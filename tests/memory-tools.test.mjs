import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../lib/memory.js';
const hook=registerHooks({resolve(specifier,context,next){if(specifier==='@deepseek-ai/dsh-tools')return {url:'data:text/javascript,export const defineTool = x => x;',shortCircuit:true};return next(specifier,context);}});
const {installMemory}=await import('../lib/memory-tools.js');hook.deregister();
async function fixture(options={}){const dir=await mkdtemp(join(tmpdir(),'palace-tools-'));const store=new MemoryStore(join(dir,'cache.json'));
 const definitions=new Map(),denials=[],restrictions=[],prompts=[];let registrations=0,disposedScopes=0;const config={memory:{enabled:true}};
 let userId=0;const baseTime=Date.now()-1000,sessionLog=[];const setUser=(text,kind='user')=>{const time=baseTime+(++userId)*10;sessionLog.splice(0,sessionLog.length,{type:'turn/start',time,data:{turn:userId}},{id:'event-'+userId,type:'user/message',time:time+1,data:{id:'user-'+userId,source:{kind},content:[{type:'text',text}]}});};setUser('我偏爱中文交流');
 const agent={id:'one',session:{header:{agentPreset:'whale'},snapshotEvents:()=>sessionLog},ctx:{plugin(p){p.apply({tools:{restrict:r=>{denials.push(r.deny);restrictions.push(structuredClone(r));}},inject:(_services,fn)=>fn({systemPrompt:{section:p=>prompts.push(p.text)}})});return {dispose(){disposedScopes++;}};}}};
 const events=new Map();const ctx={tools:{register:d=>{registrations++;definitions.set(d.name,d);}},agents:{get:()=>agent,list:()=>[agent]},effect:fn=>fn(),on:(e,fn)=>{events.set(e,fn);return ()=>events.delete(e);}};
 const reconcile=installMemory(ctx,store,()=>config,options);
 return {store,agent,config,denials,restrictions,prompts,definitions,reconcile,events,sessionLog,setUser,get registrations(){return registrations;},get disposedScopes(){return disposedScopes;},call:(name,args={})=>definitions.get('dafeiyu_memory_'+name).execute(args,{agent})};
}
test('all palace tools use native exec.agent and are denied in standard mode or when memory is disabled',async()=>{
 const f=await fixture();await f.call('save',{spaceId:'owner',predicate:'回复语言',value:'中文',evidence:'我偏爱中文交流'});assert.equal((await f.call('search',{query:'中文'})).memories.length,1);
 f.agent.session.header.agentPreset='standard';f.reconcile();assert.equal(f.denials.at(-1).length,5);await assert.rejects(f.call('search',{query:'中文'}));await assert.rejects(f.call('index'));
 f.agent.session.header.agentPreset='whale';f.config.memory.enabled=false;f.reconcile();await assert.rejects(f.call('read',{id:'x'}));
});

test('model save is grounded in the current real user message and cannot claim manual provenance',async()=>{
 const f=await fixture();f.setUser('我叫小泽');
 f.sessionLog[0].time=1793198170878;f.sessionLog[1].time=1793198170932;
 const result=await f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽',source:{kind:'manual',sessionId:'another-session'},confirmed:true});
 assert.equal(result.status,'saved');assert.equal(result.saved.confirmed,false);assert.equal(result.saved.source.kind,'conversation');assert.equal(result.saved.source.sessionId,'one');assert.equal(result.saved.source.userEventId,'user-2');assert.equal(result.saved.source.evidence,'我叫小泽');
 assert.equal(result.saved.source.observedAt,new Date(1793198170932).toISOString());
 assert.match(result.saved.content,/称呼.*小泽/);assert.doesNotMatch(JSON.stringify(result),/another-session/);
 const duplicate=await f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'});
 assert.equal(duplicate.status,'merged');assert.equal(f.store.status().memoryCount,1);
 assert.equal(duplicate.saved.sources.length,1);
});

test('a late immediate save uses its original user-event time and cannot replace a newer fact',async()=>{
 const f=await fixture();f.setUser('我住在北京');f.sessionLog[0].time=Date.parse('2026-10-28T00:00:00Z');f.sessionLog[1].time=Date.parse('2026-10-28T00:00:01Z');
 await f.store.consolidate([{spaceId:'owner',subject:'用户',predicate:'居住城市',value:'杭州',evidence:'我住在杭州',content:'用户住在杭州'}],{sessionId:'later-session',userEventId:'later-user',userText:'我住在杭州',observedAt:'2026-10-28T00:01:00Z'});
 const late=await f.call('save',{spaceId:'owner',predicate:'居住城市',value:'北京',evidence:'我住在北京'});
 assert.equal(late.status,'skipped');assert.equal(late.saved,null);assert.deepEqual(f.store.search('居住城市').map(r=>r.value),['杭州']);
});

