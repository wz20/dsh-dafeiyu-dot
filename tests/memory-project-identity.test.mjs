import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from '../lib/memory.js';

const hash=x=>createHash('sha256').update(x).digest('hex');
const identity=x=>String(x??'').normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
const userText='请记住，我们正在做的插件项目叫dsh-dafeiyu-dot。';
const at='2026-10-29T06:15:40.703Z';
const source=(text=userText,id='current',time=at)=>({sessionId:'qq-project',userEventId:id,assistantEventId:'reply-'+id,userText:text,observedAt:time});
const fact=(predicate,value,evidence=userText,extra={})=>({spaceId:'owner',subject:'用户',predicate,value,content:'用户 · '+predicate+'：'+value,evidence,operation:'add',...extra});
const name=(value='dsh-dafeiyu-dot',extra={})=>fact('插件项目名称',value,userText,{entity:value,...extra});

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'dafeiyu-project-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'cache.json'),palaceRoot=join(root,'palace'),store=new MemoryStore(path,{palaceRoot});
 async function seed(id,extra={}){
  const record={id,spaceId:'owner',subject:'主人',entity:'',scope:'',predicate:'项目名称',value:'dsh-dafeiyu-dot',content:'主人 · 项目名称：dsh-dafeiyu-dot',operation:'add',status:'active',tags:[],createdAt:'2026-10-28T11:24:22.641Z',updatedAt:'2026-10-28T11:24:22.641Z',source:{kind:'conversation',sessionId:'old',userEventId:id,evidence:'我们的项目名称是 dsh-dafeiyu-dot',observedAt:'2026-10-28T11:24:22.641Z'},...extra};
  record.sources??=[record.source];const file=join(palaceRoot,record.spaceId,id+'.md');const body='---\n'+Object.entries(record).filter(([k])=>k!=='content').map(([k,v])=>k+': '+JSON.stringify(v)).join('\n')+'\n---\n\n'+record.content+'\n';
  await writeFile(file,body);store.get();return store.getRecord(id);
 }
 return{root,path,palaceRoot,store,seed,restart:()=>new MemoryStore(path,{palaceRoot})};
}

test('the real QQ name/type sequence scopes the type and merges the repeated name into its stable legacy ID',async t=>{
 const f=await fixture(t);await f.seed('legacy-name');
 const immediate=await f.store.consolidate([fact('项目类型','插件项目')],source());
 assert.equal(immediate.saved[0].entity,'dsh-dafeiyu-dot');
 const background=await f.store.consolidate([name()],source());
 assert.equal(background.saved.length,0);assert.equal(background.merged.length,1);assert.equal(background.merged[0].id,'legacy-name');
 const records=f.restart().search('');assert.equal(records.length,2);
 const stored=records.find(r=>r.predicate==='项目名称');assert.equal(stored.entity,'dsh-dafeiyu-dot');assert.ok(stored.sources.some(s=>s.userEventId==='legacy-name'));assert.ok(stored.sources.some(s=>s.userEventId==='current'));
 assert.equal(records.find(r=>r.predicate==='项目类型').entity,'dsh-dafeiyu-dot');
});

test('project name aliases share a stable relation without changing distinct explicit project identities or scopes',async t=>{
 const {store}=await fixture(t);
 for(const [i,predicate]of ['项目名称','插件项目名称','工程名称','项目名字'].entries()){
  const evidence='项目A的'+predicate+'是共同名';const result=await store.consolidate([fact(predicate,'共同名',evidence,{entity:'项目A'})],source(evidence,'a-'+i));assert.equal(result.saved.length,i===0?1:0);
 }
 for(const [entity,scope]of [['项目B',''],['项目A','生产'],['项目A','测试']]){const evidence=entity+scope+'的项目名称是共同名';await store.consolidate([fact('插件项目名称','共同名',evidence,{entity,scope})],source(evidence,entity+scope));}
 assert.equal(store.status().memoryCount,4);assert.equal(store.search('').filter(r=>r.predicate==='项目名称').length,4);
});

