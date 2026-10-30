import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech, cleanSpeechText, validateRecording } from '../lib/speech.js';
import { voiceDirection } from '../lib/speech-delivery.js';

const config = () => ({tts:{source:'local',localUrl:'http://127.0.0.1:3900/v1',localModel:'audiocpp',localVoice:'fixture-voice',apiUrl:'https://tts.example/v1',apiModel:'test-tts',apiVoice:'fish'}});
function wav(seconds=0.1, sampleRate=16000, channels=1) {
  const size=Math.round(seconds*sampleRate)*channels*2, b=Buffer.alloc(44+size);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(sampleRate,24);b.writeUInt32LE(sampleRate*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);return b;
}
const json = data => new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function registry(phase='ready') {
  const calls=[];let state=phase;
  return {calls,setPhase:p=>{state=p;},snapshot:()=>({providers:[{id:'sensevoice-local',name:'SenseVoiceSmall',languages:['zh','auto'],preparation:{phase:state}}],selection:{providerId:'sensevoice-local',language:'auto'}}),
    resolve:input=>{calls.push(['resolve',input]);return {pinned:true,...input};},transcribe:async (spec,signal)=>{calls.push(['transcribe',spec,signal]);return {text:'主人，下午好。'};},prepare:id=>{calls.push(['prepare',id]);state='ready';}};
}
function context(speech) {return {get:key=>key==='speechToText'?speech:undefined};}
function whaleContext() {
  const agents=new Map(['session-1','session-2'].map(id=>[id,{id,session:{header:{agentPreset:'whale'},snapshotEvents:()=>[]}}]));
  return {agents:{get:id=>agents.get(id)}};
}