test('persisted DSH event shape retains the real user source despite later runtime-context events',async()=>{
 const f=await fixture();
 f.sessionLog.splice(0,f.sessionLog.length,
  {type:'turn/start',seq:4,time:1793198170878,data:{turn:1}},
  {type:'user/message',seq:8,time:1793198170932,data:{role:'user',id:'current-real-user',content:[{type:'text',text:'我叫小泽'}],source:{kind:'user'}}},
  {type:'user/message',seq:9,time:1793198170932,data:{role:'user',id:'runtime-source',content:[{type:'text',text:'内部上下文中的称呼是别的人'}],source:{kind:'runtime-context'}}},
  {type:'user/message',seq:11,time:1793198170933,data:{role:'user',id:'clock-source',content:[{type:'text',text:'内部时间说明'}],source:{kind:'time-context'}}}
 );
 const saved=(await f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'})).saved;
 assert.equal(saved.source.userEventId,'current-real-user');assert.equal(saved.source.observedAt,new Date(1793198170932).toISOString());assert.doesNotMatch(JSON.stringify(saved),/内部上下文|runtime-source|clock-source/);
});

test('a source without user-event time uses the stable turn time, and rejects a frame with no reliable time',async()=>{
 const f=await fixture();f.setUser('我叫小泽');delete f.sessionLog[1].time;
 const saved=(await f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'})).saved;
 assert.equal(saved.source.observedAt,new Date(f.sessionLog[0].time).toISOString());
 f.setUser('我住在北京');delete f.sessionLog[0].time;delete f.sessionLog[1].time;
 await assert.rejects(f.call('save',{spaceId:'owner',predicate:'居住城市',value:'北京',evidence:'我住在北京'}),/来源时间/);
 assert.equal(f.store.status().memoryCount,1);
});

test('model save rejects missing structure, unquoted values, previous turns and runtime context',async()=>{
 const f=await fixture();f.setUser('我叫小泽');
 await assert.rejects(f.call('save',{spaceId:'owner',content:'用户是工程师'}),/事实|证据|属性/);
 let result=await f.call('save',{spaceId:'owner',predicate:'职业',value:'工程师',evidence:'我叫小泽'});assert.equal(result.saved,null);
 f.setUser('今天想聊点别的');result=await f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'});assert.equal(result.saved,null);
 f.setUser('我叫小泽','runtime-context');await assert.rejects(f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'}),/用户消息/);
 f.setUser('我叫小泽');f.sessionLog.push({type:'turn/end',data:{reason:{kind:'completed'}}});await assert.rejects(f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'}),/当前|用户消息/);
 assert.equal(f.store.status().memoryCount,0);
});

test('QQ image and face enrichment cannot become immediate-save evidence while actual user text remains eligible',async()=>{
 const f=await fixture();f.setUser('');
 f.sessionLog[1].data.content=[{type:'text',text:'我喜欢喝咖啡',dafeiyuQQEnrichment:true},{type:'image',url:'data:image/png;base64,media'}];
 await assert.rejects(f.call('save',{spaceId:'owner',predicate:'饮品偏好',value:'咖啡',evidence:'我喜欢喝咖啡'}),/用户消息/);
 f.sessionLog[1].data.content.push({type:'text',text:'我叫小泽'});
 const rejected=await f.call('save',{spaceId:'owner',predicate:'饮品偏好',value:'咖啡',evidence:'我喜欢喝咖啡'});
 assert.equal(rejected.status,'skipped');
 const saved=await f.call('save',{spaceId:'owner',predicate:'称呼',value:'小泽',evidence:'我叫小泽'});
 assert.equal(saved.status,'saved');assert.equal(saved.saved.source.evidence,'我叫小泽');
 assert.equal(f.store.search('咖啡').length,0);assert.equal(f.store.status().memoryCount,1);
});

test('model save shares opt-out, temporary, hypothetical and secret filtering with background consolidation',async()=>{
 const f=await fixture();
 for(const text of ['别保存，我喜欢咖啡','风格验收，不保存本轮：我喜欢咖啡','假如我喜欢咖啡','我的密码是private-test-value，我喜欢咖啡']) {
  f.setUser(text);const result=await f.call('save',{spaceId:'owner',predicate:'饮品偏好',value:'咖啡',evidence:'我喜欢咖啡'});
  assert.equal(result.saved,null);assert.equal(result.status,'skipped');
 }
 assert.equal(f.store.status().memoryCount,0);
});

test('model corrections create the same provenance-preserving version chain as background facts',async()=>{
 const f=await fixture();f.setUser('我喜欢喝咖啡');
 const old=(await f.call('save',{spaceId:'owner',predicate:'饮品偏好',value:'咖啡',evidence:'我喜欢喝咖啡'})).saved;
 f.setUser('我不再喝咖啡，改喝茶');
 const next=(await f.call('save',{spaceId:'owner',predicate:'饮品偏好',value:'茶',evidence:'我不再喝咖啡，改喝茶',operation:'update'})).saved;
 assert.equal(next.supersedes,old.id);assert.equal(f.store.getRecord(old.id).status,'superseded');assert.deepEqual(f.store.search('饮品').map(r=>r.value),['茶']);
});

test('a queued model save rechecks mode at its actual storage admission',async()=>{
 const f=await fixture();let release;f.store.pending=new Promise(resolve=>{release=resolve;});
 const pending=f.call('save',{spaceId:'owner',predicate:'回复语言',value:'中文',evidence:'我偏爱中文交流'});
 f.agent.session.header.agentPreset='standard';release();
 await assert.rejects(pending,/鲸鱼娘/);assert.equal(f.store.status().memoryCount,0);
});

test('a queued model save cannot write from a superseded current-user frame',async()=>{
 const f=await fixture();let release;f.store.pending=new Promise(resolve=>{release=resolve;});
 const pending=f.call('save',{spaceId:'owner',predicate:'回复语言',value:'中文',evidence:'我偏爱中文交流'});
 f.setUser('今天聊点别的');release();
 await assert.rejects(pending,/用户消息已更新/);assert.equal(f.store.status().memoryCount,0);
});

test('self memory needs user-confirmed shared experience rather than role background',async()=>{
 const f=await fixture();f.setUser('你的蓝色尾巴很好看');
 const invented=await f.call('save',{spaceId:'self',predicate:'角色外形',value:'蓝色尾巴',evidence:'你的蓝色尾巴很好看'});assert.equal(invented.saved,null);
 f.setUser('我们一起完成了记忆宫殿');
 const shared=await f.call('save',{spaceId:'self',predicate:'共同完成的项目',value:'记忆宫殿',evidence:'我们一起完成了记忆宫殿'});
 assert.equal(shared.saved.spaceId,'self');assert.equal(shared.saved.subject,'共同经历');assert.equal(shared.saved.confirmed,false);
});
test('model read excludes management-only test records and follows corrections to the active fact',async()=>{
 const f=await fixture();const dummy=await f.store.put({spaceId:'self',content:'测试暗号：海盐饭团'});assert.equal(f.store.getRecord(dummy.id).testOnly,true);assert.deepEqual(await f.call('read',{id:dummy.id}),{found:false});
 const old=await f.store.put({spaceId:'owner',content:'用户住在北京',subject:'用户',predicate:'居住城市',value:'北京'});const recent=await f.store.put({spaceId:'owner',content:'用户住在上海',subject:'用户',predicate:'居住城市',value:'上海'});
 const read=await f.call('read',{id:old.id});assert.equal(read.id,recent.id);assert.equal(read.content,'用户住在上海');await f.call('forget',{id:recent.id});assert.deepEqual(await f.call('read',{id:old.id}),{found:false});
});

test('one tool registration resolves every operation to the current group member palace',async()=>{
 let selected;const f=await fixture({resolveStore:()=>selected});
 const dir=await mkdtemp(join(tmpdir(),'palace-group-member-'));const group=new MemoryStore(join(dir,'cache.json'));
 const privateFact=await f.store.put({spaceId:'owner',content:'用户住在北京',subject:'用户',predicate:'居住城市',value:'北京'});
 const groupFact=await group.put({spaceId:'owner',content:'用户喜欢咖啡',subject:'用户',predicate:'饮品偏好',value:'咖啡'});
 selected=group;f.agent.session.header.agentPreset='whale-group';f.reconcile();
 assert.equal(f.registrations,5);assert.equal(f.definitions.size,5);
 assert.deepEqual((await f.call('search')).memories.map(x=>x.id),[groupFact.id]);
 assert.equal((await f.call('read',{id:privateFact.id})).found,false);
 assert.equal((await f.call('index')).spaces.find(x=>x.id==='owner').count,1);
 f.setUser('我住在上海');const saved=await f.call('save',{spaceId:'owner',predicate:'居住城市',value:'上海',evidence:'我住在上海'});
 assert.equal(saved.status,'saved');assert.equal(group.search('上海').length,1);assert.equal(f.store.search('上海').length,0);
 await f.call('forget',{id:groupFact.id});assert.equal(group.getRecord(groupFact.id),null);assert.ok(f.store.getRecord(privateFact.id));
 assert.match(f.prompts.at(-1),/当前群|当前成员/);assert.doesNotMatch(f.prompts.at(-1),/我眼里的主人/);
});

test('an unknown group member mapping denies all memory operations and guidance without falling back to owner',async()=>{
 const f=await fixture({resolveStore:()=>undefined});f.agent.session.header.agentPreset='whale-group';f.reconcile();
 assert.deepEqual(f.restrictions.at(-1),{allow:[]});assert.equal(f.prompts.length,0);
 for(const [name,args] of [['search',{}],['index',{}],['read',{id:'private'}],['forget',{id:'private'}],['save',{spaceId:'owner',predicate:'回复语言',value:'中文',evidence:'我偏爱中文交流'}]])await assert.rejects(f.call(name,args),/记忆空间|鲸鱼娘/);
 const unconfigured=await fixture();unconfigured.agent.session.header.agentPreset='whale-group';unconfigured.reconcile();
 await assert.rejects(unconfigured.call('search'),/记忆空间|鲸鱼娘/);
});

test('ready group extra tools survive memory disable while unresolved or revoked mappings stay closed',async()=>{
 let selected;const extras=['dafeiyu_qq_stickers','dafeiyu_qq_sticker'];
 const f=await fixture({resolveStore:()=>selected,additionalGroupTools:extras});f.agent.session.header.agentPreset='whale-group';f.reconcile();
 assert.deepEqual(f.restrictions.at(-1),{allow:[]});
 selected=f.store;f.reconcile();
 assert.equal(f.registrations,5);assert.deepEqual(f.restrictions.at(-1).allow,[...f.definitions.keys(),...extras]);
 f.config.memory.enabled=false;f.reconcile();
 assert.deepEqual(f.restrictions.at(-1),{allow:extras});await assert.rejects(f.call('search'),/记忆已关闭/);
 selected=undefined;f.reconcile();assert.deepEqual(f.restrictions.at(-1),{allow:[]});
 f.config.memory.enabled=true;f.reconcile();assert.deepEqual(f.restrictions.at(-1),{allow:[]});
 selected=f.store;f.agent.session.header.parentSession='other';f.reconcile();assert.deepEqual(f.restrictions.at(-1),{allow:[]});
});

test('an unresolved group denies inherited capabilities until a ready member mapping installs the five-tool allowlist',async()=>{
 let selected;const f=await fixture({resolveStore:()=>selected});f.agent.session.header.agentPreset='whale-group';f.reconcile();
 assert.deepEqual(f.restrictions.at(-1),{allow:[]});await assert.rejects(f.call('search'),/记忆空间/);
 const before=f.disposedScopes;selected=f.store;f.reconcile();
 assert.equal(f.disposedScopes,before+1);
 assert.deepEqual(f.restrictions.at(-1),{allow:['dafeiyu_memory_search','dafeiyu_memory_save','dafeiyu_memory_forget','dafeiyu_memory_index','dafeiyu_memory_read']});
 assert.equal(f.restrictions.at(-1).allow.includes('qqbot_send_file'),false);assert.equal(f.restrictions.at(-1).allow.includes('working_directory'),false);
 assert.deepEqual((await f.call('search')).memories,[]);assert.equal(f.registrations,5);
 selected=undefined;f.reconcile();assert.deepEqual(f.restrictions.at(-1),{allow:[]});await assert.rejects(f.call('index'),/记忆空间/);
});

test('a queued save and forget cannot commit after the resolved member store changes',async()=>{
 for(const operation of ['save','forget']){
  let selected;const f=await fixture({resolveStore:()=>selected});selected=f.store;
  const record=await f.store.put({spaceId:'owner',content:'用户喜欢咖啡',subject:'用户',predicate:'饮品偏好',value:'咖啡'});
  let release;f.store.pending=new Promise(resolve=>{release=resolve;});
  const pending=operation==='save'?f.call('save',{spaceId:'owner',predicate:'回复语言',value:'中文',evidence:'我偏爱中文交流'}):f.call('forget',{id:record.id});
  selected=undefined;release();await assert.rejects(pending,/记忆空间/);
  assert.equal(f.store.status().memoryCount,1);assert.ok(f.store.getRecord(record.id));
 }
});
