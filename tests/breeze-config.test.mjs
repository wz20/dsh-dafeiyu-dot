import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,validatePatch,ConfigStore} from '../lib/config.js';

test('new Breeze settings preserve the existing local and OpenAI defaults',()=>{
 const config=defaultConfig();
 assert.equal(config.tts.source,'local');assert.equal(config.tts.apiProvider,'openai');
 assert.equal(config.tts.breezeUrl,'https://api.breeze.blue/v1');assert.equal(config.tts.breezeModel,'breeze-tts-2');assert.equal(config.tts.breezeVoice,'');
 const next=validatePatch(config,{tts:{source:'api',apiProvider:'breezeblue',breezeVoice:'voc_demo_voice'}});
 assert.equal(next.tts.apiUrl,config.tts.apiUrl);assert.equal(next.tts.apiVoice,config.tts.apiVoice);assert.equal(next.tts.localVoice,config.tts.localVoice);
 assert.equal(validatePatch(next,{tts:{apiProvider:'openai'}}).tts.breezeVoice,'voc_demo_voice');
});

test('Breeze endpoint protects credentials in transit and accepts explicit loopback proxies',()=>{
 for(const breezeUrl of ['http://external.example/v1','https://user:key@api.breeze.blue/v1','https://api.breeze.blue/v1?key=secret','https://api.breeze.blue/v1#key','file:///tmp/tts'])assert.throws(()=>validatePatch(defaultConfig(),{tts:{breezeUrl}}));
 for(const breezeUrl of ['https://api.breeze.blue/v1/','http://127.0.0.1:3999/v1/','http://[::1]:3999/v1'])assert.equal(validatePatch(defaultConfig(),{tts:{breezeUrl}}).tts.breezeUrl,breezeUrl.replace(/\/$/,''));
 assert.throws(()=>validatePatch(defaultConfig(),{tts:{apiProvider:'unknown'}}));
 assert.throws(()=>validatePatch(defaultConfig(),{tts:{breezeModel:''}}));
 assert.throws(()=>validatePatch(defaultConfig(),{tts:{breezeModel:'m'.repeat(121)}}));
 assert.throws(()=>validatePatch(defaultConfig(),{tts:{breezeVoice:'../other'}}));
 assert.equal(validatePatch(defaultConfig(),{tts:{breezeVoice:''}}).tts.breezeVoice,'');
});

test('old configurations migrate to OpenAI protocol and provider secrets never enter JSON',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-breeze-config-')),path=join(root,'config.json');
 await writeFile(path,JSON.stringify({tts:{source:'api',apiUrl:'https://compatible.example/v1',apiModel:'custom-model',apiVoice:'custom-voice'}}));
 const store=new ConfigStore(path);assert.equal(store.get().tts.apiProvider,'openai');assert.equal(store.get().tts.apiVoice,'custom-voice');
 await store.update({tts:{apiProvider:'breezeblue',breezeVoice:'voc_demo_voice'},breezeApiKey:'synthetic-breeze-key'});
 const saved=await readFile(path,'utf8');assert.doesNotMatch(saved,/synthetic-breeze-key|breezeApiKey/);assert.equal(new ConfigStore(path).get().tts.breezeVoice,'voc_demo_voice');
});
