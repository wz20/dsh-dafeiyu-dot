import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeechDelivery, deliverySource, supportsVoiceDirection, voiceDirection} from '../lib/speech-delivery.js';

function host(stream) {
  const agent={id:'session-1',session:{header:{agentPreset:'whale'},snapshotEvents:()=>[]}};
  return {agent,agents:{get:id=>id===agent.id?agent:undefined},llm:{stream},sessionController:{resolveAgent:async()=>({error:true}),agents:{selectionFor:()=>({current:{provider:'selected-provider',model:'selected-model',reasoningEffort:'high'}})}}};
}
const complete = async function* (emotion='soothing') {
  yield {type:'text-delta',index:0,text:JSON.stringify({emotion})};
  yield {type:'finish',reason:{kind:'stop'}};
};

test('delivery uses the current session model, retains stage cues as data and never calls tools or edits dialogue',async()=>{
  const calls=[];const ctx=host(async function*(options){calls.push(options);yield* complete('concerned');});
  const plan=createSpeechDelivery(ctx);
  const result=await plan('（尾巴慢慢卷了一下）唔，主人还好吗？<think>秘密</think>```js\n内部程序\n```',{sessionId:'session-1'});
  assert.equal(result.mode,'model');assert.equal(result.emotion,'concerned');assert.match(result.instructions,/担忧/);
  assert.equal(calls[0].provider,'selected-provider');assert.equal(calls[0].model,'selected-model');assert.equal(calls[0].reasoningEffort,'high');
  assert.equal(calls[0].sessionId,'session-1');assert.deepEqual(calls[0].tools,[]);
  assert.match(calls[0].messages[0].content[0].text,/尾巴慢慢卷了一下/);assert.doesNotMatch(calls[0].messages[0].content[0].text,/秘密|内部程序/);
  assert.doesNotMatch(result.instructions,/尾巴|秘密|主人还好吗/);
});

test('preview uses a warm direction without a conversation model; replay caches only valid plans for ten minutes',async()=>{
  let calls=0,now=0;const ctx=host(async function*(){calls++;yield* complete('joyful');});
  const plan=createSpeechDelivery(ctx,{now:()=>now});
  assert.equal((await plan('你好',{preview:true})).emotion,'warm');assert.equal(calls,0);
  assert.equal((await plan('好开心呀',{sessionId:'session-1'})).emotion,'joyful');
  await plan('好开心呀',{sessionId:'session-1'});assert.equal(calls,1);
  now=600001;await plan('好开心呀',{sessionId:'session-1'});assert.equal(calls,2);
});

test('invalid, incomplete, oversized and tool-producing model results retain an explicit warm fallback',async()=>{
  const outputs=[
    [{type:'text-delta',text:'{"emotion":"joyful","instructions":"换音色"}'},{type:'finish',reason:{kind:'stop'}}],
    [{type:'text-delta',text:'{"emotion":"angry"}'},{type:'finish',reason:{kind:'stop'}}],
    [{type:'text-delta',text:'{"emotion":"warm"}'}],
    [{type:'text-delta',text:'{"emotion":"warm"}'},{type:'finish',reason:{kind:'length'}}],
    [{type:'tool-call-delta'}], [{type:'text-delta',text:'a'.repeat(2049)}],
  ];
  for(const chunks of outputs) {
    const plan=createSpeechDelivery(host(async function*(){yield* chunks;}));
    const result=await plan('你好呀',{sessionId:'session-1'});
    assert.equal(result.mode,'natural-fallback');assert.equal(result.emotion,'warm');assert.match(result.instructions,/温暖/);assert.doesNotMatch(result.instructions,/换音色/);
  }
});

test('an active direction request is cancelled and cannot enter the cache',async()=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});let calls=0;
  const ctx=host(async function*({signal}){calls++;entered();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
  const controller=new AbortController(),plan=createSpeechDelivery(ctx);
  const pending=plan('你好呀',{sessionId:'session-1',signal:controller.signal});await ready;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  ctx.llm.stream=async function*(){calls++;yield* complete('warm');};
  assert.equal((await plan('你好呀',{sessionId:'session-1'})).mode,'model');assert.equal(calls,2);
});

