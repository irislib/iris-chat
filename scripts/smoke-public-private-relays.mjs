import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { Session } from 'nostr-double-ratchet';
import { TestRelay } from '../e2e/test-relay.ts';
import { createDenyProxy, assertWorkerNetworkBlocked } from './isolatedBrowser.ts';

const dist = path.resolve('dist'), assets = await readdir(path.join(dist, 'assets'));
const workers = assets.filter(name => /^nostrWorker-.*\.js$/.test(name));
assert.equal(workers.length, 1, 'Use the actual production message worker');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') { res.end('<!doctype html><title>Public/private routing</title>'); return; }
  const file = path.resolve(dist, `.${pathname}`);
  if (!file.startsWith(`${dist}${path.sep}`)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': 'application/javascript' }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const publicRelay = new TestRelay(), privateRelay = new TestRelay(), customRelay = new TestRelay();
const frames = new Map([publicRelay, privateRelay, customRelay].map(relay => [relay, []]));
for (const relay of frames.keys()) { relay.observeWire = frame => frames.get(relay).push(frame); await relay.start(); }
const boundary = await createDenyProxy();
const browser = await chromium.launch({ headless: true, proxy: { server: boundary.url, bypass: '127.0.0.1,localhost,[::1]' } });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
  await assertWorkerNetworkBlocked(page, boundary);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const owner = getPublicKey(generateSecretKey()), peer = getPublicKey(generateSecretKey());
  await page.evaluate(({ worker, owner, publicRelays, privateRelays }) => {
    const pending = new Map(); let next = 0;
    const instance = new Worker(worker, { type: 'module' });
    instance.onmessage = ({ data }) => {
      if (data.type === 'result') pending.get(data.id)?.resolve(data.value);
      if (data.type === 'error') pending.get(data.id)?.reject(new Error(data.error));
      pending.delete(data.id);
    };
    window.callWorker = (method, args) => new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker request timed out')); }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      instance.postMessage({ id, method, args });
    });
    instance.postMessage({ method: 'init', args: [owner] });
    instance.postMessage({ method: 'setRelays', args: [publicRelays, privateRelays] });
  }, { worker: `/assets/${workers[0]}`, owner, publicRelays: [publicRelay.url, privateRelay.url], privateRelays: [privateRelay.url] });
  const call = (method, args) => page.evaluate(({ method, args }) => window.callWorker(method, args), { method, args });
  const read = kinds => call('query', [[{ kinds, authors: [peer] }], { cache: 'network-only', sources: [] }]);
  await read([1060]); await read([37368]); await read([0]);
  const kinds = relay => frames.get(relay).filter(frame => frame[0] === 'REQ').flatMap(frame => frame.slice(2).flatMap(filter => filter.kinds ?? []));
  assert.deepEqual(kinds(publicRelay), [0]);
  assert(kinds(privateRelay).includes(1060) && kinds(privateRelay).includes(37368));
  const message = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey())
    .sendEvent({ kind: 14, content: 'loopback private routing proof' }, [['p', peer]]).event;
  const post = finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'loopback public routing proof' }, generateSecretKey());
  await call('publish', [message, { requireAck: true, queue: false }]);
  await call('publish', [post, { requireAck: true, queue: false }]);
  await expect.poll(() => publicRelay.publishedEvents.map(event => event.id)).toEqual([post.id]);
  await expect.poll(() => privateRelay.publishedEvents.map(event => event.id).sort()).toEqual([message.id, post.id].sort());
  const publicRead = await call('query', [[{ kinds: [1], ids: [post.id] }], { cache: 'network-only', sources: [] }]);
  assert.equal(publicRead.events[0]?.id, post.id);
  await call('setRelays', [[customRelay.url], [customRelay.url]]);
  await read([0]); await read([1060]);
  assert(kinds(customRelay).includes(0) && kinds(customRelay).includes(1060));
  await call('setRelays', [[], []]);
  assert.deepEqual((await read([0])).sources, []);
  assert.deepEqual((await read([1060])).sources, []);
  await context.close();
  console.log('Actual built message worker PASS: public read/post, private receive/discovery/envelope separation, custom and empty relay policy. Raw worker egress denied independently.');
} finally {
  await browser.close(); await boundary.close();
  for (const relay of frames.keys()) await relay.stop();
  await new Promise(resolve => server.close(resolve));
}
