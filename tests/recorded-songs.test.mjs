import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSinging } from '../lib/singing.js';

function wav(){
  const audio=Buffer.alloc(16044);
  audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(16000,40);
  return audio;
}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'bigfish-recording-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const audio=wav(),entry={id:'approved-song',song:'朋友的酒',aliases:['朋友的酒清唱'],audioFile:'approved.wav',sha256:createHash('sha256').update(audio).digest('hex'),approved:true};
  await writeFile(join(root,entry.audioFile),audio);
  const catalog={version:1,defaultRecordingId:entry.id,recordings:[entry]};
  const save=()=>writeFile(join(root,'recorded-songs.json'),JSON.stringify(catalog));await save();
  const agent={id:'one',session:{header:{agentPreset:'whale'},snapshotEvents:()=>[]}};
  let networkCalls=0;
  const service=createSinging({},{root,settings:{provider:'boson',enabled:false},getConfig:()=>{throw Error('voice configuration must not be read');},readKey:()=>{throw Error('credential must not be read');},fetch:()=>{networkCalls++;throw Error('network must not be used');}});
  return {root,audio,entry,catalog,save,agent,service,networkCalls:()=>networkCalls};
}

test('approved default and named recording reuse the exact audio with generation disabled',async t=>{
  const f=await fixture(t),catalog=await f.service.listReferences({agent:f.agent});
  assert.equal(catalog.defaultRecordingId,f.entry.id);assert.equal(catalog.recordings[0].song,'朋友的酒');assert.equal(catalog.recordings[0].audioFile,undefined);
  const first=await f.service.generate({}, {agent:f.agent});
  const second=await f.service.generate({song:'《朋友的酒清唱》',mode:'recorded'},{agent:f.agent});
  assert.notEqual(first.songId,second.songId);assert.equal(first.mode,'recorded');assert.equal(first.durationSeconds,1);
  assert.deepEqual((await f.service.read(first.songId,'one')).audio,f.audio);
  assert.deepEqual((await f.service.read(second.songId,'one')).audio,f.audio);
  assert.deepEqual(first.acceptance,{listening:'user-approved'});assert.equal(f.networkCalls(),0);
  const metadata=JSON.parse(await readFile(join(f.root,'songs',first.songId,'metadata.json'),'utf8'));
  assert.equal(metadata.service,'local-recording');assert.equal(metadata.sessionId,'one');
  await assert.rejects(f.service.read(first.songId,'other'),{status:404});
});

test('recorded playback cannot substitute a different song or accept model supplied audio and lyrics',async t=>{
  const f=await fixture(t);
  for(const args of [{song:'另一首歌'},{song:'另一首歌',recordingId:f.entry.id},{recordingId:'unknown'},{audioFile:'/tmp/arbitrary.wav'},{lyrics:'替换的歌词'}]){
    await assert.rejects(f.service.generate({...args,mode:'recorded'},{agent:f.agent}));
  }
  f.entry.approved=false;await f.save();
  assert.deepEqual((await f.service.listReferences({agent:f.agent})).recordings,[]);
  await assert.rejects(f.service.generate({}, {agent:f.agent}),{status:404});assert.equal(f.networkCalls(),0);
});

test('recording approval is bound to the source bytes and copied playback remains checked',async t=>{
  const f=await fixture(t),song=await f.service.generate({}, {agent:f.agent});
  const changed=Buffer.from(f.audio);changed.writeInt16LE(1,44);
  await writeFile(join(f.root,f.entry.audioFile),changed);
  await assert.rejects(f.service.generate({}, {agent:f.agent}),/已确认版本不一致/);
  await writeFile(join(f.root,'songs',song.songId,'song.wav'),changed);
  await assert.rejects(f.service.read(song.songId,'one'),/已确认版本不一致/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.service.generate({}, {agent:f.agent,signal:controller.signal}));
  f.agent.session.header.agentPreset='standard';
  await assert.rejects(f.service.generate({}, {agent:f.agent}),{status:409});assert.equal(f.networkCalls(),0);
});