test('Chinese speech removes code, links, Latin prose, actions and hidden reasoning',()=>{
  const text='主人，Hello 大肥鱼在这里。\n```js\nconsole.log("秘密")\n```\n`内部变量`（摇尾巴）*歪头* [文档](https://example.com) https://example.com/test <think>隐私推理</think> 123！';
  const cleaned=cleanSpeechText(text);
  assert.match(cleaned,/主人/);assert.match(cleaned,/大肥鱼在这里/);assert.match(cleaned,/文档/);assert.match(cleaned,/123/);
  assert.doesNotMatch(cleaned,/Hello|console|内部变量|摇尾巴|歪头|https|秘密|隐私推理|[A-Za-z<>`*]/);
  assert.equal(cleanSpeechText('English only ```中文代码```'), '');
});

test('nested, multiline and unfinished stage directions never become spoken dialogue',()=>{
  assert.equal(cleanSpeechText('（尾巴摇了摇（很开心））主人，你回来啦。'),'主人，你回来啦。');
  assert.equal(cleanSpeechText('（微笑[轻轻点头]）主人，听你说呢。'),'主人，听你说呢。');
  assert.equal(cleanSpeechText('*轻轻靠近\n小声地说*主人，别急呀。'),'主人，别急呀。');
  assert.equal(cleanSpeechText('主人，你好呀。（尾巴卷起来'),'主人，你好呀。');
  assert.equal(cleanSpeechText('* 第一条事情。\n* 第二条事情。'),'第一条事情。第二条事情。');
});

test('emotion can be disabled while keeping the saved model and voice without a direction request',async()=>{
  const cfg=config();cfg.tts.emotional=false;let plans=0,body;
  const speech=createSpeech({},()=>cfg,{planDelivery:async()=>{plans++;throw Error('must not plan');},fetch:async(_url,init)=>{body=JSON.parse(init.body);return new Response(wav());}});
  const result=await speech.synthesize('主人，你好呀。',{preview:true,previewEmotion:'joyful'});
  assert.equal(plans,0);assert.equal(body.voice,'fixture-voice');assert.equal(body.model,'audiocpp');assert.equal(body.instructions,undefined);
  assert.equal(result.delivery.mode,'disabled');
});

test('preview emotions and expression styles use controlled instructions, and preparation time covers the full response',async()=>{
  let time=100,body;const cfg=config();cfg.tts.expressiveness='gentle';
  const speech=createSpeech({},()=>cfg,{now:()=>time,fetch:async(_url,init)=>{time=175;body=JSON.parse(init.body);return new Response(wav());}});
  const result=await speech.synthesize('主人，你回来啦。',{preview:true,previewEmotion:'joyful'});
  assert.equal(result.delivery.emotion,'joyful');assert.equal(result.delivery.preparationMs,75);assert.match(body.instructions,/开心/);assert.match(body.instructions,/轻微/);assert.equal(body.guidance_scale,4);
  await assert.rejects(speech.synthesize('主人你好。',{preview:true,previewEmotion:'untrusted'}),e=>e.status===400);
});

test('local synthesis sends only cleaned Chinese to the explicit saved voice and returns real WAV bytes',async()=>{
  const calls=[];const audio=wav();
  const speech=createSpeech({},config,{now:()=>0,fetch:async(url,init)=>{calls.push({url,init});return new Response(audio,{headers:{'content-type':'audio/wav'}});}});
  const result=await speech.synthesize('主人，Hello（微笑）你好。',{preview:true});
  assert.equal(calls[0].url,'http://127.0.0.1:3900/v1/audio/speech');
  assert.deepEqual(JSON.parse(calls[0].init.body),{model:'audiocpp',voice:'fixture-voice',input:'主人，你好。',language:'zh',response_format:'wav',instructions:voiceDirection('warm'),guidance_scale:4});
  assert.equal(calls[0].init.headers.authorization,undefined);assert.deepEqual(result,{audio,mime:'audio/wav',delivery:{mode:'preview',emotion:'warm',cached:false,preparationMs:0}});
});

test('emotion instructions reach Breeze separately from dialogue and the saved voice stays selected',async()=>{
  let body,source;
  const speech=createSpeech(whaleContext(),config,{now:()=>0,planDelivery:async(text,options)=>{source={text,options};return {mode:'model',emotion:'soothing',instructions:voiceDirection('soothing')};},fetch:async(_url,init)=>{body=JSON.parse(init.body);return new Response(wav());}});
  const result=await speech.synthesize('（轻轻拍背）主人，先歇会儿吧。',{sessionId:'session-1'});
  assert.equal(source.options.sessionId,'session-1');assert.match(source.text,/轻轻拍背/);
  assert.equal(body.input,'主人，先歇会儿吧。');assert.equal(body.voice,'fixture-voice');assert.match(body.instructions,/安抚/);assert.equal(body.guidance_scale,4);
  assert.deepEqual(result.delivery,{mode:'model',emotion:'soothing',cached:false,preparationMs:0});
});

test('neutral and failed model planning both reach the saved voice with warm delivery and honest modes',async()=>{
  for(const [output,mode] of [['{"emotion":"neutral"}','model'],['invalid','natural-fallback']]){
    const cfg=config();cfg.tts.autoRead=false;cfg.tts.expressiveness='vivid';const ctx=whaleContext();let body;
    ctx.sessionController={agents:{selectionFor:()=>({current:{provider:'test-provider',model:'test-model'}})}};
    ctx.llm={stream:async function*(){yield {type:'text-delta',text:output};yield {type:'finish',reason:{kind:'stop'}};}};
    const speech=createSpeech(ctx,()=>cfg,{fetch:async(_url,init)=>{body=JSON.parse(init.body);return new Response(wav());}});
    const result=await speech.synthesize('我把项目名称记住啦。',{sessionId:'session-1'});
    assert.equal(result.delivery.mode,mode);assert.equal(result.delivery.emotion,'warm');
    assert.equal(body.voice,'fixture-voice');assert.equal(body.input,'我把项目名称记住啦。');
    assert.match(body.instructions,/温暖/);assert.match(body.instructions,/鲜明/);assert.equal(body.guidance_scale,4);
    assert.equal(cfg.tts.autoRead,false);
  }
});

test('normal replay reuses verified audio for five minutes while preview always generates',async()=>{
  let time=0,calls=0;const cfg=config();cfg.tts.emotional=false;
  const ctx=whaleContext(),speech=createSpeech(ctx,()=>cfg,{now:()=>time,fetch:async()=>{calls++;return new Response(wav());}});
  const first=await speech.synthesize('主人，慢慢来。',{sessionId:'session-1'});
  const replay=await speech.synthesize('主人，慢慢来。',{sessionId:'session-1'});
  assert.equal(calls,1);assert.equal(first.delivery.cached,false);assert.equal(replay.delivery.cached,true);assert.deepEqual(first.audio,replay.audio);
  await speech.synthesize('主人，慢慢来。',{preview:true});await speech.synthesize('主人，慢慢来。',{preview:true});assert.equal(calls,3);
  await speech.synthesize('主人，慢慢来。',{sessionId:'session-2'});assert.equal(calls,4);
  cfg.tts.localVoice='another-voice';await speech.synthesize('主人，慢慢来。',{sessionId:'session-1'});assert.equal(calls,5);
  time=300001;await speech.synthesize('主人，慢慢来。',{sessionId:'session-1'});assert.equal(calls,6);
  ctx.agents.get('session-1').session.header.agentPreset='standard';
  await assert.rejects(speech.synthesize('主人，慢慢来。',{sessionId:'session-1'}),e=>e.status===409);assert.equal(calls,6);
});

test('speech pace transforms shared delivery audio once and a pace change invalidates replay cache',async()=>{
  const cfg=config();cfg.tts.speed=1.15;cfg.tts.emotional=false;
  const original=wav(.2),faster=wav(.1),processed=[];let requests=0,body;
  const speech=createSpeech(whaleContext(),()=>cfg,{fetch:async(_url,init)=>{requests++;body=JSON.parse(init.body);return new Response(original);},adjustSpeed:async(audio,speed,options)=>{processed.push({audio,speed,options});return faster;}});
  const a=await speech.synthesize('本鱼在这儿呀。',{sessionId:'session-1'});
  assert.deepEqual(a.audio,faster);assert.equal(a.delivery.speed,1.15);
  assert.equal(processed.length,1);assert.deepEqual(processed[0].audio,original);assert.equal(processed[0].speed,1.15);
  assert.equal(body.speed,undefined);
  assert.equal((await speech.synthesize('本鱼在这儿呀。',{sessionId:'session-1'})).delivery.cached,true);assert.equal(processed.length,1);
  cfg.tts.speed=1.25;await speech.synthesize('本鱼在这儿呀。',{sessionId:'session-1'});assert.equal(processed.length,2);assert.equal(requests,2);
  cfg.tts.speed=1;const normal=await speech.synthesize('本鱼在这儿呀。',{sessionId:'session-1'});assert.deepEqual(normal.audio,original);assert.equal(processed.length,2);
});

test('cancelled or invalid pace processing never returns or caches audio',async()=>{
  const cfg=config();cfg.tts.speed=1.15;cfg.tts.emotional=false;let transforms=0;
  const cancel=new AbortController();
  const speech=createSpeech(whaleContext(),()=>cfg,{fetch:async()=>new Response(wav()),adjustSpeed:async()=>{transforms++;if(transforms===1)cancel.abort();return transforms===2?Buffer.from('invalid'):wav();}});
  await assert.rejects(speech.synthesize('你好呀。',{sessionId:'session-1',signal:cancel.signal}),{name:'AbortError'});
  await assert.rejects(speech.synthesize('你好呀。',{sessionId:'session-1'}),/WAV/);
  assert.equal((await speech.synthesize('你好呀。',{sessionId:'session-1'})).delivery.cached,false);assert.equal(transforms,3);
});

test('replay cache separates the actual emotion instructions and expression setting',async()=>{
  let calls=0;const cfg=config();
  const speech=createSpeech(whaleContext(),()=>cfg,{planDelivery:async()=>({mode:'model',emotion:'warm',instructions:voiceDirection('warm')}),fetch:async()=>{calls++;return new Response(wav());}});
  await speech.synthesize('主人，你好呀。',{sessionId:'session-1'});await speech.synthesize('主人，你好呀。',{sessionId:'session-1'});assert.equal(calls,1);
  cfg.tts.expressiveness='gentle';await speech.synthesize('主人，你好呀。',{sessionId:'session-1'});assert.equal(calls,2);
  cfg.tts.emotional=false;await speech.synthesize('主人，你好呀。',{sessionId:'session-1'});assert.equal(calls,3);
});

test('replay cache is bounded by both eight entries and sixteen MiB',async()=>{
  const cfg=config();cfg.tts.emotional=false;let calls=0;
  const speech=createSpeech(whaleContext(),()=>cfg,{fetch:async()=>{calls++;return new Response(wav());}});
  for(let n=0;n<9;n++)await speech.synthesize('第'+n+'句台词。',{sessionId:'session-1'});
  await speech.synthesize('第8句台词。',{sessionId:'session-1'});assert.equal(calls,9);
  await speech.synthesize('第0句台词。',{sessionId:'session-1'});assert.equal(calls,10);
  calls=0;const big=wav(100),bounded=createSpeech(whaleContext(),()=>cfg,{fetch:async()=>{calls++;return new Response(big);}});
  for(let n=0;n<6;n++)await bounded.synthesize('第'+n+'句台词。',{sessionId:'session-1'});
  await bounded.synthesize('第5句台词。',{sessionId:'session-1'});assert.equal(calls,6);
  await bounded.synthesize('第0句台词。',{sessionId:'session-1'});assert.equal(calls,7);
});

test('incomplete WAV data and a mode change during generation never enter the replay cache',async()=>{
  const cfg=config();cfg.tts.emotional=false;const ctx=whaleContext();let calls=0;
  const speech=createSpeech(ctx,()=>cfg,{fetch:async()=>{calls++;if(calls===1)return new Response(wav().subarray(0,48));if(calls===2)ctx.agents.get('session-1').session.header.agentPreset='standard';return new Response(wav());}});
  await assert.rejects(speech.synthesize('主人，你好呀。',{sessionId:'session-1'}),e=>e.status===502);
  await assert.rejects(speech.synthesize('主人，你好呀。',{sessionId:'session-1'}),e=>e.status===409);
  ctx.agents.get('session-1').session.header.agentPreset='whale';
  assert.equal((await speech.synthesize('主人，你好呀。',{sessionId:'session-1'})).delivery.cached,false);assert.equal(calls,3);
  assert.equal((await speech.synthesize('主人，你好呀。',{sessionId:'session-1'})).delivery.cached,true);assert.equal(calls,3);
});

test('a cancelled normal synthesis cannot populate the replay cache',async()=>{
  const cfg=config();cfg.tts.emotional=false;let calls=0;
  const cancelled=new AbortController();
  const speech=createSpeech(whaleContext(),()=>cfg,{fetch:async()=>{calls++;if(calls===1)cancelled.abort();return new Response(wav());}});
  await assert.rejects(speech.synthesize('主人，慢慢来。',{sessionId:'session-1',signal:cancelled.signal}),{name:'AbortError'});
  assert.equal((await speech.synthesize('主人，慢慢来。',{sessionId:'session-1'})).delivery.cached,false);assert.equal(calls,2);
  assert.equal((await speech.synthesize('主人，慢慢来。',{sessionId:'session-1'})).delivery.cached,true);assert.equal(calls,2);
});

test('API synthesis obtains the key through the host credential service',async()=>{
  const cfg=config();cfg.tts.source='api';const calls=[];let ref;
  const speech=createSpeech({credentials:{resolve:async x=>{ref=x;return {value:'test-private-key'};}}},()=>cfg,{credentialRef:name=>({name}),fetch:async(url,init)=>{calls.push({url,init});return new Response(wav(),{headers:{'content-type':'audio/wav'}});}});
  await speech.synthesize('你好。',{preview:true});
  assert.deepEqual(ref,{name:'DAFEIYU_TTS_API_KEY'});assert.equal(calls[0].url,'https://tts.example/v1/audio/speech');assert.equal(calls[0].init.headers.authorization,'Bearer test-private-key');
  assert.equal(JSON.parse(calls[0].init.body).instructions,undefined);
});

test('missing credentials and unusable text fail before networking',async()=>{
  let calls=0;const cfg=config();cfg.tts.source='api';
  const speech=createSpeech({credentials:{resolve:async()=>undefined}},()=>cfg,{credentialRef:x=>x,fetch:async()=>{calls++;}});
  await assert.rejects(speech.synthesize('English only',{preview:true}),/中文/);
  await assert.rejects(speech.synthesize('你好',{preview:true}),/密钥/);assert.equal(calls,0);
});

test('synthesis rejects HTML/JSON pretending to be audio and reports HTTP status without provider body',async()=>{
  const speech=createSpeech({},config,{fetch:async()=>new Response('{"secret":"credential-value"}',{status:401})});
  await assert.rejects(speech.synthesize('你好',{preview:true}),e=>e.status===502&&/401/.test(e.message)&&!/secret|credential-value/.test(e.message));
  const bad=createSpeech({},config,{fetch:async()=>new Response('<html>no</html>',{headers:{'content-type':'audio/wav'}})});
  await assert.rejects(bad.synthesize('你好',{preview:true}),/音频/);
});

test('a failed audio response body is sanitized like a failed connection',async()=>{
  const speech=createSpeech({},config,{fetch:async()=>new Response(new ReadableStream({start(controller){controller.error(Error('private-socket-detail'));}}))});
  await assert.rejects(speech.synthesize('你好呀。',{preview:true}),e=>e.status===503&&!/private-socket-detail/.test(e.message));
});

test('the synthesis deadline covers audio download after successful response headers',{timeout:500},async()=>{
  let bodyCancelled=false;
  const speech=createSpeech({},config,{synthesisTimeoutMs:5,fetch:async(_url,{signal})=>new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>{bodyCancelled=true;controller.error(signal.reason);},{once:true});}}))});
  const keepAlive=setTimeout(()=>{},1000);
  try {
    await assert.rejects(speech.synthesize('你好呀。',{preview:true}),e=>e.status===504&&/超时/.test(e.message));
    assert.equal(bodyCancelled,true);
  } finally {clearTimeout(keepAlive);}
});

test('cancelling after audio headers arrive stops the body without converting it into a service failure',async()=>{
  const controller=new AbortController();let receiving;
  const ready=new Promise(resolve=>{receiving=resolve;});
  const speech=createSpeech({},config,{fetch:async(_url,{signal})=>new Response(new ReadableStream({start(body){signal.addEventListener('abort',()=>body.error(signal.reason),{once:true});receiving();}}))});
  const pending=speech.synthesize('你好呀。',{preview:true,signal:controller.signal});await ready;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});

test('cancellation reaches the TTS transport',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const speech=createSpeech({},config,{fetch:async()=>{calls++;}});
  await assert.rejects(speech.synthesize('你好',{preview:true,signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
});

test('cancelling an active synthesis aborts the pending transport',async()=>{
  const controller=new AbortController();let started,transportSignal;
  const ready=new Promise(resolve=>{started=resolve;});
  const speech=createSpeech({},config,{fetch:async(_url,{signal})=>{transportSignal=signal;started();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const pending=speech.synthesize('你好',{preview:true,signal:controller.signal});await ready;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(transportSignal.aborted,true);
});

test('voice catalog validates response structure and normalizes VoiceStudio IDs',async()=>{
  const speech=createSpeech({},config,{fetch:async()=>json({voices:[{voice_id:'fixture-voice',name:'大肥鱼',language:'Chinese'}]})});
  assert.deepEqual(await speech.voices(),[{id:'fixture-voice',name:'大肥鱼',language:'Chinese'}]);
  const invalid=createSpeech({},config,{fetch:async()=>json({voices:[{name:'缺少身份'}]})});await assert.rejects(invalid.voices(),/音色/);
});

test('health combines real TTS catalog checks with DSH selected recognizer readiness',async()=>{
  const asr=registry('standby');const speech=createSpeech(context(asr),config,{fetch:async()=>json({voices:[{voice_id:'fixture-voice',name:'大肥鱼'}],engines:[{id:'audiocpp',available:true}]})});
  let h=await speech.health();assert.equal(h.tts.available,true);assert.equal(h.asr.available,false);assert.equal(h.asr.phase,'idle');assert.equal(h.asr.rawPhase,'standby');assert.equal(h.available,false);
  asr.setPhase('ready');h=await speech.health();assert.equal(h.asr.available,true);assert.equal(h.available,true);
  assert.equal(asr.calls.length,0);
});

test('health reports missing local voice, missing engine and unavailable services truthfully',async()=>{
  const missing=createSpeech(context(undefined),config,{fetch:async()=>json({voices:[{voice_id:'other',name:'其他'}]})});
  let h=await missing.health();assert.equal(h.tts.available,false);assert.equal(h.asr.phase,'unavailable');
  const down=createSpeech({},config,{fetch:async()=>{throw Error('network detail');}});h=await down.health();assert.equal(h.tts.available,false);assert.doesNotMatch(h.tts.message,/network detail/);
  const noEngine=createSpeech({},config,{fetch:async()=>json({voices:[{voice_id:'fixture-voice',name:'大肥鱼'}],engines:[{id:'audiocpp',available:false}]})});assert.equal((await noEngine.health()).tts.available,false);
});

test('API health checks the configured model when the provider exposes no voice catalog',async()=>{
  const cfg=config();cfg.tts.source='api';const calls=[];
  const speech=createSpeech({credentials:{resolve:async()=>({value:'test-private-key'})}},()=>cfg,{credentialRef:x=>x,fetch:async url=>{calls.push(url);return url.endsWith('/audio/voices')?new Response('',{status:404}):json({data:[{id:'test-tts'}]});}});
  const health=await speech.health();assert.equal(health.tts.available,true);assert.equal(health.tts.phase,'reachable');assert.deepEqual(calls,['https://tts.example/v1/audio/voices','https://tts.example/v1/models']);assert.doesNotMatch(JSON.stringify(health),/test-private-key/);
});

test('canonical recordings must be PCM16, 16 kHz mono and within 120 seconds',()=>{
  const audio=wav();assert.deepEqual(validateRecording(audio.toString('base64')),audio);
  assert.throws(()=>validateRecording(audio.toString('base64')+'\n'),/编码/);
  assert.throws(()=>validateRecording('!!!!'),/编码/);
  assert.throws(()=>validateRecording(wav(0.1,48000).toString('base64')),/16000|16 kHz/);
  assert.throws(()=>validateRecording(wav(0.1,16000,2).toString('base64')),/单声道/);
  assert.throws(()=>validateRecording(wav(120.01).toString('base64')),/120/);
  const truncated=audio.subarray(0,audio.length-2);assert.throws(()=>validateRecording(truncated.toString('base64')),/WAV/);
});

test('DSH transcription pins the selected provider and consumes {text} results',async()=>{
  const asr=registry();const speech=createSpeech(context(asr),config);const controller=new AbortController();
  assert.deepEqual(await speech.transcribe({audioBase64:wav().toString('base64')},controller.signal),{text:'主人，下午好。'});
  assert.equal(asr.calls[0][1].language,'zh');assert.ok(Buffer.isBuffer(asr.calls[0][1].audio));assert.equal(asr.calls[1][1].pinned,true);assert.equal(asr.calls[1][2],controller.signal);
});

test('transcription rejects malformed results and unprepared recognizers',async()=>{
  const asr=registry('unprepared');const speech=createSpeech(context(asr),config);
  await assert.rejects(speech.transcribe({audioBase64:wav().toString('base64')}),/准备/);assert.equal(asr.calls.length,0);
  asr.setPhase('ready');asr.transcribe=async()=>({notText:true});await assert.rejects(speech.transcribe({audioBase64:wav().toString('base64')}),/识别结果/);
});

test('prepare only starts the currently selected DSH provider after explicit invocation',async()=>{
  const asr=registry('unprepared');const speech=createSpeech(context(asr),config);
  assert.equal(asr.calls.length,0);assert.equal(speech.snapshot().asr.phase,'idle');
  const ready=await speech.prepare();assert.deepEqual(asr.calls,[['prepare','sensevoice-local']]);assert.equal(ready.available,true);assert.equal(ready.phase,'ready');
});

test('prepare follows DSH readiness and preserves intermediate state when wait expires',async()=>{
  const asr=registry('unprepared');asr.prepare=()=>asr.setPhase('loading');
  asr.follow=async function*(signal){yield this.snapshot();await new Promise(resolve=>{const id=setTimeout(resolve,500);signal.addEventListener('abort',()=>{clearTimeout(id);resolve();},{once:true});});};
  const speech=createSpeech(context(asr),config,{prepareWaitMs:15});const result=await speech.prepare();
  assert.equal(result.phase,'preparing');assert.equal(result.rawPhase,'loading');assert.equal(result.available,false);
});

test('a fresh local installation can list voices before choosing one while synthesis remains gated',async()=>{
  const c=config();c.tts.localVoice='';let requests=0;
  const speech=createSpeech({},()=>c,{fetch:async()=>{requests++;return json({voices:[{id:'fixture-available',name:'示例声音'}]});}});
  assert.deepEqual(await speech.voices(),[{id:'fixture-available',name:'示例声音'}]);
  const health=await speech.health();assert.equal(health.tts.available,false);assert.match(health.tts.message,/选择/);
  const before=requests;await assert.rejects(speech.synthesize('你好',{preview:true}),/模型与音色/);assert.equal(requests,before);
});
