import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/memory.js'
import {
  installMemoryLifecycle, extractMemoryFacts, validateExtractedFacts,
  memoryJobKey, MemoryExtractionError,
} from '../lib/memory-lifecycle.js'

const source = { sessionId: 's1', userEventId: 'user-1', assistantEventId: 'assistant-1', userText: '我一直喜欢喝冰美式，平时不加糖。', assistantText: '主人，本鱼记住你的口味啦。' }
const route = { provider: 'deepseek', model: 'DeepSeek-V4.1-Flash', reasoningEffort: 'high' }
const fact = { spaceId: 'owner', subject: '用户', predicate: '饮品偏好', value: '冰美式', content: '模型可能生成的多余叙述', evidence: '我一直喜欢喝冰美式', tags: ['冰美式', '不存在的主题'] }

test('extraction accepts only exact user evidence and reconstructs content from the validated value', () => {
  const result = validateExtractedFacts({ facts: [fact, { ...fact, value: '上海' }, { ...fact, evidence: '我喜欢咖啡' }, { ...fact, subject: '任何人' }] }, source)
  assert.equal(result.facts.length, 1)
  assert.equal(result.rejected, 3)
  assert.equal(result.facts[0].content, '用户 · 饮品偏好：冰美式')
  assert.deepEqual(result.facts[0].tags, ['冰美式'])
  assert.throws(() => validateExtractedFacts({ records: [] }, source), MemoryExtractionError)
})

test('test phrases, secrets, opt-out and invented companion experiences remain outside long-term facts', () => {
  for (const userText of ['这是一个测试，我一直喜欢喝冰美式。', '请不要记住我一直喜欢喝冰美式。', '不保存本轮，我一直喜欢喝冰美式。', '我的密码是test-private-value，我一直喜欢喝冰美式。', '假如我一直喜欢喝冰美式。']) assert.equal(validateExtractedFacts({ facts: [fact] }, { ...source, userText }).facts.length, 0)
  const self = { ...fact, spaceId: 'self', subject: '共同经历' }
  assert.equal(validateExtractedFacts({ facts: [self] }, source).facts.length, 0)
  const shared = { ...self, predicate: '共同完成的项目', value: '记忆宫殿', evidence: '我们一起完成了记忆宫殿' }
  assert.equal(validateExtractedFacts({ facts: [shared] }, { ...source, userText: shared.evidence }).facts.length, 1)
})

test('negation and historical facts retain their meaning instead of changing a current preference', () => {
  const negative = { ...fact, predicate: '咖啡加糖偏好', value: '糖', evidence: '我喝咖啡从来不加糖' }
  assert.equal(validateExtractedFacts({ facts: [negative] }, { ...source, userText: negative.evidence }).facts.length, 0)
  assert.equal(validateExtractedFacts({ facts: [{ ...negative, value: '不加糖' }] }, { ...source, userText: negative.evidence }).facts.length, 1)
  const history = { ...fact, predicate: '居住城市', value: '北京', evidence: '我以前在北京居住' }
  assert.equal(validateExtractedFacts({ facts: [history] }, { ...source, userText: history.evidence }).facts.length, 0)
  assert.equal(validateExtractedFacts({ facts: [{ ...history, predicate: '曾居住城市' }] }, { ...source, userText: history.evidence }).facts.length, 1)
})

test('parallel and additional preferences default to add while explicit corrections may update', () => {
  const userText = '我喜欢喝咖啡，也喜欢喝茶。现在也喜欢喝可可。'
  const candidates = [
    { ...fact, value: '咖啡', evidence: '我喜欢喝咖啡' },
    { ...fact, value: '茶', evidence: '也喜欢喝茶', operation: 'update' },
    { ...fact, value: '可可', evidence: '现在也喜欢喝可可', operation: 'update' },
  ]
  const result = validateExtractedFacts({ facts: candidates }, { ...source, userText })
  assert.equal(result.facts.length, 3)
  assert.deepEqual(result.facts.map(value => value.operation), ['add', 'add', 'add'])
  const evidence = '我不再喜欢喝咖啡，改为喜欢喝拿铁'
  assert.equal(validateExtractedFacts({ facts: [{ ...fact, value: '拿铁', evidence, operation: 'update' }] }, { ...source, userText: evidence }).facts[0].operation, 'update')
  const city = { ...fact, predicate: '居住城市', value: '上海', evidence: '我现在居住在上海', operation: 'update' }
  assert.equal(validateExtractedFacts({ facts: [city] }, { ...source, userText: city.evidence }).facts[0].operation, 'update')
  const correctedCity = { ...city, evidence: '我以前居住在北京，现在搬到上海' }
  assert.equal(validateExtractedFacts({ facts: [correctedCity] }, { ...source, userText: correctedCity.evidence }).facts[0].operation, 'update')
})

