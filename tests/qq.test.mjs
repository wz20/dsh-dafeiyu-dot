import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') return { url: 'data:text/javascript,export const credentialRef = name => ({name});', shortCircuit: true };
  return next(specifier, context);
} });
const { installQQ } = await import('../lib/qq.js');
const pause = (ms = 1) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label = 'condition') { for (let i = 0; i < 150; i++) { if (condition()) return; await pause(2); } assert.fail('Timed out: ' + label); }

async function environment(options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dafeiyu-qq-test-'));
  let timestamp = 1_800_000_000_000, token = 'private-gateway-token', nextMessage = 0, sequence = 0;
  const value = { qq: { enabled: true, wsUrl: 'ws://127.0.0.1:13001', botId: '10001', ownerId: '20002', sessionId: 'fish-session', voiceReplies: true, ...options.qq } };
  const handlers = new Map(), cleanups = [], calls = [], sockets = [], followups = [], speechCalls = [], log = [];
  const config = { get: () => structuredClone(value), async update(patch) { value.qq = { ...value.qq, ...patch.qq }; return this.get(); } };
  const session = { id: 'fish-session', header: { agentPreset: 'whale' }, snapshotEvents: () => [...log] };
  const agent = { id: session.id, status: 'idle', session, followup(message) {
    followups.push(message); this.status = 'running';options.onFollowup?.(message);
    if (options.followupError) return Promise.reject(Error('private-agent-details'));
    if (!options.holdTurn) queueMicrotask(() => complete(message));
  } };
  function emit(type, data) { const event = { type, data, seq: ++sequence, time: timestamp }; log.push(event); for (const listener of handlers.get('session/event') ?? []) listener(session, event); }
  function complete(message = followups.at(-1), { reason = 'completed', text = '主人，我在这儿陪你呢。', foreignUser = false, toolOnly = false } = {}) {
    emit('turn/start', { turn: sequence + 1 });
    emit('user/message', message);
    if (foreignUser) emit('user/message', { id: 'desktop-input', source: { kind: 'user' }, content: [{ type: 'text', text: '桌面私密内容' }] });
    emit('assistant/message', { message: { id: 'assistant-' + sequence, content: [{ type: 'text', text }, ...(toolOnly ? [{ type: 'tool-call', name: 'internal', id: 'tool-1' }] : [])] } });
    agent.status = 'idle'; emit('turn/end', { reason: { kind: reason } });
  }
  class FakeWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.handlers = new Map(); sockets.push(this); queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.event('open', {}); }); }
    addEventListener(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); }
    event(type, data) { for (const listener of this.handlers.get(type) ?? []) listener(data); }
    message(data) { this.event('message', { data: JSON.stringify(data) }); }
    send(raw) {
      const request = JSON.parse(raw); calls.push(request);
      let response = { status: 'ok', retcode: 0, data: request.action === 'get_login_info' ? { user_id: options.actualBotId ?? '10001' } : request.action === 'get_status' ? { online: true, good: true } : { message_id: calls.length } };
      if (options.rpcResponse) response = options.rpcResponse(request, response);
      if (response) queueMicrotask(() => this.message({ ...response, echo: request.echo }));
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.event('close', {}); }
  }
  const ctx = { agents: { get: id => id === session.id ? agent : undefined }, sessionController:{agents:{serializeImageAdmission:options.serializeImageAdmission??(async(_agent,operation)=>operation())}},
    credentials: { async resolve(ref) { assert.equal(ref.name, 'DAFEIYU_QQ_TOKEN'); return { value: token }; } },
    on(type, fn) { const list = handlers.get(type) ?? []; list.push(fn); handlers.set(type, list); return () => handlers.set(type, (handlers.get(type) ?? []).filter(item => item !== fn)); },
    effect(fn) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  };
  const speech = { async synthesize(text, details) { speechCalls.push({ text, details }); if (options.synthesize) return options.synthesize(text, details); return { audio: Buffer.from('isolated-test-wave'), delivery: { mode: 'model', emotion: 'warm' } }; } };
  const qq = installQQ(ctx, { ctx, config, speech, singing:options.singing, stickers:options.stickers, mediaPrepare:options.mediaPrepare, root, WebSocketImpl: FakeWebSocket, makeMessage: input => ({ ...input, id: 'qq-user-' + (++nextMessage) }), now: () => timestamp, rpcTimeoutMs: options.rpcTimeoutMs ?? 30, retryDelayMs: 1000, pairingTTL: 10 * 60_000, turnTimeoutMs: 1500 });
  const incoming = (text, extras = {}) => { const ws = sockets.at(-1); ws.message({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '10001', user_id: '20002', message_id: nextMessage + '-in-' + calls.length, time: Math.floor(timestamp / 1000), message: [{ type: 'text', data: { text } }], ...extras }); };
  const outgoing = () => calls.filter(call => call.action === 'send_private_msg');
  const dispose = () => { qq.dispose(); for (const cleanup of cleanups) cleanup(); };
  return { root, qq, config, agent, session, calls, sockets, followups, speechCalls, log, emit, complete, incoming, outgoing, dispose, setToken: t => { token = t; }, advance: ms => { timestamp += ms; }, setRPC: fn => { options.rpcResponse = fn; }, ready: () => until(() => qq.snapshot().phase === 'ready' || qq.snapshot().phase === 'error', 'gateway ready') };
}

