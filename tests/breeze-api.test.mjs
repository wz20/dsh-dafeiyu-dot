import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeech} from '../lib/speech.js';
import {supportsVoiceDirection,voiceDirection} from '../lib/speech-delivery.js';

const config=()=>({tts:{source:'api',apiProvider:'breezeblue',apiUrl:'https://openai.example/v1',apiModel:'other-model',apiVoice:'other-voice',breezeUrl:'https://api.breeze.blue/v1',breezeModel:'breeze-tts-2',breezeVoice:'voc_fixture',speed:1,emotional:true,expressiveness:'vivid'}});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function wav(){const audio=Buffer.alloc(244);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(24000,24);audio.writeUInt32LE(48000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);return audio;}
function fixture(fetch,overrides={}){
 const cfg=config(),refs=[],agent={id:'session-one',session:{header:{agentPreset:'whale'}}};
 const ctx={agents:{get:id=>id===agent.id?agent:undefined},sessionController:{resolveAgent:async()=>undefined},credentials:{resolve:async ref=>{refs.push(ref);return {value:ref==='DAFEIYU_BREEZE_API_KEY'?'synthetic-breeze-secret':'synthetic-openai-secret'};}}};
 return {cfg,refs,agent,ctx,speech:createSpeech(ctx,()=>cfg,{fetch,credentialRef:x=>x,now:()=>0,...overrides})};
}

test('BreezeBlue uses its own credential, voice endpoint and synchronous WAV contract with emotion directions',async()=>{
 const calls=[],f=fixture(async(url,init)=>{calls.push({url,init});return new Response(wav());});
 const result=await f.speech.synthesize('（开心地摇尾巴）主人，回来啦！',{preview:true,previewEmotion:'joyful'});
 assert.equal(calls[0].url,'https://api.breeze.blue/v1/text-to-speech/voc_fixture?output_format=wav&delivery=sync');
 assert.deepEqual(JSON.parse(calls[0].init.body),{text:'主人，回来啦！',model_id:'breeze-tts-2',language_code:'zh',instructions:voiceDirection('joyful','vivid'),voice_settings:{guidance_scale:4}});
 assert.equal(calls[0].init.headers['xi-api-key'],'synthetic-breeze-secret');assert.equal(calls[0].init.headers.authorization,undefined);assert.ok(f.refs.every(ref=>ref==='DAFEIYU_BREEZE_API_KEY'));
 assert.equal(calls[0].init.redirect,'error');assert.equal(result.mime,'audio/wav');assert.deepEqual(result.audio,wav());assert.equal(result.delivery.emotion,'joyful');
});

test('BreezeBlue ordinary replies use the existing emotion director and the chosen voice',async()=>{
 let planned=0,body;
 const f=fixture(async(_url,init)=>{body=JSON.parse(init.body);return new Response(wav());},{planDelivery:async(text,options)=>{planned++;assert.match(text,/失落/);assert.equal(options.sessionId,'session-one');return {mode:'model',emotion:'soothing',instructions:'provided'};}});
 const result=await f.speech.synthesize('（有点失落）别难过，本鱼陪着你呀。',{sessionId:'session-one'});
 assert.equal(planned,1);assert.match(body.instructions,/安抚/);assert.match(body.instructions,/鲜明/);assert.equal(body.text,'别难过，本鱼陪着你呀。');assert.equal(result.delivery.mode,'model');
});

test('BreezeBlue can disable emotion without a director call or changing its saved voice',async()=>{
 let body,planned=0;
 const f=fixture(async(_url,init)=>{body=JSON.parse(init.body);return new Response(wav());},{planDelivery:async()=>{planned++;}});f.cfg.tts.emotional=false;
 await f.speech.synthesize('你好呀。',{preview:true});assert.equal(planned,0);assert.equal(body.instructions,undefined);assert.equal(body.voice_settings,undefined);assert.equal(f.cfg.tts.breezeVoice,'voc_fixture');
});

test('BreezeBlue text above the account default limit is rejected before credentials, direction or generation',async()=>{
 let calls=0,planned=0;const f=fixture(async()=>{calls++;},{planDelivery:async()=>{planned++;}});
 await assert.rejects(f.speech.synthesize('鱼'.repeat(1001),{sessionId:'session-one'}),error=>error.status===400&&/1000/.test(error.message));
 assert.equal(calls,0);assert.equal(planned,0);assert.equal(f.refs.length,0);
});

