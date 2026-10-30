import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../lib/memory.js';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dafeiyu-palace-quality-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'cache.json'),palaceRoot=join(root,'记忆宫殿');return {root,path,palaceRoot,store:new MemoryStore(path,{palaceRoot}),restart:()=>new MemoryStore(path,{palaceRoot})};}
const source=(text,sessionId='session-a',userEventId='user-a')=>({sessionId,userEventId,assistantEventId:'assistant-'+userEventId,userText:text,assistantText:'主人，我记住了。'});
const fact=(value='拿铁',extra={})=>({spaceId:'owner',content:'主人喜欢喝'+value,subject:'主人',predicate:'饮品偏好',value,evidence:'我喜欢喝'+value,tags:['饮品','偏好'],...extra});

test('confirmed facts persist in independent Markdown and are recalled across sessions and restart',async t=>{
  const f=await fixture(t),out=await f.store.consolidate([fact()],source('我喜欢喝拿铁'));
  assert.equal(out.saved.length,1);const saved=out.saved[0];assert.match(await readFile(saved.filePath,'utf8'),/我喜欢喝拿铁/);
  const result=f.restart().search('我平时爱喝什么','owner');assert.equal(result[0].id,saved.id);assert.ok(result[0].score>0);assert.equal(result[0].source.sessionId,'session-a');assert.equal(result[0].source.userEventId,'user-a');assert.equal(result[0].source.evidence,'我喜欢喝拿铁');assert.doesNotMatch(JSON.stringify(result),/assistantText|userText/);
});

test('CJK and alias ranking retrieves paraphrased beverage preferences above unrelated preferences',async t=>{
  const {store}=await fixture(t);await store.consolidate([fact()],source('我喜欢喝拿铁'));
  await store.put({spaceId:'owner',subject:'主人',predicate:'颜色偏好',value:'蓝色',content:'主人喜欢蓝色',tags:['颜色']});
  await store.put({spaceId:'self',content:'大肥鱼喜欢吃白米饭',tags:['饮食']});
  assert.equal(store.search('偏爱哪一种饮料')[0].value,'拿铁');assert.equal(store.search('coffee')[0].value,'拿铁');assert.equal(store.search('完全无关的火箭发动机').length,0);
});

test('same fact with canonical subject/predicate aliases merges evidence without duplicating inventory',async t=>{
  const {store}=await fixture(t);const a=(await store.consolidate([fact()],source('我喜欢喝拿铁'))).saved[0];
  const duplicate=fact('拿铁',{subject:'我',predicate:'爱喝',content:'我爱喝拿铁',evidence:'我爱喝拿铁'});
  const b=await store.consolidate([duplicate],source('我爱喝拿铁','session-b','user-b'));
  assert.equal(b.saved.length,0);assert.equal(b.merged[0].id,a.id);assert.equal(store.status().memoryCount,1);assert.equal(store.getRecord(a.id).sources.length,2);
});

test('explicit corrections create a fact version chain and only latest value is recalled',async t=>{
  const f=await fixture(t),old=(await f.store.consolidate([fact()],source('我喜欢喝拿铁'))).saved[0];
  const evidence='我改喝热可可，不再喝拿铁';const latest=(await f.store.consolidate([fact('热可可',{operation:'update',evidence})],source(evidence,'session-b','user-b'))).saved[0];
  assert.equal(latest.supersedes,old.id);assert.equal(f.store.getRecord(old.id).status,'superseded');assert.equal(f.store.getRecord(old.id).supersededBy,latest.id);
  const current=f.restart().search('饮料偏好');assert.equal(current.length,1);assert.equal(current[0].value,'热可可');assert.equal(f.store.index().corrections.length,2);
});

