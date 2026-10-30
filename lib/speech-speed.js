import {spawn as nodeSpawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';

const MAX_BYTES=24*1024*1024;
const TIMEOUT_MS=30000;

export class SpeechSpeedError extends Error {
  constructor(message,status=502){super(message);this.name='SpeechSpeedError';this.status=status;}
}

function inputFormat(audio) {
  const invalid=()=>{throw new SpeechSpeedError('语速调整需要完整有效的 WAV 音频。');};
  if(!Buffer.isBuffer(audio)||audio.length<44||audio.length>MAX_BYTES||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE'||audio.readUInt32LE(4)!==audio.length-8)invalid();
  let format,dataLength,offset=12;
  while(offset<audio.length){
    if(offset+8>audio.length)invalid();
    const id=audio.toString('ascii',offset,offset+4),size=audio.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end+(size%2)>audio.length)invalid();
    if(id==='fmt '){if(format||size<16)invalid();format=audio.subarray(start,end);}
    if(id==='data'){if(dataLength!==undefined||!size)invalid();dataLength=size;}
    offset=end+(size%2);
  }
  if(!format||!dataLength)invalid();
  const encoding=format.readUInt16LE(0),channels=format.readUInt16LE(2),rate=format.readUInt32LE(4),byteRate=format.readUInt32LE(8),align=format.readUInt16LE(12),bits=format.readUInt16LE(14);
  if(channels<1||channels>8||rate<8000||rate>192000||!((encoding===1&&[8,16,24,32].includes(bits))||(encoding===3&&[32,64].includes(bits)))||align!==channels*bits/8||byteRate!==rate*align||dataLength%align)invalid();
  return {channels,rate};
}

async function installedFFmpeg() {
  if(process.platform==='darwin')for(const file of ['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg']){
    try{await access(file,constants.X_OK);return file;}catch{}
  }
  return 'ffmpeg';
}

function outputWave(chunks,length,{channels,rate}) {
  if(!length||length%(channels*2))throw new SpeechSpeedError('语速调整未返回完整的音频采样。');
  const result=Buffer.alloc(44+length);
  result.write('RIFF');result.writeUInt32LE(result.length-8,4);result.write('WAVEfmt ',8);result.writeUInt32LE(16,16);result.writeUInt16LE(1,20);result.writeUInt16LE(channels,22);result.writeUInt32LE(rate,24);result.writeUInt32LE(rate*channels*2,28);result.writeUInt16LE(channels*2,32);result.writeUInt16LE(16,34);result.write('data',36);result.writeUInt32LE(length,40);
  let offset=44;for(const chunk of chunks){chunk.copy(result,offset);offset+=chunk.length;}
  return result;
}

/** Adjust speech tempo without changing pitch; both transports receive the resulting WAV. */
export async function adjustSpeechSpeed(audio,speed,{signal,spawn=nodeSpawn,ffmpegPath,timeoutMs=TIMEOUT_MS,reapTimeoutMs=250}={}) {
  if(typeof speed!=='number'||!Number.isFinite(speed)||speed<0.75||speed>1.5)throw new SpeechSpeedError('语速需要在 0.75 到 1.5 倍之间。',400);
  signal?.throwIfAborted();
  if(speed===1)return audio;
  const format=inputFormat(audio),binary=ffmpegPath??await installedFFmpeg();
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let child,timer,reapTimer,ended=false,failed=false,reason,length=0;const chunks=[];
    const dependencyError=error=>error?.code==='ENOENT'||error?.code==='EACCES'
      ?new SpeechSpeedError('未找到可用的 FFmpeg，请先安装语速处理依赖。',503)
      :new SpeechSpeedError('语速调整暂时失败，请稍后重试。');
    const cleanup=()=>{
      clearTimeout(timer);clearTimeout(reapTimer);signal?.removeEventListener('abort',abort);
      child?.removeListener('error',processError);child?.removeListener('close',closed);
      child?.stdout?.removeListener('data',output);child?.stdout?.removeListener('error',streamError);
      child?.stderr?.removeListener('data',discard);child?.stderr?.removeListener('error',streamError);
      child?.stdin?.removeListener('error',streamError);
    };
    const stop=error=>{
      if(ended||failed)return;failed=true;reason=error;chunks.length=0;
      reapTimer=setTimeout(()=>{
        if(ended)return;ended=true;cleanup();
        // A failed OS kill must not leave callers pending. Keep only small late-error
        // guards until the process/streams close; no audio buffers remain retained.
        child.on('error',discard);child.once('close',()=>child.removeListener('error',discard));
        for(const stream of [child.stdin,child.stdout,child.stderr])if(!stream.closed){
          stream.on('error',discard);stream.once('close',()=>stream.removeListener('error',discard));
          stream.destroy();
        }
        reject(reason);
      },Math.min(250,Math.max(1,Number(reapTimeoutMs)||250)));
      try{child.kill('SIGKILL');}catch{}
    };
    const abort=()=>{try{signal.throwIfAborted();}catch(error){stop(error);}};
    const processError=error=>{stop(dependencyError(error));};
    const streamError=()=>{stop(new SpeechSpeedError('语速调整的音频传输失败，请重试。'));};
    const discard=()=>{};
    const output=chunk=>{
      if(failed||ended)return;
      if(!Buffer.isBuffer(chunk))return stop(new SpeechSpeedError('语速调整返回了无效的音频数据。'));
      if(length+chunk.length>MAX_BYTES-44)return stop(new SpeechSpeedError('语速调整返回的音频超过大小限制。'));
      chunks.push(chunk);length+=chunk.length;
    };
    const closed=(code,exitSignal)=>{
      if(ended)return;ended=true;cleanup();
      if(failed)return reject(reason);
      if(code!==0||exitSignal)return reject(new SpeechSpeedError('语速调整未能完成，请稍后重试。'));
      try{resolve(outputWave(chunks,length,format));}catch(error){reject(error);}
    };
    try{
      child=spawn(binary,['-hide_banner','-loglevel','error','-nostdin','-i','pipe:0','-map','0:a:0','-vn','-af',`atempo=${speed.toFixed(6)}`,'-acodec','pcm_s16le','-ar',String(format.rate),'-ac',String(format.channels),'-f','s16le','pipe:1'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    }catch(error){ended=true;return reject(dependencyError(error));}
    child.once('error',processError);child.once('close',closed);
    child.stdout.on('data',output);child.stdout.on('error',streamError);child.stderr.on('data',discard);child.stderr.on('error',streamError);child.stdin.on('error',streamError);
    timer=setTimeout(()=>stop(new SpeechSpeedError('语速调整超时，请稍后重试。',504)),Math.min(TIMEOUT_MS,Math.max(1,Number(timeoutMs)||TIMEOUT_MS)));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{child.stdin.end(audio);}catch{streamError();}
  });
}
