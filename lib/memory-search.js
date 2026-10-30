const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();
const compact = value => normalize(value).replace(/[\s\p{P}\p{S}]+/gu, '');
const unique = values => [...new Set(values)];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const historical = /曾经|过去|以前|从前|原来/;
const negative = /不喜欢|不爱|不喝|不吃|讨厌|避免|忌口|过敏/;
const environments = [
  ['生产', '生产环境', '线上', '正式环境', 'production', 'prod'],
  ['测试', '测试环境', 'testing', 'test'],
  ['预发', '预发布', '预发环境', 'staging', 'stage'],
  ['开发', '开发环境', 'development', 'dev'],
];

function literalMatcher(term) {
  const value = normalize(term).trim();
  if (!value) return () => false;
  if (/^[a-z0-9_]/.test(value)) {
    const expression = new RegExp('(?:^|[^a-z0-9_+#])' + escape(value) + '(?=$|[^a-z0-9_+#])');
    return text => expression.test(text);
  }
  return text => text.includes(value);
}
const includesLiteral = (text, term) => literalMatcher(term)(normalize(text));

function requestsEnvironment(query, alias, hasEntity) {
  const value = normalize(alias), text = normalize(query);
  if (text.trim() === value) return true;
  if (value.endsWith('环境') || value.endsWith('environment')) return includesLiteral(text, value);
  let offset = text.indexOf(value);
  while (offset >= 0) {
    const suffix = text.slice(offset + value.length).trimStart();
    if (/^(?:的)?(?:环境|服务|端口|地址|连接|数据库|配置|部署|模型|实例|节点|服务器|用|运行|分别|environment|port|url|endpoint|config|database|server|service|model)/i.test(suffix)) return true;
    if (hasEntity && !suffix) return true;
    offset = text.indexOf(value, offset + value.length);
  }
  return false;
}