test('forgetting removes the entire correction chain and tombstones block copied files and replay extraction',async t=>{
  const f=await fixture(t),old=(await f.store.consolidate([fact()],source('我喜欢喝拿铁'))).saved[0],raw=await readFile(old.filePath,'utf8');
  const evidence='我改喝热可可，不再喝拿铁';const latest=(await f.store.consolidate([fact('热可可',{operation:'update',evidence})],source(evidence,'session-b','user-b'))).saved[0];
  await f.store.remove(latest.id);await writeFile(old.filePath,raw);await f.store.rebuildIndex();
  assert.equal(f.store.search('饮品').length,0);assert.equal(f.store.getRecord(old.id),null);assert.equal(f.restart().status().memoryCount,0);
  const replay=await f.store.consolidate([fact()],source('我喜欢喝拿铁','session-c','user-c'));assert.equal(replay.saved.length,0);assert.equal(replay.skipped[0].reason,'forgotten');
  const explicit=await f.restart().put({spaceId:'owner',content:'主人喜欢喝拿铁'});assert.equal(f.restart().getRecord(explicit.id).confirmed,true);assert.equal(f.restart().status().memoryCount,1);
});

test('deleting JSON indexes rebuilds current facts and navigation from authoritative Markdown',async t=>{
  const f=await fixture(t);const saved=await f.store.put({spaceId:'owner',subject:'主人',predicate:'回复语言',content:'主人习惯使用中文交流',tags:['沟通']});
  await unlink(f.path);await unlink(join(f.palaceRoot,'.state','index.json'));const restored=f.restart();assert.equal(restored.search('汉语')[0].id,saved.id);
  const index=restored.index();assert.equal(index.people[0].name,'主人');assert.equal(index.topics[0].name,'沟通');assert.equal(index.dates[0].ids[0],saved.id);assert.match(await readFile(join(f.palaceRoot,'索引','人物.md'),'utf8'),/主人/);
});

test('an invalid derived JSON cache is recoverable while palace facts and forget tombstones remain authoritative',async t=>{
  const f=await fixture(t),active=await f.store.put({spaceId:'owner',content:'主人愿意把日常趣事分享给大肥鱼'}),forgotten=await f.store.put({spaceId:'self',content:'一段准备忘记的旧事'});
  await f.store.remove(forgotten.id);await writeFile(f.path,'{"interrupted":');const restored=f.restart();
  assert.equal(restored.getRecord(active.id).content,active.content);assert.equal(restored.getRecord(forgotten.id),null);assert.equal(restored.status().memoryCount,1);assert.ok(JSON.parse(await readFile(f.path,'utf8')).memories.length===1);
});

test('human Markdown edits are reindexed with provenance and revisions, including edits made while host was closed',async t=>{
  const f=await fixture(t),saved=await f.store.put({spaceId:'owner',content:'主人住在北京'}),raw=await readFile(saved.filePath,'utf8');
  await writeFile(saved.filePath,raw.replace(/\n\n主人住在北京\n$/,'\n\n主人住在杭州\n'));
  const updated=f.restart().getRecord(saved.id);assert.equal(updated.content,'主人住在杭州');assert.equal(updated.value,'主人住在杭州');assert.equal(updated.source.kind,'manual-edit');assert.equal(updated.revisions.at(-1).content,'主人住在北京');assert.equal(f.restart().search('杭州')[0].id,saved.id);
});

test('manual CRUD preserves full inventory under concurrency and moving a record changes its palace space',async t=>{
  const f=await fixture(t),saved=await Promise.all(Array.from({length:12},(_,i)=>f.store.put({spaceId:i%2?'self':'owner',content:'第'+i+'件值得记住的事情'})));
  assert.equal(f.store.status().memoryCount,12);await f.store.put({id:saved[0].id,spaceId:'self',content:'主人认可大肥鱼的认真'});
  const restarted=f.restart();assert.equal(restarted.getRecord(saved[0].id).spaceId,'self');assert.equal(restarted.search('认可','owner').length,0);assert.equal(restarted.status().memoryCount,12);
});

test('recall limits bound returned fragments while retaining the complete permanent inventory',async t=>{
  const f=await fixture(t),long='主人记录的一段长期经历。'.repeat(300);const saved=await f.store.put({spaceId:'owner',content:long});
  const result=f.store.search('长期经历')[0];assert.equal(result.truncated,true);assert.ok(result.content.length<=1200);assert.equal(result.contentLength,long.length);assert.equal(f.store.getRecord(saved.id).content,long);
  for(let batch=0;batch<7;batch++){
    const facts=Array.from({length:32},(_,i)=>{const value='事项'+(batch*32+i);return fact(value,{predicate:'独立事项'+value,evidence:'我确认'+value,content:'主人确认'+value,tags:['经历']});});
    await f.store.consolidate(facts,source(facts.map(x=>x.evidence).join('，'),'inventory','batch-'+batch));
  }
  assert.equal(f.store.status().memoryCount,225);assert.equal(f.store.search('').length,200);assert.equal(f.restart().get().memories.length,225);
});