test('QQ validates the local gateway identity and keeps its token out of observable state', async () => {
  const e = await environment(); try {
    await e.ready(); assert.equal(e.qq.snapshot().connected, true);
    assert.equal(e.calls[0].action, 'get_login_info');
    assert.equal(e.calls[1].action, 'get_status');
    assert.equal(new URL(e.sockets[0].url).searchParams.get('access_token'), 'private-gateway-token');
    assert.doesNotMatch(JSON.stringify(e.qq.snapshot()), /private-gateway-token|access_token/);
    assert.equal(new Set(e.calls.map(call => call.echo)).size, e.calls.length);
  } finally { e.dispose(); }
});

test('empty bot identity is established from the verified gateway; mismatched accounts stay disconnected', async () => {
  const e = await environment({ qq: { botId: '' } }); try { await e.ready(); assert.equal(e.config.get().qq.botId, '10001'); assert.equal(e.qq.snapshot().connected, true); } finally { e.dispose(); }
  const wrong = await environment({ actualBotId: '99999' }); try { await wrong.ready(); assert.equal(wrong.qq.snapshot().connected, false); assert.match(wrong.qq.snapshot().lastError, /不一致/); wrong.incoming('你好'); await pause(10); assert.equal(wrong.followups.length, 0); } finally { wrong.dispose(); }
});

test('non-loopback endpoints and missing gateway credentials never open a socket', async () => {
  for (const wsUrl of ['ws://example.com:13001', 'ws://127.0.0.1.evil.test:13001', 'ws://user:secret@127.0.0.1:13001', 'file:///tmp/qq', 'ws://127.0.0.1:13001?token=secret']) {
    const e = await environment({ qq: { wsUrl } }); try { await e.ready(); assert.equal(e.sockets.length, 0); assert.doesNotMatch(JSON.stringify(e.qq.snapshot()), /secret|evil/); } finally { e.dispose(); }
  }
  const e = await environment({ qq: { enabled: false } }); try { e.setToken(''); await e.config.update({ qq: { enabled: true } }); await e.qq.reconcile(); assert.equal(e.sockets.length, 0); assert.match(e.qq.snapshot().lastError, /令牌/); } finally { e.dispose(); }
});

test('one-time private pairing binds only the code sender and never enters the AI or palace', async () => {
  const e = await environment({ qq: { ownerId: '' } }); try {
    await e.ready(); const pair = e.qq.startPairing(); assert.match(pair.code, /^[A-F0-9]{24}$/);
    e.incoming('普通聊天', { user_id: '30003', message_id: 'ignored' });
    e.incoming('配对 ' + pair.code, { user_id: '30003', message_id: 'pair-first' });
    await until(() => e.qq.snapshot().paired, 'paired');
    await until(() => e.outgoing().length === 1, 'pair confirmation');
    assert.equal(e.qq.snapshot().ownerId, '30003'); assert.equal(e.qq.snapshot().pairing, null);
    assert.equal(e.followups.length, 0); assert.equal(e.speechCalls.length, 0); assert.equal(e.log.length, 0);
    assert.deepEqual((await readdir(e.root)).sort(), ['qq-state.json']);
    assert.throws(() => e.qq.startPairing(), /先解除绑定/);
    e.incoming('配对 ' + pair.code, { user_id: '40004', message_id: 'pair-reuse' });
    e.incoming('配对 ' + pair.code, { user_id: '30003', message_id: 'owner-pair-reuse' });
    await pause(10); assert.equal(e.qq.snapshot().ownerId, '30003'); assert.equal(e.outgoing().length, 1);
    assert.equal(e.followups.length, 0);
  } finally { e.dispose(); }
});

test('gateway health is not a substitute for an online QQ account', async () => {
  for (const data of [{ online: false, good: true }, { good: true }, { online: 'true', good: true }]) {
    const e = await environment({ rpcResponse: (request, normal) => request.action === 'get_status' ? { status: 'ok', retcode: 0, data } : normal });
    try { await e.ready(); assert.equal(e.qq.snapshot().connected, false); assert.equal(e.qq.snapshot().phase, 'error'); assert.match(e.qq.snapshot().lastError, /尚未在线/); e.incoming('离线消息'); await pause(5); assert.equal(e.followups.length, 0); }
    finally { e.dispose(); }
  }
});

test('an online-status failure or timeout cannot open pairing or chat intake', async () => {
  for (const response of [{ status: 'failed', retcode: 1400, message: 'private-status-error' }, null]) {
    const e = await environment({ rpcTimeoutMs: 10, rpcResponse: (request, normal) => request.action === 'get_status' ? response : normal });
    try { await e.ready(); assert.equal(e.qq.snapshot().connected, false); assert.match(e.qq.snapshot().lastError, /无法确认/); assert.doesNotMatch(JSON.stringify(e.qq.snapshot()), /private-status-error/); e.incoming('不能进入模型'); await pause(5); assert.equal(e.followups.length, 0); }
    finally { e.dispose(); }
  }
});

test('an offline heartbeat ends the verified connection and cancels pending QQ work', async () => {
  const e = await environment({ holdTurn: true }); try {
    await e.ready(); e.incoming('等待回复', { message_id: 'before-offline' }); await until(() => e.followups.length === 1);
    e.sockets.at(-1).message({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false, good: true } });
    assert.equal(e.qq.snapshot().connected, false); assert.match(e.qq.snapshot().lastError, /已离线/);
    e.complete(); await pause(10); assert.equal(e.outgoing().length, 0);
  } finally { e.dispose(); }
});

