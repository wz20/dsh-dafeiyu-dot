import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {adjustSpeechSpeed,SpeechSpeedError} from '../lib/speech-speed.js';

function wave({rate=24000,channels=1,seconds=0.1,hz=440}={}) {
  const frames=Math.round(rate*seconds),data=Buffer.alloc(frames*channels*2),audio=Buffer.alloc(44+data.length);
  for(let n=0;n<frames;n++)for(let c=0;c<channels;c++)data.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*hz*n/rate)),(n*channels+c)*2);
  audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(channels,22);audio.writeUInt32LE(rate,24);audio.writeUInt32LE(rate*channels*2,28);audio.writeUInt16LE(channels*2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(data.length,40);data.copy(audio,44);return audio;
}
function fakeProcess(run=()=>{}) {
  const proc=new EventEmitter();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.stdin=new Writable({write(_chunk,_enc,done){done();}});proc.kills=[];
  proc.kill=signal=>{proc.kills.push(signal);queueMicrotask(()=>proc.emit('close',null,signal));return true;};
  queueMicrotask(()=>run(proc));return proc;
}
const injected=(spawn,more={})=>({spawn,ffmpegPath:'test-ffmpeg',...more});
const safeError=status=>error=>error instanceof SpeechSpeedError&&error.status===status&&!/PRIVATE|sensitive/.test(error.message);

test('normal speed preserves buffer identity and does not start a process',async()=>{
 const audio=wave();assert.equal(await adjustSpeechSpeed(audio,1,injected(()=>{throw Error('unexpected');})),audio);
});

test('invalid speed and malformed WAV are rejected before process creation',async()=>{
 let spawned=0;const options=injected(()=>spawned++);
 for(const speed of [undefined,NaN,Infinity,0.74,1.51,'1.15'])await assert.rejects(adjustSpeechSpeed(wave(),speed,options),safeError(400));
 const input=wave();input.writeUInt32LE(input.length,4);await assert.rejects(adjustSpeechSpeed(input,1.15,options),safeError(502));
 const badFormat=wave();badFormat.writeUInt16LE(3,32);await assert.rejects(adjustSpeechSpeed(badFormat,1.15,options),safeError(502));
 await assert.rejects(adjustSpeechSpeed(Buffer.alloc(24*1024*1024+1),1.15,options),safeError(502));assert.equal(spawned,0);
});

test('atempo produces a complete PCM16 WAV preserving sample rate and channels',async()=>{
 let argsSeen,spawnOptions,child;const source=wave({rate:48000,channels:2});
 const result=await adjustSpeechSpeed(source,1.15,injected((binary,args,options)=>{assert.equal(binary,'test-ffmpeg');argsSeen=args;spawnOptions=options;return child=fakeProcess(p=>{p.stdout.write(Buffer.alloc(400));p.emit('close',0,null);});}));
 assert.equal(result.toString('ascii',0,4),'RIFF');assert.equal(result.readUInt32LE(4),result.length-8);assert.equal(result.readUInt32LE(24),48000);assert.equal(result.readUInt16LE(22),2);assert.equal(result.readUInt16LE(34),16);assert.equal(result.readUInt32LE(40),400);assert.equal(result.length,444);
 assert.equal(argsSeen[argsSeen.indexOf('-af')+1],'atempo=1.150000');assert.ok(argsSeen.includes('s16le'));assert.deepEqual(spawnOptions.stdio,['pipe','pipe','pipe']);assert.equal(spawnOptions.shell,undefined);
 assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('close'),0);assert.equal(child.stdout.listenerCount('data'),0);assert.equal(child.stderr.listenerCount('data'),0);assert.equal(child.stdin.listenerCount('error'),0);
});

test('abnormal exit, empty output and incomplete sample frames fail without exposing stderr',async()=>{
 for(const [bytes,code] of [[20,1],[0,0],[3,0]])await assert.rejects(adjustSpeechSpeed(wave(),1.15,injected(()=>fakeProcess(p=>{p.stderr.write('PRIVATE sensitive token');if(bytes)p.stdout.write(Buffer.alloc(bytes));p.emit('close',code,null);}))),safeError(502));
});

test('missing executable and synchronous spawn failures use safe dependency errors',async()=>{
 await assert.rejects(adjustSpeechSpeed(wave(),1.15,injected(()=>{throw Object.assign(Error('PRIVATE path'),{code:'ENOENT'});})),safeError(503));
 await assert.rejects(adjustSpeechSpeed(wave(),1.15,injected(()=>fakeProcess(p=>{p.emit('error',Object.assign(Error('PRIVATE path'),{code:'ENOENT'}));p.emit('close',-2,null);}))),safeError(503));
});