test('entity and scope must be present in each evidence and same-value project facts remain distinct', () => {
  const evidence = '项目甲生产环境使用本地模型。项目乙生产环境使用本地模型。'
  const first = { ...fact, predicate: '语音模型', value: '本地模型', entity: '项目甲', scope: '生产环境', evidence: '项目甲生产环境使用本地模型' }
  const second = { ...first, entity: '项目乙', evidence: '项目乙生产环境使用本地模型' }
  const result = validateExtractedFacts({ facts: [first, second, { ...first, entity: '项目丙' }, { ...first, scope: '测试环境' }] }, { ...source, userText: evidence })
  assert.equal(result.facts.length, 2)
  assert.equal(result.rejected, 2)
  assert.deepEqual(result.facts.map(value => value.entity), ['项目甲', '项目乙'])
  assert.match(result.facts[0].content, /项目甲.*生产环境/)
})

test('actual LLM protocol uses the completed session route, tools-free input and text deltas once', async () => {
  let request
  const output = JSON.stringify({ facts: [fact] })
  const llm = { async *stream(options) {
    request = options
    yield { type: 'reasoning-delta', index: 0, text: 'private reasoning' }
    yield { type: 'text-delta', index: 1, text: output.slice(0, 30) }
    yield { type: 'text-delta', index: 1, text: output.slice(30) }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: output } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const result = await extractMemoryFacts(llm, { ...source, assistantText: '主回复中的密码 private-assistant-provider-value。' }, route, new AbortController().signal)
  assert.equal(result.facts.length, 1)
  assert.equal(request.provider, route.provider)
  assert.equal(request.model, route.model)
  assert.equal(request.reasoningEffort, 'high')
  assert.deepEqual(request.tools, [])
  assert.equal(request.sessionId, source.sessionId)
  assert.equal(request.messages[0].role, 'user')
  assert.equal(request.messages[0].content[0].type, 'text')
  assert.equal(JSON.parse(request.messages[0].content[0].text).userText, source.userText)
  assert.deepEqual(Object.keys(JSON.parse(request.messages[0].content[0].text)), ['userText'])
  assert.doesNotMatch(JSON.stringify(request), /private-assistant-provider-value/)
})

test('complete text blocks are supported; incomplete, tool or failed output cannot be committed', async () => {
  const output = JSON.stringify({ facts: [fact] })
  const good = { async *stream() { yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  assert.equal((await extractMemoryFacts(good, source, route)).facts.length, 1)
  for (const chunks of [
    [{ type: 'text-delta', text: output }],
    [{ type: 'tool-call-delta', name: 'save_memory' }],
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'NETWORK_ERROR', message: 'private-provider-value' } } }],
    [{ type: 'text-delta', text: '{bad' }, { type: 'finish', reason: { kind: 'stop' } }],
  ]) {
    const bad = { async *stream() { yield* chunks } }
    await assert.rejects(extractMemoryFacts(bad, source, route), error => error instanceof MemoryExtractionError && !error.message.includes('private-provider-value'))
  }
})

test('job identity is tied to both source messages and cannot repeat across event replay', () => {
  assert.equal(memoryJobKey(source), memoryJobKey({ ...source, userText: '相同来源的读取副本' }))
  assert.notEqual(memoryJobKey(source), memoryJobKey({ ...source, userEventId: 'next-user' }))
})

