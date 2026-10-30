import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rawSymbol = Symbol.for('cordis.original');
const hook = registerHooks({ resolve(name, context, next) {
  if (name === '@deepseek-ai/cordis') return { url:'data:text/javascript,export const symbols={original:Symbol.for("cordis.original")};', shortCircuit:true };
  return next(name, context);
} });
const loaded = await import('../lib/memory-compaction.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
hook.deregister();

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function wrap(...args) {
  assert.equal(typeof loaded.wrapMemoryCompactionEngine, 'function', 'memory compaction must await durable checkpointing before the summarizer');
  return loaded.wrapMemoryCompactionEngine(...args);
}

test('summarization waits for the durable checkpoint and preserves its receiver, arguments and result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'palace-checkpoint-'));
  const file = join(dir, 'checkpoint.txt'), gate = deferred(), calls = [];
  const input = Object.freeze({ messages:Object.freeze([{ role:'user', content:Object.freeze([{ type:'text', text:'我叫小泽' }]) }]) });
  const agent = Object.freeze({ id:'whale-one', session:Object.freeze({ append(){ throw Error('the wrapper must not mutate conversation surface'); } }) });
  const controller = new AbortController(), result = Object.freeze({ summary:[{type:'text',text:'压缩结果'}] });
  const engine = { async summarize(...args) { calls.push({ receiver:this, args, disk:await readFile(file, 'utf8') }); return result; } };
  const original = engine.summarize;
  const release = wrap(engine, async (owner, options) => {
    assert.equal(owner, agent); assert.equal(options.signal.aborted, false);
    await gate.promise; await writeFile(file, 'durable source', 'utf8');
  });
  try {
    const pending = engine.summarize(input, agent, controller.signal, 'extra-argument');
    await tick(); assert.equal(calls.length, 0);
    gate.resolve(); assert.equal(await pending, result);
    assert.equal(calls.length, 1); assert.equal(calls[0].receiver, engine);
    assert.deepEqual(calls[0].args, [input, agent, controller.signal, 'extra-argument']);
    assert.equal(calls[0].disk, 'durable source'); assert.equal(input.messages[0].content[0].text, '我叫小泽');
  } finally { release(); await rm(dir, { recursive:true, force:true }); }
  assert.equal(engine.summarize, original);
});

test('a checkpoint failure prevents summarization and preserves the failure identity', async () => {
  for (const asynchronous of [false, true]) {
    let originalCalls = 0;
    const engine = { summarize(){ originalCalls++; return {summary:[]}; } }, failure = new Error('disk is unavailable');
    const release = wrap(engine, () => { if (asynchronous) return Promise.reject(failure); throw failure; });
    try { await assert.rejects(engine.summarize({}, {id:'one'}), error => error === failure); assert.equal(originalCalls, 0); }
    finally { release(); }
  }
});

test('an already cancelled compaction calls neither the checkpoint nor the summarizer', async () => {
  let checkpoints = 0, summaries = 0;
  const controller = new AbortController(); controller.abort();
  const engine = { summarize(){ summaries++; } }, release = wrap(engine, () => { checkpoints++; });
  try { await assert.rejects(engine.summarize({}, {}, controller.signal), {name:'AbortError'}); assert.equal(checkpoints, 0); assert.equal(summaries, 0); }
  finally { release(); }
});

test('cancellation interrupts an uncooperative checkpoint and ignores its late completion', async () => {
  const gate = deferred(), controller = new AbortController(); let signal, summaries = 0;
  const engine = { summarize(){ summaries++; } }, release = wrap(engine, (_agent, options) => { signal = options.signal; return gate.promise; });
  try {
    const pending = engine.summarize({}, {}, controller.signal); await tick(); controller.abort();
    assert.equal(signal.aborted, true);
    const outcome = await Promise.race([pending.then(() => 'resolved', error => error.name), tick().then(() => 'still waiting')]);
    assert.equal(outcome, 'AbortError'); gate.resolve(); await tick(); assert.equal(summaries, 0);
  } finally { gate.resolve(); release(); }
});