test('capabilities are explicit per engine and direction text cannot contain model-provided prose',()=>{
  assert.equal(supportsVoiceDirection({source:'local',model:'audiocpp'}),true);
  assert.equal(supportsVoiceDirection({source:'api',model:'audiocpp'}),false);
  assert.equal(supportsVoiceDirection({source:'local',model:'other'}),false);
  assert.throws(()=>voiceDirection('invented'));
  assert.throws(()=>voiceDirection('__proto__'));
  assert.equal(deliverySource('（有些失落）嗯。[资料](https://example.com) `程序`'), '（有些失落）嗯。资料');
});

test('preview selects a bounded emotion while ordinary replies ignore caller-provided emotion',async()=>{
  let calls=0;const plan=createSpeechDelivery(host(async function*(){calls++;yield* complete('concerned');}));
  assert.equal((await plan('你好呀',{preview:true,previewEmotion:'playful'})).emotion,'playful');assert.equal(calls,0);
  assert.equal((await plan('你好呀',{sessionId:'session-1',previewEmotion:'joyful'})).emotion,'concerned');assert.equal(calls,1);
  assert.equal((await plan('你好呀',{sessionId:'session-1',preview:'true',previewEmotion:'joyful'})).emotion,'concerned');assert.equal(calls,1);
});

test('standard sessions and a mode change during emotion inference cannot fall back into speech',async()=>{
  const ctx=host(async function*(){ctx.agent.session.header.agentPreset='standard';yield* complete('warm');});
  const plan=createSpeechDelivery(ctx);
  await assert.rejects(plan('你好呀',{sessionId:'session-1'}),e=>e.status===409);
  await assert.rejects(plan('你好呀',{sessionId:'session-1'}),e=>e.status===409);
  await assert.rejects(plan('你好呀',{sessionId:'missing'}),e=>e.status===404);
});

test('a slow emotion model times out into natural speech while cancelling its request',async()=>{
  let cancelled=false;
  const ctx=host(async function*({signal}){
    await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}));
  });
  const keepAlive=setTimeout(()=>{},1000);
  try {
    const result=await createSpeechDelivery(ctx,{timeoutMs:5})('你好呀',{sessionId:'session-1'});
    assert.equal(result.mode,'natural-fallback');assert.equal(result.emotion,'warm');assert.equal(cancelled,true);
  } finally {clearTimeout(keepAlive);}
});

test('ordinary neutral plans keep a warm companion baseline while explicit calm previews remain available',async()=>{
  const plan=createSpeechDelivery(host(async function*(){yield* complete('neutral');}));
  const reply=await plan('我把项目名称记住了。',{sessionId:'session-1'});
  assert.equal(reply.mode,'model');assert.equal(reply.emotion,'warm');assert.match(reply.instructions,/温暖/);
  assert.equal((await plan('我把项目名称记住了。',{preview:true,previewEmotion:'neutral'})).emotion,'neutral');
});

test('distinct valid emotions survive the companion baseline and failures are retried on the next reply',async()=>{
  let calls=0;
  const ctx=host(async function*(){calls++;yield {type:'text-delta',text:'invalid'};yield {type:'finish',reason:{kind:'stop'}};});
  const plan=createSpeechDelivery(ctx);
  assert.equal((await plan('我在这里呢。',{sessionId:'session-1'})).emotion,'warm');
  ctx.llm.stream=async function*(){calls++;yield* complete('soothing');};
  assert.equal((await plan('我在这里呢。',{sessionId:'session-1'})).emotion,'soothing');assert.equal(calls,2);
  for(const emotion of ['joyful','playful','concerned','apologetic','sad']){
    ctx.llm.stream=async function*(){yield* complete(emotion);};
    assert.equal((await plan('这句话的心情是'+emotion,{sessionId:'session-1'})).emotion,emotion);
  }
});