test('pairing expires and closes after five wrong attempts without making model calls', async () => {
  const e = await environment({ qq: { ownerId: '' } }); try {
    await e.ready(); const code = e.qq.startPairing().code;
    for (let i = 0; i < 5; i++) e.incoming('配对 BAD' + i, { user_id: '30003', message_id: 'bad-' + i });
    await until(() => !e.qq.snapshot().pairing, 'attempt limit');
    e.incoming('配对 ' + code, { user_id: '30003', message_id: 'too-late' }); await pause(10); assert.equal(e.qq.snapshot().paired, false);
    e.qq.startPairing(); e.advance(10 * 60_000); assert.equal(e.qq.snapshot().pairing, null);
    assert.equal(e.followups.length, 0); assert.equal(e.outgoing().length, 0);
  } finally { e.dispose(); }
});

test('only the owner fresh private text reaches the bound whale conversation', async () => {
  const e = await environment(); try {
    await e.ready();
    for (const extras of [{ user_id: '30003' }, { user_id: '10001' }, { self_id: '99999' }, { message_type: 'group' }, { post_type: 'notice' }, { sub_type: 'self' }, { time: 1_799_999_999 }, { time: undefined }]) e.incoming('忽略本条', extras);
    e.incoming('主人来啦', { message_id: 'owner-1' });
    await until(() => e.qq.snapshot().sentVoice === 1, 'owner reply');
    assert.equal(e.followups.length, 1); assert.equal(e.followups[0].content[0].text, '主人来啦'); assert.equal(e.followups[0].source.kind, 'user');
    assert.equal(e.outgoing()[0].params.user_id, '20002');
    const record = e.outgoing()[0].params.message[0]; assert.equal(record.type, 'record');
    assert.equal(Buffer.from(record.data.file.slice('base64://'.length), 'base64').toString(), 'isolated-test-wave');
    assert.equal(e.speechCalls[0].details.sessionId, 'fish-session'); assert.equal(e.speechCalls[0].details.signal.aborted, false);
  } finally { e.dispose(); }
});

test('inbound deduplication is committed before AI work and survives a channel restart', async () => {
  const e = await environment(); let root;
  try {
    root = e.root; await e.ready();
    e.incoming('同一句', { message_id: 'stable-id' }); e.incoming('同一句', { message_id: 'stable-id' });
    await until(() => e.qq.snapshot().sentVoice === 1, 'deduplicated reply');
    assert.equal(e.followups.length, 1); assert.match(await readFile(join(root, 'qq-state.json'), 'utf8'), /stable-id/);
  } finally { e.dispose(); }
  const next = await environment({ root }); try { await next.ready(); next.incoming('同一句', { message_id: 'stable-id' }); await pause(15); assert.equal(next.followups.length, 0); } finally { next.dispose(); }
});

test('desktop, historical, cancelled and tool-only turns are not forwarded to QQ', async () => {
  const e = await environment({ holdTurn: true }); try {
    await e.ready();
    e.complete({ id: 'old-desktop', source: { kind: 'user' }, content: [{ type: 'text', text: '桌面消息' }] });
    assert.equal(e.outgoing().length, 0);
    for (const [index, result] of [{ reason: 'cancelled' }, { reason: 'failed' }, { toolOnly: true }, { foreignUser: true }].entries()) {
      e.incoming('本轮不外发', { message_id: 'silent-' + index }); await until(() => e.followups.length === index + 1, 'source accepted');
      e.complete(e.followups.at(-1), result); await pause(8);
    }
    assert.equal(e.outgoing().length, 0); assert.equal(e.speechCalls.length, 0);
  } finally { e.dispose(); }
});

test('a completed response is tied to the exact SDK user id and final non-tool assistant text', async () => {
  const e = await environment({ holdTurn: true, qq: { voiceReplies: false } }); try {
    await e.ready(); e.incoming('来聊聊', { message_id: 'exact-source' }); await until(() => e.followups.length === 1);
    e.emit('turn/start', { turn: 1 }); e.emit('user/message', e.followups[0]);
    e.emit('assistant/message', { message: { content: [{ type: 'text', text: '中间工具说明' }, { type: 'tool-call', name: 'memory_search' }] } });
    e.emit('assistant/message', { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '最后的中文回复。' }] } });
    e.agent.status = 'idle'; e.emit('turn/end', { reason: { kind: 'completed' } });
    await until(() => e.qq.snapshot().sentText === 1);
    assert.equal(e.outgoing()[0].params.message[0].data.text, '最后的中文回复。'); assert.equal(e.speechCalls.length, 0);
  } finally { e.dispose(); }
});

test('busy sessions keep at most five queued owner messages and never bypass standard mode', async () => {
  const e = await environment({ holdTurn: true }); try {
    await e.ready(); e.agent.status = 'running';
    for (let i = 0; i < 8; i++) e.incoming('排队' + i, { message_id: 'queue-' + i });
    await until(() => e.qq.snapshot().received === 8);
    assert.equal(e.qq.snapshot().queueLength, 5); assert.equal(e.followups.length, 0);
    e.session.header.agentPreset = 'standard'; await e.qq.reconcile();
    assert.equal(e.qq.snapshot().queueLength, 0); e.agent.status = 'idle'; e.incoming('编码中', { message_id: 'standard-input' });
    await pause(20); assert.equal(e.followups.length, 0); assert.equal(e.outgoing().length, 0);
  } finally { e.dispose(); }
});