test('unique project evidence preserves punctuation and ambiguous project evidence cannot create a global type',async t=>{
 const {store}=await fixture(t);
 for(const value of ['C','C++','C#']){const evidence='我们的插件项目叫'+value+'。';await store.consolidate([fact('项目类型','插件项目',evidence)],source(evidence,value));}
 assert.deepEqual(store.search('').map(r=>r.entity).sort(),['C','C++','C#'].sort());
 const evidence='我们的插件项目叫项目甲，另一个插件项目叫项目乙。';const result=await store.consolidate([fact('项目类型','插件项目',evidence)],source(evidence,'ambiguous'));
 assert.equal(result.skipped[0].reason,'ambiguous-project-entity');assert.equal(store.status().memoryCount,3);
});

test('an explicit project name correction follows the legacy self-named relation and respects source time',async t=>{
 const f=await fixture(t);await f.seed('legacy-name');
 const evidence='dsh-dafeiyu-dot项目更名为dsh-dafeiyu-next';
 const updated=await f.store.consolidate([fact('插件项目名称','dsh-dafeiyu-next',evidence,{entity:'dsh-dafeiyu-dot',operation:'update'})],source(evidence,'rename'));
 assert.equal(updated.saved.length,1);const current=updated.saved[0];assert.equal(current.supersedes,'legacy-name');assert.equal(f.restart().getRecord('legacy-name').supersededBy,current.id);assert.equal(f.restart().status().memoryCount,1);
 const old='我们的项目名称是 dsh-dafeiyu-dot';const stale=await f.store.consolidate([fact('项目名称','dsh-dafeiyu-dot',old,{entity:'dsh-dafeiyu-dot'})],source(old,'late','2026-10-28T11:24:22.641Z'));
 assert.equal(stale.skipped[0].reason,'stale-source');assert.equal(f.store.status().memoryCount,1);
});

async function oldTombstone(f,{predicate='项目名称',value='dsh-dafeiyu-dot',entity='',scope=''}={}){
 const path=join(f.palaceRoot,'.state/state.json'),state=JSON.parse(await readFile(path,'utf8'));
 const rawKey=hash(['owner','主人',predicate,identity(entity),identity(scope)].join('|'));
 state.tombstones.push({id:'forgotten-legacy',spaceId:'owner',entity,scope,identityVersion:3,contentHash:'legacy-other-wording',valueHash:hash(rawKey+'|'+identity(value)),deletedAt:'2026-10-28T12:00:00.000Z'});await writeFile(path,JSON.stringify(state));
}

test('v3 unscoped project-name tombstones block alias/entity replay after restart without blocking another explicit project',async t=>{
 const f=await fixture(t);await oldTombstone(f);const store=f.restart();
 const replay=await store.consolidate([name()],source());assert.equal(replay.skipped[0].reason,'forgotten');assert.equal(store.status().memoryCount,0);
 const evidence='另一个项目的项目名称是dsh-dafeiyu-dot';const independent=await store.consolidate([fact('项目名称','dsh-dafeiyu-dot',evidence,{entity:'另一个项目'})],source(evidence,'independent'));assert.equal(independent.saved.length,1);
});

test('project entity completion checks its pre-completion v3 identity before saving a forgotten unscoped type',async t=>{
 const f=await fixture(t);await oldTombstone(f,{predicate:'项目类型',value:'插件项目'});const store=f.restart();
 const result=await store.consolidate([fact('项目类型','插件项目')],source());assert.equal(result.skipped[0].reason,'forgotten');assert.equal(store.status().memoryCount,0);
 const evidence='项目Y是插件项目';const explicit=await store.consolidate([fact('项目类型','插件项目',evidence,{entity:'项目Y'})],source(evidence,'explicit-y'));assert.equal(explicit.saved.length,1);
});

test('a scoped project tombstone remains scoped to its entity, environment, space and symbolic value',async t=>{
 const f=await fixture(t);await oldTombstone(f,{predicate:'项目名称',value:'C++',entity:'项目X',scope:'生产'});const store=f.restart();
 for(const [entity,scope,value]of [['项目Y','生产','C++'],['项目X','测试','C++'],['项目X','生产','C']]){const evidence=entity+scope+'的插件名称是'+value;assert.equal((await store.consolidate([fact('插件名称',value,evidence,{entity,scope})],source(evidence,entity+scope+value))).saved.length,1);}
 const evidence='项目X生产的插件名称是C++';assert.equal((await store.consolidate([fact('插件名称','C++',evidence,{entity:'项目X',scope:'生产'})],source(evidence,'replay'))).skipped[0].reason,'forgotten');
 assert.equal(store.status().memoryCount,3);
});

