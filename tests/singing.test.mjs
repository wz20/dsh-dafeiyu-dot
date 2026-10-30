import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSinging, inspectSingingWave, readBosonKey } from '../lib/singing.js';

const BOSON='https://api.boson.ai/v1/audio/speech';
const request={song:'清唱试听',lyrics:'星光轻轻落在肩头，陪你慢慢走。'};
function wave(seconds=8.5){
  const rate=8000,size=Math.round(seconds*rate)*2,data=Buffer.alloc(44+size);
  data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(size,40);
  for(let i=0;i<size/2;i++)data.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*262)*1000),44+i*2);
  return data;
}
async function fixture(overrides={}){
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-boson-'));
  const referenceAudio=join(root,'approved-reference.wav');await writeFile(referenceAudio,wave(2));
  const reference={id:'song-one',song:request.song,aliases:['星光小调'],referenceAudio,referenceText:'星光轻轻落在肩头，陪你慢慢走。',voiceId:'voice-one',approved:true,authorizedForBoson:true,source:{privateNote:'private-reference-source'},melodyCheck:{passed:true}};
  await writeFile(join(root,'singing-references.json'),JSON.stringify({version:1,references:[reference]}));
  const agent={id:'s',session:{header:{agentPreset:'whale'},snapshotEvents:()=>[]}},ctx={agents:{get:id=>id==='s'?agent:undefined}};
  const config={tts:{source:'local',localUrl:'http://127.0.0.1:3900/v1',localVoice:'voice-one'}},calls=[];
  const fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url===BOSON)return new Response(wave(),{headers:{'content-type':'audio/wav'}});
    if(url.endsWith('/audio'))return new Response(wave(1));
    return Response.json({ref_text:'这是一段匹配参考音频的台词。'});
  };
  const options={root,getConfig:()=>config,settings:{provider:'boson',enabled:true,references:[reference]},readKey:async()=>'fixture-api-key',fetch,...overrides};
  return {root,agent,ctx,config,calls,reference,referenceAudio,options,service:createSinging(ctx,options)};
}
async function noCandidates(root){
  let entries;try{entries=await readdir(join(root,'songs'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  assert.deepEqual(entries,[]);
}

test('default singing uses approved matching song audio and lyrics at the fixed Boson API',async()=>{
  const f=await fixture(),song=await f.service.generate(request,{agent:f.agent});
  assert.equal(song.status,'ready');assert.equal(song.title,request.song);assert.equal(song.durationSeconds,8.5);
  assert.deepEqual(f.calls.map(x=>x.url),[BOSON]);
  const outbound=f.calls.at(-1),body=JSON.parse(outbound.options.body);
  assert.equal(outbound.options.method,'POST');assert.equal(outbound.options.redirect,'error');
  assert.equal(outbound.options.headers.authorization,'Bearer fixture-api-key');
  assert.deepEqual(body,{model:'higgs-tts-3',input:'<|style:singing|>'+request.lyrics,response_format:'wav',stream:false,normalize:false,language:'cmn',ref_audio:wave(2).toString('base64'),ref_text:f.reference.referenceText});
  assert.equal(song.mode,'reference');assert.equal(song.referenceId,'song-one');assert.deepEqual(song.acceptance,{melody:'pending',lyrics:'pending',timbre:'pending'});
  const metadata=JSON.parse(await readFile(join(f.root,'songs',song.songId,'metadata.json'),'utf8'));
  assert.equal(metadata.service,'Boson Higgs TTS 3');assert.equal(metadata.voiceId,'voice-one');assert.equal(metadata.sessionId,'s');
  assert.equal(metadata.mode,'reference');assert.equal(metadata.referenceId,'song-one');assert.deepEqual(metadata.acceptance,song.acceptance);
  assert.doesNotMatch(JSON.stringify(metadata),/fixture-api-key|ref_audio|ref_text/);
});

test('only explicit free mode uses the current VoiceStudio speaking reference',async()=>{
  const f=await fixture(),song=await f.service.generate({...request,mode:'free'},{agent:f.agent});
  assert.deepEqual(f.calls.map(x=>x.url),['http://127.0.0.1:3900/profiles/voice-one','http://127.0.0.1:3900/profiles/voice-one/audio',BOSON]);
  const body=JSON.parse(f.calls.at(-1).options.body);
  assert.equal(body.ref_audio,wave(1).toString('base64'));assert.equal(body.ref_text,'这是一段匹配参考音频的台词。');
  assert.equal(song.mode,'free');assert.equal(song.referenceId,null);assert.deepEqual(song.acceptance,{melody:'pending',lyrics:'pending',timbre:'pending'});
  assert.equal(f.calls[0].options.headers,undefined);assert.equal(f.calls[1].options.headers,undefined);
});

test('default reference mode never falls back to speaking audio or paid synthesis when material is missing',async()=>{
  for(const change of [r=>({...r,referenceAudio:undefined}),r=>({...r,referenceText:''}),r=>({...r,referenceAudio:'/missing/private/reference.wav'}),r=>({...r,approved:false}),r=>({...r,authorizedForBoson:false})]){
    const f=await fixture();f.options.settings.references=[change(f.reference)];
    const service=createSinging(f.ctx,f.options);await assert.rejects(service.generate(request,{agent:f.agent}),error=>error instanceof Error&&/参考|授权|歌词/.test(error.message));
    assert.equal(f.calls.length,0);await noCandidates(f.root);
  }
  const f=await fixture();f.options.settings.references=[];
  await assert.rejects(f.service.generate(request,{agent:f.agent}),/尚未准备匹配的参考歌声/);assert.equal(f.calls.length,0);
});

test('song title and aliases match exactly after removing whitespace and book-title marks',async()=>{
  const f=await fixture();
  const song=await f.service.generate({...request,song:'《 星 光 小 调 》'},{agent:f.agent});assert.equal(song.referenceId,'song-one');
  await assert.rejects(f.service.generate({...request,song:'星光'},{agent:f.agent}),/尚未准备匹配/);
  await assert.rejects(f.service.generate({...request,song:'另一首歌',referenceId:'song-one'},{agent:f.agent}),/指定曲目不一致/);
  await assert.rejects(f.service.generate({...request,referenceId:'unknown'},{agent:f.agent}),/参考歌声编号/);
  await assert.rejects(f.service.generate({lyrics:request.lyrics,referenceId:'song-one'},{agent:f.agent}),/需要明确曲名/);
  assert.equal(f.calls.length,1);
});

test('an explicit reference ID cannot bypass voice, approval or upload authorization',async()=>{
  for(const change of [r=>({...r,voiceId:'other-voice'}),r=>({...r,approved:false}),r=>({...r,authorizedForBoson:false})]){
    const f=await fixture();f.options.settings.references=[change(f.reference)];
    await assert.rejects(f.service.generate({...request,referenceId:'song-one'},{agent:f.agent}),{status:409});assert.equal(f.calls.length,0);
  }
});

test('multiple approved references for one song require a unique reference ID',async()=>{
  const f=await fixture();f.options.settings.references.push({...f.reference,id:'song-alt'});
  await assert.rejects(f.service.generate(request,{agent:f.agent}),/指定 referenceId/);
  const chosen=await f.service.generate({...request,referenceId:'song-alt'},{agent:f.agent});assert.equal(chosen.referenceId,'song-alt');
  assert.equal(f.calls.length,1);
});

test('reference audio paths can only come from trusted settings rather than model arguments',async()=>{
  const f=await fixture();
  for(const extra of [{referenceAudio:f.referenceAudio},{referenceText:'other'},{referencesFile:'/tmp/model-selected.json'}])await assert.rejects(f.service.generate({...request,...extra},{agent:f.agent}),/本地曲库选择/);
  await assert.rejects(f.service.generate({...request,mode:'invalid'},{agent:f.agent}),{status:400});
  await assert.rejects(f.service.generate({...request,mode:'free',referenceId:'song-one'},{agent:f.agent}),/参考模式/);
  assert.equal(f.calls.length,0);
});

test('reference library loading supports the default file and a trusted override',async()=>{
  const f=await fixture(),defaultSettings={provider:'boson',enabled:true};
  const defaultService=createSinging(f.ctx,{...f.options,settings:defaultSettings});
  const one=await defaultService.generate(request,{agent:f.agent});assert.equal(one.referenceId,'song-one');
  const directory=join(f.root,'another-library');await import('node:fs/promises').then(fs=>fs.mkdir(directory));
  await writeFile(join(directory,'song.wav'),wave(3));
  const referencesFile=join(directory,'catalog.json');await writeFile(referencesFile,JSON.stringify({version:1,references:[{...f.reference,id:'override-reference',referenceAudio:'song.wav'}]}));
  const override=createSinging(f.ctx,{...f.options,settings:{...defaultSettings,referencesFile}});
  const two=await override.generate(request,{agent:f.agent});assert.equal(two.referenceId,'override-reference');
  assert.equal(JSON.parse(f.calls.at(-1).options.body).ref_audio,wave(3).toString('base64'));
  const missing=createSinging(f.ctx,{...f.options,settings:{...defaultSettings,referencesFile:join(f.root,'absent.json')}});
  await assert.rejects(missing.generate(request,{agent:f.agent}),/尚未准备本地清唱参考曲库/);
});

test('reference listing contains only approved public fields and current-voice availability',async()=>{
  const f=await fixture();
  f.options.settings.references.push({...f.reference,id:'other-voice',voiceId:'voice-two'},{...f.reference,id:'unapproved',approved:false},{...f.reference,id:'unauthorized',authorizedForBoson:false});
  const result=await f.service.listReferences({agent:f.agent});
  assert.deepEqual(result.references.map(r=>[r.id,r.availableForCurrentVoice]),[['song-one',true],['other-voice',false]]);
  assert.deepEqual(Object.keys(result.references[0]).sort(),['id','song','aliases','referenceText','voiceId','availableForCurrentVoice'].sort());
  assert.doesNotMatch(JSON.stringify(result),/approved-reference\.wav|private-reference-source|fixture-api-key|melodyCheck|source|referenceAudio/);
  assert.equal(f.calls.length,0);
  f.agent.session.header.agentPreset='standard';await assert.rejects(f.service.listReferences({agent:f.agent}),{status:409});
});

test('an absent default library lists no references and generation asks for the missing song',async()=>{
  const f=await fixture();await rm(join(f.root,'singing-references.json'));
  const service=createSinging(f.ctx,{...f.options,settings:{provider:'boson',enabled:true}});
  assert.deepEqual(await service.listReferences({agent:f.agent}),{references:[]});
  await assert.rejects(service.generate(request,{agent:f.agent}),error=>error.status===404&&/先添加并确认该曲目/.test(error.message)&&!error.message.includes(f.root));
  assert.equal(f.calls.length,0);
});

test('reference mode checks current voice again before making the paid request',async()=>{
  const f=await fixture(),service=createSinging(f.ctx,{...f.options,readKey:async()=>{f.config.tts.localVoice='voice-two';return 'fixture-api-key';}});
  await assert.rejects(service.generate(request,{agent:f.agent}),/当前音色已改变/);assert.equal(f.calls.length,0);await noCandidates(f.root);
});

test('replay reuses saved audio and does not call the paid service again',async()=>{
  const f=await fixture(),song=await f.service.generate(request,{agent:f.agent});
  const first=await f.service.read(song.songId,'s'),second=await f.service.read(song.songId,'s');
  assert.deepEqual(first.audio,second.audio);assert.equal(first.mime,'audio/wav');assert.equal(first.delivery.mode,'singing');assert.equal(first.mode,'reference');assert.equal(first.referenceId,'song-one');assert.deepEqual(first.acceptance,song.acceptance);assert.equal(f.calls.length,1);
});

test('saved audio belongs to its source session and requires companion mode',async()=>{
  const f=await fixture(),song=await f.service.generate(request,{agent:f.agent});
  await assert.rejects(createSinging({},f.options).read(song.songId,'other'),{status:404});
  await assert.rejects(f.service.read('../reference','s'),{status:404});
  f.agent.session.header.agentPreset='standard';
  await assert.rejects(f.service.read(song.songId,'s'),{status:409});
  await assert.rejects(f.service.generate(request,{agent:f.agent}),{status:409});
});

test('lyrics are required, bounded and cannot supply synthesis control tags',async()=>{
  const f=await fixture();
  for(const lyrics of [undefined,' ','字'.repeat(601),'<|style:whisper|>你好','你好|>','你好\0'])await assert.rejects(f.service.generate({...request,lyrics},{agent:f.agent}),{status:400});
  await assert.rejects(f.service.generate({...request,song:'x'.repeat(101)},{agent:f.agent}),{status:400});
  assert.equal(f.calls.length,0);
});

test('current voice is resolved anew and reference songs remain isolated by voice',async()=>{
  const f=await fixture();
  await f.service.generate(request,{agent:f.agent});
  f.config.tts.localVoice='voice-two';
  await assert.rejects(f.service.generate(request,{agent:f.agent}),/当前大肥鱼音色不匹配/);
  assert.equal(f.calls.length,1);
  f.options.settings.references.push({...f.reference,id:'song-two',voiceId:'voice-two'});
  const second=await f.service.generate(request,{agent:f.agent});assert.equal(second.referenceId,'song-two');assert.equal(f.calls.length,2);
});

test('reference voice source must be the configured loopback VoiceStudio',async()=>{
  const f=await fixture();
  f.config.tts.source='api';await assert.rejects(f.service.generate({...request,mode:'free'},{agent:f.agent}),/本机 VoiceStudio/);
  f.config.tts.source='local';
  for(const url of ['https://remote.example/v1','file:///tmp/audio','http://user:pass@localhost:3900/v1','http://localhost:3900/v1?key=value']){
    f.config.tts.localUrl=url;await assert.rejects(f.service.generate({...request,mode:'free'},{agent:f.agent}),/本机 VoiceStudio/);
  }
  assert.equal(f.calls.length,0);
});

test('missing matching reference text and changing voices stop before the paid request',async()=>{
  const f=await fixture();
  const missing=createSinging(f.ctx,{...f.options,fetch:async()=>Response.json({ref_text:''})});
  await assert.rejects(missing.generate({...request,mode:'free'},{agent:f.agent}),/缺少匹配的参考台词/);
  const change=createSinging(f.ctx,{...f.options,fetch:async(url)=>{
    if(url.endsWith('/audio')){f.config.tts.localVoice='changed';return new Response(wave(1));}
    if(url===BOSON)assert.fail('paid API must not run after voice changes');
    return Response.json({ref_text:'参考台词'});
  }});
  await assert.rejects(change.generate({...request,mode:'free'},{agent:f.agent}),/当前音色已改变/);
});

test('configuration is required, accepts Boson provider and respects disable state',async()=>{
  const f=await fixture();
  await assert.rejects(createSinging(f.ctx,{...f.options,settings:undefined}).generate(request,{agent:f.agent}),/配置 Boson/);
  await assert.rejects(createSinging(f.ctx,{...f.options,settings:{provider:'boson',enabled:false}}).generate(request,{agent:f.agent}),/已关闭/);
  await assert.rejects(createSinging(f.ctx,{...f.options,settings:{provider:'other'}}).generate(request,{agent:f.agent}),/配置 Boson/);
  await writeFile(join(f.root,'singing.json'),JSON.stringify({provider:'boson',enabled:true}));
  const song=await createSinging(f.ctx,{...f.options,settings:undefined}).generate(request,{agent:f.agent});assert.equal(song.status,'ready');
});

test('key lookup prefers explicit environment and requires protected env files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-boson-key-')),envFile=join(root,'credential.env');
  await writeFile(envFile,'BOSON_API_KEY="fixture-file-key"\n',{mode:0o600});
  assert.equal(await readBosonKey({envFile},{env:{BOSON_API_KEY:'fixture-env-key'}}),'fixture-env-key');
  assert.equal(await readBosonKey({envFile},{env:{}}),'fixture-file-key');
  await chmod(envFile,0o644);
  await assert.rejects(readBosonKey({envFile},{env:{}}),/只允许当前用户访问/);
  await chmod(envFile,0o600);
  await writeFile(envFile,'OTHER_KEY=fixture-other\n');await assert.rejects(readBosonKey({envFile},{env:{}}),/有效的 Boson/);
  await assert.rejects(readBosonKey({}, {env:{}}),/配置 Boson API/);
});

