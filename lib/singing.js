import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { requireWhale, resolveAgent, ModeSwitchError } from './session.js';

const BOSON_URL='https://api.boson.ai/v1/audio/speech';
const SINGING_TAG='<|style:singing|>';
const MAX_AUDIO=16*1024*1024;
const MAX_REFERENCE=7*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class SingingError extends Error {
  constructor(message,status=400){super(message);this.name='SingingError';this.status=status;}
}

/** Inspect complete PCM/float WAVE data before playback or QQ delivery. */
export function inspectSingingWave(audio) {
  const invalid=()=>{throw new SingingError('清唱服务没有返回完整可播放的 WAV 音频。',502);};
  if(!Buffer.isBuffer(audio)||audio.length<44||audio.length>MAX_AUDIO||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'||audio.readUInt32LE(4)!==audio.length-8)invalid();
  let offset=12,format,data;
  while(offset<audio.length){
    if(offset+8>audio.length)invalid();
    const id=audio.toString('ascii',offset,offset+4),size=audio.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end+(size%2)>audio.length)invalid();
    if(id==='fmt '){if(format||size<16)invalid();format=audio.subarray(start,end);}
    if(id==='data'){if(data||!size)invalid();data=audio.subarray(start,end);}
    offset=end+(size%2);
  }
  if(!format||!data)invalid();
  const encoding=format.readUInt16LE(0),channels=format.readUInt16LE(2),rate=format.readUInt32LE(4),byteRate=format.readUInt32LE(8),align=format.readUInt16LE(12),bits=format.readUInt16LE(14);
  if(![1,3].includes(encoding)||![1,2].includes(channels)||rate<8000||rate>192000||![16,24,32].includes(bits)||encoding===3&&bits!==32||align!==channels*bits/8||byteRate!==rate*align||data.length%align)invalid();
  const durationSeconds=data.length/byteRate;
  if(durationSeconds<=0||durationSeconds>180)invalid();
  return {durationSeconds,sampleRate:rate,channels};
}

async function limitedFile(path,max){
  const info=await stat(path);
  if(!info.isFile()||info.size>max)throw new SingingError('清唱文件不可用或超过大小限制。',502);
  return readFile(path);
}
function validKey(value){
  if(typeof value!=='string'||!value.trim()||value.length>8192||/[\x00-\x20\x7f]/u.test(value))throw new SingingError('请配置有效的 Boson API 密钥。',503);
  return value;
}

/** Read a protected local credential without evaluating the env file. */
export async function readBosonKey(settings,{env=process.env}={}){
  if(typeof env.BOSON_API_KEY==='string'&&env.BOSON_API_KEY.trim())return validKey(env.BOSON_API_KEY.trim());
  if(typeof settings?.envFile!=='string'||!settings.envFile)throw new SingingError('请先配置 Boson API 密钥。',503);
  let text;
  try{
    const info=await stat(settings.envFile);
    if(!info.isFile()||info.size>32768||(info.mode&0o077)!==0)throw new SingingError('Boson 密钥文件需要只允许当前用户访问。',503);
    text=await readFile(settings.envFile,'utf8');
  }catch(error){if(error instanceof SingingError)throw error;throw new SingingError('Boson 密钥文件暂时无法读取。',503);}
  const match=text.match(/^\s*(?:export\s+)?BOSON_API_KEY\s*=\s*([^\r\n]+)\s*$/mu);
  let key=match?.[1]?.trim();
  if(key?.length>=2&&((key.startsWith('"')&&key.endsWith('"'))||(key.startsWith("'")&&key.endsWith("'"))))key=key.slice(1,-1);
  return validKey(key);
}