test('maintenance scopes evidenced conversation facts and retires duplicate name records without deleting files or dates',async t=>{
 const f=await fixture(t);const old=await f.seed('legacy-name');
 const type=await f.seed('immediate-type',{predicate:'项目类型',value:'插件项目',content:'主人 · 项目类型：插件项目',createdAt:'2026-10-29T06:15:44.564Z',updatedAt:'2026-10-29T06:15:44.564Z',source:{kind:'conversation',sessionId:'qq-project',userEventId:'current',observedAt:at,evidence:userText}});
 const newer=await f.seed('background-name',{predicate:'插件项目名称',entity:'dsh-dafeiyu-dot',createdAt:'2026-10-29T06:15:48.328Z',updatedAt:'2026-10-29T06:15:48.328Z',source:{kind:'conversation',sessionId:'qq-project',userEventId:'current',assistantEventId:'reply-current',observedAt:at,evidence:'我们正在做的插件项目叫dsh-dafeiyu-dot'}});
 assert.equal(f.restart().status().memoryCount,3);assert.equal(f.store.getRecord('legacy-name').entity,'');
 const result=await f.store.reconcileProjectFacts();assert.equal(result.entitiesUpdated,2);assert.equal(result.predicatesUpdated,1);assert.equal(result.merged,1);assert.equal(result.activeAfter,2);
 const current=f.restart(),canonical=current.getRecord(old.id),duplicate=current.getRecord(newer.id);assert.equal(canonical.entity,'dsh-dafeiyu-dot');assert.equal(current.getRecord(type.id).entity,'dsh-dafeiyu-dot');assert.equal(duplicate.status,'superseded');assert.equal(duplicate.supersededBy,canonical.id);
 assert.equal(canonical.createdAt,old.createdAt);assert.equal(canonical.updatedAt,old.updatedAt);assert.deepEqual(canonical.source,old.source);assert.ok(canonical.sources.some(s=>s.assistantEventId==='reply-current'));
 for(const record of[old,type,newer]){const preserved=current.getRecord(record.id);assert.equal(preserved.createdAt,record.createdAt);assert.equal(preserved.updatedAt,record.updatedAt);assert.deepEqual(preserved.source,record.source);}
 assert.equal((await readdir(join(f.palaceRoot,'owner'))).length,3);
 const before=new Map(await Promise.all((await readdir(join(f.palaceRoot,'owner'))).map(async file=>[file,await readFile(join(f.palaceRoot,'owner',file),'utf8')])));
 const again=await current.reconcileProjectFacts();assert.equal(again.entitiesUpdated+again.predicatesUpdated+again.merged,0);
 for(const[file,bytes]of before)assert.equal(await readFile(join(f.palaceRoot,'owner',file),'utf8'),bytes);
 await current.remove(canonical.id);assert.equal(current.getRecord(duplicate.id),null);assert.equal(current.status().memoryCount,1);
 const replay=await current.consolidate([name()],source());assert.equal(replay.skipped[0].reason,'forgotten');
});

test('maintenance leaves manual, test-only, ambiguous and unrelated personal records untouched',async t=>{
 const f=await fixture(t);const manual=await f.seed('manual',{source:{kind:'manual',evidence:userText},predicate:'项目类型',value:'插件项目'});
 const testing=await f.seed('test-only',{testOnly:true});const personal=await f.seed('personal',{predicate:'称呼',value:'大肥鱼',content:'主人称呼大肥鱼',source:{kind:'conversation',evidence:'我的称呼是大肥鱼'}});
 const ambiguous=await f.seed('ambiguous',{predicate:'项目类型',value:'插件项目',source:{kind:'conversation',evidence:'插件项目叫甲项目，插件项目叫乙项目'}});
 const original=new Map([manual,testing,personal,ambiguous].map(r=>[r.id,r]));const result=await f.store.reconcileProjectFacts();assert.equal(result.entitiesUpdated+result.predicatesUpdated+result.merged,0);
 for(const[id,record]of original)assert.deepEqual(f.store.getRecord(id),record);
});

test('a later explicit manual confirmation survives project alias tombstones and subsequent refreshes',async t=>{
 const f=await fixture(t);await oldTombstone(f);const store=f.restart();
 const manual=await store.put({spaceId:'owner',subject:'主人',entity:'dsh-dafeiyu-dot',predicate:'插件项目名称',value:'dsh-dafeiyu-dot',content:'主人明确重新保存插件项目dsh-dafeiyu-dot'});
 assert.equal(manual.confirmed,true);assert.equal(manual.source.kind,'manual');assert.equal(store.getRecord(manual.id).id,manual.id);assert.equal(f.restart().getRecord(manual.id).id,manual.id);assert.equal(f.restart().status().memoryCount,1);
});

