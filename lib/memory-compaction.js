import { symbols } from '@deepseek-ai/cordis';

const installations = new WeakMap();

function waitForCheckpoint(checkpoint, agent, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) { abort(); return; }
    try { Promise.resolve(checkpoint(agent, {signal})).then(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

/** Add a durable pre-summary boundary to the existing public engine method. */
export function wrapMemoryCompactionEngine(engine, checkpoint, rawSymbol = symbols.original) {
  if (!engine || !['object','function'].includes(typeof engine) || typeof checkpoint !== 'function') throw new TypeError('记忆压缩保护需要压缩服务和补存函数。');
  const raw = engine[rawSymbol] ?? engine;
  let record = installations.get(raw);
  if (!record) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'summarize');
    const original = Reflect.get(raw, 'summarize');
    if (typeof original !== 'function') throw new TypeError('当前压缩服务未提供公开的 summarize 扩展方法。');
    record = { descriptor, original, checkpoints:new Map(), wrapper:null };
    record.wrapper = async function(...args) {
      const owners = [...record.checkpoints.values()];
      for (const owner of owners) {
        const signal = AbortSignal.any([owner.controller.signal, ...(args[2] ? [args[2]] : [])]);
        await waitForCheckpoint(owner.checkpoint, args[1], signal);
        signal.throwIfAborted();
      }
      // Every checkpoint may yield; recheck owners before handing off to DSH.
      for (const owner of owners) owner.controller.signal.throwIfAborted();
      if (owners.length) args[2]?.throwIfAborted();
      return Reflect.apply(original, this, args);
    };
    const replacement = descriptor && 'value' in descriptor
      ? {...descriptor, value:record.wrapper}
      : {value:record.wrapper, configurable:true, writable:true, enumerable:descriptor?.enumerable ?? false};
    Object.defineProperty(raw, 'summarize', replacement);
    installations.set(raw, record);
  }
  let owner = record.checkpoints.get(checkpoint);
  if (!owner) {
    owner = {checkpoint, controller:new AbortController(), references:0};
    record.checkpoints.set(checkpoint, owner);
  }
  owner.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owner.references === 0) {
      record.checkpoints.delete(checkpoint);
      owner.controller.abort(new DOMException('记忆压缩补存已停止。', 'AbortError'));
    }
    if (record.checkpoints.size) return;
    if (installations.get(raw) === record) installations.delete(raw);
    if (Object.getOwnPropertyDescriptor(raw, 'summarize')?.value !== record.wrapper) return;
    if (record.descriptor) Object.defineProperty(raw, 'summarize', record.descriptor);
    else delete raw.summarize;
  };
}

/** Dependency ownership follows the installed compaction service lifecycle. */
export function installMemoryCompaction(ctx, {checkpoint}) {
  if (typeof checkpoint !== 'function') throw new TypeError('请提供记忆补存函数。');
  return ctx.inject(['compaction'], scoped => {
    const release = wrapMemoryCompactionEngine(scoped.compaction, checkpoint);
    scoped.effect(() => release);
  });
}
