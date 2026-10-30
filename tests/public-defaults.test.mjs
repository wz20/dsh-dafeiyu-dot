import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,ConfigStore,validatePatch} from '../lib/config.js';

test('new installations choose their own voice and start with manual audio controls',()=>{
  const c=defaultConfig();assert.equal(c.tts.localVoice,'');assert.equal(c.tts.autoRead,false);assert.equal(c.widget.soundEnabled,false);
  assert.equal(c.qq.ownerId,'');assert.equal(c.qq.botId,'');assert.equal(c.qq.sessionId,'');assert.deepEqual(c.qq.groups,[]);
  assert.doesNotThrow(()=>validatePatch(c,c));
});
test('loading local configuration preserves the selected voice and established preferences',async t=>{
  const root=await mkdtemp(join(tmpdir(),'companion-local-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const c=defaultConfig();c.tts.localVoice='fixture-selected-voice';c.tts.speed=1.25;c.widget.soundEnabled=true;
  const file=join(root,'config.json');await writeFile(file,JSON.stringify(c));const store=new ConfigStore(file);
  assert.equal(store.get().tts.localVoice,'fixture-selected-voice');assert.equal(store.get().tts.speed,1.25);assert.equal(store.get().widget.soundEnabled,true);
});