test('mode changes abort synthesis and suppress audio that completes after cancellation', async () => {
  let finish;
  const e = await environment({ synthesize: () => new Promise(resolve => { finish = resolve; }) }); try {
    await e.ready(); e.incoming('说一句', { message_id: 'late-audio' }); await until(() => e.speechCalls.length === 1);
    e.session.header.agentPreset = 'standard'; await e.qq.reconcile();
    assert.equal(e.speechCalls[0].details.signal.aborted, true);
    finish({ audio: Buffer.from('late-wave') }); await pause(15);
    assert.equal(e.outgoing().length, 0);
  } finally { e.dispose(); }
});

test('owner/session/configuration changes immediately stop old work and rotate credentials safely', async () => {
  let finish;
  const e = await environment({ synthesize: () => new Promise(resolve => { finish = resolve; }) }); try {
    await e.ready(); e.incoming('旧绑定', { message_id: 'old-binding' }); await until(() => e.speechCalls.length === 1);
    await e.config.update({ qq: { ownerId: '30003' } }); await e.qq.reconcile(); await e.ready();
    assert.equal(e.speechCalls[0].details.signal.aborted, true); finish({ audio: Buffer.from('late') }); await pause(10); assert.equal(e.outgoing().length, 0);
    const previousCount = e.sockets.length; e.setToken('rotated-private-token'); await e.qq.reconcile(); await e.ready();
    assert.equal(e.sockets.length, previousCount + 1); assert.equal(new URL(e.sockets.at(-1).url).searchParams.get('access_token'), 'rotated-private-token');
    assert.doesNotMatch(JSON.stringify(e.qq.snapshot()), /rotated-private-token/);
  } finally { e.dispose(); }
});

test('a cancelled non-cooperative synthesizer cannot block new binding work or surface a stale failure', async () => {
  let finish;
  const e = await environment({ synthesize: () => new Promise(resolve => { finish = resolve; }) }); try {
    await e.ready(); e.incoming('旧消息', { message_id: 'non-cooperative-old' }); await until(() => e.speechCalls.length === 1);
    await e.config.update({ qq: { ownerId: '30003', voiceReplies: false } }); await e.qq.reconcile(); await e.ready();
    e.incoming('新的主人消息', { user_id: '30003', message_id: 'new-binding' }); await until(() => e.qq.snapshot().sentText === 1, 'new binding unblocked');
    assert.equal(e.outgoing().length, 1); assert.equal(e.outgoing()[0].params.user_id, '30003');
    finish({ audio: Buffer.from('late-audio') }); await pause(5);
    assert.equal(e.outgoing().length, 1); assert.equal(e.qq.snapshot().lastError, null);
  } finally { e.dispose(); }
});

test('synthesis failure or an explicit voice rejection falls back to the same bounded text', async () => {
  for (const mode of ['synthesis', 'rejected', 'oversized']) {
    const e = await environment({ synthesize: mode === 'synthesis' ? async () => { throw Error('private-tts-error'); } : mode === 'oversized' ? async () => ({ audio: Buffer.alloc(16 * 1024 * 1024 + 1) }) : undefined,
      rpcResponse: (request, normal) => mode === 'rejected' && request.params?.message?.[0]?.type === 'record' ? { status: 'failed', retcode: 1200, message: 'private-backend-details' } : normal });
    try {
      await e.ready(); e.incoming('说一句', { message_id: 'fallback-' + mode }); await until(() => e.qq.snapshot().sentText === 1);
      assert.equal(e.qq.snapshot().sentVoice, 0); assert.equal(e.outgoing().at(-1).params.message[0].data.text, '主人，我在这儿陪你呢。');
      assert.doesNotMatch(JSON.stringify(e.qq.snapshot()), /private-tts-error|private-backend-details/);
    } finally { e.dispose(); }
  }
});

test('an unconfirmed voice RPC is not retried or followed by a duplicate text reply', async () => {
  const e = await environment({ rpcResponse: (request, normal) => request.action === 'send_private_msg' ? null : normal, rpcTimeoutMs: 10 }); try {
    await e.ready(); e.incoming('本条只发一次', { message_id: 'uncertain-voice' });
    await until(() => e.outgoing().length === 1); await pause(25);
    assert.equal(e.outgoing().length, 1); assert.equal(e.qq.snapshot().sentVoice, 0); assert.equal(e.qq.snapshot().sentText, 0); assert.match(e.qq.snapshot().lastError, /结果未确认/);
  } finally { e.dispose(); }
});

test('failed text RPCs never count as delivered and response text is bounded', async () => {
  const e = await environment({ holdTurn: true, qq: { voiceReplies: false }, rpcResponse: (request, normal) => request.action === 'send_private_msg' ? { status: 'failed', retcode: 100, data: null } : normal }); try {
    await e.ready(); e.incoming('长回复', { message_id: 'long-text' }); await until(() => e.followups.length === 1);
    e.complete(e.followups[0], { text: '鱼'.repeat(5000) }); await until(() => e.outgoing().length === 1); await pause(5);
    assert.equal(e.outgoing()[0].params.message[0].data.text.length, 4000); assert.equal(e.qq.snapshot().sentText, 0); assert.match(e.qq.snapshot().lastError, /没有接受/);
  } finally { e.dispose(); }
});

test('disposing the channel cancels source tracking, removes listeners and never revives queued work', async () => {
  const e = await environment({ holdTurn: true }); await e.ready();
  e.incoming('停止后不发', { message_id: 'dispose' }); await until(() => e.followups.length === 1);
  e.dispose(); e.complete(); await pause(10);
  assert.equal(e.outgoing().length, 0); assert.equal(e.qq.snapshot().connected, false); assert.equal(e.qq.snapshot().phase, 'disabled');
});