test('provider and endpoint changes never borrow credentials or speech parameters from another API',async()=>{
 const calls=[],f=fixture(async(url,init)=>{calls.push({url,init});return new Response(wav());});
 await f.speech.synthesize('你好呀。',{preview:true});f.cfg.tts.apiProvider='openai';await f.speech.synthesize('你好呀。',{preview:true});
 assert.equal(calls[1].url,'https://openai.example/v1/audio/speech');assert.equal(calls[1].init.headers.authorization,'Bearer synthetic-openai-secret');assert.equal(calls[1].init.headers['xi-api-key'],undefined);assert.equal(JSON.parse(calls[1].init.body).model,'other-model');assert.equal(JSON.parse(calls[1].init.body).voice,'other-voice');assert.equal(JSON.parse(calls[1].init.body).instructions,undefined);
});

test('a missing BreezeBlue key is not satisfied by an existing OpenAI key',async()=>{
 const cfg=config();let calls=0;
 const speech=createSpeech({credentials:{resolve:async ref=>ref==='DAFEIYU_TTS_API_KEY'?{value:'synthetic-openai-secret'}:undefined}},()=>cfg,{credentialRef:x=>x,fetch:async()=>{calls++;}});
 await assert.rejects(speech.synthesize('你好呀。',{preview:true}),/密钥/);assert.equal(calls,0);
});

test('BreezeBlue voices follow cursor pagination, normalize language and preserve unique results',async()=>{
 const urls=[],f=fixture(async url=>{urls.push(url);return urls.length===1?json({voices:[{voice_id:'voc_one',name:'声音一',language_code:'zh'}],has_more:true,next_page_token:'cursor/+='}):json({voices:[{voice_id:'voc_two',name:'声音二',language_code:'zh'}],has_more:false});});
 assert.deepEqual(await f.speech.voices(),[{id:'voc_one',name:'声音一',language:'zh'},{id:'voc_two',name:'声音二',language:'zh'}]);
 assert.equal(urls[0],'https://api.breeze.blue/v1/voices?page_size=100');assert.equal(new URL(urls[1]).searchParams.get('next_page_token'),'cursor/+=');
});

test('BreezeBlue pagination accepts the documented page-number fallback and rejects repeated pages',async()=>{
 const urls=[],f=fixture(async url=>{urls.push(url);return json({voices:[{voice_id:'voc_same',name:'声音'}],has_more:true});});
 await assert.rejects(f.speech.voices(),/分页/);assert.equal(urls.length,2);assert.equal(new URL(urls[1]).searchParams.get('page'),'2');
});

test('BreezeBlue voice pagination rejects reused cursors instead of looping',async()=>{
 let calls=0;const f=fixture(async()=>json({voices:[{voice_id:'voc_'+(++calls),name:'声音'}],has_more:true,next_page_token:'same'}));
 await assert.rejects(f.speech.voices(),/分页/);assert.equal(calls,2);
});

test('BreezeBlue connection checks validate the configured model and voice without generating audio',async()=>{
 const calls=[],f=fixture(async url=>{calls.push(url);return url.endsWith('/models')?json([{model_id:'breeze-tts-2',name:'Breeze TTS 2'}]):json({voice_id:'voc_fixture',name:'测试音色',language_code:'zh'});});
 const health=await f.speech.health();assert.equal(health.tts.available,true);assert.equal(health.tts.voiceName,'测试音色');assert.equal(calls.length,2);assert.ok(calls.includes('https://api.breeze.blue/v1/models'));assert.ok(calls.includes('https://api.breeze.blue/v1/voices/voc_fixture'));assert.doesNotMatch(JSON.stringify(health),/synthetic-breeze-secret/);
});

test('BreezeBlue connection checks distinguish missing model and missing voice',async()=>{
 const missing=fixture(async url=>url.endsWith('/models')?json([{model_id:'other'}]):json({voice_id:'voc_fixture',name:'音色'}));
 assert.match((await missing.speech.health()).tts.message,/模型/);
 const noVoice=fixture(async url=>url.endsWith('/models')?json([{model_id:'breeze-tts-2'}]):new Response('',{status:404}));
 const h=await noVoice.speech.health();assert.equal(h.tts.available,false);assert.match(h.tts.message,/音色/);
});

test('BreezeBlue HTTP errors provide safe actionable messages and never retry paid generation',async()=>{
 for(const [status,expected] of [[401,/密钥/],[402,/额度|预算/],[403,/权限/],[429,/并发|频率/],[422,/参数/],[503,/稍后|不可用/]]){
  let calls=0;const f=fixture(async()=>{calls++;return new Response(JSON.stringify({detail:'synthetic-breeze-secret private detail'}),{status});});
  await assert.rejects(f.speech.synthesize('你好呀。',{preview:true}),e=>expected.test(e.message)&&!e.message.includes('synthetic-breeze-secret')&&!e.message.includes('private detail'));assert.equal(calls,1);
 }
});