test('forgetting a reconciled duplicate old ID covers its canonical record and prevents either representation returning',async t=>{
 const f=await fixture(t);await f.seed('legacy-name');await f.seed('new-name',{predicate:'插件项目名称',entity:'dsh-dafeiyu-dot',createdAt:'2026-10-29T06:15:48.328Z',updatedAt:'2026-10-29T06:15:48.328Z',source:{kind:'conversation',sessionId:'qq-project',userEventId:'current',observedAt:at,evidence:userText}});
 await f.store.reconcileProjectFacts();const removed=await f.store.remove('new-name');assert.deepEqual(new Set(removed.forgotten),new Set(['legacy-name','new-name']));assert.equal(f.restart().status().memoryCount,0);
 assert.equal((await f.store.consolidate([name()],source())).skipped[0].reason,'forgotten');
 const oldEvidence='我们的项目名称是 dsh-dafeiyu-dot';assert.equal((await f.store.consolidate([fact('项目名称','dsh-dafeiyu-dot',oldEvidence)],source(oldEvidence,'legacy-replay'))).skipped[0].reason,'forgotten');
});

test('entity completion never truncates qualified project identifiers or attributes another clause project to the named one',async t=>{
 const {store}=await fixture(t);
 for(const[entity,projectName]of[['前端项目A','海风'],['后端项目A','潮汐']]){
  const evidence=entity+'的项目名称是'+projectName+'，项目类型是插件项目。';
  const result=await store.consolidate([fact('项目类型','插件项目',evidence)],source(evidence,entity));assert.equal(result.saved.length,0);assert.equal(result.skipped[0].reason,'ambiguous-project-entity');
  const explicit=await store.consolidate([fact('项目类型','插件项目',evidence,{entity})],source(evidence,entity+'-explicit'));assert.equal(explicit.saved[0].entity,entity);
 }
 assert.equal(store.status().memoryCount,2);
 for(const evidence of ['项目A的名称是海风，项目B是插件项目。','我们的项目叫海风，项目B是插件项目。']){
  const result=await store.consolidate([fact('项目类型','插件项目',evidence)],source(evidence,'different-clause'));assert.equal(result.saved.length,0);assert.equal(result.skipped[0].reason,'ambiguous-project-entity');
 }
 assert.equal(store.status().memoryCount,2);
});

test('maintenance retires a legacy expression whose completed identity was forgotten and copied active files cannot revive it',async t=>{
 const f=await fixture(t),record=await f.seed('legacy-type',{predicate:'项目类型',value:'插件项目',content:'主人 · 项目类型：插件项目',source:{kind:'conversation',sessionId:'old',evidence:userText}});
 const original=await readFile(record.filePath,'utf8');
 const key=hash(['owner','主人','项目类型','dsh-dafeiyu-dot',''].join('|'));
 f.store.state.tombstones.push({id:'forgotten-scoped-type',spaceId:'owner',entity:'dsh-dafeiyu-dot',scope:'',identityVersion:3,contentHash:'other-wording',valueHash:hash(key+'|插件项目'),deletedAt:'2026-10-29T06:20:00.000Z'});
 const result=await f.store.reconcileProjectFacts();assert.equal(result.forgottenBlocked,1);assert.equal(result.activeAfter,0);assert.equal(result.recordsChanged,1);
 const retired=f.store.get().memories.find(r=>r.id===record.id);if(retired){assert.equal(retired.status,'superseded');assert.equal(retired.supersededBy,null);assert.equal(retired.updatedAt,record.updatedAt);assert.deepEqual(retired.source,record.source);}
 const preserved=await readFile(record.filePath,'utf8');assert.match(preserved,/status: "superseded"/);assert.equal(f.restart().search('').length,0);
 const again=await f.restart().reconcileProjectFacts();assert.equal(again.recordsChanged,0);assert.equal(await readFile(record.filePath,'utf8'),preserved);
 await writeFile(record.filePath,original.replace('id: "legacy-type"','id: "copied-legacy-type"'));assert.equal(f.restart().search('').length,0);
});