function environment({ preset = 'whale', parentSession, enabled = true, extractor, jobs = [], storeOverride, retryDelaysMs = [1, 1], timeoutMs = 2000, acceptAgent } = {}) {
  const handlers = new Map(), disposers = [], events = []
  let memoryEnabled = enabled, seq = 0
  const session = { id: 's1', header: { agentPreset: preset, ...(parentSession ? { parentSession } : {}) }, snapshotEvents: () => [...events], requestHeader: () => ({ config: route }) }
  const agent = { id: 's1', session, status: 'idle' }
  const data = { jobs: structuredClone(jobs), facts: [] }
  const store = storeOverride ?? {
    get: () => structuredClone(data),
    async createJob(payload) { const found = data.jobs.find(job => job.key === payload.key); if (found) return structuredClone(found); const job = { ...structuredClone(payload), id: 'job-' + (data.jobs.length + 1) }; data.jobs.push(job); return structuredClone(job) },
    pendingJobs: () => structuredClone(data.jobs.filter(job => ['queued', 'running'].includes(job.status) || (job.status === 'failed' && job.retryable && (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= Date.now())))),
    async startJob(id, details) { Object.assign(data.jobs.find(job => job.id === id), details, { status: 'running' }) },
    async failJob(id, details) { Object.assign(data.jobs.find(job => job.id === id), details) },
    async completeJob(id, result) { Object.assign(data.jobs.find(job => job.id === id), { status: 'completed', retryable: false, result }) },
    async retryJob(id) { Object.assign(data.jobs.find(job => job.id === id), { status: 'queued', attempts: 0, retryable: false, nextRetryAt: undefined }) },
    async consolidate(facts, recordedSource) { data.facts.push(...facts.map(value => ({ ...value, source: structuredClone(recordedSource) }))); return { saved: facts, merged: [], skipped: [] } },
  }
  const ctx = {
    agents: { get: id => id === 's1' ? agent : undefined, list: () => [agent] }, llm: {},
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); return () => handlers.get(name).delete(fn) },
    effect(fn) { disposers.push(fn()) },
  }
  const emit = (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) }
  const lifecycle = installMemoryLifecycle(ctx, store, () => ({ memory: { enabled: memoryEnabled } }), { extractor: extractor ?? (async () => validateExtractedFacts({ facts: [fact] }, source)), retryDelaysMs, timeoutMs, acceptAgent })
  function event(type, body) { const event = { type, seq: seq++, time: Date.now(), data: body }; events.push(event); emit('session/event', session, event); return event }
  function turn({ reason = 'completed', text = source.userText, content, sourceKind = 'user', assistant = source.assistantText, tool = false } = {}) {
    const n = seq
    event('turn/start', { turn: n })
    event('user/message', { id: 'user-' + n, content: content ?? [{ type: 'text', text }], source: { kind: sourceKind } })
    event('assistant/message', { message: { id: 'assistant-' + n, content: [{ type: 'text', text: assistant }, ...(tool ? [{ type: 'tool-call', name: 'tool' }] : [])] } })
    event('turn/end', { turn: n, reason: { kind: reason } })
  }
  return { ctx, agent, session, store, data, lifecycle, turn, event, emit,
    async setEnabled(value) { memoryEnabled = value; await lifecycle.reconcile() },
    async setPreset(value) { event('agent-preset/selected', { agentPreset: value }); emit('agent-preset/selected', session.id, value); await lifecycle.reconcile(session.id) },
    dispose() { lifecycle.dispose(); for (const remove of disposers) remove?.() },
  }
}

async function until(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition timeout'); await pause(5) }
}

test('a completed whale root turn persists a source-bound job before consolidation', async () => {
  const env = environment()
  try {
    env.turn(); await env.lifecycle.waitForIdle()
    assert.equal(env.data.jobs.length, 1)
    assert.equal(env.data.jobs[0].status, 'completed')
    assert.equal(env.data.facts.length, 1)
    assert.equal(env.data.facts[0].source.sessionId, 's1')
    assert.equal(env.data.facts[0].source.userText, source.userText)
    assert.equal(env.data.facts[0].source.observedAt, new Date(env.session.snapshotEvents().find(event=>event.type==='user/message'&&event.data.source.kind==='user').time).toISOString())
    assert.equal(env.data.jobs[0].route.model, route.model)
    assert.equal(env.lifecycle.snapshot().completed, 1)
    assert.doesNotMatch(JSON.stringify(env.lifecycle.snapshot()), /冰美式/)
  } finally { env.dispose() }
})