test('releasing the last owner cancels its pending checkpoint without starting summarization', async () => {
  const gate = deferred(); let signal, summaries = 0;
  const original = () => { summaries++; }, engine = {summarize:original};
  const release = wrap(engine, (_agent, options) => { signal = options.signal; return gate.promise; });
  const pending = engine.summarize({}, {}); await tick(); release(); release();
  assert.equal(signal.aborted, true); assert.equal(engine.summarize, original);
  await assert.rejects(pending, {name:'AbortError'}); gate.resolve(); await tick(); assert.equal(summaries, 0);
});

test('duplicate owners share one checkpoint and restore inherited and own method descriptors', async () => {
  for (const own of [false, true]) {
    let checkpoints = 0, summaries = 0;
    const original = function(){ summaries++; return 'summary'; }, prototype = {summarize:original}, engine = Object.create(prototype);
    if (own) Object.defineProperty(engine, 'summarize', {value:original,writable:true,configurable:true,enumerable:false});
    const descriptor = Object.getOwnPropertyDescriptor(engine, 'summarize'), checkpoint = () => { checkpoints++; };
    const first = wrap(engine, checkpoint), second = wrap(engine, checkpoint);
    assert.equal(await engine.summarize({}, {}), 'summary'); assert.equal(checkpoints, 1); assert.equal(summaries, 1);
    first(); assert.equal(await engine.summarize({}, {}), 'summary'); assert.equal(checkpoints, 2);
    second(); assert.deepEqual(Object.getOwnPropertyDescriptor(engine, 'summarize'), descriptor);
    assert.equal(engine.summarize, original); engine.summarize({}, {}); assert.equal(checkpoints, 2);
  }
});

test('Cordis-style service proxies unwrap to stable ownership while preserving the call receiver', async () => {
  let checkpoints = 0, receiver;
  const prototype = { summarize(input){ receiver=this; return input; } }, raw = Object.create(prototype);
  const service = new Proxy(raw, { get(target, key, proxy) {
    if (key === rawSymbol) return target;
    const value = Reflect.get(target, key, proxy);
    return typeof value === 'function' ? new Proxy(value, {apply(fn, owner, args){return Reflect.apply(fn, owner, args);}}) : value;
  } });
  const checkpoint = () => { checkpoints++; }, first = wrap(service, checkpoint), second = wrap(service, checkpoint);
  const input = {}; assert.equal(await service.summarize(input, {}), input); assert.equal(receiver, service); assert.equal(checkpoints, 1);
  first(); second(); assert.equal(Object.hasOwn(raw, 'summarize'), false);
});

test('unloading leaves a later wrapper installed and removes only its own checkpoint behavior', async () => {
  let checkpoints = 0, summaries = 0, foreignCalls = 0;
  const original = function(){ summaries++; return 'preserved'; }, engine = {summarize:original}, release = wrap(engine, () => {checkpoints++;});
  const inner = engine.summarize;
  const foreign = async function(...args){foreignCalls++; return Reflect.apply(inner, this, args);};
  engine.summarize = foreign; release();
  assert.equal(engine.summarize, foreign); assert.equal(await engine.summarize({}, {}), 'preserved');
  assert.equal(checkpoints, 0); assert.equal(summaries, 1); assert.equal(foreignCalls, 1);
});

test('the compaction dependency lifecycle installs on replacement and restores each owned engine', async () => {
  assert.equal(typeof loaded.installMemoryCompaction, 'function', 'the public compaction service must be attached through dependency injection');
  let mount, cleanups = [], checkpoints = 0;
  const fiber = { dispose(){for (const dispose of cleanups.splice(0)) dispose();} };
  const ctx = { inject(services, callback){assert.deepEqual(services, ['compaction']); mount = engine => { fiber.dispose(); callback({compaction:engine,effect(fn){cleanups.push(fn());}}); }; return fiber; } };
  const oldOriginal = () => 'old', nextOriginal = () => 'next', oldEngine = {summarize:oldOriginal}, nextEngine = {summarize:nextOriginal};
  assert.equal(loaded.installMemoryCompaction(ctx, {checkpoint:()=>{checkpoints++;}}), fiber);
  mount(oldEngine); assert.equal(await oldEngine.summarize({}, {}), 'old');
  mount(nextEngine); assert.equal(oldEngine.summarize, oldOriginal); assert.equal(await nextEngine.summarize({}, {}), 'next');
  fiber.dispose(); assert.equal(nextEngine.summarize, nextOriginal); assert.equal(checkpoints, 2);
});
