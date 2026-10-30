import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const hook=registerHooks({resolve(name,ctx,next){return name==='@deepseek-ai/dsh-tools'?{url:'data:text/javascript,export const defineTool=x=>x;',shortCircuit:true}:next(name,ctx);}});
const {installSinging}=await import('../lib/singing-tools.js');hook.deregister();

test('singing tool renders the real result, combines source cancellation, and is scoped to whale mode',async()=>{
 let argumentsSeen,signalSeen;const definitions=new Map();const denials=[],guidance=[];
 const agent={id:'one',session:{header:{agentPreset:'whale'},snapshotEvents:()=>[]},ctx:{plugin(p){p.apply({tools:{restrict:r=>denials.push(r.deny)},inject:(_deps,fn)=>fn({systemPrompt:{section:s=>guidance.push(s.text)}})});return {dispose(){}};}}};
 const events=new Map();const ctx={tools:{register:d=>definitions.set(d.name,d)},agents:{list:()=>[agent],get:()=>agent},effect:fn=>fn(),on:(name,fn)=>{events.set(name,fn);return ()=>{};}};
 const source=new AbortController(),turn=new AbortController();
 const result={songId:'01a186a2-e576-4b43-82eb-2df0217eee08',title:'小星星',status:'ready'};
 installSinging(ctx,{listReferences:async()=>({references:[{id:'twinkle',song:'小星星',availableForCurrentVoice:true}]}),generate:async(args,{signal})=>{argumentsSeen=args;signalSeen=signal;return result;}},{sourceSignal:()=>source.signal});
 const definition=definitions.get('dafeiyu_sing');
 assert.match(guidance[0],/用户确认的现成音频/);assert.match(guidance[0],/用户要求你唱歌时必须调用/);
 assert.equal(definition.parameters.lyrics,undefined);assert.equal(definition.parameters.mode,undefined);assert.equal(definition.parameters.song.required,undefined);
 const catalog=definitions.get('dafeiyu_singing_references');assert.equal((await catalog.execute({}, {agent})).references[0].id,'twinkle');const args={song:'小星星'};
 assert.deepEqual(await definition.execute(args,{agent,signal:turn.signal}),result);assert.deepEqual(argumentsSeen,{...args,mode:'recorded'});
 await definition.execute({}, {agent,signal:turn.signal});assert.deepEqual(argumentsSeen,{mode:'recorded'});
 assert.equal(JSON.parse(definition.output.render(args,result)[0].text).songId,result.songId);
 source.abort();assert.equal(signalSeen.aborted,true);
 agent.session.header.agentPreset='standard';events.get('agent-preset/selected')('one');assert.deepEqual(denials.at(-1),['dafeiyu_sing','dafeiyu_singing_references']);
 await assert.rejects(definition.execute(args,{agent}),/鲸鱼娘/);await assert.rejects(catalog.execute({}, {agent}),/鲸鱼娘/);
});
