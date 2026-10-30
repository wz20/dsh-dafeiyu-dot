import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, defaultConfig } from '../lib/config.js';
import { MemoryStore } from '../lib/memory.js';
import { switchWhaleMode, projectMessages, sendText } from '../lib/session.js';

test('configuration validates patches, serializes concurrent writes, and keeps keys out of disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-test-'));
  const config = new ConfigStore(join(dir, 'config.json'));
  await Promise.all([config.update({role:{name:'鲸鱼娘'}}), config.update({tts:{volume:0.3}})]);
  assert.equal(config.get().role.name, '鲸鱼娘');
  assert.equal(config.get().tts.volume, 0.3);
  await assert.rejects(config.update({tts:{source:'mystery'}}));
  await assert.rejects(config.update({tts:{localUrl:'file:///etc/passwd'}}));
  await config.update({apiKey:'secret',tts:{apiKey:'secret'}});
  assert.doesNotMatch(await readFile(join(dir,'config.json'),'utf8'), /secret|apiKey/);
  assert.ok(defaultConfig().role.prompt.length > 5000);
  assert.equal(config.get().tts.emotional,true);assert.equal(config.get().tts.expressiveness,'natural');
  await config.update({tts:{emotional:false,expressiveness:'gentle'}});
  assert.equal(config.get().tts.emotional,false);assert.equal(config.get().tts.expressiveness,'gentle');
  await assert.rejects(config.update({tts:{expressiveness:'unbounded'}}));
  await assert.rejects(config.update({tts:{emotional:'yes'}}));
});

test('speech pace persists a bounded numeric multiplier and keeps other voice settings', async () => {
  const dir=await mkdtemp(join(tmpdir(),'dafeiyu-speed-config-'));
  const path=join(dir,'config.json'),store=new ConfigStore(path);
  assert.equal(store.get().tts.speed,1);
  await store.update({tts:{speed:1.15}});
  assert.equal(new ConfigStore(path).get().tts.speed,1.15);
  assert.equal(store.get().tts.expressiveness,'natural');
  for(const speed of [.5,2,'1.15',NaN,Infinity])await assert.rejects(store.update({tts:{speed}}),/语速/);
});

test('memory CRUD is isolated by space and survives concurrent writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-test-'));
  const store = new MemoryStore(join(dir,'memories.json'));
  const [a,b] = await Promise.all([store.put({spaceId:'self',content:'一起解决难题'}),store.put({spaceId:'owner',content:'喜欢中文'})]);
  assert.equal(store.search('中文').length,1);
  assert.equal(store.search('', 'self')[0].id,a.id);
  await assert.rejects(store.put({spaceId:'unknown',content:'x'}));
  await store.remove(b.id);
  assert.equal(new MemoryStore(join(dir,'memories.json')).search('').length,1);
});

test('mode switching commits under maintenance and rolls composition back after failure', async () => {
  const events=[];const calls=[];
  const agent={id:'s',status:'idle',ctx:{},session:{header:{agentPreset:'standard'},snapshotEvents:()=>events,append(type,data){events.push({type,data});}},runMaintenance:fn=>fn(new AbortController().signal)};
  const ctx={agents:{get:()=>agent},agentPresets:{resolve:async()=>({broken:false}),recompose:async(_,p)=>calls.push(p)}};
  await switchWhaleMode(ctx,{sessionId:'s',agentPreset:'whale',expectedPreset:'standard'});
  assert.equal(events[0].data.agentPreset,'whale');
  assert.deepEqual(calls,['whale']);
  ctx.agentPresets.recompose=async(_,p)=>{calls.push(p);if(p==='standard')throw Error('mount failed')};
  await assert.rejects(switchWhaleMode(ctx,{sessionId:'s',agentPreset:'standard',expectedPreset:'whale'}));
  assert.equal(calls.at(-1),'whale');
  agent.status='running';
  await assert.rejects(switchWhaleMode(ctx,{sessionId:'s',agentPreset:'standard',expectedPreset:'whale'}));
});