test('an unexpected async result and JSON masquerading as WAV cannot become playback audio',async()=>{
 for(const response of [new Response('{"generation_job_id":"job-private"}',{status:202}),json({error:'private text'})]){
  const f=fixture(async()=>response);await assert.rejects(f.speech.synthesize('你好呀。',{preview:true}),e=>/同步|音频|WAV/.test(e.message)&&!/job-private|private text/.test(e.message));
 }
});

test('BreezeBlue rejects plaintext remote addresses and unsafe voice IDs before contacting a service',async()=>{
 for(const patch of [{breezeUrl:'http://remote.example/v1'},{breezeVoice:'../other'},{breezeVoice:'voc_fish?query=secret'},{apiProvider:'unknown'}]){
  let calls=0;const f=fixture(async()=>{calls++;});Object.assign(f.cfg.tts,patch);await assert.rejects(f.speech.synthesize('你好呀。',{preview:true}));assert.equal(calls,0);
 }
});

test('BreezeBlue redirects are rejected before any redirected body can be used',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {ok:true,status:200,redirected:true,body:{cancel:async()=>{}},headers:new Headers()};});
 await assert.rejects(f.speech.synthesize('你好呀。',{preview:true}),/跳转|连接|接口/);assert.equal(calls,1);
});

test('BreezeBlue cancellation and deadlines cover the response body without returning partial audio',async()=>{
 for(const cancel of [false,true]){
  const controller=new AbortController();let opened,bodyCancelled=false;const ready=new Promise(r=>{opened=r;});
  const f=fixture(async()=>{opened();return new Response(new ReadableStream({cancel(){bodyCancelled=true;}}));},{synthesisTimeoutMs:15});
  const keepAlive=setTimeout(()=>{},200),pending=f.speech.synthesize('你好呀。',{preview:true,signal:controller.signal});await ready;if(cancel)controller.abort();
  try{await assert.rejects(pending,err=>cancel?err.name==='AbortError':err.status===504);assert.equal(bodyCancelled,true);}finally{clearTimeout(keepAlive);}
 }
});

test('BreezeBlue supports voice direction while ordinary OpenAI-compatible APIs retain explicit capability limits',()=>{
 assert.equal(supportsVoiceDirection({source:'api',provider:'breezeblue',model:'breeze-tts-2'}),true);
 assert.equal(supportsVoiceDirection({source:'api',provider:'openai',model:'breeze-tts-2'}),false);
});

test('closing a voice catalog or health check aborts its active request',async()=>{
 for(const method of ['voices','health']){
  const controller=new AbortController();let entered,transport;const ready=new Promise(r=>{entered=r;});
  const f=fixture(async(_url,{signal})=>{transport=signal;entered();return new Response(new ReadableStream());});
  const pending=f.speech[method]({signal:controller.signal});await ready;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(transport.aborted,true);
 }
});

test('one catalog deadline bounds a stalled later page',async()=>{
 let calls=0;const f=fixture(async()=>++calls===1?json({voices:[{voice_id:'voc_one',name:'声音'}],has_more:true,next_page_token:'next'}):new Response(new ReadableStream()),{catalogTimeoutMs:15});
 const keepAlive=setTimeout(()=>{},200);
 try{await assert.rejects(f.speech.voices(),e=>e.status===504);assert.equal(calls,2);}finally{clearTimeout(keepAlive);}
});

test('the voice catalog enforces the documented page size and finite page budget',async()=>{
 const oversized=fixture(async()=>json({voices:Array.from({length:101},(_,i)=>({voice_id:'voc_'+i,name:'声音'})),has_more:false}));
 await assert.rejects(oversized.speech.voices(),/每页限制/);
 let calls=0;const f=fixture(async()=>json({voices:[{voice_id:'voc_'+(++calls),name:'声音'}],has_more:true,next_page_token:'page-'+calls}));
 await assert.rejects(f.speech.voices(),/分页限制/);assert.equal(calls,100);
});

test('the preliminary key check obeys cancellation and timeout before any emotion or generation request',async()=>{
 for(const cancel of [false,true]){
  const cfg=config(),controller=new AbortController();let entered,network=0,planning=0;const ready=new Promise(r=>{entered=r;});
  const speech=createSpeech({credentials:{resolve:async()=>{entered();return new Promise(()=>{});}}},()=>cfg,{credentialRef:x=>x,synthesisTimeoutMs:15,fetch:async()=>{network++;},planDelivery:async()=>{planning++;}});
  const keepAlive=setTimeout(()=>{},200),pending=speech.synthesize('你好呀。',{preview:true,signal:controller.signal});await ready;if(cancel)controller.abort();
  try{await assert.rejects(pending,e=>cancel?e.name==='AbortError':e.status===504);assert.equal(network,0);assert.equal(planning,0);}finally{clearTimeout(keepAlive);}
 }
});