test('automatic memory requires original user evidence and rejects invented, uncertain, test and credential facts',async t=>{
  const {store}=await fixture(t);
  assert.equal((await store.consolidate([fact()],source('今天天气不错'))).skipped[0].reason,'unverified-evidence');
  assert.equal((await store.consolidate([fact('美式',{evidence:'我喜欢喝拿铁'})],source('我喜欢喝拿铁'))).skipped[0].reason,'unverified-value');
  assert.equal((await store.consolidate([fact('拿铁',{evidence:'我可能喜欢喝拿铁'})],source('我可能喜欢喝拿铁'))).skipped[0].reason,'uncertain');
  assert.equal((await store.consolidate([fact()],source('测试口令：我喜欢喝拿铁'))).skipped[0].reason,'test-source');
  const secret='sk-abcdefghijklmnopqrstuv';const candidate=fact(secret,{predicate:'API密钥',content:'API密钥：'+secret,evidence:'我的API密钥：'+secret});assert.equal((await store.consolidate([candidate],source(candidate.evidence))).skipped[0].reason,'sensitive');
  assert.equal(store.status().memoryCount,0);
});

test('fact evidence preserves negative and historical meaning even when only the value was quoted',async t=>{
  const {store}=await fixture(t);
  assert.equal((await store.consolidate([fact('咖啡',{evidence:'咖啡'})],source('我不喜欢咖啡'))).skipped[0].reason,'meaning-mismatch');
  assert.equal((await store.consolidate([fact('咖啡',{evidence:'以前我喜欢喝咖啡'})],source('以前我喜欢喝咖啡'))).skipped[0].reason,'meaning-mismatch');
  const negative=await store.consolidate([fact('不喜欢咖啡',{evidence:'我不喜欢咖啡'})],source('我不喜欢咖啡'));assert.equal(negative.saved.length,1);assert.match(negative.saved[0].content,/不喜欢咖啡/);
});

test('forget tombstones remain scoped to the relevant memory space',async t=>{
  const f=await fixture(t),a=await f.store.put({spaceId:'owner',content:'珍惜共同的回忆'}),b=await f.store.put({spaceId:'self',content:'珍惜共同的回忆'});
  await f.store.remove(a.id);assert.equal(f.restart().getRecord(b.id).spaceId,'self');assert.equal(f.restart().status().memoryCount,1);
});

test('legacy import retains source and space, marks test material, and is idempotent after restart',async t=>{
  const f=await fixture(t),legacy=join(f.root,'old'),folder=join(legacy,'default');await mkdir(folder,{recursive:true});
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(folder,'mnemon.db'));
  db.exec('CREATE TABLE insights(id TEXT,content TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT)');const insert=db.prepare('INSERT INTO insights VALUES(?,?,?,?,NULL)');insert.run('one','大肥鱼喜欢白米饭','2026-10-01','2026-10-01');insert.run('test','验收口令：主人喜欢绿色','2026-10-01','2026-10-01');insert.run('phrase','配置测试验收暗号：海洋之蓝','2026-10-01','2026-10-01');db.close();
  assert.equal((await f.store.importLegacy(legacy)).imported,3);assert.equal(f.store.search('白米饭','self')[0].source.kind,'mnemon');assert.equal(f.store.search('绿色').length,0);assert.equal(f.store.search('海洋之蓝').length,0);assert.equal(f.store.getRecord('mnemon:default:test').testOnly,true);assert.equal(f.store.getRecord('mnemon:default:phrase').testOnly,true);assert.equal((await f.restart().importLegacy(legacy)).imported,0);
});

