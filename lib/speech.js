import {createSpeechDelivery, isSpeechEmotion, supportsVoiceDirection, voiceDirection} from './speech-delivery.js';
import {createHash} from 'node:crypto';
import {resolveAgent,requireWhale} from './session.js';
import {adjustSpeechSpeed} from './speech-speed.js';
import {validateBreezeUrl} from './config.js';

const MAX_AUDIO_BYTES=4*1024*1024;
const MAX_RESULT_BYTES=24*1024*1024;
const AUDIO_CACHE_BYTES=16*1024*1024;
const AUDIO_CACHE_ENTRIES=8;
const AUDIO_CACHE_TTL=5*60*1000;
const READY_PHASES=new Set(['ready']);
const PREPARING_PHASES=new Set(['checking','downloading','loading','waking','preparing','cancelling']);
const PHASE_MESSAGES={ready:'语音识别已就绪。',idle:'请点击开始语音，准备 DSH 当前选择的语音识别。',preparing:'DSH 正在准备语音识别，请稍等。',error:'DSH 语音识别准备失败，请在语音设置中查看详情。',unavailable:'DSH 语音识别服务尚未接入，请先在 DSH 语音设置中配置。'};

export class SpeechError extends Error {
  constructor(message,status=400){super(message);this.name='SpeechError';this.status=status;}
}

function withoutStageBrackets(text) {
  const pairs = new Map([['(', ')'], ['（', '）'], ['【', '】'], ['[', ']']]);
  const stack = []; let result = '';
  for (const character of text) {
    if (pairs.has(character)) {
      if (!stack.length) result += ' ';
      stack.push(pairs.get(character));
    } else if (stack.length) {
      if (character === stack.at(-1)) stack.pop();
    } else result += character;
  }
  return result;
}

function completeWave(audio) {
  if(audio.length<44||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'||audio.readUInt32LE(4)!==audio.length-8)return false;
  let offset=12,format=null,dataLength=0;
  while(offset<audio.length){
    if(offset+8>audio.length)return false;
    const id=audio.toString('ascii',offset,offset+4),size=audio.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>audio.length||end+(size%2)>audio.length)return false;
    if(id==='fmt '){if(format||size<16)return false;format=audio.subarray(start,end);}
    if(id==='data'){if(dataLength||!size)return false;dataLength=size;}
    offset=end+(size%2);
  }
  if(!format||!dataLength||!format.readUInt16LE(2)||!format.readUInt32LE(4)||!format.readUInt16LE(12))return false;
  return ![1,3].includes(format.readUInt16LE(0))||dataLength%format.readUInt16LE(12)===0;
}