test('HTTP errors map authentication, balance and rate limits without exposing response bodies',async()=>{
  for(const [status,text] of [[401,'身份验证'],[402,'余额不足'],[403,'身份验证'],[429,'限流'],[503,'暂时不可用']]){
    const f=await fixture();let cancelled=false;
    const service=createSinging(f.ctx,{...f.options,fetch:async(url,options)=>url===BOSON?new Response(new ReadableStream({cancel(){cancelled=true;}}),{status}):f.options.fetch(url,options)});
    await assert.rejects(service.generate(request,{agent:f.agent}),error=>error.code==='boson_http_'+status&&error.message.includes(text)&&!error.message.includes('fixture-api-key'));
    assert.equal(cancelled,true);await noCandidates(f.root);
  }
});

test('parallel generation is refused until the current request is cancelled',async()=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;}),controller=new AbortController();
  const f=await fixture({fetch:async()=>{entered();return new Promise(()=>{});}});
  const task=f.service.generate(request,{agent:f.agent,signal:controller.signal});await started;
  await assert.rejects(f.service.generate(request,{agent:f.agent}),{status:409});controller.abort();
  await assert.rejects(task,/已停止/);await noCandidates(f.root);
});

test('timeout and transport errors clear candidates and keep raw errors private',async()=>{
  const f=await fixture({timeoutMs:20,fetch:async()=>new Promise(()=>{})}),keeper=setTimeout(()=>{},500);
  try{await assert.rejects(f.service.generate(request,{agent:f.agent}),{status:504});}finally{clearTimeout(keeper);}
  await noCandidates(f.root);
  const fail=createSinging(f.ctx,{...f.options,fetch:async()=>{throw Error('fixture-api-key private connection error');}});
  await assert.rejects(fail.generate(request,{agent:f.agent}),error=>!error.message.includes('fixture-api-key'));await noCandidates(f.root);
});