test('standard sessions, child sessions, aborted turns and internal contexts never enqueue a fact', async () => {
  for (const settings of [{ preset: 'standard' }, { parentSession: 'parent' }, { enabled: false }]) {
    const env = environment(settings)
    try { env.turn(); await env.lifecycle.waitForIdle(); assert.equal(env.data.jobs.length, 0) } finally { env.dispose() }
  }
  const env = environment()
  try {
    env.turn({ reason: 'cancelled' }); env.turn({ sourceKind: 'runtime-context' }); env.turn({ tool: true })
    await env.lifecycle.waitForIdle(); assert.equal(env.data.jobs.length, 0)
  } finally { env.dispose() }
})

test('QQ image-only and face enrichment turns do not enter permanent-memory extraction', async () => {
  let extracted=0;const env=environment({extractor:async()=>{extracted++;return {facts:[]}}})
  try {
    env.turn({content:[{type:'image',url:'data:image/png;base64,media'}]})
    env.turn({content:[{type:'text',text:'我喜欢喝咖啡',dafeiyuQQEnrichment:true}]})
    await env.lifecycle.waitForIdle();assert.equal(extracted,0);assert.equal(env.data.jobs.length,0)
  }finally{env.dispose()}
})

test('QQ mixed-media background extraction uses only the exact human text as its source', async () => {
  const env=environment({extractor:async(_llm,recordedSource)=>validateExtractedFacts({facts:[{spaceId:'owner',subject:'用户',predicate:'称呼',value:'小泽',evidence:'我叫小泽'}]},recordedSource)})
  try {
    env.turn({content:[{type:'text',text:'我叫小泽'},{type:'text',text:'我喜欢喝咖啡',dafeiyuQQEnrichment:true},{type:'image',url:'data:image/png;base64,media'}]})
    await env.lifecycle.waitForIdle();assert.equal(env.data.jobs.length,1);assert.equal(env.data.facts.length,1)
    assert.equal(env.data.jobs[0].source.userText,'我叫小泽');assert.equal(env.data.facts[0].source.userText,'我叫小泽')
    assert.equal(env.data.facts[0].value,'小泽')
  }finally{env.dispose()}
})

test('rapid completed turns remain serial and each retained source is consolidated once', async () => {
  let concurrent = 0, maximum = 0
  const env = environment({ extractor: async () => { concurrent++; maximum = Math.max(maximum, concurrent); await pause(2); concurrent--; return { facts: [fact] } } })
  try {
    for (let index = 0; index < 5; index++) env.turn()
    await until(() => env.lifecycle.snapshot().completed === 5)
    assert.equal(maximum, 1)
    assert.equal(new Set(env.data.facts.map(value => value.source.userEventId)).size, 5)
  } finally { env.dispose() }
})

test('failed extraction has a three-attempt ceiling and remains visible for manual retry', async () => {
  let calls = 0
  const env = environment({ extractor: async () => { calls++; throw Error('private-provider-message') } })
  try {
    env.turn(); await until(() => env.lifecycle.snapshot().failed === 1)
    assert.equal(calls, 3)
    assert.equal(env.data.jobs[0].attempts, 3)
    assert.equal(env.data.facts.length, 0)
    assert.doesNotMatch(JSON.stringify(env.lifecycle.snapshot()), /private-provider-message/)
    assert.equal((await env.lifecycle.retry(env.data.jobs[0].id)).retried, 1)
    await until(() => calls === 6 && env.lifecycle.snapshot().failed === 1)
  } finally { env.dispose() }
})