test('an explicit song returns its generated audio in QQ even with ordinary voice replies disabled',async()=>{
  const songId='01a186a2-e576-4b43-82eb-2df0217eee08',audio=Buffer.from('real-song-result');let reads=0;
  const e=await environment({holdTurn:true,qq:{voiceReplies:false},singing:{read:async(id,sid)=>{reads++;assert.equal(id,songId);assert.equal(sid,'fish-session');return {audio,delivery:{mode:'singing',cached:true}};}}});
  try{
    await e.ready();e.incoming('唱一段小星星');await until(()=>e.followups.length===1);
    e.emit('turn/start',{turn:1});e.emit('user/message',e.followups[0]);
    e.emit('tool/call',{name:'dafeiyu_sing',callId:'sing'});
    e.emit('tool/result',{message:{toolCallId:'sing',content:[{type:'text',text:JSON.stringify({status:'ready',songId,title:'小星星'})}]}});
    e.emit('assistant/message',{message:{content:[{type:'text',text:'唱好啦。'}]}});e.agent.status='idle';e.emit('turn/end',{reason:{kind:'completed'}});
    await until(()=>e.outgoing().length===1);
    assert.equal(e.speechCalls.length,0);assert.equal(reads,1);
    assert.equal(e.outgoing()[0].params.message[0].type,'record');
    assert.equal(e.outgoing()[0].params.message[0].data.file,'base64://'+audio.toString('base64'));
    assert.equal(e.qq.snapshot().monitor.entries.find(x=>x.direction==='out').delivery.mode,'singing');
  }finally{e.dispose();}
});

test('a completed song sends its audio in QQ without a final text reply',async()=>{
  const songId='01a186a2-e576-4b43-82eb-2df0217eee08',audio=Buffer.from('approved-local-song');let reads=0;
  const e=await environment({holdTurn:true,qq:{voiceReplies:false},singing:{read:async(id,sid)=>{reads++;assert.equal(id,songId);assert.equal(sid,'fish-session');return {audio,delivery:{mode:'singing',cached:true}};}}});
  try{
    await e.ready();e.incoming('唱个歌');await until(()=>e.followups.length===1);
    e.emit('turn/start',{turn:1});e.emit('user/message',e.followups[0]);
    e.emit('tool/call',{name:'dafeiyu_sing',callId:'local-song'});
    e.emit('tool/result',{message:{toolCallId:'local-song',content:[{type:'text',text:JSON.stringify({status:'ready',songId,title:'朋友的酒'})}]}});
    e.emit('assistant/message',{message:{content:[{type:'text',text:''}]}});e.agent.status='idle';e.emit('turn/end',{reason:{kind:'completed'}});
    await until(()=>e.outgoing().length===1,'song audio sent without text');
    assert.equal(reads,1);assert.equal(e.speechCalls.length,0);
    assert.equal(e.outgoing()[0].params.message[0].type,'record');
    assert.equal(e.outgoing()[0].params.message[0].data.file,'base64://'+audio.toString('base64'));
  }finally{e.dispose();}
});

test('QQ reports unavailable song audio as text and never substitutes TTS for a song',async()=>{
  const e=await environment({holdTurn:true,singing:{read:async()=>{throw Error('private-path');}}});
  try{
    await e.ready();e.incoming('唱小星星');await until(()=>e.followups.length===1);
    e.emit('turn/start',{turn:1});e.emit('user/message',e.followups[0]);e.emit('tool/call',{name:'dafeiyu_sing',callId:'sing'});
    e.emit('tool/result',{message:{toolCallId:'sing',content:[{type:'text',text:JSON.stringify({status:'ready',songId:'01a186a2-e576-4b43-82eb-2df0217eee08'})}]}});
    e.emit('assistant/message',{message:{content:[{type:'text',text:'唱好啦'}]}});e.agent.status='idle';e.emit('turn/end',{reason:{kind:'completed'}});
    await until(()=>e.outgoing().length===1);assert.equal(e.speechCalls.length,0);
    assert.equal(e.outgoing()[0].params.message[0].type,'text');assert.match(e.outgoing()[0].params.message[0].data.text,/清唱音频.*无法读取/);
  }finally{e.dispose();}
});

test('QQ source cancellation reaches only the matching singing turn',async()=>{
 const e=await environment({holdTurn:true});try{
  await e.ready();e.incoming('唱首歌');await until(()=>e.followups.length===1);
  assert.equal(e.qq.signalForTurn(e.agent),undefined);
  e.emit('turn/start',{turn:1});e.emit('user/message',e.followups[0]);
  const signal=e.qq.signalForTurn(e.agent);assert.ok(signal);assert.equal(signal.aborted,false);
  assert.equal(e.qq.signalForTurn({id:'other'}),undefined);
  e.sockets.at(-1).close();assert.equal(signal.aborted,true);
 }finally{e.dispose();}
});

test('QQ song rejection reports the send failure without reading the success text aloud',async()=>{
 const e=await environment({holdTurn:true,singing:{read:async()=>({audio:Buffer.from('song'),delivery:{mode:'singing'}})},rpcResponse:(request,normal)=>request.action==='send_private_msg'&&request.params.message[0].type==='record'?{status:'failed',retcode:1}:normal});
 try{
  await e.ready();e.incoming('唱歌');await until(()=>e.followups.length===1);
  e.emit('turn/start',{turn:1});e.emit('user/message',e.followups[0]);e.emit('tool/call',{name:'dafeiyu_sing',callId:'sing'});
  e.emit('tool/result',{message:{toolCallId:'sing',content:[{type:'text',text:JSON.stringify({status:'ready',songId:'01a186a2-e576-4b43-82eb-2df0217eee08'})}]}});
  e.emit('assistant/message',{message:{content:[{type:'text',text:'唱好啦。'}]}});e.agent.status='idle';e.emit('turn/end',{reason:{kind:'completed'}});
  await until(()=>e.outgoing().length===2);assert.equal(e.speechCalls.length,0);
  assert.match(e.outgoing()[1].params.message[0].data.text,/清唱已生成.*发送失败/);
 }finally{e.dispose();}
});


