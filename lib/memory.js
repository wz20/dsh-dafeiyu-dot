import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { JsonStore } from './storage.js';
import { dataRoot } from './config.js';
import { rankMemoryRecords } from './memory-search.js';

export const spaces=[{id:'self',name:'鲸鱼娘自己的'},{id:'owner',name:'我眼里的主人'}];
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const norm=x=>String(x??'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
const identity=x=>String(x??'').normalize('NFKC').toLowerCase().trim().replace(/\s+/g,' ');
const copy=x=>structuredClone(x), unique=x=>[...new Set(x)];
const validSpace=id=>spaces.some(x=>x.id===id);
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const date=(x,fallback)=>Number.isFinite(Date.parse(x))?new Date(x).toISOString():fallback;
const isTest=x=>/(?:测试|验收)(?:口令|暗号|数据|文本|会话|记录|用例)|^(?:测试|验收)[：:]|(?:仅供|用于|进行).{0,5}测试|(?:verification|test)[-_ ]?(?:code|data|only)/i.test(x);
const sensitive=x=>/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|密钥|密码|token|secret)\s*[:：=]\s*\S+/i.test(x);
const concepts=[
 ['饮品','饮料','喝','爱喝','咖啡','拿铁','美式','茶','奶茶','可可','coffee','latte'],
 ['偏好','喜欢','喜爱','最爱','爱好','偏爱','习惯','preference'],
 ['工作','上班','职业','任职','公司'],['居住','住在','住址','城市','家乡','故乡'],
 ['称呼','名字','姓名','叫什么','昵称'],['生日','出生','诞辰'],['饮食','口味','吃','食物'],
 ['编程','编码','开发','代码','coding'],['声音','语音','音色','朗读','tts'],
 ['语气','交流','沟通','说话'],['中文','汉语','普通话','简体'],['运动','健身','锻炼'],
 ['颜色','配色','蓝色','红色','绿色','紫色','黑色','白色'],
 ['插件','项目','工程','应用','plugin','project'],['名称','名字','命名','叫做','名为']
];
const aliases=[['饮品偏好','喜欢喝','爱喝','偏爱饮品','最喜欢的饮料','最爱喝'],['称呼','名字','姓名','昵称'],['居住城市','住在','居住地','所在城市','住址'],['回复语言','交流语言','语言偏好'],['颜色偏好','喜欢的颜色','偏爱颜色'],['职业','工作职业','从事职业']];
function subject(x,space){const n=norm(x);if(space==='owner'&&['我','用户','主人','本人'].includes(n))return '主人';if(space==='self'&&['你','鲸鱼娘','大肥鱼','本鱼'].includes(n))return '大肥鱼';return String(x??'').trim();}
function predicate(x,v,context={}){const n=norm(x);if((context.entity||context.scope)&&['名字','名称','命名','项目名称','工程名称','插件名称'].includes(n))return String(x).trim();for(const a of aliases)if(a.some(y=>norm(y)===n))return a[0];if(['喜欢','偏好','喜爱','最爱'].includes(n)){if(concepts[0].some(y=>norm(v).includes(norm(y))))return '饮品偏好';if(concepts[12].slice(2).some(y=>norm(v).includes(norm(y))))return '颜色偏好';}return String(x??'').trim();}
const factKey=r=>r.subject&&r.predicate?hash([r.spaceId,norm(r.subject),norm(r.predicate),identity(r.entity),identity(r.scope)].join('|')):null;
// Fact identity retains meaningful symbols (C, C++ and C# are distinct values).
const valueHash=r=>factKey(r)?hash(factKey(r)+'|'+identity(r.value??r.content)):null;
const legacyScopedValueHash=r=>factKey(r)?hash(factKey(r)+'|'+norm(r.value??r.content)):null;
const legacyValueHash=r=>r.subject&&r.predicate?hash(hash([r.spaceId,norm(r.subject),norm(r.predicate)].join('|'))+'|'+norm(r.value??r.content)):null;
const projectNamePredicates=['项目名称','项目名字','插件项目名称','工程项目名称','工程名称','插件名称'];
const projectName=p=>projectNamePredicates.includes(norm(p));
const projectAttribute=p=>projectName(p)||/^(?:项目|插件项目|工程项目|工程|插件|应用项目|应用)(?:类型|技术栈|模型|服务地址|服务端口|端口|仓库|仓库地址|工作目录|目录|路径)$/.test(norm(p));
function projectDeclarations(evidence=''){
 const declarations=[];let ambiguous=false;
 // Only direct naming statements prove a self-named project. Other subjects need an explicit entity.
 const direct=/^(?:(?:我们|我|主人|用户)(?:(?:正在|现在)?(?:做|开发|维护|制作|进行)的|的)|当前的?|这个|那个)?(?:插件项目|工程项目|应用项目|项目|工程|插件|应用)(?:的)?(?:(?:名称|名字)\s*(?:是|叫做|叫|名为|为|[:：])|(?:叫做|叫|名为|称为))\s*([「“"'`《]?)([^」”"'`》]+)[」”"'`》]?$/u;
 for(const clause of evidence.split(/[，。！？；,!?;\n]/u).map(x=>x.trim()).filter(Boolean)){
  const match=direct.exec(clause);if(!match){if(/项目|工程|插件|应用/.test(clause))ambiguous=true;continue;}
  const name=match[2].trim();if(!name||name.length>120||(!match[1]&&/(?:并且|同时|使用|采用|部署|运行|属于|是一个|还有|另一个|(?:和|与|及).*(?:项目|工程|插件|应用))/.test(name))){ambiguous=true;continue;}
  declarations.push({entity:name,name,clause});
 }
 return {declarations,ambiguous};
}
function normalizeProjectFact(f,evidence){
 if(!projectAttribute(f.predicate))return {fact:f};
 const out={...f,predicate:projectName(f.predicate)?'项目名称':f.predicate};
 if(f.entity)return {fact:out};
 const {declarations,ambiguous}=projectDeclarations(evidence),relevant=projectName(f.predicate)?declarations.filter(item=>identity(item.name)===identity(f.value)):declarations.filter(item=>item.clause.includes(f.value));
 const entities=unique(relevant.map(item=>item.entity));
 if(ambiguous||unique(declarations.map(item=>identity(item.entity))).length!==1||entities.length!==1)return {fact:out,reason:'ambiguous-project-entity'};
 if(entities.length===1)return {fact:{...out,entity:entities[0]},previous:f};
 return {fact:out};
}
function projectEntity(r){
 if(r.entity)return r.entity;
 if(!projectName(r.predicate)||r.source?.kind!=='conversation')return '';
 return normalizeProjectFact(r,r.source.evidence??'').fact.entity??'';
}
function relationKey(r){
 if(!projectName(r.predicate))return factKey(r);
 return r.subject?hash([r.spaceId,norm(r.subject),'项目名称',identity(projectEntity(r)),identity(r.scope)].join('|')):null;
}
function projectIdentityVariants(r){
 const normalized=projectAttribute(r.predicate)&&r.source?.kind==='conversation'?normalizeProjectFact(r,r.source.evidence??''):null;
 const shapes=normalized&&!normalized.reason&&normalized.fact.entity!==r.entity?[r,normalized.fact]:[r];
 return shapes.flatMap(shape=>{
  if(!projectName(shape.predicate))return [shape];
  const entities=[shape.entity??''],inferred=projectEntity(shape);if(!shape.entity&&inferred)entities.push(inferred);
  // Old unscoped name fingerprints can be proved equivalent to a self-named project.
  if(shape.entity&&identity(shape.entity)===identity(shape.value))entities.push('');
  return projectNamePredicates.flatMap(p=>unique(entities).map(entity=>({...shape,predicate:p,entity})));
 });
}
function factContent(r){return [subject(r.subject,r.spaceId),r.entity,r.scope,predicate(r.predicate,r.value,r)+'：'+r.value.trim()].filter(Boolean).join(' · ');}
export function isAdditiveEvidence(evidence=''){return /(?:也|还)(?:喜欢|喜爱|爱|喝|会|使用|用|有|支持)|同时|另外|以及|并且|都喜欢|均喜欢/.test(evidence);}
export function hasMemoryOptOut(text=''){return /(?:不要|别|无需|不用|不)(?:再)?(?:保存|存储|存下|记住|记录|记忆|记下来|留存)/.test(text);}
export function hasExplicitUpdateEvidence(evidence=''){
 if(/不再|改为|改成|改用|改喝|改叫|更正|纠正|替换|换成|搬到|重命名|重新命名|更名为/.test(evidence))return true;
 return !isAdditiveEvidence(evidence)&&/(?:以前|曾经|原来|之前)[\s\S]{0,100}(?:现在|如今|目前)/.test(evidence);
}
export function isSingleValueFact(fact={}){
 const p=predicate(fact.predicate,fact.value,fact),person=['主人','用户','我','本人','大肥鱼','鲸鱼娘','你','本鱼'].includes(norm(fact.subject));
 if(person&&['居住城市','称呼','回复语言','生日','出生日期'].includes(p))return true;
 return !!(fact.entity||fact.scope)&&(projectName(p)||['名称','名字','当前模型','主模型','当前服务地址'].includes(p));
}
function replacedValueMention(evidence,value){
 const text=String(evidence),at=text.indexOf(value);if(at<0)return false;
 const before=text.slice(Math.max(0,at-24),at),after=text.slice(at+value.length,at+value.length+30);
 return /(?:不再|不喜欢|不爱|不喝|不吃|不用|不要|停用|放弃|告别)[^，。！？；,.!?;]{0,12}$/.test(before)||/^\s*(?:改为|改成|改叫|换成|更名为|替换为|[→]|->)/.test(after)||/(?:以前|曾经|原来|之前)[^，。！？；,.!?;]{0,12}$/.test(before)&&/(?:现在|如今|目前)/.test(after)||/^\s*(?:错了|不对)/.test(after);
}
function replacementTargets(candidate,conflicts,evidence){
 if(!conflicts.length)return [];
 const explicit=candidate.operation==='update'&&(candidate.source.kind==='manual'||hasExplicitUpdateEvidence(evidence));
 if(!explicit&&isAdditiveEvidence(evidence))return [];
 if(!explicit&&!isSingleValueFact(candidate))return [];
 if(isSingleValueFact(candidate))return conflicts;
 const named=conflicts.filter(r=>replacedValueMention(evidence,r.value));if(named.length)return named;
 if(conflicts.length===1)return conflicts;
 return /(?:只|仅)(?:喝|用|使用|保留|喜欢)|全部|统统/.test(evidence)?conflicts:[];
}
function safeSource(input={},evidence,manualTime){const x=typeof input==='string'?{kind:input}:input??{},out={kind:typeof x.kind==='string'?x.kind:'conversation'};for(const f of ['sessionId','userEventId','assistantEventId','sourceId','workspace','path'])if(typeof x[f]==='string')out[f]=x[f];if(typeof x.observedAt==='string'&&Number.isFinite(Date.parse(x.observedAt)))out.observedAt=new Date(x.observedAt).toISOString();else if(/^manual/.test(out.kind)&&Number.isFinite(Date.parse(manualTime)))out.observedAt=new Date(manualTime).toISOString();if(typeof evidence==='string'&&evidence)out.evidence=evidence;else if(typeof x.evidence==='string')out.evidence=x.evidence;if(x.testOnly===true)out.testOnly=true;return out;}
function sources(...groups){const m=new Map();for(const s of groups.flat().filter(Boolean)){const normalized=safeSource(s);m.set(hash(JSON.stringify(normalized)),normalized);}return [...m.values()];}
function observedTime(record){const times=sources(record.sources??[],[record.source]).map(s=>Date.parse(s.observedAt)).filter(Number.isFinite);if(/^manual/.test(record.source?.kind??'')&&!Number.isFinite(Date.parse(record.source?.observedAt)))times.push(Date.parse(record.updatedAt));return times.length?Math.max(...times):Date.parse(record.updatedAt);}
function supportsMeaning(f,source){
 const at=source.userText.indexOf(f.evidence),near=source.userText.slice(Math.max(0,at-30),at+f.evidence.length),valueAt=near.lastIndexOf(f.value),prefix=valueAt<0?'':near.slice(Math.max(0,valueAt-16),valueAt);
 if(/(?:不再|不喜欢|不爱|讨厌|不喝|不吃|不加|不带|不含|不想|不能|没有|从不|不是|不要)[^，。！？；,.!?;]{0,10}$/.test(prefix)&&!/(?:不|没|无|非|讨厌)/.test(f.value))return false;
 if(/(?:以前|曾经|当时|过去|原来)/.test(f.evidence)&&!/(?:曾|过去|原|历史|当时)/.test(f.predicate)&&!(f.operation==='update'&&hasExplicitUpdateEvidence(f.evidence)))return false;
 return true;
}
function atomic(path,text){mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,text,{mode:0o600});renameSync(temp,path);}catch(e){try{unlinkSync(temp);}catch{}throw e;}}
function readJson(path,fallback){try{return JSON.parse(readFileSync(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function recoverCache(path,palaceRoot){
 try{const value=JSON.parse(readFileSync(path,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.memories))throw new SyntaxError('记忆缓存格式不正确。');}
 catch(error){if(error.code==='ENOENT')return path;if(!(error instanceof SyntaxError)||!existsSync(join(palaceRoot??join(dirname(path),'记忆宫殿'),'.state','state.json')))throw error;renameSync(path,path+'.recovery-'+randomUUID()+'.json');}
 return path;
}
function files(root){const out=[];function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())walk(path);else if(item.isFile()&&item.name.endsWith('.md'))out.push(path);}}for(const s of spaces){const dir=join(root,s.id);mkdirSync(dir,{recursive:true,mode:0o700});walk(dir);}return out.sort();}
function encode(r){const fields=['id','spaceId','subject','entity','scope','predicate','value','operation','tags','status','createdAt','updatedAt','confirmed','testOnly','supersedes','supersededBy','revisions','source','sources'];return '---\n'+fields.filter(k=>r[k]!==undefined).map(k=>k+': '+JSON.stringify(r[k])).join('\n')+'\n---\n\n'+r.content.trim()+'\n';}
function parse(path,root){const raw=readFileSync(path,'utf8'),mtime=statSync(path).mtime.toISOString();let meta={},body=raw;
 if(/^---\r?\n/.test(raw)){const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);if(!match)throw Error('记忆文件的元信息尚未闭合。');for(const line of match[1].split(/\r?\n/)){const p=/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);if(p)try{meta[p[1]]=JSON.parse(p[2]);}catch{meta[p[1]]=p[2].replace(/^['"]|['"]$/g,'');}}body=raw.slice(match[0].length);}
 const file=relative(root,path),spaceId=file.split(sep)[0],src=safeSource(meta.source??{kind:'manual-file',path:file},undefined,date(meta.updatedAt,mtime));
 return {id:typeof meta.id==='string'&&meta.id&&meta.id.length<300?meta.id:'file:'+hash(file).slice(0,32),spaceId,content:body.trim(),subject:subject(meta.subject,spaceId),entity:typeof meta.entity==='string'?meta.entity:'',scope:typeof meta.scope==='string'?meta.scope:'',predicate:predicate(meta.predicate,meta.value??body,meta),value:typeof meta.value==='string'?meta.value:body.trim(),operation:meta.operation==='update'?'update':'add',tags:Array.isArray(meta.tags)?meta.tags.filter(x=>typeof x==='string'):[],status:meta.status==='superseded'?'superseded':'active',createdAt:date(meta.createdAt,mtime),updatedAt:date(meta.updatedAt,mtime),confirmed:meta.confirmed===true,testOnly:meta.testOnly===true||src.testOnly===true||isTest(body),supersedes:typeof meta.supersedes==='string'?meta.supersedes:null,supersededBy:typeof meta.supersededBy==='string'?meta.supersededBy:null,revisions:Array.isArray(meta.revisions)?meta.revisions:[],source:src,sources:sources(Array.isArray(meta.sources)?meta.sources:[],[src]),file,filePath:path};
}
const revision=r=>({content:r.content,value:r.value,entity:r.entity,scope:r.scope,predicate:r.predicate,updatedAt:r.updatedAt,source:r.source});
function tokens(text){const out=[];for(const p of String(text).normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_]+(?:\+\+|#)?/gu)??[]){if(/^[a-z0-9_]/.test(p)){out.push(p);continue;}if(p.length===1)out.push(p);for(const n of [2,3])for(let i=0;i<=p.length-n;i++)out.push(p.slice(i,i+n));}const stop=new Set(['主人','用户','什么','怎么','如何','请问','记得','一下','最近','之前','告诉','关于','是否','现在','这个','那个']);return unique(out.filter(x=>!stop.has(x)));}
const profilePredicates=new Set(['称呼','姓名','昵称','年龄','生日','出生日期','职业','任职公司','工作单位','掌握技能','专业背景','教育背景','毕业院校','居住城市','家乡','自我介绍','个人简介','工作方向','长期目标','饮品偏好','颜色偏好','回复语言']);
function asksAboutOwner(query){return /我是谁|主人是谁|个人(?:资料|信息|档案)|你(?:还)?(?:记得|了解|知道)我(?:什么|多少|哪些|吗|么|嘛|呢)?$|关于我的(?:信息|资料|了解)/.test(norm(query));}
function profileFact(record){if(record.spaceId!=='owner'||record.entity||record.scope)return false;if(['主人','用户'].includes(norm(record.subject)))return profilePredicates.has(record.predicate);return !record.subject&&!record.predicate&&/^(?:主人|用户|我)(?:叫|名叫|名字|姓名|昵称|职业|工作是|住在|毕业于|擅长|会使用)/.test(norm(record.content));}
function fragment(content,q,max){if(content.length<=max)return {content,truncated:false,contentLength:content.length};let at=q?content.toLowerCase().indexOf(q.toLowerCase()):-1;if(at<0&&q)for(const t of tokens(q)){at=content.toLowerCase().indexOf(t);if(at>=0)break;}const start=Math.max(0,at-Math.floor(max/4)),end=Math.min(content.length,start+max-2);return {content:(start?'…':'')+content.slice(start,end)+(end<content.length?'…':''),truncated:true,contentLength:content.length};}

/** Independent Markdown facts are authoritative; navigation indexes are rebuildable. */
export class MemoryStore extends JsonStore {
 constructor(path=join(dataRoot(),'memories.json'),{palaceRoot}={}){
  super(recoverCache(path,palaceRoot),{version:2,memories:[],imports:[],jobs:[]});const legacy=this.value;
  this.palaceRoot=resolve(palaceRoot??join(dirname(path),'记忆宫殿'));this.statePath=join(this.palaceRoot,'.state','state.json');this.indexPath=join(this.palaceRoot,'.state','index.json');mkdirSync(this.palaceRoot,{recursive:true,mode:0o700});
  this.state=readJson(this.statePath,{version:2,imports:legacy.imports??[],jobs:legacy.jobs??[],tombstones:[],migratedLegacy:false});this.state.jobs??=[];this.state.imports??=[];this.state.tombstones??=[];this.clock=Date.now();for(const item of [...this.state.tombstones,...this.state.jobs,...legacy.memories??[]]){const time=Date.parse(item.updatedAt??item.deletedAt);if(Number.isFinite(time))this.clock=Math.max(this.clock,time);}this.signature='';this.indexErrors=[];
  this.value={version:2,memories:legacy.version===2&&Array.isArray(legacy.memories)?legacy.memories:[],imports:this.state.imports,jobs:this.state.jobs};
  if(!this.state.migratedLegacy){for(const old of legacy.memories??[]){if(!old?.id||!validSpace(old.spaceId)||typeof old.content!=='string')continue;const r=this._record({...old,source:typeof old.source==='string'?{kind:old.source,sourceId:old.sourceId}:old.source??{kind:'manual'}},old.createdAt??this._now());if(!this._forgotten(r))atomic(r.filePath,encode(r));}this.state.migratedLegacy=true;this._state();}
  this._refresh(true);
 }
 _now(){this.clock=Math.max(Date.now(),this.clock+1);return new Date(this.clock).toISOString();}
 _state(){atomic(this.statePath,JSON.stringify(this.state,null,2)+'\n');}
 _record(input,now=this._now()){
  const id=input.id??randomUUID(),spaceId=input.spaceId,src=safeSource(input.source??{kind:'manual'},input.evidence,date(input.updatedAt,now)),content=String(input.content??'').trim(),file=join(spaceId,hash(id).slice(0,40)+'.md');
  return {id,spaceId,content,subject:subject(input.subject,spaceId),entity:String(input.entity??'').trim(),scope:String(input.scope??'').trim(),predicate:predicate(input.predicate,input.value??content,input),value:String(input.value??content),operation:input.operation==='update'?'update':'add',tags:unique((input.tags??[]).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim())),status:input.status==='superseded'?'superseded':'active',createdAt:date(input.createdAt,now),updatedAt:date(input.updatedAt,now),confirmed:input.confirmed===true,testOnly:input.testOnly===true||src.testOnly===true||isTest(content),supersedes:input.supersedes??null,supersededBy:input.supersededBy??null,revisions:input.revisions??[],source:src,sources:sources(input.sources??[],[src]),file,filePath:join(this.palaceRoot,file)};
 }
 _forgotten(r){
  const variants=projectIdentityVariants(r);
  return this.state.tombstones.some(t=>t.id===r.id||(!(r.confirmed&&r.source?.kind==='manual'&&r.createdAt>t.deletedAt)&&variants.some(v=>{
   if(t.spaceId!==v.spaceId||identity(t.entity)!==identity(v.entity)||identity(t.scope)!==identity(v.scope))return false;
   const vh=valueHash(v),oldVh=legacyScopedValueHash(v),legacy=!v.entity&&!v.scope?legacyValueHash(v):null;
   return t.contentHash===hash(identity(v.content))||(vh&&t.valueHash===vh)||((t.identityVersion??1)<3&&(t.contentHash===hash(norm(v.content))||(oldVh&&t.valueHash===oldVh)))||((t.identityVersion??1)<2&&legacy&&t.valueHash===legacy);
  })));
 }
 _signature(list){return list.map(p=>{const s=statSync(p);return [p,s.size,s.mtimeMs].join(':');}).join('|');}
 _tombstone(r){return {id:r.id,spaceId:r.spaceId,entity:r.entity??'',scope:r.scope??'',identityVersion:3,contentHash:hash(identity(r.content)),valueHash:valueHash(r),deletedAt:this._now()};}
 _refresh(force=false){
  const list=files(this.palaceRoot),signature=this._signature(list);if(!force&&signature===this.signature)return;
  const previous=new Map((this.value.memories??[]).map(r=>[r.id,r])),records=new Map();this.indexErrors=[];let changed=false;
  for(const path of list)try{let r=parse(path,this.palaceRoot);if(!r.content||this._forgotten(r))continue;const old=previous.get(r.id);
   if(old&&(old.content!==r.content||old.value!==r.value||identity(old.entity)!==identity(r.entity)||identity(old.scope)!==identity(r.scope))){const src={kind:'manual-edit',path:r.file,observedAt:this._now()};r={...r,value:old.content!==r.content&&old.value===r.value?r.content:r.value,updatedAt:src.observedAt,confirmed:true,revisions:[...r.revisions,revision(old)],source:src,sources:sources(r.sources,[src])};atomic(r.filePath,encode(r));}
   if(records.has(r.id)){this.indexErrors.push({file:r.file,message:'记忆 ID 重复，请为副本设置独立 ID。'});if(records.get(r.id).updatedAt>=r.updatedAt)continue;}records.set(r.id,r);
  }catch(e){this.indexErrors.push({file:relative(this.palaceRoot,path),message:e.message});}
  for(const old of previous.values())if(!records.has(old.id)&&!existsSync(old.filePath)&&!this.state.tombstones.some(t=>t.id===old.id)){this.state.tombstones.push(this._tombstone(old));changed=true;}if(changed)this._state();
  for(const r of records.values())if(r.supersedes&&records.has(r.supersedes)){const old=records.get(r.supersedes);old.status='superseded';old.supersededBy=r.id;}
  this.value={version:2,memories:[...records.values()],imports:this.state.imports,jobs:this.state.jobs};this.signature=this._signature(files(this.palaceRoot));this._writeIndex();
 }
 _transaction(change){const operation=this.pending.then(()=>{this._refresh();const result=change();this.value.imports=this.state.imports;this.value.jobs=this.state.jobs;this._state();this.signature=this._signature(files(this.palaceRoot));this._writeIndex();return copy(result);});this.pending=operation.catch(()=>{});return operation;}
 _save(r){atomic(r.filePath,encode(r));const i=this.value.memories.findIndex(x=>x.id===r.id);if(i<0)this.value.memories.push(r);else this.value.memories[i]=r;return r;}
 get(){this._refresh();return copy(this.value);}
 getRecord(id){this._refresh();const r=this.value.memories.find(x=>x.id===id);return r?copy(r):null;}
 search(q='',spaceId,options={}){
  this._refresh();const query=String(q??'').slice(0,4000).trim(),limit=Math.max(1,Math.min(options.limit??(query?20:200),200)),max=Math.max(80,Math.min(options.maxChars??1200,8000));
  const profile=asksAboutOwner(query),records=this.value.memories.filter(r=>r.status==='active'&&!r.testOnly&&(!spaceId||r.spaceId===spaceId)&&(!profile||profileFact(r)));
  if(!query)return records.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit).map(r=>({...copy(r),...fragment(r.content,'',max),score:0}));
  return rankMemoryRecords(records,query,{concepts,profile}).slice(0,limit).map(({r,score})=>({...copy(r),...fragment(r.content,query,max),score:Math.round(score*1000)/1000}));
 }
 _upsert(input,src,{automatic=false,previousProjectFact}={}){
  const existing=input.id?this.value.memories.find(r=>r.id===input.id):undefined;if(input.id&&!existing)throw fail('这条记忆已不存在。',404);
  if(existing?.status==='superseded')throw fail('这条记忆已有更正，请修改最新版本。',409);
  const now=this._now(),candidate=this._record({...existing,...input,value:input.value??(existing&&existing.content===input.content?existing.value:input.content),source:src,confirmed:!automatic,createdAt:now,updatedAt:now});
  const predecessor=previousProjectFact?{...candidate,...previousProjectFact,subject:subject(previousProjectFact.subject,candidate.spaceId),entity:previousProjectFact.entity??'',scope:previousProjectFact.scope??'',content:factContent(previousProjectFact)}:null;
  if(automatic&&(this._forgotten(candidate)||(predecessor&&this._forgotten(predecessor))))return {kind:'skipped',reason:'forgotten'};
  const key=relationKey(candidate),active=this.value.memories.filter(r=>r.status==='active'&&!r.testOnly&&r.spaceId===candidate.spaceId);
  const same=active.find(r=>(key&&relationKey(r)===key&&identity(r.value)===identity(candidate.value))||(!key&&!relationKey(r)&&identity(r.entity)===identity(candidate.entity)&&identity(r.scope)===identity(candidate.scope)&&identity(r.content)===identity(candidate.content)));
  if(existing){const changed=existing.content!==candidate.content||existing.value!==candidate.value;const sameSpace=existing.spaceId===candidate.spaceId;const r={...existing,...candidate,id:existing.id,...sameSpace?{file:existing.file,filePath:existing.filePath}:{},createdAt:existing.createdAt,supersedes:existing.supersedes,supersededBy:null,revisions:[...existing.revisions,...(changed?[revision(existing)]:[])],sources:sources(existing.sources,candidate.sources)};this._save(r);if(!sameSpace)try{unlinkSync(existing.filePath);}catch(e){if(e.code!=='ENOENT')throw e;}return {kind:'saved',record:r};}
  const conflicts=key?active.filter(r=>relationKey(r)===key&&identity(r.value)!==identity(candidate.value)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)):[];
  const targets=replacementTargets(candidate,conflicts,src.evidence??'');
  const observedAt=Date.parse(src.observedAt);if(automatic&&Number.isFinite(observedAt)&&targets.some(r=>observedTime(r)>observedAt))return {kind:'skipped',reason:'stale-source'};
  if(same){const shape=projectName(candidate.predicate)?{...same,predicate:'项目名称',entity:same.entity||candidate.entity}:same,changed=shape.predicate!==same.predicate||shape.entity!==same.entity;const merged={...shape,...changed?{content:factContent(shape),revisions:[...same.revisions,revision(same)]}:{},updatedAt:now,sources:sources(same.sources,candidate.sources),...(targets.length?{operation:'update',supersedes:same.supersedes??targets[0].id}:{})};this._save(merged);for(const old of targets)this._save({...old,status:'superseded',supersededBy:merged.id});return {kind:'merged',record:merged};}
  if(targets.length){candidate.operation='update';candidate.supersedes=targets[0].id;}
  this._save(candidate);for(const old of targets)this._save({...old,status:'superseded',supersededBy:candidate.id});return {kind:'saved',record:candidate};
 }
 async put(input){if(!input||!validSpace(input.spaceId)||typeof input.content!=='string'||!input.content.trim()||input.content.length>8000)throw fail('请选择记忆分区并填写有效内容。');if(sensitive(input.content))throw fail('记忆中请使用事实与偏好，密钥和密码由凭据服务保管。');if(input.tags!==undefined&&(!Array.isArray(input.tags)||input.tags.length>30||input.tags.some(t=>typeof t!=='string'||t.length>100)))throw fail('记忆主题格式不正确。');for(const field of ['entity','scope'])if(input[field]!==undefined&&(typeof input[field]!=='string'||input[field].length>200))throw fail('记忆实体或范围格式不正确。');if(input.operation!==undefined&&!['add','update'].includes(input.operation))throw fail('记忆关系操作不正确。');const allowed=Object.fromEntries(['id','spaceId','content','subject','entity','scope','predicate','value','operation','tags'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));return this._transaction(()=>this._upsert(allowed,{kind:'manual'}).record);}
 async remove(id,options={}){if(typeof id!=='string'||!id)throw fail('请选择记忆。');return this._transaction(()=>{options.admit?.();const found=this.value.memories.find(r=>r.id===id);if(!found)return {forgotten:[]};const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const r of this.value.memories)if(ids.has(r.id)||ids.has(r.supersedes)||ids.has(r.supersededBy))for(const x of [r.id,r.supersedes,r.supersededBy])if(x&&!ids.has(x)){ids.add(x);changed=true;}}const forgotten=this.value.memories.filter(r=>ids.has(r.id));for(const r of forgotten)this.state.tombstones.push(this._tombstone(r));this._state();for(const r of forgotten)try{unlinkSync(r.filePath);}catch(e){if(e.code!=='ENOENT')throw e;}this.value.memories=this.value.memories.filter(r=>!ids.has(r.id));return {forgotten:[...ids]};});}
 async consolidate(facts,source={},options={}){
  if(!Array.isArray(facts)||facts.length>32)throw fail('本次记忆整理的事实数量不正确。');
  return this._transaction(()=>{options.admit?.();const out={saved:[],merged:[],skipped:[]};for(const [index,f] of facts.entries()){let reason;
   if(!f||!validSpace(f.spaceId)||['content','subject','predicate','value','evidence'].some(k=>typeof f[k]!=='string'||!norm(f[k]))||f.content.length>8000||f.evidence.length>4000)reason='invalid-fact';
   else if(typeof source.userText!=='string'||!source.userText.includes(f.evidence))reason='unverified-evidence';
   else if(!norm(f.evidence).includes(norm(f.value)))reason='unverified-value';
   else if(f.entity!==undefined&&(typeof f.entity!=='string'||f.entity.length>200||f.entity&&!f.evidence.includes(f.entity)))reason='unverified-entity';
   else if(f.scope!==undefined&&(typeof f.scope!=='string'||f.scope.length>200||f.scope&&!f.evidence.includes(f.scope)))reason='unverified-scope';
   else if(f.operation!==undefined&&!['add','update'].includes(f.operation))reason='invalid-operation';
   else if(f.operation==='update'&&!isSingleValueFact(f)&&!hasExplicitUpdateEvidence(f.evidence))reason='unverified-update';
   else if(hasMemoryOptOut(source.userText))reason='user-opt-out';
   else if(source.testOnly||isTest(source.userText)||isTest(f.content))reason='test-source';
   else if(sensitive(f.content)||sensitive(f.evidence))reason='sensitive';
   else if(/(?:也许|可能|或许|大概|假设|假如|虚构|举例|不确定)/.test(f.evidence))reason='uncertain';
   else if(!supportsMeaning(f,source))reason='meaning-mismatch';
   if(reason){out.skipped.push({index,reason});continue;}
   const normalized=normalizeProjectFact(f,f.evidence);if(normalized.reason){out.skipped.push({index,reason:normalized.reason});continue;}const prepared=normalized.fact;
   const safeFact=Object.fromEntries(['spaceId','subject','predicate','value'].map(k=>[k,prepared[k]]));safeFact.entity=prepared.entity??'';safeFact.scope=prepared.scope??'';safeFact.operation=prepared.operation??'add';safeFact.content=factContent(safeFact);safeFact.tags=Array.isArray(f.tags)?f.tags.filter(t=>typeof t==='string').slice(0,30).map(t=>t.slice(0,100)):[];
   const result=this._upsert(safeFact,safeSource({...source,kind:'conversation'},f.evidence),{automatic:true,previousProjectFact:normalized.previous});if(result.kind==='skipped')out.skipped.push({index,reason:result.reason});else out[result.kind].push(copy(result.record));
  }return out;});
 }
 async reconcileProjectFacts(){
  return this._transaction(()=>{
   const active=this.value.memories.filter(r=>r.status==='active'&&!r.testOnly),changed=new Set(),eligible=[];
   const result={examined:0,entitiesUpdated:0,predicatesUpdated:0,merged:0,skipped:0,forgottenBlocked:0,recordsChanged:0,activeBefore:active.length,activeAfter:active.length,links:[],legacyUnscopedForgetPolicy:'check-pre-completion-v3-identity'};
   for(const record of active){
    const evidence=record.source?.evidence;
    if(record.source?.kind!=='conversation'||!projectAttribute(record.predicate)||typeof evidence!=='string'||!evidence.includes(record.value)||sensitive(evidence)||isTest(evidence)||hasMemoryOptOut(evidence)||/(?:也许|可能|或许|大概|假设|假如|虚构|举例|不确定)/.test(evidence)||!supportsMeaning({...record,evidence},{userText:evidence})) {result.skipped++;continue;}
    const normalized=normalizeProjectFact(record,evidence);
    if(normalized.reason||!normalized.fact.entity||!evidence.includes(normalized.fact.entity)){result.skipped++;continue;}
    result.examined++;
    const shape=normalized.fact;
    if(this._forgotten(shape)||(normalized.previous&&this._forgotten(normalized.previous))){this._save({...record,status:'superseded',supersededBy:null});changed.add(record.id);result.forgottenBlocked++;continue;}
    const entityChanged=shape.entity!==record.entity,predicateChanged=shape.predicate!==record.predicate;
    let current=record;
    if(entityChanged||predicateChanged){
     current={...shape,content:factContent(shape),revisions:[...record.revisions,revision(record)]};
     this._save(current);changed.add(current.id);if(entityChanged)result.entitiesUpdated++;if(predicateChanged)result.predicatesUpdated++;
    }
    eligible.push(current);
   }
   const groups=new Map();
   for(const record of eligible){if(!projectName(record.predicate))continue;const key=relationKey(record)+'|'+identity(record.value);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}
   for(const group of groups.values()){
    if(group.length<2)continue;
    group.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const [canonical,...duplicates]=group;
    this._save({...canonical,sources:sources(group.flatMap(r=>sources(r.sources,[r.source]))),tags:unique(group.flatMap(r=>r.tags))});changed.add(canonical.id);
    for(const duplicate of duplicates){this._save({...duplicate,status:'superseded',supersededBy:canonical.id});changed.add(duplicate.id);result.merged++;result.links.push({id:duplicate.id,supersededBy:canonical.id});}
   }
   result.recordsChanged=changed.size;result.activeAfter=this.value.memories.filter(r=>r.status==='active'&&!r.testOnly).length;
   return result;
  });
 }
 async createJob(payload,options={}){if(!payload||typeof payload.key!=='string'||!payload.key||!payload.source||typeof payload.source.sessionId!=='string')throw fail('记忆整理任务格式不正确。');return this._transaction(()=>{options.admit?.();const old=this.state.jobs.find(j=>j.key===payload.key);if(old)return old;const now=this._now(),job={...copy(payload),id:randomUUID(),status:'queued',attempts:0,createdAt:now,updatedAt:now};this.state.jobs.push(job);return job;});}
 captureFloor(sessionId){return copy((this.state.captureFloors??[]).find(row=>row.sessionId===sessionId)??null);}
 ensureCaptureFloor(sessionId,eventOffset,anchor){return this._transaction(()=>{if(typeof sessionId!=='string'||!sessionId||!Number.isSafeInteger(eventOffset)||eventOffset<0)throw fail('会话记忆起点无效。');this.state.captureFloors??=[];if(!Array.isArray(this.state.captureFloors))throw fail('会话记忆起点暂时无法读取。');const existing=this.state.captureFloors.find(row=>row.sessionId===sessionId);if(existing){if(eventOffset>existing.eventOffset)Object.assign(existing,{eventOffset,anchor:anchor??null});return existing;}const row={sessionId,eventOffset,anchor:anchor??null,createdAt:this._now()};this.state.captureFloors.push(row);return row;});}
 isSourceExcluded(source){const values=this.state.excludedSources??[];if(!Array.isArray(values))throw fail('记忆排除记录暂时无法读取。');return values.includes(hash(JSON.stringify([source.sessionId,source.userEventId])));}
 excludeSource(source){return this._transaction(()=>{if(typeof source?.sessionId!=='string'||typeof source?.userEventId!=='string')throw fail('记忆来源无效。');this.state.excludedSources??=[];if(!Array.isArray(this.state.excludedSources))throw fail('记忆排除记录暂时无法读取。');const key=hash(JSON.stringify([source.sessionId,source.userEventId]));if(!this.state.excludedSources.includes(key))this.state.excludedSources.push(key);return {excluded:true};});}
 pendingJobs(){this._refresh();const now=Date.now();return copy(this.state.jobs.filter(j=>['queued','running'].includes(j.status)||(j.status==='failed'&&j.retryable===true&&(!j.nextRetryAt||Date.parse(j.nextRetryAt)<=now))));}
 _job(id){const job=this.state.jobs.find(j=>j.id===id);if(!job)throw fail('这项记忆整理任务已不存在。',404);return job;}
 startJob(id,{attempts}={}){return this._transaction(()=>{const j=this._job(id);j.status='running';j.attempts=attempts??j.attempts+1;j.updatedAt=this._now();return j;});}
 deferJob(id,{attempts}={}){return this._transaction(()=>{const j=this._job(id);if(j.status==='completed')return j;j.status='queued';j.attempts=Math.max(0,attempts??j.attempts);j.retryable=false;j.nextRetryAt=null;j.error=null;j.updatedAt=this._now();return j;});}
 completeJob(id,result){return this._transaction(()=>{const j=this._job(id);j.status='completed';j.result=copy(result??{});j.retryable=false;j.updatedAt=this._now();if(j.source)for(const field of ['userText','assistantText'])if(typeof j.source[field]==='string'){j.source[field+'Hash']=hash(j.source[field]);delete j.source[field];}return j;});}
 failJob(id,error){return this._transaction(()=>{const j=this._job(id),e=typeof error==='object'&&error?error:{error:String(error)};j.status=e.status==='cancelled'?'cancelled':'failed';const message=String(e.error??e.message??'整理暂时未完成。');j.error=sensitive(message)?'整理暂时未完成，请检查服务配置。':message.slice(0,1000);j.retryable=e.retryable===true;j.attempts=e.attempts??j.attempts;j.nextRetryAt=e.nextRetryAt??null;j.updatedAt=this._now();return j;});}
 retryJob(id){return this._transaction(()=>{const j=this._job(id);if(j.status==='completed')throw fail('这项记忆整理已经完成。',409);if(typeof j.source?.userText!=='string')throw fail('整理来源已不可用，请重新发送需要记住的内容。',409);j.status='queued';j.retryable=true;j.nextRetryAt=null;j.attempts=0;j.error=null;j.updatedAt=this._now();return j;});}
 _catalog(){
  const active=this.value.memories.filter(r=>r.status==='active'&&!r.testOnly),group=get=>{const groups=new Map();for(const r of active)for(const name of unique(get(r).filter(Boolean))){if(!groups.has(name))groups.set(name,[]);groups.get(name).push(r.id);}return [...groups].map(([name,ids])=>({name,count:ids.length,ids})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh'));};
  return {palaceRoot:this.palaceRoot,builtAt:this._builtAt??this._now(),spaces:spaces.map(s=>({...s,count:active.filter(r=>r.spaceId===s.id).length})),people:group(r=>[r.subject||spaces.find(s=>s.id===r.spaceId)?.name]),topics:group(r=>r.tags.length?r.tags:[r.predicate||'日常记忆']),dates:group(r=>[/^\d{4}-\d{2}-\d{2}/.exec(r.updatedAt)?.[0]??'未知日期']).map(({name,...rest})=>({date:name,...rest})),corrections:this.value.memories.filter(r=>r.supersedes||r.supersededBy||r.revisions.length).map(r=>({id:r.id,subject:r.subject,predicate:r.predicate,supersedes:r.supersedes,supersededBy:r.supersededBy,revisions:r.revisions.length,updatedAt:r.updatedAt})),files:this.value.memories.map(r=>({id:r.id,path:r.file,spaceId:r.spaceId,status:r.status,testOnly:r.testOnly})),errors:this.indexErrors};
 }
 _writeIndex(){
  this._builtAt=this._now();const catalog=this._catalog(),records=new Map(this.value.memories.map(r=>[r.id,r]));atomic(this.path,JSON.stringify(this.value,null,2)+'\n');atomic(this.indexPath,JSON.stringify(catalog,null,2)+'\n');
  atomic(join(this.palaceRoot,'README.md'),'# 大肥鱼记忆宫殿\n\n角色自己的经历与对主人的了解分开保存。独立 Markdown 记忆文件保留来源、更新时间和更正关系。\n\n'+spaces.map(s=>'- ['+s.name+'](./'+s.id+'/)：'+catalog.spaces.find(x=>x.id===s.id).count+' 条当前记忆').join('\n')+'\n\n- [人物索引](./索引/人物.md)\n- [主题索引](./索引/主题.md)\n- [时间索引](./索引/时间.md)\n');
  for(const [name,groups] of [['人物',catalog.people],['主题',catalog.topics],['时间',catalog.dates]]){const lines=['# '+name+'索引','','索引更新时间：'+catalog.builtAt,''];for(const g of groups){lines.push('## '+(g.name??g.date),'');for(const id of g.ids){const r=records.get(id);lines.push('- ['+r.content.slice(0,100).replace(/[\r\n\[\]]/g,' ')+'](../'+r.file.split(sep).join('/')+')');}lines.push('');}atomic(join(this.palaceRoot,'索引',name+'.md'),lines.join('\n')+'\n');}
 }
 index(){this._refresh();return copy(this._catalog());}
 status(){this._refresh();const active=this.value.memories.filter(r=>r.status==='active'&&!r.testOnly),jobs={total:this.state.jobs.length,pending:this.state.jobs.filter(j=>['queued','running'].includes(j.status)).length,failed:this.state.jobs.filter(j=>j.status==='failed').length,cancelled:this.state.jobs.filter(j=>j.status==='cancelled').length,completed:this.state.jobs.filter(j=>j.status==='completed').length};return {palaceRoot:this.palaceRoot,memoryCount:active.length,pendingJobs:jobs.pending,failedJobs:jobs.failed,jobs,index:{version:2,builtAt:this._builtAt,files:this.value.memories.length,totalRecords:this.value.memories.length,activeRecords:active.length,errors:this.indexErrors}};}
 rebuildIndex(){return this._transaction(()=>{this.signature='';this._refresh(true);return this._catalog();});}
 async importLegacy(root){
  if(!root||!existsSync(root)||this.state.imports.includes(root))return {imported:0};const {DatabaseSync}=await import('node:sqlite'),list=[];
  for(const entry of readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory())continue;const file=join(root,entry.name,'mnemon.db');if(!existsSync(file))continue;const db=new DatabaseSync(file,{readOnly:true});try{for(const row of db.prepare('SELECT id, content, created_at, updated_at FROM insights WHERE deleted_at IS NULL').all())list.push({id:'mnemon:'+entry.name+':'+row.id,spaceId:entry.name==='default'?'self':'owner',content:row.content,createdAt:row.created_at,updatedAt:row.updated_at,source:{kind:'mnemon',sourceId:String(row.id),workspace:entry.name},testOnly:isTest(row.content)});}finally{db.close();}}
  return this._transaction(()=>{if(this.state.imports.includes(root))return {imported:0};const ids=new Set(this.value.memories.map(r=>r.id));let imported=0;for(const old of list){const r=this._record(old);if(!ids.has(r.id)&&!this._forgotten(r)){this._save(r);ids.add(r.id);imported++;}}this.state.imports.push(root);return {imported};});
 }
}