test('oversized output is stopped and rejected before buffering beyond the limit',async()=>{
 let child;await assert.rejects(adjustSpeechSpeed(wave(),1.15,injected(()=>child=fakeProcess(p=>p.stdout.write(Buffer.alloc(24*1024*1024))))),safeError(502));assert.deepEqual(child.kills,['SIGKILL']);assert.equal(child.stdout.listenerCount('data'),0);
});

test('cancellation kills the child, preserves AbortSignal reason and releases listeners',async()=>{
 const pre=new AbortController(),preReason=Error('pre-cancel');pre.abort(preReason);await assert.rejects(adjustSpeechSpeed(wave(),1.15,{signal:pre.signal,...injected(()=>{throw Error('unexpected');})}),e=>e===preReason);
 const controller=new AbortController(),reason=Error('cancelled');let child;
 const pending=adjustSpeechSpeed(wave(),1.15,{signal:controller.signal,...injected(()=>child=fakeProcess(()=>controller.abort(reason)))});await assert.rejects(pending,e=>e===reason);assert.deepEqual(child.kills,['SIGKILL']);assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('close'),0);assert.equal(child.stdout.listenerCount('data'),0);
 const nullReason=new AbortController();await assert.rejects(adjustSpeechSpeed(wave(),1.15,{signal:nullReason.signal,...injected(()=>fakeProcess(()=>nullReason.abort(null)))}),e=>e===null);
});

test('processing timeout kills the child and returns a typed safe timeout',async()=>{
 let child;await assert.rejects(adjustSpeechSpeed(wave(),1.15,injected(()=>child=fakeProcess(),{timeoutMs:10})),safeError(504));assert.deepEqual(child.kills,['SIGKILL']);assert.equal(child.listenerCount('close'),0);
});

test('failed termination still settles within a bounded grace period and absorbs late process errors',async()=>{
 let child;const pending=adjustSpeechSpeed(wave(),1.15,injected(()=>{child=fakeProcess();child.kill=()=>false;return child;},{timeoutMs:5,reapTimeoutMs:5}));
 const settled=await Promise.race([pending.then(()=>({unexpected:true}),error=>({error})),new Promise(resolve=>setTimeout(()=>resolve({pending:true}),60))]);
 assert.equal(settled.pending,undefined);assert.ok(safeError(504)(settled.error));assert.equal(child.stdout.listenerCount('data'),0);assert.equal(child.stderr.listenerCount('data'),0);
 assert.doesNotThrow(()=>child.emit('error',Error('PRIVATE late error')));child.emit('close',null,'SIGKILL');assert.equal(child.listenerCount('error'),0);assert.equal(child.listenerCount('close'),0);
 const controller=new AbortController(),reason=0;let cancelledChild;
 const cancelled=adjustSpeechSpeed(wave(),1.15,{signal:controller.signal,...injected(()=>{cancelledChild=fakeProcess(()=>controller.abort(reason));cancelledChild.kill=()=>{throw Error('kill failed');};return cancelledChild;},{reapTimeoutMs:5})});
 await assert.rejects(cancelled,e=>e===reason);assert.doesNotThrow(()=>cancelledChild.emit('error',Error('late error')));cancelledChild.emit('close',null,'SIGKILL');assert.equal(cancelledChild.listenerCount('error'),0);
});

test('installed ffmpeg shortens a 2-second sine at 1.15x while retaining pitch',async t=>{
 const binary='/opt/homebrew/bin/ffmpeg';try{await access(binary,constants.X_OK);}catch{return t.skip('Local ffmpeg smoke requires the installed macOS binary');}
 const input=wave({seconds:2});const result=await adjustSpeechSpeed(input,1.15,{ffmpegPath:binary});
 const rate=result.readUInt32LE(24),length=result.readUInt32LE(40)/2,duration=length/rate;assert.ok(Math.abs(duration-2/1.15)<0.065,`duration ${duration}`);
 const start=Math.round(.08*rate),end=length-start;let crossings=0;
 for(let n=start+1;n<end;n++)if(result.readInt16LE(44+(n-1)*2)<=0&&result.readInt16LE(44+n*2)>0)crossings++;
 const frequency=crossings/((end-start)/rate);assert.ok(Math.abs(frequency-440)<2,`frequency ${frequency}`);assert.equal(rate,24000);assert.equal(result.readUInt16LE(22),1);
 t.diagnostic(JSON.stringify({originalSeconds:2,adjustedSeconds:duration,speed:1.15,frequencyHz:frequency,sampleRate:rate,speakerPlayback:false}));
});