test('transcript exposes user text and completed final reply, never reasoning or interrupted speech', () => {
  const log=[
    {id:'u',type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'你好'}]}},
    {id:'context',type:'user/message',data:{source:{kind:'plugin'},content:[{type:'text',text:'内部时间上下文'}]}},
    {id:'a',type:'assistant/message',data:{message:{content:[{type:'reasoning',text:'secret'},{type:'text',text:'你好呀'}]}}},
    {id:'e',type:'turn/end',data:{reason:{kind:'completed'}}},
    {id:'b',type:'assistant/message',data:{message:{content:[{type:'text',text:'interrupted'}]}}},
    {id:'e2',type:'turn/end',data:{reason:{kind:'cancelled'}}}
  ];
  assert.deepEqual(projectMessages(log).map(x=>[x.role,x.text,x.speakable]),[['user','你好',false],['assistant','你好呀',true],['assistant','interrupted',false]]);
});

test('transcript distinguishes pending assistant rows from an explicit completed or cancelled turn', () => {
  const message = (id, text, tool = false) => ({id,type:'assistant/message',data:{message:{content:[{type:'text',text},...(tool?[{type:'tool-call',id:'tool-1',name:'memory_search',arguments:{}}]:[])]}}});
  const log=[message('tool','查一下记忆',true),message('final','主人，本鱼记得。')];
  assert.deepEqual(projectMessages(log).map(x=>[x.terminal,x.speakable]),[[false,false],[false,false]]);
  log.push({id:'end-1',type:'turn/end',data:{reason:{kind:'completed'}}});
  assert.deepEqual(projectMessages(log).map(x=>[x.terminal,x.speakable]),[[true,false],[true,true]]);
  log.push(message('cancelled','尚未说完'));
  assert.equal(projectMessages(log).at(-1).terminal,false);
  log.push({id:'end-2',type:'turn/end',data:{reason:{kind:'cancelled'}}});
  assert.deepEqual([projectMessages(log).at(-1).terminal,projectMessages(log).at(-1).speakable],[true,false]);
});

test('send requires explicit whale session and deduplicates a retried request', async () => {
  let count=0;const session={header:{agentPreset:'whale'},snapshotEvents:()=>[]};
  const agent={status:'idle',session,followup:()=>count++};const ctx={agents:{get:()=>agent}};
  const receipts=new Map();
  const req={sessionId:'s',text:'你好',requestId:'r'};
  await sendText(ctx,req,receipts,v=>v);await sendText(ctx,req,receipts,v=>v);
  assert.equal(count,1);
  session.header.agentPreset='standard';
  await assert.rejects(sendText(ctx,{...req,requestId:'r2'},receipts));
});

test('a verified singing tool result attaches only to its completed turn final reply', () => {
  const songId='01a186a2-e576-4b43-82eb-2df0217eee08';
  const log=[{type:'turn/start',data:{turn:1}},
    {type:'tool/call',data:{name:'dafeiyu_sing',callId:'sing-1'}},
    {type:'tool/result',data:{message:{toolCallId:'sing-1',content:[{type:'text',text:JSON.stringify({status:'ready',songId,title:'小星星'})}]}}},
    {id:'sung',type:'assistant/message',data:{message:{content:[{type:'text',text:'小星星唱好了。'}]}}},
    {type:'turn/end',data:{reason:{kind:'completed'}}},
    {type:'turn/start',data:{turn:2}},
    {id:'ordinary',type:'assistant/message',data:{message:{content:[{type:'text',text:'我在这里。'}]}}},
    {type:'turn/end',data:{reason:{kind:'completed'}}}];
  const rows=projectMessages(log);
  assert.equal(rows[0].songId,songId);assert.equal(rows[1].songId,undefined);
  log[2].data.message.toolCallId='different-call';assert.equal(projectMessages(log)[0].songId,undefined);
  log[2].data.message.toolCallId='sing-1';log[2].data.message.isError=true;assert.equal(projectMessages(log)[0].songId,undefined);
  log[2].data.message.isError=false;log[4].data.reason.kind='cancelled';assert.equal(projectMessages(log)[0].songId,undefined);
});

