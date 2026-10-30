import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(name,ctx,next){return name==='@deepseek-ai/dsh-tools'?{url:'data:text/javascript,export const defineTool=x=>x;',shortCircuit:true}:next(name,ctx);}});
const loaded=await import('../lib/qq-sticker-tools.js').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});hook.deregister();
function fixture() {
 assert.equal(typeof loaded.installQQStickerTools,'function','source-bound sticker tools must be available');
 const definitions=new Map(),calls=[],prompts=[],restrictions=[],events=new Map();let disposed=0;
 const makeAgent=(id,preset='whale',parentSession)=>({id,session:{header:{agentPreset:preset,...parentSession?{parentSession}:{}},snapshotEvents:()=>[]},ctx:{plugin(plugin){plugin.apply({tools:{restrict:value=>restrictions.push({id,...value})},inject:(_deps,fn)=>fn({systemPrompt:{section:value=>prompts.push({id,...value})}})});return {dispose(){disposed++;}};}}});
 const agents=new Map(['private','group','standard'].map((id,i)=>[id,makeAgent(id,['whale','whale-group','standard'][i])]));
 const ctx={tools:{register:d=>definitions.set(d.name,d)},agents:{list:()=>[...agents.values()],get:id=>agents.get(id)},on:(name,fn)=>{events.set(name,fn);return ()=>events.delete(name);},effect:fn=>fn()};
 const catalog=[{id:'warm',title:'本鱼在呢',emotion:'warm',tags:['陪伴']}],receipt={status:'queued',stickerId:'warm',summary:'本鱼在呢'};
 const qq={stickerCatalog:async agent=>{calls.push({kind:'catalog',agent});return {stickers:catalog};},chooseSticker:async(agent,stickerId)=>{calls.push({kind:'choose',agent,stickerId});return receipt;}};
 loaded.installQQStickerTools(ctx,qq);
 return {definitions,calls,prompts,restrictions,events,agents,makeAgent,receipt,get disposed(){return disposed;}};
}

test('sticker tools bind real exec.agent and return only the current-turn queued receipt',async()=>{
 const f=fixture();assert.deepEqual([...loaded.QQ_STICKER_TOOLS],['dafeiyu_qq_stickers','dafeiyu_qq_sticker']);
 const catalog=f.definitions.get('dafeiyu_qq_stickers'),choose=f.definitions.get('dafeiyu_qq_sticker');
 for(const agent of [f.agents.get('private'),f.agents.get('group')]){
  assert.equal((await catalog.execute({}, {agent})).stickers[0].id,'warm');assert.deepEqual(await choose.execute({stickerId:'warm'},{agent}),f.receipt);assert.equal(f.calls.at(-1).agent,agent);assert.equal(f.calls.at(-1).stickerId,'warm');
 }
 const rendered=JSON.parse(choose.output.render({},f.receipt)[0].text);assert.equal(rendered.status,'queued');assert.equal(rendered.stickerId,'warm');assert.equal(rendered.sent,undefined);
 assert.deepEqual(Object.keys(choose.parameters),['stickerId']);assert.equal(choose.parameters.stickerId.required,true);
});

test('recipient, URL, path and unexpected arguments are rejected before QQ admission',async()=>{
 const f=fixture(),choose=f.definitions.get('dafeiyu_qq_sticker'),catalog=f.definitions.get('dafeiyu_qq_stickers'),agent=f.agents.get('private');
 for(const args of [{stickerId:'warm',userId:'12345'},{stickerId:'warm',groupId:'12345'},{stickerId:'warm',url:'https://example.com/a.png'},{stickerId:'warm',path:'/private/a.png'},{stickerId:'warm',agent:f.agents.get('group')},null,[],{stickerId:''},{stickerId:'../warm'},{stickerId:'https://example.com/a.png'}])await assert.rejects(choose.execute(args,{agent}));
 await assert.rejects(catalog.execute({userId:'12345'},{agent}));assert.equal(f.calls.length,0);
});

test('standard or nested agents are denied and mode scope guidance is released on transitions',async()=>{
 const f=fixture(),tool=f.definitions.get('dafeiyu_qq_sticker');
 assert.equal(f.prompts.length,2);for(const prompt of f.prompts){assert.match(prompt.text,/QQ/);assert.match(prompt.text,/一张/);assert.match(prompt.text,/送达/);}
 assert.deepEqual(f.restrictions.find(x=>x.id==='standard').deny,[...loaded.QQ_STICKER_TOOLS]);
 await assert.rejects(tool.execute({stickerId:'warm'},{agent:f.agents.get('standard')}));await assert.rejects(tool.execute({stickerId:'warm'},{agent:f.makeAgent('child','whale','parent')}));assert.equal(f.calls.length,0);
 const privateAgent=f.agents.get('private');privateAgent.session.header.agentPreset='standard';f.events.get('agent-preset/selected')('private');assert.ok(f.disposed>=1);assert.deepEqual(f.restrictions.at(-1).deny,[...loaded.QQ_STICKER_TOOLS]);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(tool.execute({stickerId:'warm'},{agent:f.agents.get('group'),signal:cancelled.signal}),{name:'AbortError'});assert.equal(f.calls.length,0);
});