const imageInput=()=>[{type:'image',data:{url:'https://gchat.qpic.cn/safe-image',file:'test.png'}}];
const mediaResult=parsed=>({content:[...(parsed.text?[{type:'text',text:parsed.text}]:[]),{type:'image',attachment:{id:'attachment-test',mediaType:'image/png'}}],media:[]});
const stickerFixture=()=>({list:async()=>[{id:'joyful',title:'嘿嘿！',emotion:'joyful',tags:['开心']}],read:async id=>{if(id!=='joyful')throw Error('Unknown sticker');return {id,bytes:Buffer.from('validated-png-fixture'),mime:'image/png',summary:'嘿嘿！'};}});
async function finishWithSticker(e,{text='本鱼开心啦。',foreign=false}={}) {
 e.emit('turn/start',{turn:100});e.emit('user/message',e.followups.at(-1));
 const result=await e.qq.chooseSticker(e.agent,'joyful');assert.equal(result.status,'queued');
 assert.equal(e.outgoing().length,0);
 if(foreign)e.emit('user/message',{id:'other-user',source:{kind:'user'},content:[{type:'text',text:'其他桌面输入'}]});
 if(text)e.emit('assistant/message',{message:{content:[{type:'text',text}]}});
 e.agent.status='idle';e.emit('turn/end',{reason:{kind:'completed'}});
}

test('QQ pure image and mixed image text enter the authorized session as durable image blocks',async()=>{
 const prepared=[];const e=await environment({mediaPrepare:async(_ctx,_agent,parsed)=>{prepared.push(parsed);return mediaResult(parsed);}});
 try{await e.ready();
  for(const [id,text] of [['pure',''],['mixed','看这张呀']]){e.incoming(text,{message_id:id,message:[...(text?[{type:'text',data:{text}}]:[]),...imageInput()]});await until(()=>e.followups.length===(id==='pure'?1:2),'image admitted');}
  assert.equal(prepared.length,2);assert.equal(prepared[0].text,'');assert.equal(prepared[1].text,'看这张呀');assert.equal(e.followups[0].content[0].type,'image');assert.equal(e.followups[1].content[0].text,'看这张呀');assert.equal(e.followups[1].content[1].type,'image');
 }finally{e.dispose();}
});

test('QQ unauthorized image sources are refused before any media preparation',async()=>{
 let prepared=0;const e=await environment({mediaPrepare:async(_ctx,_agent,parsed)=>{prepared++;return mediaResult(parsed);}});
 try{await e.ready();for(const extras of [{user_id:'30003'},{self_id:'99999'},{user_id:'10001'},{message_type:'group'},{time:1}])e.incoming('',{message:imageInput(),...extras});await pause(20);assert.equal(prepared,0);assert.equal(e.followups.length,0);
 }finally{e.dispose();}
});

test('a late image admission after binding changes never enters or replies in either session',async()=>{
 let release;const e=await environment({mediaPrepare:(_ctx,_agent,parsed)=>new Promise(resolve=>{release=()=>resolve(mediaResult(parsed));})});
 try{await e.ready();e.incoming('',{message:imageInput()});await until(()=>!!release,'media waiting');await e.config.update({qq:{ownerId:'30003'}});await e.qq.reconcile();await e.ready();release();await pause(20);assert.equal(e.followups.length,0);assert.equal(e.outgoing().length,0);
 }finally{e.dispose();}
});

test('sticker tools require the real active QQ source and only send once after its final reply',async()=>{
 const e=await environment({holdTurn:true,stickers:stickerFixture()});try{await e.ready();await assert.rejects(e.qq.stickerCatalog(e.agent));e.incoming('给我个开心表情');await until(()=>e.followups.length===1);await finishWithSticker(e);await until(()=>e.outgoing().length===2,'voice and sticker');assert.equal(e.outgoing()[0].params.message[0].type,'record');assert.equal(e.outgoing()[1].params.message[0].type,'image');assert.equal(e.outgoing()[1].params.message[0].data.sub_type,1);assert.ok(e.outgoing().every(x=>x.params.user_id==='20002'));assert.equal(e.qq.snapshot().sentSticker,1);await assert.rejects(e.qq.chooseSticker(e.agent,'joyful'));
 }finally{e.dispose();}
});

test('a pure sticker reply skips speech while foreign user interleaving suppresses its selected sticker',async()=>{
 for(const foreign of [false,true]){const e=await environment({holdTurn:true,stickers:stickerFixture()});try{await e.ready();e.incoming('只回表情');await until(()=>e.followups.length===1);await finishWithSticker(e,{text:'',foreign});if(!foreign)await until(()=>e.outgoing().length===1);else await pause(20);assert.equal(e.outgoing().length,foreign?0:1);assert.equal(e.speechCalls.length,0);}finally{e.dispose();}}
});