function abortable(task,signal){
  let abort;
  const result=new Promise((resolve,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal.throwIfAborted();return task();}).then(resolve,reject);
    if(signal.aborted)abort();
  });
  return result.finally(()=>signal.removeEventListener('abort',abort));
}
async function readResponse(response,max,signal){
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>max){await response.body?.cancel();throw new SingingError('清唱服务返回的数据超过大小限制。',502);}
  if(!response.body)throw new SingingError('清唱服务返回了空数据。',502);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){
      const {done,value}=await abortable(()=>reader.read(),signal);if(done)break;
      size+=value.length;
      if(size>max){await reader.cancel();throw new SingingError('清唱服务返回的数据超过大小限制。',502);}
      chunks.push(Buffer.from(value));
    }
  }finally{if(signal.aborted)await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
function voiceSelection(config){
  const tts=config?.tts;
  if(tts?.source!=='local')throw new SingingError('清唱需要连接本机 VoiceStudio 中当前保存的音色。',503);
  let url;
  try{url=new URL(tts.localUrl);}catch{throw new SingingError('请先连接本机 VoiceStudio 语音服务。',503);}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new SingingError('清唱参考音色仅从本机 VoiceStudio 读取。',503);
  if(typeof tts.localVoice!=='string'||!/^[-A-Za-z0-9_]{1,200}$/u.test(tts.localVoice))throw new SingingError('请先选择 VoiceStudio 中保存的音色。',503);
  return {origin:url.origin,voice:tts.localVoice};
}
function currentVoice(config){
  if(config?.tts?.source!=='local')throw new SingingError('清唱需要使用当前本机 VoiceStudio 音色，请先确认语音来源。',503);
  const voice=config?.tts?.localVoice;
  if(typeof voice!=='string'||!/^[-A-Za-z0-9_]{1,200}$/u.test(voice))throw new SingingError('请先选择当前大肥鱼音色。',503);
  return voice;
}
const pendingAcceptance=()=>({melody:'pending',lyrics:'pending',timbre:'pending'});
const songName=value=>typeof value==='string'?value.replace(/[\s《》〈〉]/gu,''):'';
const matchesSong=(reference,song)=>[reference?.song,...Array.isArray(reference?.aliases)?reference.aliases:[]].some(name=>songName(name)===song);
function referenceReady(reference){return reference?.approved===true&&reference?.authorizedForBoson===true;}
function bosonHttpError(status){
  const message=status===401||status===403?'Boson 身份验证失败，请检查 API 密钥。':status===402?'Boson 账户余额不足，请检查账户额度。':status===429?'Boson 请求达到限流，请稍后重试。':status>=500?'Boson 清唱服务暂时不可用，请稍后重试。':'Boson 未接受本次清唱请求，请检查歌词与参考音色。';
  return Object.assign(new SingingError(message+'（HTTP '+status+'）',status===429?429:503),{code:'boson_http_'+status});
}

/** Generate a session-bound audition from an approved song reference or explicit free singing. */
export function createSinging(ctx,{root,getConfig,settings,fetch:fetcher=globalThis.fetch,readKey=readBosonKey,timeoutMs=300_000}={}){
  if(typeof root!=='string'||!root)throw new Error('Singing data root is required');
  const active=new Set();
  async function recordings(){
    let catalog;
    try{catalog=JSON.parse((await limitedFile(join(root,'recorded-songs.json'),1024*1024)).toString('utf8'));}
    catch(error){if(error?.code==='ENOENT')return null;throw new SingingError('现成歌曲目录暂时无法读取。',503);}
    if(catalog?.version!==1||!Array.isArray(catalog.recordings)||catalog.recordings.length>1000)throw new SingingError('现成歌曲目录格式不正确。',503);
    return catalog;
  }
  const approvedRecording=r=>r?.approved===true&&typeof r.id==='string'&&r.id.length>0&&r.id.length<=200&&typeof r.song==='string'&&r.song.length>0&&r.song.length<=100;
  async function playRecording(args,catalog,{agent,signal}){
    if(args.audio!==undefined||args.audioFile!==undefined||args.recordingsFile!==undefined||args.referenceAudio!==undefined||args.referenceText!==undefined||args.referencesFile!==undefined)throw new SingingError('现成歌曲只能从本机已确认的曲库选择。');
    if(args.lyrics!==undefined&&args.lyrics!=='')throw new SingingError('这段现成歌曲按已确认音频完整播放，不支持替换歌词。');
    if(args.referenceId!==undefined)throw new SingingError('播放现成歌曲请使用 recordingId。');
    if(!catalog)throw new SingingError('还没有可直接播放的现成歌曲。',404);
    if(args.song!==undefined&&(typeof args.song!=='string'||args.song.length>100)||args.recordingId!==undefined&&(typeof args.recordingId!=='string'||!args.recordingId||args.recordingId.length>200))throw new SingingError('请选择有效的现成曲目。');
    const entries=catalog.recordings.filter(approvedRecording),name=songName(args.song);
    const selectedId=args.recordingId??(!name?catalog.defaultRecordingId:undefined);
    const matches=selectedId?entries.filter(r=>r.id===selectedId):entries.filter(r=>matchesSong(r,name));
    if(matches.length!==1)throw new SingingError('没有找到唯一匹配的现成歌曲，请先查看可用曲目。',404);
    const entry=matches[0];
    if(name&&!matchesSong(entry,name))throw new SingingError('现成音频与点播的曲目不一致，请选择对应歌曲。');
    if(typeof entry.audioFile!=='string'||!entry.audioFile||entry.audioFile.includes('\0')||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new SingingError('这首现成歌曲的本地音频记录不完整。',503);
    const admit=()=>{signal?.throwIfAborted();requireWhale(agent);};
    admit();
    const songId=randomUUID(),directory=join(root,'songs',songId);
    try{
      const audio=await limitedFile(resolve(root,entry.audioFile),MAX_AUDIO);admit();
      if(createHash('sha256').update(audio).digest('hex')!==entry.sha256)throw new SingingError('这段音频与已确认版本不一致，请重新确认素材。',409);
      const wave=inspectSingingWave(audio),acceptance={listening:'user-approved'};
      const metadata={songId,title:entry.song,durationSeconds:wave.durationSeconds,status:'ready',sessionId:agent.id,createdAt:new Date().toISOString(),service:'local-recording',mode:'recorded',recordingId:entry.id,sha256:entry.sha256,acceptance};
      await mkdir(directory,{recursive:true,mode:0o700});admit();
      await writeFile(join(directory,'song.wav'),audio,{mode:0o600,flag:'wx'});admit();
      await writeFile(join(directory,'metadata.json'),JSON.stringify(metadata),{mode:0o600,flag:'wx'});admit();
      return {songId,title:entry.song,durationSeconds:wave.durationSeconds,status:'ready',mode:'recorded',recordingId:entry.id,acceptance};
    }catch(error){
      await rm(directory,{recursive:true,force:true}).catch(()=>{});
      if(signal?.aborted)throw new SingingError('本次歌曲播放已停止。',409);
      if(error instanceof SingingError||error instanceof ModeSwitchError)throw error;
      throw new SingingError('这段现成歌曲的音频暂时无法读取。',503);
    }
  }
  async function configuration(){
    let value;
    try{value=typeof settings==='function'?await settings():settings??JSON.parse(await readFile(join(root,'singing.json'),'utf8'));}
    catch{throw new SingingError('请先配置 Boson 清唱服务。',503);}
    if(value?.enabled===false)throw new SingingError('清唱服务已关闭。',503);
    if(value?.provider!=='boson')throw new SingingError('请先配置 Boson 清唱服务。',503);
    return value;
  }
  async function request(url,options,max,signal,kind){
    const response=await abortable(()=>fetcher(url,{...options,signal,redirect:'error'}),signal);
    if(!response.ok){await response.body?.cancel();if(kind==='boson')throw bosonHttpError(response.status);throw new SingingError('本机参考音色暂时无法读取（HTTP '+response.status+'）。',503);}
    return readResponse(response,max,signal);
  }
  async function references(config){
    const file=typeof config.referencesFile==='string'&&config.referencesFile?config.referencesFile:join(root,'singing-references.json');
    let entries;
    if(config.references!==undefined){
      if(!Array.isArray(config.references))throw new SingingError('本地清唱参考曲库格式不正确。',503);
      entries=config.references;
    }else{
      let catalog;
      try{catalog=JSON.parse((await limitedFile(file,1024*1024)).toString('utf8'));}
      catch(error){
        if(!config.referencesFile&&error?.code==='ENOENT')return {entries:[],base:root};
        throw new SingingError('尚未准备本地清唱参考曲库，请先添加已确认的曲目歌声。',503);
      }
      if(catalog?.version!==1||!Array.isArray(catalog.references))throw new SingingError('本地清唱参考曲库格式不正确。',503);
      entries=catalog.references;
    }
    if(entries.length>1000)throw new SingingError('本地清唱参考曲库超过读取限制。',503);
    return {entries,base:config.references!==undefined?root:dirname(resolve(file))};
  }
  function selectReference(entries,args,voice){
    const name=songName(args.song);
    if(!name)throw new SingingError('参考歌声清唱需要明确曲名，请先选择已准备的曲目。');
    let matches;
    if(args.referenceId!==undefined){
      if(typeof args.referenceId!=='string'||!args.referenceId||args.referenceId.length>200||/[\r\n\0]/u.test(args.referenceId))throw new SingingError('请选择曲库中有效的参考歌声编号。');
      matches=entries.filter(r=>r?.id===args.referenceId);
      if(matches.length!==1)throw new SingingError('未找到唯一匹配的参考歌声编号，请先查询可用曲目。',404);
      if(!matchesSong(matches[0],name))throw new SingingError('参考歌声与指定曲目不一致，请选择这首歌对应的参考。');
    }else{
      matches=entries.filter(r=>matchesSong(r,name));
      if(!matches.length)throw new SingingError('这首歌尚未准备匹配的参考歌声，请先添加并确认该曲目。',404);
      const sameVoice=matches.filter(r=>r?.voiceId===voice);
      if(sameVoice.length)matches=sameVoice;
      const approved=matches.filter(referenceReady);
      if(approved.length)matches=approved;
      if(matches.length!==1)throw new SingingError('这首歌有多段参考歌声，请先指定 referenceId。',409);
    }
    const reference=matches[0];
    if(reference.approved!==true)throw new SingingError('这段参考歌声尚未确认演唱效果，请先完成确认。',409);
    if(reference.authorizedForBoson!==true)throw new SingingError('这段参考歌声尚未授权发送到 Boson，请先确认授权。',409);
    if(reference.voiceId!==voice)throw new SingingError('这段参考歌声与当前大肥鱼音色不匹配，请选择对应音色的参考。',409);
    if(typeof reference.id!=='string'||!reference.id||reference.id.length>200||/[\r\n\0]/u.test(reference.id))throw new SingingError('本地参考歌声编号格式不正确。',503);
    if(typeof reference.referenceText!=='string'||!reference.referenceText.trim()||reference.referenceText.length>8000)throw new SingingError('这段参考歌声缺少准确匹配的歌词，请先补全参考歌词。',503);
    if(typeof reference.referenceAudio!=='string'||!reference.referenceAudio||reference.referenceAudio.includes('\0'))throw new SingingError('这段参考歌声缺少本地音频，请先准备参考歌声。',503);
    return reference;
  }
  return {
    async listReferences({agent,signal}={}){
      requireWhale(agent);signal?.throwIfAborted();
      const recorded=await recordings();requireWhale(agent);signal?.throwIfAborted();
      if(recorded)return {recordings:recorded.recordings.filter(approvedRecording).map(r=>({id:r.id,song:r.song,aliases:Array.isArray(r.aliases)?r.aliases.filter(a=>typeof a==='string'):[],approved:true})),defaultRecordingId:recorded.defaultRecordingId??null,references:[]};
      const config=await configuration(),voice=currentVoice(await getConfig?.()),catalog=await references(config);
      requireWhale(agent);signal?.throwIfAborted();
      return {references:catalog.entries.filter(referenceReady).filter(r=>typeof r.id==='string'&&r.id&&typeof r.song==='string'&&r.song).map(r=>({id:r.id,song:r.song,aliases:Array.isArray(r.aliases)?r.aliases.filter(a=>typeof a==='string'):[],referenceText:typeof r.referenceText==='string'?r.referenceText:'',voiceId:typeof r.voiceId==='string'?r.voiceId:'',availableForCurrentVoice:r.voiceId===voice}))};
    },
    async generate(args={},{agent,signal}={}){
      requireWhale(agent);signal?.throwIfAborted();
      if(typeof agent.id!=='string'||!agent.id)throw new SingingError('清唱需要有效的陪伴会话。');
      const recorded=await recordings();requireWhale(agent);signal?.throwIfAborted();
      if(args.mode==='recorded'||args.mode===undefined&&recorded)return playRecording(args,recorded,{agent,signal});
      const lyrics=typeof args.lyrics==='string'?args.lyrics.trim():'';
      if(!lyrics||Array.from(lyrics).length>600)throw new SingingError('请提供一段 600 字以内的清唱歌词。');
      if(/<\||\|>|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(lyrics))throw new SingingError('歌词中请只保留演唱文字与标点。');
      const mode=args.mode===undefined?'reference':args.mode;
      if(!['reference','free'].includes(mode))throw new SingingError('请选择参考歌声清唱，或明确选择自由清唱。');
      if(args.referenceAudio!==undefined||args.referenceText!==undefined||args.referencesFile!==undefined)throw new SingingError('参考歌声只能从已配置的本地曲库选择，请提供 referenceId。');
      if(mode==='free'&&args.referenceId!==undefined)throw new SingingError('参考歌声编号用于参考模式，请确认清唱方式。');
      const title=typeof args.title==='string'&&args.title.trim()?args.title.trim():typeof args.song==='string'&&args.song.trim()?args.song.trim():'清唱片段';
      if(title.length>100||/[\r\n\0]/u.test(title))throw new SingingError('清唱标题过长或格式不正确。');
      if(active.has(agent.id))throw new SingingError('这段清唱还在生成，请稍等。',409);
      active.add(agent.id);
      const songId=randomUUID(),directory=join(root,'songs',songId),timer=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timer]):timer;
      const admit=()=>{combined.throwIfAborted();requireWhale(agent);};
      try{
        const config=await abortable(configuration,combined);admit();
        const voiceConfig=await abortable(()=>getConfig?.(),combined),voice=currentVoice(voiceConfig);
        let reference,refText,referenceId=null,selection;
        if(mode==='reference'){
          const catalog=await abortable(()=>references(config),combined),entry=selectReference(catalog.entries,args,voice);
          referenceId=entry.id;refText=entry.referenceText;
          try{reference=await abortable(()=>limitedFile(resolve(catalog.base,entry.referenceAudio),MAX_REFERENCE),combined);}
          catch(error){combined.throwIfAborted();throw new SingingError('这段参考歌声的本地音频暂时无法读取，请检查曲库素材。',503);}
          inspectSingingWave(reference);
        }else{
          selection=voiceSelection(voiceConfig);
          const profileUrl=selection.origin+'/profiles/'+encodeURIComponent(selection.voice);
          let profile;
          try{profile=JSON.parse((await request(profileUrl,{},128*1024,combined,'reference')).toString('utf8'));}
          catch(error){if(error instanceof SingingError)throw error;combined.throwIfAborted();throw new SingingError('本机参考音色信息格式不正确。',502);}
          refText=profile?.ref_text;
          if(typeof refText!=='string'||!refText.trim()||refText.length>8000)throw new SingingError('当前音色缺少匹配的参考台词，请在 VoiceStudio 补全。',503);
          reference=await request(profileUrl+'/audio',{},MAX_REFERENCE,combined,'reference');inspectSingingWave(reference);
        }
        admit();const key=validKey(await abortable(()=>readKey(config),combined));admit();
        const currentConfig=await abortable(()=>getConfig?.(),combined);
        if(currentVoice(currentConfig)!==voice||mode==='free'&&voiceSelection(currentConfig).origin!==selection.origin)throw new SingingError('当前音色已改变，请重新发送清唱请求。',409);
        const body={model:'higgs-tts-3',input:SINGING_TAG+lyrics,response_format:'wav',stream:false,normalize:false,language:'cmn',ref_audio:reference.toString('base64'),ref_text:refText};
        const audio=await request(BOSON_URL,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify(body)},MAX_AUDIO,combined,'boson');
        admit();
        if(currentVoice(await abortable(()=>getConfig?.(),combined))!==voice)throw new SingingError('当前音色已改变，本次清唱仍使用先前音色，请重新发送请求。',409);
        const wave=inspectSingingWave(audio);
        await mkdir(directory,{recursive:true,mode:0o700});admit();
        await writeFile(join(directory,'song.wav'),audio,{mode:0o600,flag:'wx'});admit();
        const acceptance=pendingAcceptance();
        const metadata={songId,title,durationSeconds:wave.durationSeconds,status:'ready',sessionId:agent.id,createdAt:new Date().toISOString(),service:'Boson Higgs TTS 3',voiceId:voice,mode,referenceId,acceptance};
        await writeFile(join(directory,'metadata.json'),JSON.stringify(metadata),{mode:0o600,flag:'wx'});admit();
        return {songId,title,durationSeconds:wave.durationSeconds,status:'ready',mode,referenceId,acceptance};
      }catch(error){
        await rm(directory,{recursive:true,force:true}).catch(()=>{});
        if(signal?.aborted)throw new SingingError('本次清唱已停止。',409);
        if(timer.aborted)throw new SingingError('Boson 清唱服务响应超时，请稍后重试。',504);
        if(error instanceof SingingError||error instanceof ModeSwitchError)throw error;
        throw new SingingError('清唱服务暂时无法连接，请检查本机语音服务与 Boson 服务。',503);
      }finally{active.delete(agent.id);}
    },
    async read(songId,sessionId){
      if(typeof songId!=='string'||!UUID.test(songId)||typeof sessionId!=='string'||!sessionId)throw new SingingError('这段清唱暂时无法打开。',404);
      if(ctx?.agents)requireWhale(await resolveAgent(ctx,sessionId));
      const directory=join(root,'songs',songId);let metadata,audio;
      try{
        metadata=JSON.parse((await limitedFile(join(directory,'metadata.json'),16*1024)).toString('utf8'));
        if(metadata.status!=='ready'||metadata.songId!==songId||metadata.sessionId!==sessionId)throw Error();
        audio=await limitedFile(join(directory,'song.wav'),MAX_AUDIO);
      }catch{throw new SingingError('这段清唱暂时无法打开。',404);}
      const wave=inspectSingingWave(audio);
      if(Math.abs(wave.durationSeconds-metadata.durationSeconds)>0.001)throw new SingingError('清唱文件与生成记录不一致。',502);
      if(metadata.mode==='recorded'&&createHash('sha256').update(audio).digest('hex')!==metadata.sha256)throw new SingingError('这段音频与已确认版本不一致。',502);
      return {audio,mime:'audio/wav',songId,title:metadata.title,durationSeconds:wave.durationSeconds,mode:metadata.mode??'free',referenceId:metadata.referenceId??null,...metadata.mode==='recorded'?{recordingId:metadata.recordingId}:{},acceptance:metadata.acceptance??pendingAcceptance(),delivery:{mode:'singing',cached:true}};
    },
  };
}
