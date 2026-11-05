import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {WebSocket} from 'ws';
import {chromium, expect} from '@playwright/test';
import {SocialGraph} from 'nostr-social-graph';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import {createGraphPolicyRelay} from './graph-policy-relay.mjs';

const app=process.argv[2];assert(['contacts','chat'].includes(app));
const root='4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0';
const key=new Uint8Array(32).fill(42),owner=getPublicKey(key),friend=getPublicKey(new Uint8Array(32).fill(43)),muted=getPublicKey(new Uint8Array(32).fill(44));
const lists=(created_at, follows=friend, mutes=muted)=>[3,10000].map(kind=>finalizeEvent({kind,created_at,content:'',tags:[['p',kind===3?follows:mutes]]},key));
const seedEvents=lists(100),newEvents=lists(300),lateEvents=lists(400,muted,friend),personalEvents=lists(500,muted,friend),servedEvents=[...newEvents];
const seed=new SocialGraph(root);seed.addFollower(root,owner);seed.handleEvent(seedEvents,true);
const seedBytes=Buffer.from(await seed.toBinary()),httpMarker=getPublicKey(new Uint8Array(32).fill(45));
const httpSeed=await SocialGraph.fromBinary(root,seedBytes);httpSeed.addFollower(friend,httpMarker);const httpSeedBytes=Buffer.from(await httpSeed.toBinary());
const dist=path.resolve('dist');
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/__fixture'){res.end('<!doctype html><title>Fixture</title>');return;}
 const file=path.resolve(dist,`.${pathname==='/'?'/index.html':pathname}`);
 if(!file.startsWith(dist+path.sep)){res.writeHead(403).end();return;}
 try{let bytes=await readFile(file);
 // Route the message worker's sockets at the transport boundary as well as the
 // page sockets. Keep all application/protocol code from the actual built asset.
 if(app==='chat'&&/^nostrWorker-.*\.js$/.test(path.basename(file)))bytes=Buffer.concat([Buffer.from(`const __GraphFixtureWebSocket=globalThis.WebSocket;globalThis.WebSocket=class extends __GraphFixtureWebSocket{constructor(url,protocols){super(${JSON.stringify(relay.url('custom'))},protocols)}};\n`),bytes]);
 res.writeHead(200,{'content-type':{'.js':'application/javascript','.html':'text/html','.css':'text/css','.wasm':'application/wasm'}[path.extname(file)]??'application/octet-stream','cache-control':'no-store'}).end(bytes);}catch{res.writeHead(404).end();}
}).listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`,relay=await createGraphPolicyRelay(servedEvents),browser=await chromium.launch({headless:true});
const cacheInfo={name:app==='contacts'?'iris-public-social-graph':'iris-chat-people-graph',store:app==='contacts'?'graphs':'accounts',version:app==='contacts'?1:10,key:app==='contacts'?root:owner};
async function stored(page){return page.evaluate(async info=>{
 if(!(await indexedDB.databases()).some(db=>db.name===info.name))return null;
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{return await new Promise((resolve,reject)=>{const r=db.transaction(info.store).objectStore(info.store).get(info.key);r.onsuccess=()=>{const bytes=info.store==='accounts'?r.result?.graph:r.result;resolve({bytes:bytes?[...bytes]:null,events:info.store==='accounts'?r.result?.events:undefined})};r.onerror=()=>reject(r.error);});}finally{db.close();}
 },cacheInfo);}
async function cached(page){const record=await stored(page);return record?.bytes?SocialGraph.fromBinary(cacheInfo.key,new Uint8Array(record.bytes)):null;}
async function assertCached(page,events,partial=false){await expect.poll(async()=>{const graph=await cached(page);return events.map(e=>graph?.getListRevision(owner,e.kind)?.id)},{timeout:15000}).toEqual(events.map(e=>e.id));const graph=await cached(page);assert.equal(graph.getListRevision(owner,3).complete,!partial);assert.equal(graph.getListRevision(owner,10000).complete,true);assert.deepEqual([...graph.getMutedByUser(owner)],[events[1].tags[0][1]]);}
async function retain(page,invalid=false,events=[]){const graph=new SocialGraph(root);graph.addFollower(root,owner);graph.handleEvent(events.length?events:newEvents,true);if(!events.length)graph.markListIncomplete(owner,3);await page.evaluate(async({info,bytes,newEvents})=>{
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(info.name,info.version);r.onupgradeneeded=()=>r.result.createObjectStore(info.store,info.store==='accounts'?{keyPath:'owner'}:undefined);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 try{await new Promise((resolve,reject)=>{const tx=db.transaction(info.store,'readwrite'),store=tx.objectStore(info.store);if(info.store==='accounts')store.put({owner:info.key,graph:new Uint8Array(bytes),events:newEvents});else store.put(new Uint8Array(bytes),info.key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}finally{db.close();}
 },{info:cacheInfo,bytes:invalid?[255,0,254,1]:[...await graph.toBinary()],newEvents:events});}
const modes=[...(app==='chat'?['fresh-neg','custom-neg','pending-custom','empty-retained']:['fresh-neg']),'unsupported-retained','pending-other-tab','unreadable-cache'];
if(process.argv[3])assert(modes.includes(process.argv[3]));
try{for(const mode of process.argv[3]?[process.argv[3]]:modes){
 servedEvents.splice(0,servedEvents.length,...newEvents);const start=relay.records.length,records=()=>relay.records.slice(start),sync=()=>records().filter(r=>r.neg);
 const conflict=mode==='pending-other-tab',invalid=mode==='unreadable-cache',pendingCustom=mode==='pending-custom',empty=mode==='empty-retained',custom=mode==='custom-neg',context=await browser.newContext({serviceWorkers:'allow'});let http=0,unsupported=mode==='unsupported-retained',releaseBootstrap;
 const bootstrapGate=new Promise(resolve=>{releaseBootstrap=resolve;});
 await context.route('https://graph-api.iris.to/**',async route=>{http++;if(conflict||pendingCustom)await bootstrapGate;return route.fulfill({body:httpSeedBytes,contentType:'application/octet-stream',headers:{'x-graph-root':root,'access-control-allow-origin':'*','access-control-expose-headers':'x-graph-root'}})});
 await context.route(/\/assets\/socialGraph[^/]*\.bin$/,route=>route.fulfill({body:seedBytes,contentType:'application/octet-stream'}));
 // Bridge browser WebSocket I/O to the same real local NEG responder used by worker apps.
 await context.routeWebSocket(/^wss?:/,route=>{
  let closed=false;const queued=[],socket=new WebSocket(relay.url(unsupported?'unsupported':'custom'));
  socket.on('open',()=>{for(const data of queued)socket.send(data);queued.length=0;});
  route.onMessage(data=>{let frame;try{frame=JSON.parse(String(data));}catch{return;}if(!Array.isArray(frame))return;const text=JSON.stringify(frame);if(socket.readyState===1)socket.send(text);else if(socket.readyState===0)queued.push(text);});
  socket.on('message',data=>{if(!closed)route.send(data.toString());});socket.on('error',()=>{if(!closed)route.close();});
  socket.on('close',()=>{if(!closed){closed=true;route.close();}});route.onClose(()=>{closed=true;socket.close();});
 });
 if(app==='chat')await context.addInitScript(({key,custom,empty})=>{localStorage.setItem('iris-chat-identity',key);localStorage.setItem('iris-native-app-suggestion','dismissed');if(custom)localStorage.setItem('iris-chat-relays',JSON.stringify(empty?[]:['wss://graph-fixture.example']));},{key:Buffer.from(key).toString('hex'),custom:custom||unsupported||empty,empty});
 const blocker=await context.newPage();await blocker.goto(`${origin}/__fixture`);if(unsupported||invalid||empty)await retain(blocker,invalid);let retained=await stored(blocker);
 const page=await context.newPage();const ready=()=>app==='chat'?page.getByRole('button',{name:'New Chat',exact:true}):page.locator('[data-contact-index="0"]');
 try{
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  if(conflict){await expect.poll(()=>http,{timeout:15000}).toBe(1);await retain(blocker,false,personalEvents);retained=await stored(blocker);releaseBootstrap();}
  await expect(ready()).toBeVisible({timeout:30000});
  if(pendingCustom){
   await expect.poll(()=>http,{timeout:15000}).toBe(1);
   await page.evaluate(()=>{location.hash='settings/network'});await page.getByRole('button',{name:'Edit',exact:true}).click();
   await page.getByPlaceholder('wss://relay.example.com').fill('wss://graph-fixture.example');await page.getByRole('button',{name:'Add',exact:true}).click();
   await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('iris-chat-relays')).includes('wss://graph-fixture.example'))).toBe(true);
   releaseBootstrap();await page.evaluate(()=>{location.hash=''});
  }
  if(empty){await page.waitForTimeout(2000);assert.equal(http,0);assert.equal(sync().length,0);assert.deepEqual(await stored(blocker),retained);await page.reload({waitUntil:'domcontentloaded'});await expect(ready()).toBeVisible({timeout:30000});await page.waitForTimeout(1500);assert.equal(http,0);assert.equal(sync().length,0);assert.deepEqual(await stored(blocker),retained);console.log('chat: empty-retained PASS; saved empty policy causes no seed or reconciliation');continue;}
  await expect.poll(()=>sync().some(r=>r.filters.some(f=>f.authors?.includes(owner)&&f.kinds?.includes(3)&&f.kinds?.includes(10000))),{timeout:15000}).toBe(true);
  await expect.poll(()=>sync().every(r=>r.closed),{timeout:15000}).toBe(true);
  if(conflict||invalid){
   await expect.poll(()=>newEvents.every(e=>sync().some(r=>r.servedIds.includes(e.id))),{timeout:15000}).toBe(true);
   await page.waitForTimeout(1800);assert.deepEqual(await stored(blocker),retained,'A pending seed or unreadable cache must preserve the other tab’s exact row');
   if(app==='chat')relay.publishLive(lateEvents);else{servedEvents.splice(0,servedEvents.length,...lateEvents);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
   await page.waitForTimeout(2200);assert.deepEqual(await stored(blocker),retained,'Conflict latch must also block later debounce saves');
   assert.equal(http,conflict?1:0);unsupported=true;
   await page.reload({waitUntil:'domcontentloaded'});await expect(ready()).toBeVisible({timeout:30000});
   await page.waitForTimeout(1800);assert.deepEqual(await stored(blocker),retained,'Close/reload must preserve retained or unreadable bytes');assert.equal(http,conflict?1:0);
   console.log(`${app}: ${mode} PASS; second-tab row preserved through debounce and reload; HTTP=${http}`);continue;
  }
  if(unsupported){assert.equal(sync().flatMap(r=>r.requests).length,0,'Unsupported NEG must not fall back to REQ');await assertCached(page,newEvents,true);assert.equal(http,0);}
  else{
   await assertCached(page,newEvents);const requests=sync().flatMap(r=>r.requests);assert(requests.length>0);assert(requests.every(filters=>filters.every(f=>Array.isArray(f.ids)&&Object.keys(f).every(k=>k==='ids'))),'Only exact-ID body fetches may follow NEG');assert(newEvents.every(e=>sync().some(r=>r.servedIds.includes(e.id))));assert.equal(http,custom?0:1);if(pendingCustom)assert.equal((await cached(page)).getFollowedByUser(friend).has(httpMarker),false,'Revoked bootstrap must not merge after custom settings');
   if(app==='chat'){await expect.poll(()=>records().some(r=>!r.neg&&!r.closed&&[...r.active.values()].flat().some(f=>f.authors?.includes(owner))),{timeout:15000}).toBe(true);assert(relay.publishLive(lateEvents)>=2,'Normal live follow/mute subscription remains active');}
   else{servedEvents.splice(0,servedEvents.length,...lateEvents);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));}
   await assertCached(page,lateEvents);
  }
  const before=http;await page.reload({waitUntil:'domcontentloaded'});await expect(ready()).toBeVisible({timeout:30000});await assertCached(page,unsupported?newEvents:lateEvents,unsupported);assert.equal(http,before,'Reload must preserve graph without replacement HTTP');assert.deepEqual(records().flatMap(r=>r.errors),[]);
  console.log(`${app}: ${mode} PASS; exact signed follow/mute IDs and retained partial cache; HTTP=${http}; NEG sockets=${sync().length}`);
 }finally{releaseBootstrap();await context.close();}
}}finally{await browser.close();await relay.close();await new Promise(resolve=>server.close(resolve));}