test('cancellation while transport rejects synchronously is fully handled',async()=>{
  const controller=new AbortController(),f=await fixture({fetch:()=>{controller.abort();return Promise.reject(Error('stopped'));}});
  await assert.rejects(f.service.generate(request,{agent:f.agent,signal:controller.signal}),/已停止/);
  await new Promise(resolve=>setImmediate(resolve));await noCandidates(f.root);
});

test('WAV data must be complete, within 180 seconds, and is revalidated on replay',async()=>{
  assert.throws(()=>inspectSingingWave(wave().subarray(0,90)),{status:502});
  assert.throws(()=>inspectSingingWave(wave(180.01)),{status:502});
  const invalid=wave();invalid.writeUInt16LE(99,20);assert.throws(()=>inspectSingingWave(invalid),{status:502});
  const f=await fixture(),song=await f.service.generate(request,{agent:f.agent});
  await writeFile(join(f.root,'songs',song.songId,'song.wav'),'invalid');await assert.rejects(f.service.read(song.songId,'s'),{status:502});
});

test('oversized declared or streamed audio is rejected before publication',async()=>{
  for(const declared of [true,false]){
    const f=await fixture();
    const service=createSinging(f.ctx,{...f.options,fetch:async(url,options)=>{
      if(url!==BOSON)return f.options.fetch(url,options);
      return declared?new Response(wave(),{headers:{'content-length':String(16*1024*1024+1)}}):new Response(Buffer.alloc(16*1024*1024+1));
    }});
    await assert.rejects(service.generate(request,{agent:f.agent}),/超过大小限制/);await noCandidates(f.root);
  }
});

test('changing companion mode before remote completion prevents audio publication',async()=>{
  const f=await fixture();
  const service=createSinging(f.ctx,{...f.options,fetch:async(url,options)=>{
    if(url===BOSON){f.agent.session.header.agentPreset='standard';return new Response(wave());}
    return f.options.fetch(url,options);
  }});
  await assert.rejects(service.generate(request,{agent:f.agent}),{status:409});await noCandidates(f.root);
});

test('switching to API speech cannot reuse an inactive local voice for reference singing',async()=>{
 const f=await fixture();f.config.tts.source='api';
 await assert.rejects(f.service.generate(request,{agent:f.agent}),/本机 VoiceStudio/);
 await assert.rejects(f.service.listReferences({agent:f.agent}),/本机 VoiceStudio/);
 assert.equal(f.calls.length,0);
});

test('a voice change during generation prevents the earlier voice from being published',async()=>{
 const f=await fixture();
 const service=createSinging(f.ctx,{...f.options,fetch:async(url,options)=>{
  if(url===BOSON){f.config.tts.localVoice='voice-after-request';return new Response(wave());}
  return f.options.fetch(url,options);
 }});
 await assert.rejects(service.generate(request,{agent:f.agent}),/当前音色已改变/);await noCandidates(f.root);
});