test('switching modes cancels live extraction and prevents a late fact from being written', async () => {
  let started, extractionSignal
  const ready = new Promise(resolve => { started = resolve })
  const env = environment({ extractor: async (_llm, _source, _route, signal) => {
    extractionSignal = signal; started()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return { facts: [fact] }
  } })
  try {
    env.turn(); await ready; await env.setPreset('standard'); await env.lifecycle.waitForIdle()
    assert.equal(extractionSignal.aborted, true)
    assert.equal(env.data.facts.length, 0)
    assert.equal(env.lifecycle.snapshot().cancelled, 1)
    assert.equal((await env.lifecycle.retry()).retried, 0)
  } finally { env.dispose() }
})

test('disabling memory cancels both the active task and queued tasks', async () => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  const env = environment({ extractor: async (_llm, _source, _route, signal) => {
    started(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return { facts: [] }
  } })
  try {
    env.turn(); env.turn(); await ready; await env.setEnabled(false); await env.lifecycle.waitForIdle()
    assert.equal(env.lifecycle.snapshot().cancelled, 2)
    assert.equal(env.data.facts.length, 0)
  } finally { env.dispose() }
})

test('persistent queued tasks recover after restart using their original route and evidence', async () => {
  const job = { id: 'persisted', key: memoryJobKey(source), source, route, status: 'queued', attempts: 0 }
  const env = environment({ jobs: [job] })
  try {
    await env.lifecycle.waitForIdle()
    assert.equal(env.data.jobs[0].status, 'completed')
    assert.equal(env.data.facts[0].source.userEventId, source.userEventId)
  } finally { env.dispose() }
})

test('group lifecycle requires an explicit session filter and private lifecycle excludes group turns',async()=>{
 for(const settings of [{preset:'whale-group'},{preset:'whale-group',acceptAgent:()=>false},{preset:'whale',acceptAgent:()=>false},{preset:'standard',acceptAgent:()=>true}]){
  const env=environment(settings);
  try{env.turn();await env.lifecycle.waitForIdle();assert.equal(env.data.jobs.length,0);}finally{env.dispose();}
 }
 const group=environment({preset:'whale-group',acceptAgent:agent=>agent.id==='s1'});
 try{group.turn();await group.lifecycle.waitForIdle();assert.equal(group.data.jobs.length,1);assert.equal(group.data.jobs[0].status,'completed');}finally{group.dispose();}
});

test('recovered group jobs stay in their selected lifecycle and rejected session mappings cancel without extraction',async()=>{
 const job={id:'group-persisted',key:memoryJobKey(source),source,route,status:'queued',attempts:0};
 for(const accepted of [true,false]){
  let calls=0;const env=environment({preset:'whale-group',jobs:[job],acceptAgent:agent=>accepted&&agent.id==='s1',extractor:async()=>{calls++;return {facts:[fact]};}});
  try{await env.lifecycle.waitForIdle();assert.equal(calls,accepted?1:0);assert.equal(env.data.jobs[0].status,accepted?'completed':'cancelled');assert.equal(env.data.facts.length,accepted?1:0);}finally{env.dispose();}
 }
});

test('a group mapping revoked while its real palace commit waits cannot persist a late fact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dafeiyu-group-commit-'));
 const store=new MemoryStore(join(dir,'cache.json'),{palaceRoot:join(dir,'palace')});
 const consolidate=store.consolidate.bind(store);let release,queued,accepted=true;
 const waiting=new Promise(resolve=>{queued=resolve;});
 store.consolidate=(...args)=>{store.pending=new Promise(resolve=>{release=resolve;});const result=consolidate(...args);queued();return result;};
 const env=environment({preset:'whale-group',storeOverride:store,acceptAgent:agent=>accepted&&agent.id==='s1'});
 try{
  env.turn();await waiting;accepted=false;release();await env.lifecycle.waitForIdle();
  assert.equal(store.status().memoryCount,0);assert.equal(store.get().jobs[0].status,'cancelled');
 }finally{env.dispose();await rm(dir,{recursive:true,force:true});}
});

