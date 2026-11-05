import { createRequire } from 'node:module';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const graphPackage = path.dirname(require.resolve('nostr-social-graph/package.json'));
const { Negentropy, NegentropyStorageVector } = await import(pathToFileURL(path.join(graphPackage, 'src/vendor/negentropy.js')));

export function matches(event, filter) {
  return (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (!filter.ids || filter.ids.includes(event.id));
}
export function createNegSession(events = [], filter = {}) {
  const storage = new NegentropyStorageVector();
  for (const event of events) if (matches(event, filter)) storage.insert(event.created_at, event.id);
  storage.seal();
  return new Negentropy(storage, 16384);
}

/** Real codec and WebSocket I/O; ordinary live subscriptions are tracked separately. */
export async function createGraphPolicyRelay(events) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const records = [];
  server.on('connection', (socket, connection) => {
    const record = { socket, path: connection.url, neg: false, filters: [], requests: [], servedIds: [], errors: [], active: new Map(), closed: false };
    records.push(record);
    const sessions = new Map();
    let pending = Promise.resolve();
    socket.on('close', () => { record.closed = true; });
    socket.on('message', raw => {
      pending = pending.then(async () => {
        const frame = JSON.parse(raw.toString()), id = frame[1];
        if (frame[0] === 'NEG-OPEN') {
          record.neg = true; record.filters.push(frame[2]);
          if (record.path.includes('unsupported')) { socket.send(JSON.stringify(['NEG-ERR', id, 'unsupported'])); return; }
          const session = createNegSession(events, frame[2]); sessions.set(id, session);
          const [reply] = await session.reconcile(frame[3]);
          socket.send(JSON.stringify(['NEG-MSG', id, reply]));
        } else if (frame[0] === 'NEG-MSG') {
          const [reply] = await sessions.get(id).reconcile(frame[2]);
          socket.send(JSON.stringify(['NEG-MSG', id, reply]));
        } else if (frame[0] === 'NEG-CLOSE') sessions.delete(id);
        else if (frame[0] === 'CLOSE') record.active.delete(id);
        else if (frame[0] === 'EVENT' && frame[1]?.id) socket.send(JSON.stringify(['OK', frame[1].id, true, 'fixture accepted']));
        else if (frame[0] === 'REQ') {
          const filters = frame.slice(2); record.requests.push(filters); record.active.set(id, filters);
          // Only exact-ID reads following real NEG receive initial bodies. This
          // prevents live subscriptions from accidentally satisfying the NEG test.
          if (record.neg && filters.every(filter => Array.isArray(filter.ids) && Object.keys(filter).every(key => key === 'ids'))) {
            for (const event of events) if (filters.some(filter => matches(event, filter))) {
              record.servedIds.push(event.id); socket.send(JSON.stringify(['EVENT', id, event]));
            }
          }
          socket.send(JSON.stringify(['EOSE', id]));
        }
      }).catch(error => { record.errors.push(String(error)); socket.close(); });
    });
  });
  return {
    records,
    url: suffix => `ws://127.0.0.1:${server.address().port}/${suffix}`,
    publishLive(liveEvents) {
      let deliveries = 0;
      for (const record of records) if (!record.neg && record.socket.readyState === 1) {
        for (const [id, filters] of record.active) for (const event of liveEvents) if (filters.some(filter => matches(event, filter))) {
          record.socket.send(JSON.stringify(['EVENT', id, event])); deliveries++;
        }
      }
      return deliveries;
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