test('PTC singing dispatch is associated with the completed final reply',()=>{
 const songId='01a186a2-e576-4b43-82eb-2df0217eee08';
 const log=[{type:'turn/start',data:{}},{type:'tool/ptc-dispatch-start',data:{name:'dafeiyu_sing',subCallId:'ptc-sing'}},
  {type:'tool/ptc-dispatch',data:{name:'dafeiyu_sing',subCallId:'ptc-sing',isError:false,content:[{type:'text',text:JSON.stringify({status:'ready',songId})}]}},
  {id:'final',type:'assistant/message',data:{message:{content:[{type:'text',text:'唱好了'}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}}];
 assert.equal(projectMessages(log)[0].songId,songId);
 log[2].data.isError=true;assert.equal(projectMessages(log)[0].songId,undefined);
});

test('a completed song without final assistant text projects a stable playable row',()=>{
 const songId='01a186a2-e576-4b43-82eb-2df0217eee08';
 const log=[{id:'start',type:'turn/start',data:{}},
  {type:'tool/call',data:{name:'dafeiyu_sing',callId:'local-song'}},
  {type:'tool/result',data:{message:{toolCallId:'local-song',content:[{type:'text',text:JSON.stringify({status:'ready',songId,title:'朋友的酒'})}]}}},
  {id:'empty',type:'assistant/message',data:{message:{content:[{type:'text',text:''}]}}},
  {id:'song-end',type:'turn/end',data:{reason:{kind:'completed'}}}];
 assert.deepEqual(projectMessages(log),[{id:'song-end',role:'assistant',text:'《朋友的酒》',terminal:true,speakable:true,songId,title:'朋友的酒'}]);
 assert.deepEqual(projectMessages(log),projectMessages(structuredClone(log)));
 const spaces=structuredClone(log);spaces[3].data.message.content[0].text=' \n ';assert.deepEqual(projectMessages(spaces),projectMessages(log));
 for(const kind of ['cancelled','error']){
  const failed=structuredClone(log);failed.at(-1).data.reason.kind=kind;
  assert.deepEqual(projectMessages(failed),[]);
 }
 assert.deepEqual(projectMessages(log.slice(0,-1)),[]);
 const unrelated=structuredClone(log);unrelated[2].data.message.toolCallId='other';assert.deepEqual(projectMessages(unrelated),[]);
 const rejected=structuredClone(log);rejected[2].data.message.isError=true;assert.deepEqual(projectMessages(rejected),[]);
});

test('a PTC song can project its own playback row when only tool-call assistant text exists',()=>{
 const songId='01a186a2-e576-4b43-82eb-2df0217eee08';
 const log=[{type:'turn/start',data:{}},{type:'tool/ptc-dispatch-start',data:{name:'dafeiyu_sing',subCallId:'local-song'}},
  {type:'tool/ptc-dispatch',data:{name:'dafeiyu_sing',subCallId:'local-song',isError:false,content:[{type:'text',text:JSON.stringify({status:'ready',songId,title:'朋友的酒'})}]}},
  {id:'tool-row',type:'assistant/message',data:{message:{content:[{type:'text',text:'准备播放'}, {type:'tool-call',name:'dafeiyu_sing',id:'local-song'}]}}},
  {id:'ptc-song-end',type:'turn/end',data:{reason:{kind:'completed'}}}];
 const rows=projectMessages(log);
 assert.equal(rows.length,2);assert.equal(rows[0].speakable,false);
 assert.deepEqual(rows[1],{id:'ptc-song-end',role:'assistant',text:'《朋友的酒》',terminal:true,speakable:true,songId,title:'朋友的酒'});
});
