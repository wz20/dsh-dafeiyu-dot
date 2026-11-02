import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { authorize, json, readJson } from '../lib/http.js';
import { defaultConfig, validatePatch } from '../lib/config.js';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='@deepseek-ai/dsh-credentials'?{url:'data:text/javascript,export const credentialRef = name => name;',shortCircuit:true}:next(specifier,context);}});
const {registerRoutes}=await import('../lib/routes.js');hook.deregister();
const base='/dsh-dafeiyu-dot';
function req(path='/state',method='GET',body,headers={}) {
  const request=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
  request.url=base+path;request.method=method;request.headers={host:'localhost:19999','sec-fetch-site':'same-origin',...headers};request.socket={remoteAddress:'127.0.0.1'};return request;
}
class Response extends EventEmitter {
  writableEnded=false;destroyed=false;status=0;headers={};body=Buffer.alloc(0);
  writeHead(status,headers){this.status=status;this.headers=headers;}
  end(value=''){this.body=Buffer.from(value);this.writableEnded=true;}
  data(){return JSON.parse(this.body.toString());}
}
function fixture(qq,memoryOverrides={},singing,options={}) {
  let handler,value=defaultConfig(),cancelled=0;const secrets=[];
  const agent={id:'one',status:'running',session:{header:{agentPreset:'standard'},snapshotEvents:()=>[]},cancel(){cancelled++;}};
  const ctx={effect:fn=>fn(),webServer:{register:route=>{handler=route.handler;return ()=>{};}},connection:{requestRejection:()=>undefined},credentials:{describe:async()=>({configured:true}),set:async(ref,key)=>secrets.push({ref,key})},agents:{get:id=>id==='one'?agent:undefined},sessionController:{list:async()=>({items:[]})}};
  const speech={snapshot:()=>({}),voices:async()=>[],health:async()=>({}),synthesize:async()=>({audio:Buffer.alloc(44),mime:'audio/wav'})};
  registerRoutes(ctx,{config:{get:()=>structuredClone(value),update:async patch=>{value=validatePatch(value,patch);}},memory:{search:()=>[],...memoryOverrides},speech,singing,reconcile:()=>{},qq,...options});
  return {ctx,speech,agent,secrets,get cancelled(){return cancelled;},config:()=>value,call:async(request,response=new Response())=>{await handler(request,response);return response;}};
}

test('messages include the explicit last turn end even when cancellation produced no assistant row',async()=>{
  const host=fixture();host.agent.status='idle';
  host.agent.session.snapshotEvents=()=>[{id:42,type:'turn/end',data:{reason:{kind:'cancelled'}}}];
  const result=await host.call(req('/messages?sessionId=one'));
  assert.equal(result.status,200);assert.deepEqual(result.data().lastTurnEnd,{id:'42',reason:'cancelled'});
  assert.deepEqual(result.data().messages,[]);
});

test('model catalog and switching routes use the current root session and return normalized selection',async()=>{
  const host=fixture(),selected={provider:'local',model:'mimo',reasoningEffort:'high'};let current=selected,commits=0;
  host.ctx.sessionController.modelCatalog=async()=>({groups:[{id:'local',name:'本地',models:[{id:'mimo',name:'MiMo',reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}]}],failures:[]});
  host.ctx.sessionController.agents={selectionFor:()=>({current}),serializeImageAdmission:async(_agent,fn)=>fn(),selectForNextRequest:(_agent,value)=>{commits++;current=value;}};
  host.ctx.llm={resolveCallConfig:async value=>({...value,reasoningEffort:'high'})};
  host.agent.status='idle';host.agent.session.header.agentPreset='whale';host.agent.runMaintenance=async fn=>fn(new AbortController().signal);
  const catalog=await host.call(req('/models?sessionId=one'));
  assert.equal(catalog.status,200);assert.deepEqual(catalog.data().selected,selected);assert.equal(catalog.data().groups[0].models[0].name,'MiMo');
  const changed=await host.call(req('/model','POST',{sessionId:'one',provider:'local',model:'mimo'}));
  assert.equal(changed.status,200);assert.deepEqual(changed.data().selected,selected);assert.equal(commits,1);
  const state=await host.call(req('/state?sessionId=one'));
  assert.deepEqual(state.data().session.modelSelection,selected);
  const messages=await host.call(req('/messages?sessionId=one'));
  assert.deepEqual(messages.data().modelSelection,selected);
});