/** Read aloud Chinese dialogue, excluding program text and roleplay stage directions. */
export function cleanSpeechText(raw) {
  if(typeof raw!=='string')return '';
  return withoutStageBrackets(raw
    .replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,' ')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,' ')
    .replace(/`[^`\n]*(?:`|$)/g,' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/https?:\/\/[^\s<>()（）]+|www\.[^\s<>()（）]+/gi,' ')
    .replace(/<[^>]*>/g,' '))
    .replace(/\*\*([\s\S]*?)\*\*/g,'$1')
    .replace(/^\s*\*\s+/gm,' ')
    .replace(/\*[^*]+\*/g,' ')
    .replace(/[^\p{Script=Han}\d\s，。！？、；：,.!?;:…—-]/gu,' ')
    .replace(/^[\s\d]*[.、]\s*/gm,'')
    .replace(/\s+/g,' ')
    .replace(/\s*([，。！？、；：,.!?;:…])\s*/g,'$1')
    .replace(/([，、；：,;:])(?=[，。！？、；：,.!?;:…])/g,'')
    .replace(/^[，。！？、；：,.!?;:…\s-]+|[，、；：,;:\s-]+$/g,'')
    .trim();
}

/** Validate the same canonical PCM recording contract used by the DSH speech controller. */
export function validateRecording(encoded) {
  if(typeof encoded!=='string'||!encoded.length||encoded.length%4!==0||encoded.length>Math.ceil(MAX_AUDIO_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new SpeechError('录音编码不正确，请重新录音。');
  const audio=Buffer.from(encoded,'base64');
  if(audio.toString('base64')!==encoded||audio.length>MAX_AUDIO_BYTES)throw new SpeechError('录音编码不正确或超过大小限制。');
  if(audio.length<44||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'||audio.readUInt32LE(4)!==audio.length-8)throw new SpeechError('WAV 录音数据不完整，请重新录音。');
  let format,data,offset=12;
  while(offset<audio.length){
    if(offset+8>audio.length)throw new SpeechError('WAV 录音区块不完整。');
    const id=audio.toString('ascii',offset,offset+4),size=audio.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>audio.length||end+(size%2)>audio.length)throw new SpeechError('WAV 录音区块长度不正确。');
    if(id==='fmt '){if(format||size<16)throw new SpeechError('WAV 音频格式不正确。');format=audio.subarray(start,end);}
    if(id==='data'){if(data)throw new SpeechError('WAV 录音包含重复音频区块。');data=audio.subarray(start,end);}
    offset=end+(size%2);
  }
  if(!format||!data||!data.length)throw new SpeechError('WAV 录音缺少音频数据。');
  if(format.readUInt16LE(0)!==1||format.readUInt16LE(14)!==16)throw new SpeechError('请使用 PCM16 WAV 格式录音。');
  if(format.readUInt16LE(2)!==1)throw new SpeechError('录音需要使用单声道。');
  if(format.readUInt32LE(4)!==16000)throw new SpeechError('录音采样率需要为 16000 Hz（16 kHz）。');
  if(format.readUInt32LE(8)!==32000||format.readUInt16LE(12)!==2||data.length%2)throw new SpeechError('WAV PCM16 音频数据不正确。');
  if(data.length/32000>120)throw new SpeechError('每段录音最长为 120 秒。');
  return audio;
}

function selectedConfig(config,{requireVoice=true}={}) {
  const tts=config?.tts;
  if(!tts||!['local','api'].includes(tts.source))throw new SpeechError('请先选择本地或 API 语音。');
  const provider=tts.source==='api'?(tts.apiProvider??'openai'):'local';
  if(!['local','openai','breezeblue'].includes(provider))throw new SpeechError('请选择BreezeBlue官方或OpenAI兼容API。');
  const prefix=provider==='breezeblue'?'breeze':tts.source;let url;
  try{url=new URL(provider==='breezeblue'?validateBreezeUrl(tts.breezeUrl):tts[prefix+'Url']);}catch{throw new SpeechError(provider==='breezeblue'?'请填写 HTTPS BreezeBlue 服务地址；HTTP仅用于本机服务。':'请填写有效的 HTTP 或 HTTPS 语音服务地址。');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new SpeechError('请填写有效的 HTTP 或 HTTPS 语音服务地址。');
  const model=tts[prefix+'Model'],voice=tts[prefix+'Voice'];
  if(typeof model!=='string'||!model.trim()||typeof voice!=='string'||requireVoice&&!voice.trim())throw new SpeechError('请先填写语音模型与音色。');
  if(provider==='breezeblue'&&(model.trim().length>120||voice.trim()&&!/^[A-Za-z0-9_-]{1,200}$/.test(voice.trim())))throw new SpeechError('请填写有效的 BreezeBlue 模型与音色 ID。');
  const speed=tts.speed??1;
  if(typeof speed!=='number'||!Number.isFinite(speed)||speed<0.75||speed>1.5)throw new SpeechError('语速范围为 0.75 到 1.5 倍。');
  return {source:tts.source,provider,url:url.href.replace(/\/$/,''),model:model.trim(),voice:voice.trim(),speed};
}

function readAsr(ctx,snapshot) {
  let service;
  try{service=ctx.get?.('speechToText');}catch{}
  try{
    const observation=snapshot??service?.snapshot();
    const providers=Array.isArray(observation?.providers)?observation.providers:[];
    const id=observation?.selection?.providerId,provider=providers.find(p=>p.id===id);
    if(!service||!provider)return {service,providers,state:{available:false,phase:'unavailable',message:PHASE_MESSAGES.unavailable}};
    const rawPhase=provider.preparation?.phase??'ready';
    const phase=READY_PHASES.has(rawPhase)?'ready':PREPARING_PHASES.has(rawPhase)?'preparing':['failed','error'].includes(rawPhase)?'error':'idle';
    return {service,providers,state:{available:phase==='ready',phase,rawPhase,providerId:id,name:provider.name,message:PHASE_MESSAGES[phase]}};
  }catch{return {service,providers:[],state:{available:false,phase:'unavailable',message:PHASE_MESSAGES.unavailable}};}
}

async function readLimited(response,limit,signal) {
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit){await response.body?.cancel();throw new SpeechError('语音服务返回的数据超过限制。',502);}
  if(!response.body)throw new SpeechError('语音服务返回了空数据。',502);
  const reader=response.body.getReader(),chunks=[];let length=0,complete=false;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{while(true){signal?.throwIfAborted();const {done,value}=await reader.read();signal?.throwIfAborted();if(done){complete=true;break;}length+=value.length;if(length>limit)throw new SpeechError('语音服务返回的数据超过限制。',502);chunks.push(Buffer.from(value));}}
  finally{signal?.removeEventListener('abort',abort);if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,length);
}

/** Host adapter. The optional dependency object isolates transport and timing in tests. */
export function createSpeech(ctx,getConfig,dependencies={}) {
  const fetcher=dependencies.fetch??globalThis.fetch;
  const planDelivery=dependencies.planDelivery??createSpeechDelivery(ctx);
  const now=dependencies.now??(()=>performance.now());
  const audioCache=new Map();let cachedBytes=0;
  const ref=async name=>dependencies.credentialRef?dependencies.credentialRef(name):(await import('@deepseek-ai/dsh-credentials')).credentialRef(name);

  function discard(key){const entry=audioCache.get(key);if(entry){cachedBytes-=entry.audio.length;audioCache.delete(key);}}
  function prune(){for(const [key,entry] of audioCache)if(now()-entry.at>=AUDIO_CACHE_TTL)discard(key);}
  function remember(key,audio,delivery){
    if(audio.length>AUDIO_CACHE_BYTES)return;
    discard(key);
    while(audioCache.size>=AUDIO_CACHE_ENTRIES||cachedBytes+audio.length>AUDIO_CACHE_BYTES)discard(audioCache.keys().next().value);
    audioCache.set(key,{audio:Buffer.from(audio),delivery,at:now()});cachedBytes+=audio.length;
  }

  async function headers(selection,{signal,timeout=6000}={}) {
    const result={'content-type':'application/json'};
    if(selection.source==='api'){
      signal?.throwIfAborted();
      const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);let resolved,rejectAbort;
      const onAbort=()=>rejectAbort?.(combined.reason),aborted=new Promise((_,reject)=>{rejectAbort=reject;});combined.addEventListener('abort',onAbort,{once:true});
      try{resolved=await Promise.race([(async()=>{const reference=await ref(selection.provider==='breezeblue'?'DAFEIYU_BREEZE_API_KEY':'DAFEIYU_TTS_API_KEY');combined.throwIfAborted();return await ctx.credentials?.resolve(reference);})(),aborted]);combined.throwIfAborted();}
      catch{signal?.throwIfAborted();if(combined.aborted)throw new SpeechError('API语音密钥读取超时，请稍后重试。',504);throw new SpeechError('API 语音密钥暂时无法读取，请重新保存密钥。',503);}
      finally{combined.removeEventListener('abort',onAbort);}
      if(typeof resolved?.value!=='string'||!resolved.value.trim())throw new SpeechError('请先在语音设置中保存 API 密钥。',503);
      if(selection.provider==='breezeblue')result['xi-api-key']=resolved.value.trim();else result.authorization='Bearer '+resolved.value.trim();
    }
    return result;
  }
  async function request(selection,path,{signal,timeout=6000,method='GET',body,maxBytes=2*1024*1024}={}) {
    signal?.throwIfAborted();
    const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
    let rejectAbort;
    const onAbort=()=>rejectAbort?.(combined.reason),aborted=new Promise((_,reject)=>{rejectAbort=reject;});
    combined.addEventListener('abort',onAbort,{once:true});
    const work=async()=>{
      const requestHeaders=await headers(selection,{signal:combined});combined.throwIfAborted();
      const response=await fetcher(selection.url+path,{method,headers:requestHeaders,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:combined,redirect:'error'});
      if(combined.aborted){await response.body?.cancel();combined.throwIfAborted();}
      if(response.redirected){await response.body?.cancel();throw new SpeechError('语音接口发生了跳转，请直接填写最终的可信服务地址。',502);}
      if(!response.ok){
        await response.body?.cancel();
        const messages={401:'BreezeBlue API密钥无效或已失效，请重新保存密钥。',402:'BreezeBlue额度或密钥预算不足，请检查官网余额与预算。',403:'BreezeBlue当前密钥没有访问所选音色或模型的权限。',404:'BreezeBlue音色或接口不存在，请检查音色ID与服务地址。',422:'BreezeBlue请求参数未通过校验，请检查模型、音色和文本长度。',429:'BreezeBlue并发或请求频率达到限制，请稍后重试。',503:'BreezeBlue服务暂时不可用，请稍后重试。',504:'BreezeBlue服务响应超时，请稍后重试。'};
        throw new SpeechError(selection.provider==='breezeblue'&&messages[response.status]?`${messages[response.status]}（HTTP ${response.status}）`:`语音服务请求失败（HTTP ${response.status}），请检查地址、模型与密钥。`,502);
      }
      if(selection.provider==='breezeblue'&&response.status===202){await response.body?.cancel();throw new SpeechError('BreezeBlue未返回同步语音，本次不会重复提交，请检查响应模式。',502);}
      return await readLimited(response,maxBytes,combined);
    };
    try{return await Promise.race([work(),aborted]);}
    catch(error){signal?.throwIfAborted();if(error instanceof SpeechError)throw error;if(combined.aborted)throw new SpeechError('语音服务响应超时，请稍后重试。',504);throw new SpeechError('暂时无法连接语音服务，请检查服务是否已启动。',503);}
    finally{combined.removeEventListener('abort',onAbort);}
  }
  function voiceList(items,breeze=false) {
    if(!Array.isArray(items)||items.length>10000)throw new SpeechError('语音服务返回的音色列表格式不正确。',502);
    return items.map(v=>{
      const id=v?.voice_id??v?.id,name=v?.name??id,language=breeze?v?.language_code:v?.language;
      if(typeof id!=='string'||!id||id.length>200||typeof name!=='string'||name.length>500)throw new SpeechError('语音服务返回的音色信息不完整。',502);
      return {id,name,...typeof language==='string'?{language}:{}};
    });
  }
  async function jsonRequest(selection,path,options) {
    try{return JSON.parse((await request(selection,path,options)).toString('utf8'));}
    catch(error){if(options?.signal?.aborted&&options.signal.reason?.name==='TimeoutError')throw new SpeechError('语音服务响应超时，请稍后重试。',504);options?.signal?.throwIfAborted();if(error instanceof SpeechError)throw error;throw new SpeechError('语音服务返回的数据格式不正确。',502);}
  }
  async function breezeCatalog(selection,{signal}={}) {
    const deadline=dependencies.catalogTimeoutMs??6000,combined=signal?AbortSignal.any([signal,AbortSignal.timeout(deadline)]):AbortSignal.timeout(deadline),voices=new Map(),tokens=new Set(),pages=new Set();let token;
    for(let page=1;page<=100;page++){
      const query=new URLSearchParams({page_size:'100'});if(token)query.set('next_page_token',token);else if(page>1)query.set('page',String(page));
      const data=await jsonRequest(selection,'/voices?'+query,{signal:combined}),items=voiceList(data?.voices,true);
      if(items.length>100)throw new SpeechError('BreezeBlue音色分页超过每页限制，请稍后重试。',502);
      if(typeof data?.has_more!=='boolean')throw new SpeechError('BreezeBlue音色分页信息不正确。',502);
      const signature=JSON.stringify(items.map(item=>item.id));
      if(pages.has(signature)&&items.length)throw new SpeechError('BreezeBlue音色分页重复，请稍后重试。',502);pages.add(signature);
      for(const item of items)voices.set(item.id,item);
      if(!data.has_more)return {voices:[...voices.values()]};
      if(!items.length)throw new SpeechError('BreezeBlue音色分页信息不正确。',502);
      const next=data.next_page_token;
      if(next!==undefined&&next!==null&&(typeof next!=='string'||!next||next.length>4096||/[\r\n\0]/.test(next)||tokens.has(next)))throw new SpeechError('BreezeBlue音色分页信息不正确。',502);
      if(next)tokens.add(next);token=next||undefined;
    }
    throw new SpeechError('BreezeBlue音色列表超过分页限制，请在配置中填写自己的音色ID。',502);
  }
  async function catalog(selection,options) {
    if(selection.provider==='breezeblue')return breezeCatalog(selection,options);
    let data;
    try{data=JSON.parse((await request(selection,'/audio/voices',options)).toString('utf8'));}catch(error){options?.signal?.throwIfAborted();if(error instanceof SpeechError)throw error;throw new SpeechError('语音服务返回的音色列表格式不正确。',502);}
    const items=Array.isArray(data)?data:data?.voices??data?.data;
    const voices=voiceList(items);
    return {voices,engines:Array.isArray(data?.engines)?data.engines:undefined};
  }
  async function ttsHealth({signal}={}) {
    let selection;
    try{
      signal?.throwIfAborted();
      selection=selectedConfig(await getConfig(),{requireVoice:false});
      if(selection.provider==='breezeblue'){
        const timeout=AbortSignal.timeout(dependencies.catalogTimeoutMs??6000),combined=signal?AbortSignal.any([signal,timeout]):timeout,models=await jsonRequest(selection,'/models',{signal:combined});
        if(!Array.isArray(models)||!models.some(model=>model?.model_id===selection.model))throw new SpeechError('BreezeBlue已连接，请选择账号可用的语音模型。',502);
        if(!selection.voice)return {source:selection.source,provider:selection.provider,model:selection.model,voice:'',available:false,phase:'unavailable',message:'BreezeBlue已连接，请读取音色列表并选择自己的音色。'};
        const [voice]=voiceList([await jsonRequest(selection,'/voices/'+encodeURIComponent(selection.voice),{signal:combined})],true);
        if(voice.id!==selection.voice)throw new SpeechError('BreezeBlue返回的音色与所选音色不一致，请重新选择。',502);
        return {source:selection.source,provider:selection.provider,model:selection.model,voice:voice.id,voiceName:voice.name,available:true,phase:'reachable',message:`BreezeBlue已连接，已找到${voice.name}音色。`};
      }
      const {voices,engines}=await catalog(selection,{signal}),voice=voices.find(v=>v.id===selection.voice);
      if(!voice)return {source:selection.source,model:selection.model,voice:selection.voice,available:false,phase:'unavailable',message:'语音服务已连接，请选择服务中已保存的音色。'};
      const engine=engines?.find(e=>e.id===selection.model);
      if(engines&&(!engine||engine.available!==true))return {source:selection.source,model:selection.model,voice:selection.voice,available:false,phase:'unavailable',message:'所选语音引擎尚未就绪，请在语音服务中准备模型。'};
      return {source:selection.source,model:selection.model,voice:selection.voice,voiceName:voice.name,available:true,phase:'reachable',message:`语音服务已连接，已找到${voice.name}音色。`};
    }catch(error){
      signal?.throwIfAborted();
      // OpenAI-compatible providers can expose /models without a voice catalog.
      if(selection?.source==='api'&&selection.provider!=='breezeblue'&&error instanceof SpeechError&&/HTTP (404|405)/.test(error.message)){
        try{
          const data=JSON.parse((await request(selection,'/models',{signal})).toString('utf8'));
          if(!Array.isArray(data?.data)||!data.data.some(m=>m?.id===selection.model))throw new SpeechError('服务已连接，请核对语音模型名称。',503);
          return {source:selection.source,model:selection.model,voice:selection.voice,available:true,phase:'reachable',message:'API 模型接口已连接，可通过试听验证所选音色。'};
        }catch(fallback){signal?.throwIfAborted();error=fallback;}
      }
      return {source:selection?.source??'local',available:false,phase:'unavailable',message:error instanceof SpeechError?error.message:'语音配置暂时不可用，请检查语音设置。'};
    }
  }
  return {
    async synthesize(text,{signal,preview=false,previewEmotion='warm',sessionId}={}) {
      const started=now();
      preview=preview===true;
      signal?.throwIfAborted();
      if(preview&&!isSpeechEmotion(previewEmotion))throw new SpeechError('请选择有效的试听语气。');
      if(typeof text!=='string'||text.length>32000)throw new SpeechError('朗读文字格式不正确或过长。');
      const input=cleanSpeechText(text);
      if(!/\p{Script=Han}/u.test(input))throw new SpeechError('这段内容没有可以朗读的中文。');
      if(input.length>4000)throw new SpeechError('本次朗读文字较长，请分段试听。');
      const admit=async()=>{signal?.throwIfAborted();if(!preview)requireWhale(await resolveAgent(ctx,sessionId));signal?.throwIfAborted();};
      await admit();
      const config=await getConfig(),selection=selectedConfig(config);
      if(selection.provider==='breezeblue'&&Array.from(input).length>1000)throw new SpeechError('BreezeBlue每次朗读最多1000个字符，请将内容分段后再试听。');
      if(selection.provider==='breezeblue')await headers(selection,{signal,timeout:dependencies.synthesisTimeoutMs??6000});
      const delivery=config.tts.emotional===false?{mode:'disabled'}:supportsVoiceDirection(selection)?await planDelivery(text,{signal,preview,sessionId,...preview?{previewEmotion}:{}}):{mode:'unsupported'};
      await admit();
      const instructions=delivery.instructions?voiceDirection(delivery.emotion,config.tts.expressiveness):undefined;
      const metadata={mode:delivery.mode,...delivery.emotion?{emotion:delivery.emotion}:{},...selection.speed!==1?{speed:selection.speed}:{}};
      const key=preview?null:createHash('sha256').update(JSON.stringify([sessionId,selection,input,metadata.mode,instructions??null])).digest('hex');
      prune();
      const cached=key&&audioCache.get(key);
      if(cached){
        audioCache.delete(key);audioCache.set(key,cached);
        return {audio:Buffer.from(cached.audio),mime:'audio/wav',delivery:{...cached.delivery,cached:true,preparationMs:Math.max(0,Math.round(now()-started))}};
      }
      const breeze=selection.provider==='breezeblue';
      const path=breeze?'/text-to-speech/'+encodeURIComponent(selection.voice)+'?output_format=wav&delivery=sync':'/audio/speech';
      const body=breeze?{text:input,model_id:selection.model,language_code:'zh',...(instructions?{instructions,voice_settings:{guidance_scale:4}}:{})}:{model:selection.model,voice:selection.voice,input,language:'zh',response_format:'wav',...(instructions?{instructions,guidance_scale:4}:{})};
      let audio=await request(selection,path,{signal,timeout:dependencies.synthesisTimeoutMs??120000,method:'POST',maxBytes:MAX_RESULT_BYTES,body});
      await admit();
      if(!completeWave(audio))throw new SpeechError('语音服务未返回完整有效的 WAV 音频，请检查语音接口。',502);
      if(selection.speed!==1){
        audio=await (dependencies.adjustSpeed??adjustSpeechSpeed)(audio,selection.speed,{signal});
        await admit();
        if(!completeWave(audio))throw new SpeechError('语速处理未返回完整有效的 WAV 音频。',502);
      }
      if(key)remember(key,audio,metadata);
      return {audio,mime:'audio/wav',delivery:{...metadata,cached:false,preparationMs:Math.max(0,Math.round(now()-started))}};
    },
    async voices({signal}={}){return (await catalog(selectedConfig(await getConfig(),{requireVoice:false}),{signal})).voices;},
    snapshot(){const {providers,state}=readAsr(ctx);return {providers,asr:state};},
    async health({signal}={}){const {providers,state}=readAsr(ctx),tts=await ttsHealth({signal});return {available:tts.available&&state.available,providers,tts,asr:state};},
    async transcribe({audioBase64,language='zh'}={},signal=new AbortController().signal) {
      signal.throwIfAborted();const audio=validateRecording(audioBase64);
      if(typeof language!=='string'||!language||language.length>20)throw new SpeechError('语音识别语言设置不正确。');
      const {service,state}=readAsr(ctx);
      if(!service||state.phase==='unavailable')throw new SpeechError(PHASE_MESSAGES.unavailable,503);
      if(!state.available)throw new SpeechError(state.message,409);
      try{
        const spec=service.resolve({audio,language});
        const result=await service.transcribe(spec,signal);signal.throwIfAborted();
        const text=typeof result==='string'?result:result?.text;
        if(typeof text!=='string'||text.length>32000)throw new SpeechError('DSH 返回的语音识别结果格式不正确。',502);
        return {text:text.trim()};
      }catch(error){signal.throwIfAborted();if(error instanceof SpeechError)throw error;throw new SpeechError('DSH 语音识别暂时失败，请检查识别模型与语言设置。',503);}
    },
    async prepare() {
      let {service,state}=readAsr(ctx);
      if(!service||!state.providerId)throw new SpeechError(PHASE_MESSAGES.unavailable,503);
      if(state.available)return state;
      try{await service.prepare(state.providerId);}catch{throw new SpeechError('DSH 语音识别暂时无法准备，请检查语音设置。',503);}
      state=readAsr(ctx).state;
      if(state.available||state.phase==='error'||typeof service.follow!=='function')return state;
      const observer=new AbortController();let timer;
      try{
        await Promise.race([
          (async()=>{try{for await(const update of service.follow(observer.signal)){const current=readAsr(ctx,update).state;if(current.available||current.phase==='error'||current.phase==='unavailable')return;}}catch(error){if(!observer.signal.aborted)throw error;}})(),
          new Promise(resolve=>{timer=setTimeout(resolve,dependencies.prepareWaitMs??20000);})
        ]);
      }catch{throw new SpeechError('读取 DSH 语音识别准备状态失败，请重试。',503);}
      finally{clearTimeout(timer);observer.abort();}
      return readAsr(ctx).state;
    }
  };
}