test('completed-turn consolidation writes a real Markdown palace and remains retrievable after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-palace-lifecycle-'))
  const path = join(dir, 'memory-cache.json'), palaceRoot = join(dir, '记忆宫殿')
  const store = new MemoryStore(path, { palaceRoot })
  const env = environment({ storeOverride: store })
  try {
    env.turn(); await env.lifecycle.waitForIdle()
    const memories = store.search('冰美式')
    assert.equal(memories.length, 1)
    assert.equal(memories[0].value, '冰美式')
    assert.equal(memories[0].source.sessionId, source.sessionId)
    const file = await readFile(memories[0].filePath, 'utf8')
    assert.match(file, /饮品偏好/)
    assert.match(file, /userEventId/)
    assert.match(await readFile(join(palaceRoot, '索引', '主题.md'), 'utf8'), /冰美式/)
    assert.equal(store.get().jobs[0].status, 'completed')
    assert.equal(store.get().jobs[0].source.userText, undefined)
    const resumed = new MemoryStore(path, { palaceRoot })
    assert.equal(resumed.search('冰美式')[0].id, memories[0].id)
  } finally { env.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('sensitive values, opt-out and testing passphrases are filtered before durable job creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-palace-privacy-'))
  const palaceRoot = join(dir, '记忆宫殿'), path = join(dir, 'memory-cache.json')
  const store = new MemoryStore(path, { palaceRoot })
  let extracted = 0
  const env = environment({ storeOverride: store, extractor: async () => { extracted++; return { facts: [] } } })
  try {
    for (const text of ['我的密码是 private-sensitive-value。', '本次配置测试验收暗号是 private-verification-value。', '请不要记住 private-opt-out-value。']) env.turn({ text })
    await env.lifecycle.waitForIdle()
    assert.equal(store.get().jobs.length, 0)
    assert.equal(extracted, 0)
    assert.equal(env.lifecycle.snapshot().skipped, 3)
    const durableState = await readFile(join(palaceRoot, '.state', 'state.json'), 'utf8')
    const durableCache = await readFile(path, 'utf8')
    assert.doesNotMatch(durableState + durableCache, /private-sensitive-value|private-verification-value|private-opt-out-value/)
    assert.doesNotMatch(JSON.stringify(store.get().jobs.map(job => job.source)), /private-/)
  } finally { env.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('assistant reply text is absent from durable jobs even while consolidation is running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-palace-assistant-privacy-'))
  const palaceRoot = join(dir, '记忆宫殿'), path = join(dir, 'memory-cache.json')
  const store = new MemoryStore(path, { palaceRoot })
  const privateReply = '主回复中的密码 private-assistant-durable-value。'
  let observedSource, stateDuringExtraction
  const env = environment({ storeOverride: store, extractor: async (_llm, recordedSource) => {
    observedSource = structuredClone(recordedSource)
    stateDuringExtraction = await readFile(join(palaceRoot, '.state', 'state.json'), 'utf8')
    assert.equal(store.get().jobs[0].status, 'running')
    assert.equal(store.get().jobs[0].source.assistantText, '')
    return { facts: [] }
  } })
  try {
    env.turn({ assistant: privateReply }); await env.lifecycle.waitForIdle()
    assert.equal(observedSource.assistantText, '')
    assert.equal(typeof observedSource.assistantEventId, 'string')
    assert.doesNotMatch(stateDuringExtraction, /private-assistant-durable-value|主回复中的密码/)
    const state = await readFile(join(palaceRoot, '.state', 'state.json'), 'utf8')
    const cache = await readFile(path, 'utf8')
    assert.doesNotMatch(state + cache, /private-assistant-durable-value|主回复中的密码/)
    assert.equal(store.get().jobs[0].status, 'completed')
  } finally { env.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('real palace retains parallel and later preferences while replacing only an explicitly corrected value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-palace-preferences-'))
  const store = new MemoryStore(join(dir, 'memory-cache.json'), { palaceRoot: join(dir, '记忆宫殿') })
  const first = '我喜欢喝咖啡，也喜欢喝茶。', added = '我现在也喜欢喝可可。', corrected = '我不再喜欢喝咖啡，改为喝拿铁。'
  const byText = new Map([
    [first, [{ ...fact, value: '咖啡', evidence: '我喜欢喝咖啡' }, { ...fact, value: '茶', evidence: '也喜欢喝茶' }]],
    [added, [{ ...fact, value: '可可', evidence: '我现在也喜欢喝可可', operation: 'update' }]],
    [corrected, [{ ...fact, value: '拿铁', evidence: '我不再喜欢喝咖啡，改为喝拿铁', operation: 'update' }]],
  ])
  const env = environment({ storeOverride: store, extractor: async (_llm, recordedSource) => validateExtractedFacts({ facts: byText.get(recordedSource.userText) }, recordedSource) })
  try {
    env.turn({ text: first }); await env.lifecycle.waitForIdle()
    assert.deepEqual(new Set(store.search('', 'owner').map(value => value.value)), new Set(['咖啡', '茶']))
    const coffee = store.search('', 'owner').find(value => value.value === '咖啡')
    env.turn({ text: added }); await env.lifecycle.waitForIdle()
    assert.deepEqual(new Set(store.search('', 'owner').map(value => value.value)), new Set(['咖啡', '茶', '可可']))
    env.turn({ text: corrected }); await env.lifecycle.waitForIdle()
    const active = store.search('', 'owner')
    assert.deepEqual(new Set(active.map(value => value.value)), new Set(['拿铁', '茶', '可可']))
    assert.equal(store.getRecord(coffee.id).status, 'superseded')
    assert.equal(active.find(value => value.value === '拿铁').supersedes, coffee.id)
  } finally { env.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('real palace isolates project and environment configuration through subsequent corrections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-palace-entities-'))
  const store = new MemoryStore(join(dir, 'memory-cache.json'), { palaceRoot: join(dir, '记忆宫殿') })
  const first = '项目甲的语音模型使用本地模型。项目乙的语音模型也使用本地模型。'
  const corrected = '项目甲的语音模型改为云端模型。'
  const scopes = '项目甲生产环境的服务地址是地址甲。项目甲测试环境的服务地址是地址乙。'
  const correctedScope = '项目甲生产环境的服务地址改为地址丙。'
  const byText = new Map([
    [first, [
      { ...fact, predicate: '语音模型', value: '本地模型', entity: '项目甲', evidence: '项目甲的语音模型使用本地模型' },
      { ...fact, predicate: '语音模型', value: '本地模型', entity: '项目乙', evidence: '项目乙的语音模型也使用本地模型' },
    ]],
    [corrected, [{ ...fact, predicate: '语音模型', value: '云端模型', entity: '项目甲', evidence: '项目甲的语音模型改为云端模型', operation: 'update' }]],
    [scopes, [
      { ...fact, predicate: '服务地址', value: '地址甲', entity: '项目甲', scope: '生产环境', evidence: '项目甲生产环境的服务地址是地址甲' },
      { ...fact, predicate: '服务地址', value: '地址乙', entity: '项目甲', scope: '测试环境', evidence: '项目甲测试环境的服务地址是地址乙' },
    ]],
    [correctedScope, [{ ...fact, predicate: '服务地址', value: '地址丙', entity: '项目甲', scope: '生产环境', evidence: '项目甲生产环境的服务地址改为地址丙', operation: 'update' }]],
  ])
  const env = environment({ storeOverride: store, extractor: async (_llm, recordedSource) => validateExtractedFacts({ facts: byText.get(recordedSource.userText) }, recordedSource) })
  try {
    env.turn({ text: first }); await env.lifecycle.waitForIdle()
    assert.equal(store.search('', 'owner').length, 2)
    env.turn({ text: corrected }); await env.lifecycle.waitForIdle()
    const models = store.search('', 'owner').filter(value => value.predicate === '语音模型')
    assert.deepEqual(models.map(value => [value.entity, value.value]).sort(), [['项目乙', '本地模型'], ['项目甲', '云端模型']].sort())
    env.turn({ text: scopes }); await env.lifecycle.waitForIdle()
    env.turn({ text: correctedScope }); await env.lifecycle.waitForIdle()
    const addresses = store.search('', 'owner').filter(value => value.predicate === '服务地址')
    assert.deepEqual(addresses.map(value => [value.scope, value.value]).sort(), [['生产环境', '地址丙'], ['测试环境', '地址乙']].sort())
  } finally { env.dispose(); await rm(dir, { recursive: true, force: true }) }
})