test('durable consolidation jobs deduplicate, retry and preserve completed receipts across restart',async t=>{
  const f=await fixture(t),payload={key:'stable-event-key',source:source('我喜欢喝拿铁'),route:{provider:'deepseek',model:'flash'}};
  const [a,b]=await Promise.all([f.store.createJob(payload),f.store.createJob(payload)]);assert.equal(a.id,b.id);assert.equal(f.store.pendingJobs().length,1);
  await f.store.startJob(a.id);await f.store.failJob(a.id,{error:'暂时没有连上',retryable:true,nextRetryAt:new Date(Date.now()-1000).toISOString()});assert.equal(f.restart().pendingJobs()[0].attempts,1);
  await f.store.retryJob(a.id);await f.store.completeJob(a.id,{saved:1});const restored=f.restart();assert.equal(restored.pendingJobs().length,0);assert.equal((await restored.createJob(payload)).id,a.id);assert.equal(restored.get().jobs[0].source.userText,undefined);assert.equal(restored.status().jobs.completed,1);
});

test('parallel preferences and later additions remain independently recallable',async t=>{
  const f=await fixture(t),text='我喜欢咖啡，也喜欢茶';
  await f.store.consolidate([fact('咖啡',{evidence:'我喜欢咖啡'}),fact('茶',{evidence:'也喜欢茶'})],source(text));
  await f.store.consolidate([fact('热可可',{evidence:'我还喜欢热可可'})],source('我还喜欢热可可','session-b','user-b'));
  assert.deepEqual(f.restart().search('饮品偏好').map(r=>r.value).sort(),['咖啡','热可可','茶'].sort());assert.equal(f.store.index().corrections.length,0);
});

test('unknown relation slots conserve skills and shared experiences without a preference allowlist',async t=>{
  const {store}=await fixture(t);
  for(const value of ['Java','Python']){const evidence='我会'+value;await store.consolidate([fact(value,{predicate:'掌握技能',evidence})],source(evidence,'skills',value));}
  for(const value of ['一起修复语音','一起整理账单']){const evidence='我们'+value;await store.consolidate([fact(value,{spaceId:'self',subject:'共同经历',predicate:'共同经历',evidence})],source(evidence,'events',value));}
  assert.equal(store.get().memories.filter(r=>r.status==='active').length,4);assert.equal(store.index().corrections.length,0);
});

test('a correction retires only the named old preference even when the new value already exists',async t=>{
  const {store,restart}=await fixture(t);
  for(const value of ['咖啡','热可可','茶'])await store.consolidate([fact(value)],source('我喜欢喝'+value,'preferences',value));
  const coffee=store.search('饮品').find(r=>r.value==='咖啡'),tea=store.search('饮品').find(r=>r.value==='茶'),evidence='我改喝茶，不再喝咖啡';
  await store.consolidate([fact('茶',{operation:'update',evidence})],source(evidence,'correction','user-correction'));
  assert.deepEqual(restart().search('饮品').map(r=>r.value).sort(),['热可可','茶'].sort());assert.equal(store.getRecord(coffee.id).supersededBy,tea.id);assert.equal(store.getRecord(coffee.id).status,'superseded');
});

test('separate project names and scoped configurations coexist and corrections stay inside their entity',async t=>{
  const f=await fixture(t),projectFact=(entity,value,predicate='项目名称',scope='')=>{const evidence=entity+(scope?'的'+scope:'')+'的'+predicate+'是'+value;return fact(value,{entity,scope,predicate,evidence,tags:['项目']});};
  for(const [entity,value] of [['项目A','海风'],['项目B','潮汐']]){const record=projectFact(entity,value);await f.store.consolidate([record],source(record.evidence,entity,'name'));}
  for(const [entity,scope,value] of [['项目A','后端','8080'],['项目A','前端','3000'],['项目B','后端','8080']]){const record=projectFact(entity,value,'服务端口',scope);await f.store.consolidate([record],source(record.evidence,entity,scope));}
  assert.equal(f.store.status().memoryCount,5);assert.equal(f.store.search('项目 名称').filter(r=>r.predicate==='项目名称').length,2);
  const evidence='项目A的后端服务端口改为8081';await f.store.consolidate([fact('8081',{entity:'项目A',scope:'后端',predicate:'服务端口',operation:'update',evidence})],source(evidence,'项目A','correction'));
  const active=f.restart().get().memories.filter(r=>r.status==='active');assert.equal(active.find(r=>r.entity==='项目A'&&r.scope==='后端').value,'8081');assert.equal(active.find(r=>r.entity==='项目B'&&r.scope==='后端').value,'8080');assert.equal(active.find(r=>r.entity==='项目A'&&r.scope==='前端').value,'3000');assert.equal(active.length,5);assert.match(active.find(r=>r.entity==='项目A'&&r.scope==='后端').content,/项目A.*后端/);
});

