import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigStore} from '../lib/config.js';

test('QQ group whitelist persists explicit opt-ins and preserves private voice settings',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-group-config-'));
  const store=new ConfigStore(join(root,'config.json'));
  await store.update({tts:{autoRead:false},qq:{groups:[{id:'40004',name:'陪伴群',enabled:true}]}});
  const saved=new ConfigStore(join(root,'config.json')).get();
  assert.deepEqual(saved.qq.groups,[{id:'40004',name:'陪伴群',enabled:true}]);
  assert.equal(saved.tts.autoRead,false);assert.equal(saved.qq.voiceReplies,true);
  for(const groups of [[{id:'../owner',name:'bad',enabled:true}],[{id:'40004',name:'a',enabled:'yes'}],[{id:'40004',name:'a',enabled:true},{id:'40004',name:'b',enabled:true}],Array(21).fill({id:'40004',name:'a',enabled:true})])
    await assert.rejects(store.update({qq:{groups}}));
  assert.equal(store.get().qq.groups.length,1);
});
