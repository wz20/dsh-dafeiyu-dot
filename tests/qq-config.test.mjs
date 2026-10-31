import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultConfig,validatePatch,ConfigStore} from '../lib/config.js';

test('QQ stays disabled until a session is selected and accepts only local credential-free websocket endpoints',()=>{
 const base=defaultConfig();assert.equal(base.qq.enabled,false);assert.equal(base.qq.ownerId,'');
 assert.throws(()=>validatePatch(base,{qq:{enabled:true}}),/会话/);
 for(const wsUrl of ['ws://remote.example:3001','wss://127.0.0.1.evil.test','ws://user:secret@localhost','ws://127.0.0.1:13001?access_token=secret','http://localhost:13001'])assert.throws(()=>validatePatch(base,{qq:{wsUrl}}));
 const next=validatePatch(base,{qq:{enabled:true,sessionId:'session-one',wsUrl:'ws://127.0.0.1:13001',voiceReplies:true}});
 assert.equal(next.qq.enabled,true);assert.equal(next.qq.voiceReplies,true);assert.equal(next.tts.localVoice,'');
 assert.equal(validatePatch(base,{qq:{wsUrl:'ws://[::1]:13001'}}).qq.wsUrl,'ws://[::1]:13001');
});

test('QQ identifiers and booleans are validated; gateway credentials never enter config JSON',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-qq-config-')),path=join(root,'config.json'),store=new ConfigStore(path);
 for(const patch of [{qq:[]},{qq:{enabled:'yes'}},{qq:{voiceReplies:1}},{qq:{ownerId:'friend'}},{qq:{botId:'123\n456'}},{qq:{sessionId:'session\nother'}}])await assert.rejects(store.update(patch));
 await store.update({qq:{botId:'12345678',ownerId:'87654321',sessionId:'session-one'},qqToken:'private-gateway-token'});
 const reopened=new ConfigStore(path);assert.equal(reopened.get().qq.ownerId,'87654321');
 assert.doesNotMatch(await readFile(path,'utf8'),/private-gateway-token|qqToken/);
});

test('QQ sticker replies can be controlled independently from voice and keep typed configuration',()=>{
 const base=defaultConfig();assert.equal(base.qq.stickerReplies,true);
 const next=validatePatch(base,{qq:{stickerReplies:false}});assert.equal(next.qq.stickerReplies,false);assert.equal(next.qq.voiceReplies,true);
 assert.throws(()=>validatePatch(base,{qq:{stickerReplies:'yes'}}),/开关/);
});

test('NapCat management address is a credential-free loopback origin and the key stays outside JSON',async()=>{
 const base=defaultConfig();assert.equal(base.qq.napcatUrl,'http://127.0.0.1:16099');
 for(const napcatUrl of ['https://remote.example','http://127.0.0.1.evil.test','http://user:secret@localhost:16099','http://localhost:16099?token=secret','http://localhost:16099/webui','file:///tmp/napcat','http://localhost:16099/#token'])assert.throws(()=>validatePatch(base,{qq:{napcatUrl}}));
 assert.equal(validatePatch(base,{qq:{napcatUrl:'http://[::1]:16099/'}}).qq.napcatUrl,'http://[::1]:16099');
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-napcat-config-')),path=join(root,'config.json'),store=new ConfigStore(path);
 await store.update({qq:{napcatUrl:'http://localhost:16099'},napcatToken:'synthetic-napcat-secret'});
 assert.equal(new ConfigStore(path).get().qq.napcatUrl,'http://localhost:16099');
 assert.doesNotMatch(await readFile(path,'utf8'),/synthetic-napcat-secret|napcatToken/);
});