test('updated styles revalidate while the stylesheet version query resolves to the same owned asset',async()=>{
  const host=fixture(),result=await host.call(req('/assets/immersive.css?v=1'));
  assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-cache');
  assert.match(result.headers['Content-Type'],/text\/css/);assert.ok(result.body.includes(Buffer.from('.dfj-model-controls')));
});

test('HTTP admission delegates to authenticated DSH peer and rejects cross-site or foreign Origin',()=>{
  let checked=0;const connection={requestRejection:()=>{checked++;return 401;}};
  assert.equal(authorize(req(),connection),401);assert.equal(checked,1);
  assert.equal(authorize(req('/state','GET',undefined,{'sec-fetch-site':'cross-site'}),connection),403);
  assert.equal(authorize(req('/state','GET',undefined,{origin:'http://elsewhere.example'}),connection),403);
  assert.equal(checked,1);assert.equal(authorize(req(),{requestRejection:()=>403}),403);
  assert.equal(authorize(req('/state','GET',undefined,{origin:'http://localhost:19999'}),{requestRejection:()=>undefined}),undefined);
});

test('local fallback admission excludes remote sockets',()=>{
  const request=req();assert.equal(authorize(request),undefined);request.socket.remoteAddress='::1';assert.equal(authorize(request),undefined);
  request.socket.remoteAddress='::ffff:127.0.0.1';assert.equal(authorize(request),undefined);request.socket.remoteAddress='192.168.1.20';assert.equal(authorize(request),401);
});

test('JSON body enforces byte boundary and reports malformed content',async()=>{
  assert.deepEqual(await readJson(Readable.from([Buffer.from('{"a":1}')]),7),{a:1});
  await assert.rejects(readJson(Readable.from([Buffer.from('{"a":1}')]),6),e=>e.status===413);
  await assert.rejects(readJson(Readable.from([Buffer.from('{bad}')])) ,e=>e.status===400);
  await assert.rejects(readJson(Readable.from([Buffer.from('{"a":"鲸鱼"}')]),12),e=>e.status===413);
});

test('JSON routes require an object body before dereferencing fields',async()=>{
  for(const value of ['null','false','42','"text"','[]'])await assert.rejects(readJson(Readable.from([Buffer.from(value)])),e=>e.status===400);
});

test('JSON responses have no-store policy and tolerate an already closed response',()=>{
  const response=new Response();json(response,401,{ok:false,error:'请重新打开'});assert.equal(response.status,401);assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.headers['X-Content-Type-Options'],'nosniff');assert.equal(response.data().ok,false);
  json(response,200,{ok:true});assert.equal(response.status,401);
});

test('asset route blocks encoded traversal and only serves public project assets',async()=>{
  const host=fixture();const response=await host.call(req('/assets/%2e%2e%2Flib%2Fconfig.js'));assert.equal(response.status,404);
  const good=await host.call(req('/assets/icon.png'));assert.equal(good.status,200);assert.equal(good.headers['Content-Type'],'image/png');assert.equal(good.body.subarray(1,4).toString(),'PNG');
});

test('save stores API credentials in the host and returns the configured Chinese voice without the key',async()=>{
  const host=fixture(),secret='test-private-key';const response=await host.call(req('/config','POST',{apiKey:secret,role:{name:'大肥鱼'}}));
  assert.equal(response.status,200);assert.deepEqual(host.secrets,[{ref:'DAFEIYU_TTS_API_KEY',key:secret}]);assert.equal(response.data().config.tts.localVoice,'');assert.equal(response.data().config.tts.localModel,'audiocpp');assert.doesNotMatch(response.body.toString(),/test-private-key|"apiKey"/);assert.doesNotMatch(JSON.stringify(host.config()),/test-private-key|"apiKey"/);
});

test('Breeze API key is independently stored and configuration responses never return it',async()=>{
 const host=fixture(),key='synthetic-breeze-api-key';
 const result=await host.call(req('/config','POST',{tts:{source:'api',apiProvider:'breezeblue',breezeVoice:'voc_demo_voice'},breezeApiKey:key}));
 assert.equal(result.status,200);assert.deepEqual(host.secrets,[{ref:'DAFEIYU_BREEZE_API_KEY',key}]);
 assert.equal(result.data().config.tts.breezeKeyConfigured,true);assert.equal(result.data().config.tts.apiProvider,'breezeblue');
 assert.doesNotMatch(result.body.toString(),/synthetic-breeze-api-key|breezeApiKey/);assert.doesNotMatch(JSON.stringify(host.config()),/synthetic-breeze-api-key|breezeApiKey/);
 const invalid=await host.call(req('/config','POST',{tts:{apiProvider:'unknown'},breezeApiKey:'other-key'}));assert.equal(invalid.status,400);assert.equal(host.secrets.length,1);
 const blocked=await host.call(req('/config','POST',{breezeApiKey:'other-key'},{'sec-fetch-site':'cross-site'}));assert.equal(blocked.status,403);assert.equal(host.secrets.length,1);
 const malformed=await host.call(req('/config','POST',{breezeApiKey:123}));assert.equal(malformed.status,400);assert.equal(host.secrets.length,1);
});

