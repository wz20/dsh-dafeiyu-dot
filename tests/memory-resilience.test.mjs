import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../lib/memory.js';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'dafeiyu-memory-resilience-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'cache.json'),palaceRoot=join(root,'palace');
  return {store:new MemoryStore(path,{palaceRoot}),restart:()=>new MemoryStore(path,{palaceRoot})};
}
const source=(userText,observedAt)=>({sessionId:'companion',userEventId:observedAt,assistantEventId:'reply-'+observedAt,userText,observedAt});
const fact=(predicate,value,evidence,extra={})=>({spaceId:'owner',subject:'用户',predicate,value,evidence,content:predicate+'：'+value,...extra});

test('identity questions recall evidenced personal facts without guessing an identity from project names',async t=>{
  const {store}=await fixture(t);
  for(const [predicate,value] of [['称呼','小泽'],['职业','后端工程师'],['居住城市','北京']])await store.put({spaceId:'owner',subject:'用户',predicate,value,content:'用户'+predicate+'是'+value});
  await store.put({spaceId:'owner',subject:'用户',entity:'陪伴插件',predicate:'项目名称',value:'大肥鱼',content:'陪伴插件项目名称是大肥鱼'});
  await store.put({spaceId:'self',subject:'大肥鱼',predicate:'角色名称',value:'大肥鱼',content:'大肥鱼是一只鲸鱼娘'});
  for(const query of ['你知道我是谁吗','你了解我什么','我的个人档案']) {
    const rows=store.search(query,'owner');
    assert.deepEqual(new Set(rows.map(r=>r.value)),new Set(['小泽','后端工程师','北京']),query);
  }
  assert.equal(store.search('你知道我是谁吗','self').length,0);
});

test('programming-language values retain meaningful punctuation across consolidation and restart',async t=>{
  const f=await fixture(t);
  for(const value of ['C','C++','C#']) {
    const evidence='我掌握'+value;
    await f.store.consolidate([fact('掌握技能',value,evidence)],source(evidence,'2026-10-29T00:00:00.000Z'));
  }
  assert.deepEqual(f.restart().get().memories.filter(r=>r.status==='active').map(r=>r.value).sort(),['C','C++','C#'].sort());
  for(const value of ['C','C++','C#'])assert.deepEqual(f.restart().search(value,'owner').map(r=>r.value),[value]);
});

test('forgetting C++ does not block a distinct C fact or allow the forgotten value to return',async t=>{
  const f=await fixture(t),evidence='我掌握C++';
  const saved=(await f.store.consolidate([fact('掌握技能','C++',evidence)],source(evidence,'2026-10-29T00:00:00.000Z'))).saved[0];
  await f.store.remove(saved.id);const restored=f.restart();
  const allowed=await restored.consolidate([fact('掌握技能','C','我掌握C')],source('我掌握C','2026-10-29T00:01:00.000Z'));
  assert.equal(allowed.saved.length,1);
  const replay=await restored.consolidate([fact('掌握技能','C++',evidence)],source(evidence,'2026-10-29T00:02:00.000Z'));
  assert.equal(replay.skipped[0].reason,'forgotten');
  assert.deepEqual(restored.search('掌握技能').map(r=>r.value),['C']);
});

test('a delayed older job cannot supersede a newer single-value fact',async t=>{
  const f=await fixture(t),newEvidence='我现在住在杭州',oldEvidence='我住在北京';
  await f.store.consolidate([fact('居住城市','杭州',newEvidence)],source(newEvidence,'2026-10-29T00:02:00.000Z'));
  const delayed=await f.store.consolidate([fact('居住城市','北京',oldEvidence)],source(oldEvidence,'2026-10-29T00:01:00.000Z'));
  assert.equal(delayed.skipped[0].reason,'stale-source');
  assert.deepEqual(f.restart().search('居住城市').map(r=>r.value),['杭州']);
  const latestEvidence='我现在搬到天津';
  const latest=await f.store.consolidate([fact('居住城市','天津',latestEvidence,{operation:'update'})],source(latestEvidence,'2026-10-29T00:03:00.000Z'));
  assert.equal(latest.saved.length,1);assert.deepEqual(f.restart().search('居住城市').map(r=>r.value),['天津']);
});

test('older independent preferences are still admitted while stale explicit replacements are rejected',async t=>{
  const {store}=await fixture(t);
  await store.consolidate([fact('饮品偏好','茶','我喜欢茶')],source('我喜欢茶','2026-10-29T00:03:00.000Z'));
  const old=await store.consolidate([fact('饮品偏好','咖啡','我也喜欢咖啡')],source('我也喜欢咖啡','2026-10-29T00:01:00.000Z'));
  assert.equal(old.saved.length,1);
  const evidence='我不再喝茶，改喝咖啡';
  const stale=await store.consolidate([fact('饮品偏好','咖啡',evidence,{operation:'update'})],source(evidence,'2026-10-29T00:02:00.000Z'));
  assert.equal(stale.skipped[0].reason,'stale-source');
  assert.deepEqual(store.search('饮品').map(r=>r.value).sort(),['咖啡','茶']);
});

test('replaying an old confirmation does not make a manual fact newer than a subsequent user correction',async t=>{
  const {store}=await fixture(t),manual=await store.put({spaceId:'owner',subject:'用户',predicate:'居住城市',value:'北京',content:'用户住在北京'});
  const manualTime=Date.parse(manual.updatedAt),oldTime=new Date(manualTime-1000).toISOString(),newTime=new Date(manualTime+1).toISOString();
  await store.consolidate([fact('居住城市','北京','我住在北京')],source('我住在北京',oldTime));
  const latest=await store.consolidate([fact('居住城市','杭州','我现在搬到杭州',{operation:'update'})],source('我现在搬到杭州',newTime));
  assert.equal(latest.saved.length,1);assert.deepEqual(store.search('居住城市').map(r=>r.value),['杭州']);
});

test('explicit do-not-save wording is enforced at the store boundary as well as extraction',async t=>{
  const {store}=await fixture(t),text='不保存本轮，我喜欢咖啡';
  const result=await store.consolidate([fact('饮品偏好','咖啡','我喜欢咖啡')],source(text,'2026-10-29T00:00:00.000Z'));
  assert.equal(result.skipped[0].reason,'user-opt-out');assert.equal(store.status().memoryCount,0);
});