test('entity and operation metadata need original evidence and do not authorize model-only replacement',async t=>{
  const {store}=await fixture(t);await store.consolidate([fact('咖啡')],source('我喜欢喝咖啡'));
  const unauthorized=await store.consolidate([fact('茶',{operation:'update'})],source('我喜欢喝茶'));assert.equal(unauthorized.skipped[0].reason,'unverified-update');assert.equal(store.search('饮品')[0].value,'咖啡');
  const entity=await store.consolidate([fact('茶',{entity:'项目X'})],source('我喜欢喝茶'));assert.equal(entity.skipped[0].reason,'unverified-entity');
  const scoped=await store.consolidate([fact('茶',{scope:'前端'})],source('我喜欢喝茶'));assert.equal(scoped.skipped[0].reason,'unverified-scope');
});

test('single-value personal attributes version naturally and additions do not silently replace preferences',async t=>{
  const {store}=await fixture(t);
  const city=value=>fact(value,{predicate:'居住城市',evidence:'我住在'+value});
  const old=(await store.consolidate([city('北京')],source('我住在北京'))).saved[0];const current=(await store.consolidate([city('杭州')],source('我住在杭州','s2','u2'))).saved[0];assert.equal(current.supersedes,old.id);
  await store.consolidate([fact('咖啡')],source('我喜欢喝咖啡'));await store.consolidate([fact('茶',{evidence:'我现在也喜欢茶'})],source('我现在也喜欢茶','s3','u3'));assert.equal(store.search('饮品').filter(r=>r.predicate==='饮品偏好').length,2);
});

test('plugin-name wording softly recalls a project-name fact while preserving distinct project identities',async t=>{
  const {store}=await fixture(t),entity='鲸鱼娘插件',value='dsh-dafeiyu-dot',evidence='鲸鱼娘插件的项目名称是dsh-dafeiyu-dot';
  await store.consolidate([fact(value,{entity,predicate:'项目名称',evidence,tags:['工程']})],source(evidence));
  await store.put({spaceId:'owner',subject:'主人',predicate:'称呼',value:'Ze',content:'主人称呼为Ze'});
  const result=store.search('插件 名字');assert.equal(result[0].value,value);assert.equal(result[0].entity,entity);assert.ok(result[0].score>0);
});

test('entity punctuation remains part of identity and forgetting one project leaves the other intact',async t=>{
  const f=await fixture(t),all=[];
  for(const entity of ['项目甲-乙','项目甲乙']){const evidence=entity+'使用模型DeepSeek';all.push((await f.store.consolidate([fact('DeepSeek',{entity,predicate:'模型',evidence})],source(evidence,entity,entity))).saved[0]);}
  assert.equal(f.store.status().memoryCount,2);await f.store.remove(all[0].id);assert.equal(f.restart().getRecord(all[1].id).entity,'项目甲乙');assert.equal(f.restart().status().memoryCount,1);
});

test('pre-entity forget fingerprints remain effective after relation metadata is introduced',async t=>{
  const f=await fixture(t),record=(await f.store.consolidate([fact('咖啡')],source('我喜欢喝咖啡'))).saved[0];await f.store.remove(record.id);
  const path=join(f.palaceRoot,'.state','state.json'),state=JSON.parse(await readFile(path,'utf8')),hash=x=>createHash('sha256').update(x).digest('hex');
  for(const tombstone of state.tombstones){delete tombstone.entity;delete tombstone.scope;delete tombstone.identityVersion;tombstone.contentHash='old-wording';tombstone.valueHash=hash(hash('owner|主人|饮品偏好')+'|咖啡');}
  await writeFile(path,JSON.stringify(state));const restored=f.restart(),result=await restored.consolidate([fact('咖啡')],source('我喜欢喝咖啡','replay','replay-user'));assert.equal(result.skipped[0].reason,'forgotten');assert.equal(restored.status().memoryCount,0);
});