test('sticker send failure or uncertain receipt never resends an already delivered voice',async()=>{
 for(const uncertain of [false,true]){const e=await environment({holdTurn:true,stickers:stickerFixture(),rpcTimeoutMs:8,rpcResponse:(request,response)=>request.action==='send_private_msg'&&request.params.message[0].type==='image'?(uncertain?null:{status:'failed',retcode:1}):response});try{await e.ready();e.incoming('开心表情');await until(()=>e.followups.length===1);await finishWithSticker(e);await until(()=>e.outgoing().length===2);await pause(25);assert.equal(e.outgoing().length,2);assert.equal(e.qq.snapshot().sentVoice,1);assert.equal(e.qq.snapshot().sentSticker,0);assert.match(e.qq.snapshot().lastError,/表情/);}finally{e.dispose();}}
});


test('image admission holds the host model-selection serialization until followup receives the image',async()=>{
 let locked=false,admissions=0;
 const e=await environment({serializeImageAdmission:async(_agent,operation)=>{admissions++;locked=true;try{return await operation();}finally{locked=false;}},onFollowup:()=>assert.equal(locked,true),mediaPrepare:async(_ctx,_agent,parsed)=>mediaResult(parsed)});
 try{await e.ready();e.incoming('',{message:imageInput()});await until(()=>e.followups.length===1);assert.equal(admissions,1);assert.equal(locked,false);}finally{e.dispose();}
});

test('a cancelled image waiting for the host admission slot releases the QQ queue before its late callback',async()=>{
 let release,prepared=0;
 const e=await environment({serializeImageAdmission:async(_agent,operation)=>new Promise(resolve=>{release=()=>resolve(operation());}),mediaPrepare:async(_ctx,_agent,parsed)=>{prepared++;return mediaResult(parsed);}});
 try{await e.ready();e.incoming('',{message_id:'image-before-rebind',message:imageInput()});await until(()=>!!release,'host slot waiting');await e.config.update({qq:{ownerId:'30003'}});await e.qq.reconcile();await e.ready();e.incoming('新绑定正常接话',{user_id:'30003',message_id:'new-owner-after-slot'});await until(()=>e.followups.length===1,'new owner not blocked');assert.equal(prepared,0);const resume=release;release=undefined;resume();await pause(20);assert.equal(prepared,0);assert.equal(e.followups.length,1);assert.equal(e.followups[0].content[0].text,'新绑定正常接话');}finally{release?.();e.dispose();}
});

function automaticStickers({read,list}={}) {
 const rows=[{id:'warm-a',title:'本鱼在呢',emotion:'warm',tags:['generic']},{id:'warm-b',title:'陪你呀',emotion:'warm',tags:['generic']},{id:'joyful',title:'嘿嘿！',emotion:'joyful',tags:['generic']}],reads=[];
 return {rows,reads,list:list??(async()=>rows),read:async(id,options)=>{reads.push(id);return read?read(id,options):{id,bytes:Buffer.from('sticker-'+id),mime:'image/png',summary:rows.find(r=>r.id===id)?.title??'表情'};}};
}
const stickerIdOf=request=>Buffer.from(request.params.message[0].data.file.slice('base64://'.length),'base64').toString().replace('sticker-','');

