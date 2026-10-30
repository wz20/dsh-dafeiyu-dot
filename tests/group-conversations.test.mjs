import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGroupConversations} from '../lib/group-conversations.js';
import {MemoryStore} from '../lib/memory.js';

async function environment(root) {
  root??=await mkdtemp(join(tmpdir(),'dafeiyu-group-context-'));
  const values={qq:{groups:[{id:'40004',name:'陪伴群',enabled:true},{id:'50005',name:'另一个群',enabled:true}]},memory:{enabled:true}};
  const agents=new Map(),created=[],lifecycles=[];let reconciled=0;
  const ctx={agents:{get:id=>agents.get(id)},effect:()=>{},sessionController:{create:async spec=>{
    created.push(spec);const id='group-session-'+created.length;
    agents.set(id,{id,session:{header:{agentPreset:spec.agentPreset},snapshotEvents:()=>[]}});return {sessionId:id};
  }}};
  const options={root,palaceRoot:join(root,'palace'),config:{get:()=>values},onReady:()=>reconciled++,installLifecycle:(_ctx,store,_config,scope)=>{
    const lifecycle={store,scope,reconcile:async()=>{},dispose(){}};lifecycles.push(lifecycle);return lifecycle;
  }};
  const groups=createGroupConversations(ctx,options),owner=new MemoryStore(join(root,'owner.json'));
  return {root,groups,owner,ctx,agents,created,values,lifecycles,options,reconciled:()=>reconciled};
}

test('group conversations create fresh restricted sessions once, with separate member and group stores',async()=>{
  const e=await environment();await e.owner.put({spaceId:'owner',content:'私人项目资料'});
  const [a,same]=await Promise.all([e.groups.ensure({groupId:'40004',senderId:'20002'}),e.groups.ensure({groupId:'40004',senderId:'20002'})]);
  assert.equal(a.sessionId,same.sessionId);assert.equal(e.created.length,1);assert.equal(e.created[0].agentPreset,'whale-group');assert.ok(e.reconciled()>0);
  const b=await e.groups.ensure({groupId:'40004',senderId:'30003'}),c=await e.groups.ensure({groupId:'50005',senderId:'20002'});
  const first=e.groups.resolveStore(e.agents.get(a.sessionId),e.owner);
  assert.equal(first.search('私人').length,0);await first.put({spaceId:'owner',content:'喜欢热茶'});
  assert.equal(e.groups.resolveStore(e.agents.get(b.sessionId),e.owner).search('热茶').length,0);
  assert.equal(e.groups.resolveStore(e.agents.get(c.sessionId),e.owner).search('热茶').length,0);
  assert.equal(e.owner.search('热茶').length,0);
  assert.equal(e.lifecycles[0].scope.acceptAgent(e.agents.get(a.sessionId)),true);
  assert.equal(e.lifecycles[0].scope.acceptAgent(e.agents.get(b.sessionId)),false);
});

test('each concurrent waiter can cancel independently without waiting for group creation',async()=>{
  const e=await environment();const create=e.ctx.sessionController.create;let release,entered;
  const ready=new Promise(resolve=>entered=resolve);
  e.ctx.sessionController.create=async spec=>{entered();await new Promise(resolve=>release=resolve);return create(spec);};
  const first=e.groups.ensure({groupId:'40004',senderId:'20002'});await ready;
  const controller=new AbortController();const second=e.groups.ensure({groupId:'40004',senderId:'20002'},{signal:controller.signal});
  controller.abort();const outcome=second.then(()=>false,e=>e.name==='AbortError');
  release();assert.equal(await outcome,true);assert.ok((await first).sessionId);
});

test('one corrupt group palace cannot prevent private memory or other group members from opening',async()=>{
  const e=await environment();const first=await e.groups.ensure({groupId:'40004',senderId:'20002'});
  const store=e.groups.resolveStore(e.agents.get(first.sessionId),e.owner);await writeFile(join(store.palaceRoot,'.state/state.json'),'{bad json');
  let reopened;assert.doesNotThrow(()=>reopened=createGroupConversations(e.ctx,e.options));
  const privateAgent={id:'private',session:{header:{agentPreset:'whale'}}};assert.equal(reopened.resolveStore(privateAgent,e.owner),e.owner);
  await assert.rejects(reopened.ensure({groupId:'40004',senderId:'20002'}));
  assert.ok((await reopened.ensure({groupId:'40004',senderId:'30003'})).sessionId);
});

test('disabled or missing group mappings never resolve to private memory, including after restart',async()=>{
  const e=await environment();const a=await e.groups.ensure({groupId:'40004',senderId:'20002'});
  const store=e.groups.resolveStore(e.agents.get(a.sessionId),e.owner);await store.put({spaceId:'owner',content:'喜欢热茶'});
  const reopened=createGroupConversations(e.ctx,e.options);assert.equal((await reopened.ensure({groupId:'40004',senderId:'20002'})).sessionId,a.sessionId);
  assert.equal(reopened.resolveStore(e.agents.get(a.sessionId),e.owner).search('热茶').length,1);assert.equal(e.created.length,1);
  e.values.qq.groups=[];assert.throws(()=>e.groups.resolveStore(e.agents.get(a.sessionId),e.owner));assert.equal(e.groups.isGroupSession(a.sessionId),true);
  await assert.rejects(e.groups.ensure({groupId:'40004',senderId:'20002'}));
  assert.throws(()=>e.groups.resolveStore({id:'unregistered',session:{header:{agentPreset:'whale-group'}}},e.owner));
  e.agents.get(a.sessionId).session.header.agentPreset='whale';assert.throws(()=>e.groups.resolveStore(e.agents.get(a.sessionId),e.owner));
  const privateAgent={id:'private',session:{header:{agentPreset:'whale'}}};assert.equal(e.groups.resolveStore(privateAgent,e.owner),e.owner);
});