test('stop route is restricted to the same whale-mode boundary as send and transcribe',async()=>{
  const host=fixture();let response=await host.call(req('/stop','POST',{sessionId:'one'}));assert.equal(response.status,409);assert.equal(host.cancelled,0);
  host.agent.session.header.agentPreset='whale';response=await host.call(req('/stop','POST',{sessionId:'one'}));assert.equal(response.status,200);assert.equal(host.cancelled,1);
});

test('closing an HTTP synthesis response aborts the pending provider request',async()=>{
  const host=fixture(),response=new Response();let started,signal;const pendingReady=new Promise(resolve=>{started=resolve;});
  host.speech.synthesize=async(_text,options)=>{signal=options.signal;started();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=host.call(req('/synthesize','POST',{preview:true,text:'主人你好'}),response);await pendingReady;response.destroyed=true;response.emit('close');await pending;assert.equal(signal.aborted,true);assert.equal(response.writableEnded,false);
});

test('closing a voice catalog or health check cancels the provider work',async()=>{
 for(const [path,method] of [['/voices','voices'],['/health','health']]){
  const host=fixture(),response=new Response();let ready,signal;const started=new Promise(resolve=>ready=resolve);
  host.speech[method]=async options=>{signal=options.signal;ready();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=host.call(req(path),response);await started;assert.equal(signal.aborted,false);response.destroyed=true;response.emit('close');await pending;assert.equal(signal.aborted,true);assert.equal(response.writableEnded,false);
 }
});

test('speech response exposes bounded delivery metadata and rechecks mode before returning audio',async()=>{
  const host=fixture();host.agent.session.header.agentPreset='whale';
  host.speech.synthesize=async()=>({audio:Buffer.alloc(44),mime:'audio/wav',delivery:{mode:'model',emotion:'soothing'}});
  let result=await host.call(req('/synthesize','POST',{sessionId:'one',text:'慢慢来呀'}));
  assert.equal(result.status,200);assert.equal(result.headers['X-Dafeiyu-Delivery'],'model');assert.equal(result.headers['X-Dafeiyu-Emotion'],'soothing');
  host.speech.synthesize=async()=>{host.agent.session.header.agentPreset='standard';return {audio:Buffer.alloc(44),mime:'audio/wav'};};
  result=await host.call(req('/synthesize','POST',{sessionId:'one',text:'你好呀'}));
  assert.equal(result.status,409);assert.equal(result.headers['Content-Type'],'application/json; charset=utf-8');
});

test('QQ credentials stay in the host credential service while pairing stays behind DSH authorization',async()=>{
 const pairing={code:'A1B2C3D4E5F60718293A4B5C',expiresAt:Date.now()+600000};let started=0,reconciled=0;
 const host=fixture({snapshot:()=>({connected:false,paired:false,pairing:started?pairing:null}),startPairing:()=>{started++;return pairing;},reconcile:async()=>{reconciled++;}});
 const saved=await host.call(req('/config','POST',{qq:{enabled:true,sessionId:'one'},qqToken:'private-qq-gateway-token'}));
 assert.equal(saved.status,200);assert.deepEqual(host.secrets,[{ref:'DAFEIYU_QQ_TOKEN',key:'private-qq-gateway-token'}]);
 assert.equal(saved.data().config.qq.tokenConfigured,true);assert.doesNotMatch(saved.body.toString(),/private-qq-gateway-token|qqToken/);assert.doesNotMatch(JSON.stringify(host.config()),/private-qq-gateway-token|qqToken/);
 const blocked=await host.call(req('/qq/pairing','POST',{}, {'sec-fetch-site':'cross-site'}));assert.equal(blocked.status,403);assert.equal(started,0);
 const ready=await host.call(req('/qq/pairing','POST',{}));assert.equal(ready.status,200);assert.deepEqual(ready.data().pairing,pairing);
 const state=await host.call(req('/qq/state'));assert.equal(state.status,200);assert.equal(state.data().qq.pairing.code,pairing.code);assert.doesNotMatch(state.body.toString(),/private-qq-gateway-token/);
 const reset=await host.call(req('/qq/unpair','POST',{}));assert.equal(reset.status,200);assert.equal(host.config().qq.ownerId,'');assert.equal(reconciled,1);
});

test('project memory reconciliation requires DSH authorization and returns preserved-source maintenance results',async()=>{
 let calls=0;const host=fixture(undefined,{reconcileProjectFacts:async()=>{calls++;return {merged:1,normalized:1};},status:()=>({memoryCount:4})});
 const rejected=await host.call(req('/memory/projects/reconcile','POST',{}, {'sec-fetch-site':'cross-site'}));assert.equal(rejected.status,403);assert.equal(calls,0);
 const accepted=await host.call(req('/memory/projects/reconcile','POST',{}));assert.equal(accepted.status,200);assert.equal(calls,1);assert.equal(accepted.data().merged,1);assert.equal(accepted.data().palace.memoryCount,4);
 const unavailable=await fixture().call(req('/memory/projects/reconcile','POST',{}));assert.equal(unavailable.status,503);
});

test('memory graph returns the complete current inventory with bounded excerpts instead of search pagination',async()=>{
 const records=Array.from({length:245},(_,i)=>({id:'record-'+i,spaceId:i%2?'self':'owner',status:'active',content:i===0?'记'.repeat(1501):'当前记忆 '+i,subject:'主人',predicate:'偏好',tags:['生活'],createdAt:'2026-10-29T10:00:00Z',updatedAt:'2026-10-29T10:00:00Z'}));
 let searches=0,reads=0;const host=fixture(undefined,{get:()=>{reads++;return {memories:records};},search:()=>{searches++;return records.slice(0,200);},status:()=>({memoryCount:245}),index:()=>({builtAt:'2026-10-29T10:00:00Z',people:[{name:'主人',count:245,ids:records.map(r=>r.id)}],topics:[],dates:[]})});
 const response=await host.call(req('/memory/graph?q=不存在&limit=1'));
 assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');
 const data=response.data();assert.equal(data.records.length,245);assert.equal(reads,1);assert.equal(searches,0);
 assert.equal(data.records[0].content.length,1200);assert.equal(data.records[0].contentLength,1501);assert.equal(data.records[0].truncated,true);assert.equal(data.records[1].truncated,false);
 assert.equal(data.palace.memoryCount,245);assert.equal(data.index.people[0].count,245);assert.equal(data.spaces.length,2);
});

test('memory graph excludes retired and test records and limits projections to current display facts',async()=>{
 const active={id:'current',spaceId:'owner',status:'active',content:'当前偏好',subject:'主人',entity:'项目甲',scope:'开发',predicate:'饮品偏好',tags:['生活'],source:{kind:'conversation',sessionId:'private-session',evidence:'private-source-evidence'},sources:[{kind:'conversation',evidence:'private-previous-evidence'}],revisions:[{content:'private-old-content'}],value:'private-full-value',filePath:'/private/path',supersedes:'old'};
 const source={memories:[active,{...active,id:'old',status:'superseded'},{...active,id:'test',testOnly:true},{...active,id:'source-test',source:{kind:'conversation',testOnly:true}}]};
 const before=structuredClone(source);const host=fixture(undefined,{get:()=>source,status:()=>({memoryCount:1}),index:()=>({builtAt:'2026-10-29T10:00:00Z',people:[{name:'主人',count:4,ids:['current','old','test','source-test']}],topics:[{name:'仅旧版本',count:1,ids:['old']}],dates:[],files:[{path:'/private/path'}],corrections:[{id:'old',supersededBy:'current'}]})});
 const response=await host.call(req('/memory/graph')),data=response.data();assert.equal(response.status,200);assert.deepEqual(data.records.map(r=>r.id),['current']);
 assert.deepEqual(data.records[0].source,{kind:'conversation'});assert.equal(data.records[0].entity,'项目甲');assert.equal(data.records[0].scope,'开发');
 assert.deepEqual(data.index.people,[{name:'主人',count:1,ids:['current']}]);assert.deepEqual(data.index.topics,[]);
 assert.doesNotMatch(response.body.toString(),/private-session|private-source-evidence|private-previous-evidence|private-old-content|private-full-value|\/private\/path|supersedes|corrections|revisions|"files"/);
 assert.deepEqual(source,before);
});

test('memory graph keeps inventory reads behind host admission and handles an empty inventory',async()=>{
 let reads=0;const host=fixture(undefined,{get:()=>{reads++;return {memories:[]};},status:()=>({memoryCount:0}),index:()=>({people:[],topics:[],dates:[]})});
 const rejected=await host.call(req('/memory/graph','GET',undefined,{'sec-fetch-site':'cross-site'}));assert.equal(rejected.status,403);assert.equal(reads,0);
 host.ctx.connection.requestRejection=()=>401;const unauthorized=await host.call(req('/memory/graph'));assert.equal(unauthorized.status,401);assert.equal(reads,0);
 host.ctx.connection.requestRejection=()=>undefined;const accepted=await host.call(req('/memory/graph'));assert.equal(accepted.status,200);assert.deepEqual(accepted.data().records,[]);assert.equal(reads,1);
});

test('memory graph search finds every match in complete long records and retains multiword AND semantics',async()=>{
 const records=Array.from({length:237},(_,i)=>({id:'long-'+i,spaceId:'owner',status:'active',content:'前文'.repeat(700)+' 尾部关键词 ＭＥＭＯＲＹ',subject:'主人',entity:'项目甲',scope:'开发',predicate:'交流习惯',tags:['声音'],value:'Straße'}));
 records.push({...records[0],id:'wrong-scope',scope:'生产',content:'只有尾部关键词'});
 let searches=0;const inventory={memories:records},before=structuredClone(inventory);const host=fixture(undefined,{get:()=>inventory,search:()=>{searches++;return [];}});
 const response=await host.call(req('/memory/graph/search?q='+encodeURIComponent('尾部关键词 memory 开发 声音 STRASSE'))),data=response.data();
 assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(data.ids.length,237);assert.equal(data.ids[236],'long-236');assert.equal(searches,0);assert.deepEqual(Object.keys(data).sort(),['ids','ok']);
 assert.doesNotMatch(response.body.toString(),/前文|尾部关键词|source|revisions|content/);assert.deepEqual(inventory,before);
 const wrong=await host.call(req('/memory/graph/search?q='+encodeURIComponent('尾部关键词 开发 不存在')));assert.deepEqual(wrong.data().ids,[]);
});

test('memory graph search applies active inventory and host boundaries, accepts empty queries and rejects oversized input',async()=>{
 const active={id:'current',status:'active',content:'关系图谱'};
 let reads=0;const host=fixture(undefined,{get:()=>{reads++;return {memories:[active,{...active,id:'old',status:'superseded'},{...active,id:'test',testOnly:true},{...active,id:'source-test',source:{testOnly:true}}]};}});
 const blocked=await host.call(req('/memory/graph/search?q=关系','GET',undefined,{'sec-fetch-site':'cross-site'}));assert.equal(blocked.status,403);assert.equal(reads,0);
 const empty=await host.call(req('/memory/graph/search?q=%20%20'));assert.equal(empty.status,200);assert.deepEqual(empty.data().ids,['current']);
 const oversized=await host.call(req('/memory/graph/search?q='+'a'.repeat(1001)));assert.equal(oversized.status,400);assert.equal(reads,1);
 const boundary=await host.call(req('/memory/graph/search?q='+'a'.repeat(1000)));assert.equal(boundary.status,200);assert.deepEqual(boundary.data().ids,[]);assert.equal(reads,2);
});

test('song replay returns the completed reply audio and bypasses ordinary speech synthesis',async()=>{
  const songId='01a186a2-e576-4b43-82eb-2df0217eee08',audio=Buffer.from('verified-singing-wave');let reads=0,tts=0;
  const host=fixture(undefined,{}, {read:async(id,sid)=>{assert.equal(id,songId);assert.equal(sid,'one');reads++;return {audio,mime:'audio/wav',delivery:{mode:'singing',cached:true}};}});
  host.agent.status='idle';host.agent.session.header.agentPreset='whale';
  host.agent.session.snapshotEvents=()=>[
    {type:'turn/start',data:{}},{type:'tool/call',data:{name:'dafeiyu_sing',callId:'sing'}},
    {type:'tool/result',data:{message:{toolCallId:'sing',content:[{type:'text',text:JSON.stringify({status:'ready',songId,title:'小星星'})}]}}},
    {id:'reply',type:'assistant/message',data:{message:{content:[{type:'text',text:'唱好了'}]}}},{type:'turn/end',data:{reason:{kind:'completed'}}}];
  host.speech.synthesize=async()=>{tts++;throw Error('must not call TTS');};
  const result=await host.call(req('/synthesize','POST',{sessionId:'one',replyId:'reply',text:'唱好了'}));
  assert.equal(result.status,200);assert.deepEqual(result.body,audio);assert.equal(result.headers['X-Dafeiyu-Delivery'],'singing');assert.equal(reads,1);assert.equal(tts,0);
  const stale=await host.call(req('/synthesize','POST',{sessionId:'one',replyId:'missing',text:'唱好了'}));
  assert.equal(stale.status,409);assert.equal(tts,0);assert.equal(reads,1);
});

test('manual QQ recovery requires the existing trusted route and retains saved configuration',async()=>{
  let attempts=0;const host=fixture({reconnect:async()=>{attempts++;return {phase:'connecting',connected:false};}}),saved=host.config();
  const rejected=await host.call(req('/qq/reconnect','POST',{}, {'sec-fetch-site':'cross-site'}));assert.equal(rejected.status,403);assert.equal(attempts,0);
  const response=await host.call(req('/qq/reconnect','POST',{}));assert.equal(response.status,200);assert.equal(response.data().qq.phase,'connecting');assert.equal(attempts,1);assert.deepEqual(host.config(),saved);
});

test('NapCat login routes require DSH authorization and keep QR responses uncached',async()=>{
 const calls=[],login={phase:'waiting_qrcode',loggedIn:false,qrImage:'data:image/svg+xml;base64,PHN2Zy8+'};
 const host=fixture({snapshot:()=>({connected:false})},{},undefined,{napcatLogin:{state:async options=>{calls.push(options);return login;}}});
 const blocked=await host.call(req('/qq/login','GET',undefined,{'sec-fetch-site':'cross-site'}));assert.equal(blocked.status,403);assert.equal(calls.length,0);
 const read=await host.call(req('/qq/login'));assert.equal(read.status,200);assert.deepEqual(read.data().login,login);assert.equal(read.headers['Cache-Control'],'no-store');assert.equal(calls[0].refresh,undefined);
 const refreshed=await host.call(req('/qq/login/refresh','POST',{}));assert.equal(refreshed.status,200);assert.equal(calls[1].refresh,true);
 assert.equal(calls[1].signal.aborted,false);
});

test('NapCat setup stores only its secret in DSH and preserves unrelated saved QQ settings',async()=>{
 const host=fixture(),before=structuredClone(host.config().qq);
 const saved=await host.call(req('/qq/login/config','POST',{napcatUrl:'http://localhost:16099',napcatToken:'synthetic-napcat-key'}));
 assert.equal(saved.status,200);assert.deepEqual(host.secrets,[{ref:'DAFEIYU_NAPCAT_WEBUI_TOKEN',key:'synthetic-napcat-key'}]);
 assert.equal(saved.data().config.napcatTokenConfigured,true);assert.deepEqual(host.config().qq,{...before,napcatUrl:'http://localhost:16099'});
 assert.doesNotMatch(saved.body.toString(),/synthetic-napcat-key|"napcatToken"/);assert.doesNotMatch(JSON.stringify(host.config()),/synthetic-napcat-key|"napcatToken"/);
 const invalid=await host.call(req('/qq/login/config','POST',{napcatUrl:'https://remote.example',napcatToken:'other-secret'}));assert.equal(invalid.status,400);assert.equal(host.secrets.length,1);
 const blocked=await host.call(req('/qq/login/config','POST',{napcatToken:'other-secret'},{'sec-fetch-site':'cross-site'}));assert.equal(blocked.status,403);assert.equal(host.secrets.length,1);
});

test('NapCat missing credentials return a setup code without returning secrets',async()=>{
 const host=fixture(undefined,{},undefined,{napcatLogin:{state:async()=>{throw Object.assign(Error('请先保存 NapCat 管理密钥。'),{status:428,code:'NAPCAT_TOKEN_REQUIRED'});}}});
 const result=await host.call(req('/qq/login'));assert.equal(result.status,428);assert.equal(result.data().code,'NAPCAT_TOKEN_REQUIRED');
});

test('personal media uses the authenticated asset route with private no-store caching',async t=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'companion-http-assets-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'role-preview.png'),'local-image-bytes');
  const host=fixture(undefined,{},undefined,{localAssetRoot:root}),r=await host.call(req('/assets/role-preview.png'));
  assert.equal(r.status,200);assert.equal(r.body.toString(),'local-image-bytes');assert.equal(r.headers['Cache-Control'],'private, no-store');
});