test('every successful voice or text reply automatically gets one controlled sticker without a tool call',async()=>{
 for(const options of [{},{qq:{voiceReplies:false}},{synthesize:async()=>{throw Error('isolated speech failure');}}]){
  const stickers=automaticStickers(),e=await environment({...options,stickers});try{await e.ready();e.incoming('你好呀');await until(()=>e.outgoing().length===2,'automatic sticker');assert.equal(e.outgoing()[1].params.message[0].type,'image');assert.equal(e.qq.snapshot().sentSticker,1);assert.equal(stickers.reads.length,1);assert.ok(e.outgoing().every(r=>r.params.user_id==='20002'));if(options.qq)assert.equal(e.speechCalls.length,0);}finally{e.dispose();}
 }
});
test('explicit sticker selection takes priority over automatic matching and still sends at most one image',async()=>{
 const stickers=automaticStickers(),e=await environment({holdTurn:true,stickers});try{await e.ready();e.incoming('指定开心表情');await until(()=>e.followups.length===1);await finishWithSticker(e,{text:'本鱼在呢。'});await until(()=>e.outgoing().length===2);assert.equal(stickerIdOf(e.outgoing()[1]),'joyful');assert.equal(stickers.reads.length,1);}finally{e.dispose();}
});
test('a damaged sticker is replaced before sending while an image RPC failure never triggers another attempt',async()=>{
 const rows=automaticStickers().rows,reads=[];const stickers=automaticStickers({read:async id=>{reads.push(id);if(id==='warm-a')throw Error('PRIVATE damaged asset');return {id,bytes:Buffer.from('sticker-'+id),mime:'image/png',summary:'本鱼在呢'};}});
 const e=await environment({stickers});try{await e.ready();e.incoming('你好呀');await until(()=>e.outgoing().length===2);assert.deepEqual(reads,['warm-a','warm-b']);assert.equal(stickerIdOf(e.outgoing()[1]),'warm-b');}finally{e.dispose();}
 for(const uncertain of [false,true]){const s=automaticStickers(),f=await environment({stickers:s,rpcTimeoutMs:8,rpcResponse:(r,normal)=>r.action==='send_private_msg'&&r.params.message[0].type==='image'?(uncertain?null:{status:'failed',retcode:1}):normal});try{await f.ready();f.incoming('你好呀');await until(()=>f.outgoing().length===2);await pause(25);assert.equal(f.outgoing().length,2);assert.equal(f.qq.snapshot().sentVoice,1);assert.equal(f.qq.snapshot().sentSticker,0);assert.equal(s.reads.length,1);}finally{f.dispose();}}
});
test('automatic sticker completion respects the switch and rejects a late source after rebinding',async()=>{
 const disabled=automaticStickers(),off=await environment({stickers:disabled,qq:{stickerReplies:false}});try{await off.ready();off.incoming('你好呀');await until(()=>off.outgoing().length===1);await pause(10);assert.equal(disabled.reads.length,0);assert.equal(off.outgoing().length,1);}finally{off.dispose();}
 let release;const pending=automaticStickers({list:()=>new Promise(resolve=>{release=()=>resolve(automaticStickers().rows);})}),e=await environment({stickers:pending});try{await e.ready();e.incoming('你好呀');await until(()=>!!release,'catalog pending');await e.config.update({qq:{ownerId:'30003'}});await e.qq.reconcile();await e.ready();release();await pause(20);assert.equal(e.outgoing().length,1);assert.equal(pending.reads.length,0);}finally{e.dispose();}
});
test('automatic stickers use recent delivery history only within the current private scope',async()=>{
 const stickers=automaticStickers(),e=await environment({stickers});try{await e.ready();e.incoming('第一句',{message_id:'auto-first'});await until(()=>e.outgoing().length===2);e.incoming('第二句',{message_id:'auto-second'});await until(()=>e.outgoing().length===4);assert.notEqual(stickerIdOf(e.outgoing()[1]),stickerIdOf(e.outgoing()[3]));await e.config.update({qq:{ownerId:'30003'}});await e.qq.reconcile();await e.ready();e.incoming('另一个来源',{user_id:'30003',message_id:'auto-third'});await until(()=>e.outgoing().length===6);assert.equal(stickerIdOf(e.outgoing()[5]),'warm-a');}finally{e.dispose();}
});
test('authorized image failure notifications also include a sticker while foreign desktop input sends nothing',async()=>{
 const fail=await environment({stickers:automaticStickers(),mediaPrepare:async()=>{throw Error('PRIVATE media failure');}});try{await fail.ready();fail.incoming('',{message:imageInput()});await until(()=>fail.outgoing().length===2);assert.equal(fail.outgoing()[0].params.message[0].type,'text');assert.equal(fail.outgoing()[1].params.message[0].type,'image');assert.equal(fail.speechCalls.length,0);}finally{fail.dispose();}
 const foreign=await environment({holdTurn:true,stickers:automaticStickers()});try{await foreign.ready();foreign.incoming('只回复这条QQ');await until(()=>foreign.followups.length===1);foreign.complete(foreign.followups[0],{foreignUser:true,text:'桌面私密内容'});await pause(20);assert.equal(foreign.outgoing().length,0);}finally{foreign.dispose();}
});
test('a completed singing response automatically gets its own sticker with ordinary voice disabled',async()=>{
 const songId='01a186a2-e576-4b43-82eb-2df0217eee08',e=await environment({holdTurn:true,qq:{voiceReplies:false},stickers:automaticStickers(),singing:{read:async()=>({audio:Buffer.from('song-audio'),delivery:{mode:'singing'}})}});try{await e.ready();e.incoming('唱一段歌');await until(()=>e.followups.length===1);e.emit('turn/start',{turn:300});e.emit('user/message',e.followups[0]);e.emit('tool/call',{name:'dafeiyu_sing',callId:'song'});e.emit('tool/result',{message:{toolCallId:'song',content:[{type:'text',text:JSON.stringify({status:'ready',songId})}]}});e.emit('assistant/message',{message:{content:[{type:'text',text:'清唱生成好啦。'}]}});e.agent.status='idle';e.emit('turn/end',{reason:{kind:'completed'}});await until(()=>e.outgoing().length===2);assert.equal(e.outgoing()[0].params.message[0].type,'record');assert.equal(e.outgoing()[1].params.message[0].type,'image');assert.equal(e.speechCalls.length,0);}finally{e.dispose();}
});
test('a valid larger built-in sticker may be sent within the four MiB trusted asset limit',async()=>{
 const stickers=automaticStickers({read:async id=>({id,bytes:Buffer.alloc(2*1024*1024),mime:'image/png',summary:'本鱼在呢'})}),e=await environment({stickers});try{await e.ready();e.incoming('你好呀');await until(()=>e.outgoing().length===2);assert.equal(e.outgoing()[1].params.message[0].type,'image');}finally{e.dispose();}
});

test('automatic delivery retains the three most recent choices rather than only the last image',async()=>{
 const rows=['warm-a','warm-b','warm-c'].map(id=>({id,title:'本鱼在呢',emotion:'warm',tags:['generic']}));const stickers=automaticStickers({list:async()=>rows});
 const e=await environment({stickers});try{await e.ready();for(let n=0;n<3;n++){e.incoming('你好呀',{message_id:'recent-'+n});await until(()=>e.outgoing().length===(n+1)*2);}assert.deepEqual(e.outgoing().filter(r=>r.params.message[0].type==='image').map(stickerIdOf),['warm-a','warm-b','warm-c']);}finally{e.dispose();}
});
test('a pure-image conversation reply automatically receives its sticker without model tool selection',async()=>{
 const e=await environment({stickers:automaticStickers(),mediaPrepare:async(_ctx,_agent,parsed)=>mediaResult(parsed)});try{await e.ready();e.incoming('',{message:imageInput()});await until(()=>e.outgoing().length===2);assert.equal(e.followups[0].content[0].type,'image');assert.equal(e.outgoing()[0].params.message[0].type,'record');assert.equal(e.outgoing()[1].params.message[0].type,'image');}finally{e.dispose();}
});
