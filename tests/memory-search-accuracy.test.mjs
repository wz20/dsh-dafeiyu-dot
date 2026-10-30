import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../lib/memory.js';
import {seedMemorySearchFacts,evaluateMemorySearch} from './fixtures/memory-search-cases.mjs';

test('structured retrieval separates project, environment, attribute, polarity and time across paraphrases',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-retrieval-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'cache.json'),palaceRoot=join(root,'palace'),store=new MemoryStore(path,{palaceRoot});
  await seedMemorySearchFacts(store);
  const result=evaluateMemorySearch(new MemoryStore(path,{palaceRoot}));
  console.log(JSON.stringify({retrievalSyntheticEvaluation:{cases:result.cases,exactCases:result.exactCases,precisionAt6:result.precisionAt6,recallAt6:result.recallAt6,hitAt1:result.hitAt1}}));
  assert.deepEqual(result.rows.filter(row=>!row.exact),[]);
});

test('literal entity matching preserves significant programming-language symbols',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-symbol-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  for(const entity of ['C','C++','C#'])await store.put({spaceId:'owner',subject:'用户',entity,predicate:'项目名称',value:entity,content:entity+'项目名称：'+entity});
  assert.deepEqual(store.search('C++项目叫什么').map(row=>row.entity),['C++']);
  assert.deepEqual(store.search('C#项目叫什么').map(row=>row.entity),['C#']);
  assert.deepEqual(store.search('C项目叫什么').map(row=>row.entity),['C']);
});

test('explicit quoted project names use their own records and unknown names have no borrowed configuration',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-named-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  await seedMemorySearchFacts(store);
  assert.deepEqual(store.search('「晨星」项目生产环境端口是多少').map(row=>row.value),['8088']);
  assert.deepEqual(store.search('「银河」项目生产环境端口是多少'),[]);
  assert.deepEqual(store.search('项目“银河”的服务地址是什么'),[]);
});

test('environment constraints require an environment request rather than an incidental shared word',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-scope-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  await seedMemorySearchFacts(store);
  await store.put({spaceId:'owner',subject:'用户',entity:'晨星',scope:'开发',predicate:'服务端口',value:'38088',content:'晨星开发环境服务端口38088'});
  await store.put({spaceId:'owner',subject:'用户',scope:'工作',predicate:'回复语言',value:'英文',content:'工作场景回复语言：英文'});
  assert.deepEqual(store.search('晨星开发语言是什么').map(row=>row.value),['Python']);
  assert.deepEqual(store.search('这是一个测试。晨星生产环境端口是什么').map(row=>row.value),['8088']);
  assert.deepEqual(store.search('这是一个测试。插件项目叫什么名字').map(row=>row.value).sort(),['晨星','晚潮'].sort());
  assert.deepEqual(store.search('我从事什么工作').map(row=>row.value),['工程师']);
});

test('related personal attributes stay distinct when a question uses conversational wording',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-attribute-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  await seedMemorySearchFacts(store);
  await store.put({spaceId:'owner',subject:'用户',predicate:'家乡',value:'合肥',content:'用户家乡在合肥'});
  assert.deepEqual(store.search('你和我聊天用什么语言').map(row=>row.value),['中文']);
  assert.deepEqual(store.search('晨星使用什么语言').map(row=>row.value),['Python']);
  assert.deepEqual(store.search('我的家乡是哪儿').map(row=>row.value),['合肥']);
  assert.deepEqual(store.search('我现在住哪儿').map(row=>row.value),['杭州']);
});

test('literal keyword searches preserve full-text notes and historical records',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-fulltext-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  const note=await store.put({spaceId:'owner',subject:'用户',predicate:'备注',content:'请使用中文和我交流'});
  const config=await store.put({spaceId:'owner',subject:'用户',entity:'晨星',predicate:'项目配置',content:'晨星的服务端口是8088'});
  await store.put({spaceId:'owner',subject:'用户',predicate:'曾经居住城市',value:'苏州',content:'用户以前住在苏州'});
  await store.put({spaceId:'owner',subject:'用户',predicate:'居住城市',value:'杭州',content:'用户现在住在杭州'});
  assert.deepEqual(store.search('中文').map(record=>record.id),[note.id]);
  assert.deepEqual(store.search('端口').map(record=>record.id),[config.id]);
  assert.deepEqual(store.search('居住城市').map(record=>record.value).sort(),['杭州','苏州'].sort());
});

test('a question asking for both preferred and avoided drinks retains both constraints',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-polarity-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  await seedMemorySearchFacts(store);
  assert.deepEqual(store.search('我喜欢什么饮料，有什么不喝').map(record=>record.value).sort(),['热茶','不喝咖啡'].sort());
});

test('a question comparing earlier and current residence retains both time frames',async t=>{
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-time-search-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new MemoryStore(join(root,'cache.json'));
  await seedMemorySearchFacts(store);
  assert.deepEqual(store.search('我以前住在哪，现在住哪').map(record=>record.value).sort(),['杭州','苏州'].sort());
});