function tokens(text) {
  const out = [];
  for (const piece of normalize(text).match(/[\p{Script=Han}]+|[a-z0-9_]+(?:\+\+|#)?/gu) ?? []) {
    if (/^[a-z0-9_]/.test(piece)) { out.push(piece); continue; }
    if (piece.length === 1) out.push(piece);
    for (const length of [2, 3]) for (let index = 0; index <= piece.length - length; index++) out.push(piece.slice(index, index + length));
  }
  const stop = new Set(['主人','用户','什么','怎么','如何','请问','记得','一下','最近','之前','告诉','关于','是否','现在','这个','那个']);
  return unique(out.filter(token => !stop.has(token)));
}

const document = record => [record.content, record.subject, record.entity, record.scope, record.predicate, record.value, ...(record.tags ?? [])].join(' ');
const attributeText = record => [record.predicate, record.content, record.value, ...(record.tags ?? [])].join(' ');
const attributeFamilies = [
  {query:/端口|\bport\b/i, record:/端口|\bport\b/i},
  {query:/服务地址|连接地址|接口地址|网址|\burl\b|endpoint/i, record:/地址|网址|\burl\b|endpoint/i},
  {query:/工作目录|保存位置|存储位置|路径|目录|存在哪|保存在哪/, record:/路径|目录|位置|存储/},
  {query:/项目类型|插件类型|工程类型|应用类型/, record:/类型/},
  {query:/名称|名字|叫什么|称呼|姓名|昵称/, record:/名称|名字|称呼|姓名|昵称/},
  {query:/开发语言|编程语言|技术栈|(?:用|使用|采用).{0,8}(?:编程|开发)/, record:/开发语言|编程语言|技术栈|掌握技能/},
  {query:/模型|\bmodel\b/i, record:/模型|\bmodel\b/i},
  {query:/饮品|饮料|喝|咖啡|拿铁|茶|奶茶|可可|\bcoffee\b|\blatte\b/i, record:/饮品|饮料|喝|咖啡|拿铁|茶|奶茶|可可/i},
  {query:/颜色|配色/, record:/颜色|配色/},
  {query:/居住|住在|住哪|住址|城市|在哪.{0,6}生活/, record:/居住|住在|住址|城市/},
  {query:/家乡|故乡/, record:/家乡|故乡/},
  {query:/生日|出生|诞辰/, record:/生日|出生|诞辰/},
  {query:/回复语言|交流语言|汉语|中文|普通话|简体|(?:回复|交流|聊天|回答|沟通).{0,10}语言|语言.{0,10}(?:回复|交流|聊天|回答|沟通)/, record:/回复语言|交流语言|语言偏好|汉语|中文/},
  {query:/声音|语音|音色|朗读|\btts\b/i, record:/声音|语音|音色|朗读|\btts\b/i},
];

/** Rank current facts with explicit structured constraints before topic expansion. */
export function rankMemoryRecords(records, query, {concepts = [], profile = false} = {}) {
  const q = normalize(query), qn = compact(query);
  const texts = new Map(records.map(record => [record, normalize(document(record))]));
  const quotedNames = unique([
    ...[...q.matchAll(/[「“"]([^「」“”"\n]{1,120})[」”"]\s*(?:项目|工程|插件|应用)/g)].map(match => match[1].trim()),
    ...[...q.matchAll(/(?:项目|工程|插件|应用)\s*[「“"]([^「」“”"\n]{1,120})[」”"]/g)].map(match => match[1].trim()),
  ]);
  const entities = quotedNames.length ? quotedNames : unique(records.map(record => record.entity).filter(Boolean)).filter(entity => includesLiteral(q, entity));
  const scopedEntities = entities.filter(entity => !entities.some(other => other !== entity && normalize(other).length > normalize(entity).length && normalize(other).includes(normalize(entity))));
  const selectedEnvironments = environments.filter(group => group.some(alias => includesLiteral(q, alias) && requestsEnvironment(q, alias, scopedEntities.length > 0)));
  const literalScopes = unique(records.map(record => record.scope).filter(Boolean)).filter(scope => !environments.some(group => group.some(alias => normalize(scope) === normalize(alias))) && new RegExp(escape(normalize(scope)) + '(?:环境|范围|场景|配置)').test(q));
  const intentFamilies = attributeFamilies.filter(family => family.query.test(q));
  if (scopedEntities.length && /语言/.test(q) && !/回复|交流|聊天|回答|沟通/.test(q) && !intentFamilies.some(family => family.record.test('开发语言'))) intentFamilies.push({record:/开发语言|编程语言|技术栈|掌握技能/});
  if (/工作|上班|职业|任职|公司/.test(q) && !/工作目录/.test(q)) intentFamilies.push({record:/职业|任职|工作单位|公司|工作方向/});
  const asksQuestion = /什么|哪|多少|几|是否|吗|么|嘛|谁|怎么|如何|啥|[?？]/.test(q);
  const asksPast = asksQuestion && /(?:以前|过去|曾经|从前)(?:的)?(?:住|居住|生活|工作|职业|喜欢|偏好|饮品|喝|爱|在哪)/.test(q);
  const asksCurrent = asksQuestion && (/现在|目前|如今|当前/.test(q) || /居住|住在|住哪|在哪.{0,6}生活/.test(q) && !asksPast);
  const positiveQuestion = /喜欢|偏爱|最爱|爱喝/.test(q.replace(new RegExp(negative.source, 'g'), ''));
  const asksNegative = asksQuestion && negative.test(q) && !positiveQuestion;
  const residenceQuery = /居住|住在|住哪|住址|城市|在哪.{0,6}生活|家乡|故乡/.test(q);
  const literalQuery = /^[a-z0-9_]+(?:\+\+|#)?$/i.test(query) ? literalMatcher(query) : text => qn.length > 1 && compact(text).includes(qn);
  const candidates = records.filter(record => {
    const text = texts.get(record);
    // A literal keyword remains a full-text lookup, including generic notes.
    if (!asksQuestion && literalQuery(text)) return true;
    if (scopedEntities.length && !scopedEntities.some(entity => record.entity ? normalize(record.entity) === normalize(entity) : includesLiteral(text, entity))) return false;
    if (selectedEnvironments.length && !selectedEnvironments.some(group => group.some(alias => includesLiteral(record.scope || text, alias)))) return false;
    if (!selectedEnvironments.length && literalScopes.length && !literalScopes.some(scope => record.scope ? normalize(record.scope) === normalize(scope) : includesLiteral(text, scope))) return false;
    if (intentFamilies.length && !intentFamilies.some(family => family.record.test(attributeText(record)))) return false;
    if (asksPast && !asksCurrent && !historical.test(record.predicate + ' ' + record.content)) return false;
    if (asksCurrent && !asksPast && residenceQuery && historical.test(record.predicate + ' ' + record.content)) return false;
    if (asksNegative && !negative.test(record.value + ' ' + record.content)) return false;
    return true;
  });
  const terms = tokens(query), groups = concepts.filter(group => group.some(term => qn.includes(compact(term))));
  const matchers = new Map(terms.map(term => [term, literalMatcher(term)])), groupMatchers = groups.map(group => group.map(literalMatcher));
  const frequency = new Map(terms.map(term => [term, candidates.filter(record => matchers.get(term)(texts.get(record))).length]));
  const exact = /^[a-z0-9_]+(?:\+\+|#)$/i.test(query) ? text => includesLiteral(text, query) : text => qn.length > 1 && compact(text).includes(qn);
  return candidates.map(record => {
    const text = texts.get(record);
    let score = (profile ? 12 : 0) + (exact(text) ? 30 : 0);
    for (const term of terms) if (matchers.get(term)(text)) score += (term.length >= 3 ? 2 : 1) * Math.log(1 + (candidates.length + 1) / (1 + frequency.get(term)));
    for (const group of groupMatchers) if (group.some(match => match(text))) score += 1.5;
    if (scopedEntities.length) score += 12;
    if (selectedEnvironments.length || literalScopes.length) score += 8;
    if (intentFamilies.length) score += 8;
    if (!asksNegative && /喜欢|偏爱|最爱|爱喝/.test(q) && !negative.test(record.value + ' ' + record.content)) score += 3;
    return {r:record, score};
  }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || right.r.updatedAt.localeCompare(left.r.updatedAt));
}
