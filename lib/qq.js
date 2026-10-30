import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { JsonStore } from './storage.js';
import { currentPreset, isRoot, resolveAgent, requireWhale } from './session.js';
import { observeSongResult, SINGING_TOOL } from './song-result.js';
import { parseQQContent, prepareQQContent } from './qq-media.js';
import { rankQQStickerChoices } from './qq-sticker-choice.js';

const MAX_QUEUE = 5;
const MAX_SEEN = 2048;
const MAX_AUDIO = 16 * 1024 * 1024;
const MAX_STICKER = 4 * 1024 * 1024;
const MONITOR_LIMIT = 200;
const MONITOR_DAYS = 7;
const MONITOR_AGE = MONITOR_DAYS * 86_400_000;
const monitorStatuses = new Set(['received','queued','replying','synthesizing','sent','failed','uncertain','cancelled']);
const monitorKinds = new Set(['text','voice','control','image','face','sticker']);
const monitorModes = new Set(['model','preview','natural-fallback','disabled','unsupported','singing']);
const monitorEmotions = new Set(['neutral','warm','joyful','playful','soothing','concerned','apologetic','sad']);
const privateText = message => typeof message === 'string' ? message : Array.isArray(message) ? message.filter(item => item?.type === 'text' && typeof item.data?.text === 'string').map(item => item.data.text).join('') : '';
const identifier = value => typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const textOf = content => Array.isArray(content) ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
const boundedText = text => { let result = ''; for (const character of text.trim()) { if (result.length + character.length > 4000) break; result += character; } return result; };
const failure = (message, uncertain = false) => Object.assign(new Error(message), { uncertain });
const messageIdentifier = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[A-Za-z0-9_-]{1,100}$/.test(String(value)) ? String(value) : '';
function monitorText(value, secrets = []) {
  let text = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (secret) text = text.split(secret).join('[已隐藏]');
  if (/^\s*配对(?:\s|$)/u.test(text)) return '配对请求';
  text = text.replace(/配对\s+[A-Za-z0-9_-]{6,}/giu,'配对 [已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{16})\b/gu,'[已隐藏]')
    .replace(/((?:api[_ -]?key|password|passwd|token|secret|密钥|密码|访问令牌|令牌)["']?\s*[:：=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s，。；;,]+)/giu,'$1[已隐藏]')
    .replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]+=*/giu,'$1[已隐藏]')
    .replace(/(?:https?|wss?|file|base64):\/\/[^\s<>"'，。；;,\]]+/giu,'[链接已隐藏]')
    .replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=]+/giu,'[音频数据已隐藏]')
    .replace(/\[CQ:[^\]]+\]/giu,'[消息]')
    .replace(/(?:[A-Za-z]:[\\/])[^\s，。；;,<>"']+/gu,'[路径已隐藏]')
    .replace(/\/[^\s/，。；;,)\]}>"']+(?:\/[^\s，。；;,)\]}>"']+)+/gu,'[路径已隐藏]')
    .replace(/(^|[\s('"=:：\p{Script=Han}])\/[^\s，。；;,)\]}>"']+/gu,'$1[路径已隐藏]');
  return Array.from(text.trim()).slice(0,800).join('');
}
function monitorDelivery(value) {
  if (!value || !monitorModes.has(value.mode)) return undefined;
  return { mode:value.mode, ...(monitorEmotions.has(value.emotion)?{emotion:value.emotion}:{}), ...(typeof value.cached==='boolean'?{cached:value.cached}:{}), ...(Number.isSafeInteger(value.preparationMs)&&value.preparationMs>=0&&value.preparationMs<=300_000?{preparationMs:value.preparationMs}:{}) };
}
function monitorMessage(message) {
  const blocks = Array.isArray(message) ? message : [];
  const text = privateText(message);
  const voice = blocks.some(item=>item?.type==='record') || typeof message==='string' && /\[CQ:record[\],]/u.test(message);
  const image=blocks.some(item=>['image','mface'].includes(item?.type)),face=blocks.some(item=>item?.type==='face');
  const control = /^\s*配对(?:\s|$)/u.test(text);
  return { kind:control?'control':voice&&!text.trim()?'voice':image?'image':face&&!text.trim()?'face':'text', text:control?'配对请求':text.trim() || (voice?'[语音消息]':image?'[表情或图片]':face?'[QQ表情]':'[其他消息]') };
}
function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(failure('本次 QQ 回复已停止。'));
  let abort;
  const result = new Promise((resolve, reject) => {
    abort = () => reject(failure('本次 QQ 回复已停止。'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject);
  });
  return result.finally(() => signal.removeEventListener('abort', abort));
}

function selection(config) {
  const q = config.get()?.qq ?? {};
  const groups = Array.isArray(q.groups) ? q.groups.filter(g => g && identifier(g.id)).map(g => ({id:identifier(g.id),name:typeof g.name==='string'?g.name.slice(0,100):'',enabled:g.enabled===true})).sort((a,b)=>a.id.localeCompare(b.id)) : [];
  return { groups, enabled: q.enabled === true, wsUrl: q.wsUrl ?? 'ws://127.0.0.1:13001', botId: identifier(q.botId), ownerId: identifier(q.ownerId), sessionId: typeof q.sessionId === 'string' ? q.sessionId : '', voiceReplies: q.voiceReplies !== false,stickerReplies:q.stickerReplies!==false };
}
function gatewayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('请填写本机 QQ 网关地址。'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw failure('QQ 网关仅允许本机 WebSocket 地址。');
  return url;
}
const signature = value => JSON.stringify(value);

/** Source-bound private and opt-in group QQ channels. It never plays audio or opens a microphone. */
export function installQQ(ctx, { config, speech, singing, stickers, mediaPrepare=prepareQQContent, groupConversations, root, WebSocketImpl = globalThis.WebSocket, makeMessage, now = Date.now, rpcTimeoutMs = 15_000, pairingTTL = 10 * 60_000, retryDelayMs = 2000, retryMaxDelayMs = 30_000, connectTimeoutMs = 15_000, healthIntervalMs = 30_000, timers = globalThis, turnTimeoutMs = 180_000, groupPrepareTimeoutMs = 30_000 } = {}) {
  const setTimeout=timers.setTimeout.bind(timers),clearTimeout=timers.clearTimeout.bind(timers);
  const seen = new JsonStore(join(root, 'qq-state.json'), { messages: [] });
  let monitorStore, monitorError = null;
  try { monitorStore = new JsonStore(join(root,'qq-monitor.json'),{version:1,entries:[]}); }
  catch { monitorError = '消息监控存储暂不可用，聊天仍可继续。'; }
  let monitorRows = [], monitorSecrets = [], monitorFlushTimer = null, monitorWriting = false, monitorDirty = false, backfillState = 'idle', monitorOrdinal = 0;
  let disposed = false, epoch = 0, reconciliation = 0, socket = null, reconnectTimer = null, busyTimer = null;
  let connectionSignature = '', activeConfig = null, readyAt = 0, drainPromise = null, activeJob = null, inbound = Promise.resolve();
  let phase = 'disabled', connected = false, botId = '', lastError = null, pairing = null, pairingAttempts = 0;
  let connectTimer=null,healthTimer=null,retryAttempts=0,nextRetryAt=null,lastCheckedAt=null,lastHealthyAt=null,healthChecking=false;
  let received = 0, sentVoice = 0, sentText = 0, sentSticker=0, groupReceived = 0, groupSentVoice = 0, groupSentText = 0,groupSentSticker=0;
  const groupSessions = new Map(), groupPreparations = new Set();
  const queue = [], pending = new Map(), turns = new Map(), recentStickers = new Map();
  const eligibleAgent = agent => isRoot(agent) && ['whale','whale-group'].includes(currentPreset(agent.session));
  const enabledGroup = id => effective().groups.some(group => group.id === id && group.enabled);
  const jobConfigured = job => !!job && (job.groupId ? enabledGroup(job.groupId) && groupSessions.get(job.sessionId)?.groupId===job.groupId && groupSessions.get(job.sessionId)?.senderId===job.ownerId : effective().ownerId===job.ownerId && effective().sessionId===job.sessionId);
  const jobAgentAllowed = (job,agent) => eligibleAgent(agent) && currentPreset(agent.session)===(job.groupId?'whale-group':'whale');
  const effective = () => selection(config);
  const current = generation => !disposed && generation === epoch && effective().enabled && signature(effective()) === signature(activeConfig);
  const safeError = message => { lastError = message; };
  async function admitJob(job) {
    if(!current(job.epoch)||job.controller.signal.aborted||!connected||!jobConfigured(job))throw failure('QQ会话绑定已改变。');
    const agent=requireWhale(await resolveAgent(ctx,job.sessionId));
    if(!jobAgentAllowed(job,agent)||!current(job.epoch)||job.controller.signal.aborted)throw failure('QQ会话绑定已改变。');
    return agent;
  }
  const expirePairing = () => { if (pairing && now() >= pairing.expiresAt) pairing = null; };

  function monitorRow(value) {
    if (!value || !identifier(value.botId) || !identifier(value.ownerId) || !['in','out'].includes(value.direction) || !monitorKinds.has(value.kind) || !monitorStatuses.has(value.status)) return null;
    const at = Date.parse(value.at), updated = Date.parse(value.updatedAt);
    if (!Number.isFinite(at) || at < now()-MONITOR_AGE || at > now()+60_000 || typeof value.id!=='string' || !/^[A-Za-z0-9:_-]{1,180}$/.test(value.id)) return null;
    const delivery=monitorDelivery(value.delivery), messageId=messageIdentifier(value.messageId);
    return {id:value.id,botId:identifier(value.botId),ownerId:identifier(value.ownerId),ordinal:Number.isSafeInteger(value.ordinal)&&value.ordinal>=0?value.ordinal:0,at:new Date(at).toISOString(),updatedAt:new Date(Number.isFinite(updated)?updated:at).toISOString(),direction:value.direction,kind:value.kind,status:value.status,text:monitorText(value.text,monitorSecrets),...(messageId?{messageId}:{}),...(delivery?{delivery}:{}),...(Number.isSafeInteger(value.audioBytes)&&value.audioBytes>0&&value.audioBytes<=MAX_AUDIO?{audioBytes:value.audioBytes}:{}),...(typeof value.error==='string'&&value.error?{error:monitorText(value.error,monitorSecrets)}:{})};
  }
  function pruneMonitor() { const count=monitorRows.length;monitorRows=monitorRows.map(monitorRow).filter(Boolean).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||b.ordinal-a.ordinal).slice(0,MONITOR_LIMIT);return count!==monitorRows.length; }
  try {
    const stored=monitorStore?.get()?.entries??[];let recovered=false;
    monitorRows=stored.map(value=>{
      const row=monitorRow(value);
      if(row&&['queued','replying','synthesizing'].includes(row.status)){
        recovered=true;
        return {...row,status:'uncertain',updatedAt:new Date(now()).toISOString(),error:'上次运行结果未记录，请核对QQ聊天'};
      }
      return row;
    }).filter(Boolean);
    monitorOrdinal=monitorRows.reduce((max,row)=>Math.max(max,row.ordinal),0);pruneMonitor();
    if(recovered||stored.length!==monitorRows.length)scheduleMonitorFlush();
  } catch { monitorRows=[];monitorError='消息监控存储暂不可用，聊天仍可继续。'; }
  function scheduleMonitorFlush() {
    monitorDirty=true;
    if (!monitorStore || monitorFlushTimer || monitorWriting) return;
    monitorFlushTimer=setTimeout(()=>{monitorFlushTimer=null;void flushMonitor();},25);monitorFlushTimer.unref?.();
  }
  async function flushMonitor() {
    if (monitorWriting || !monitorDirty || !monitorStore) return;
    monitorDirty=false;monitorWriting=true;pruneMonitor();const entries=structuredClone(monitorRows);
    try { await monitorStore.mutate(()=>({version:1,entries}));monitorError=null; }
    catch { monitorError='消息监控暂时无法保存，聊天仍可继续。'; }
    finally {monitorWriting=false;if(monitorDirty){if(disposed)void flushMonitor();else scheduleMonitorFlush();}}
  }
  function rememberMonitor(value, { history=false }={}) {
    const row=monitorRow(value);if(!row)return;
    const index=monitorRows.findIndex(item=>item.id===row.id&&item.botId===row.botId&&item.ownerId===row.ownerId);
    if(index>=0){
      const old=monitorRows[index];
      // A gateway history echo must not replace richer live progress or voice delivery metadata.
      monitorRows[index]=history?{...row,...old}: {...old,...row,ordinal:old.ordinal};
    }else monitorRows.push({...row,ordinal:++monitorOrdinal});
    pruneMonitor();scheduleMonitorFlush();
  }
  function activity(job,status,error) {
    if(!job?.monitorId)return;
    const previous=monitorRows.find(row=>row.id===job.monitorId&&row.botId===job.botId&&row.ownerId===job.ownerId);
    if(previous)rememberMonitor({...previous,status,updatedAt:new Date(now()).toISOString(),...(error?{error}:{})});
  }
  function outgoingMonitor(job,{kind,text,status,messageId,delivery,audioBytes,error}={}) {
    if(!job?.ownerId||!job.botId||job.groupId)return;
    const id=messageIdentifier(messageId),stamp=new Date(now()).toISOString();
    rememberMonitor({id:'out:'+(id||job.id||randomUUID()),botId:job.botId,ownerId:job.ownerId,at:stamp,updatedAt:stamp,direction:'out',kind:kind||'text',status,text,messageId:id,delivery,audioBytes,error});
  }
  function observePrivate(event,generation) {
    const settings=effective();
    if(!current(generation)||!connected||!settings.ownerId||event.post_type!=='message'||event.message_type!=='private'||identifier(event.self_id)!==botId||identifier(event.user_id)!==settings.ownerId||identifier(event.user_id)===botId||event.sub_type==='self')return;
    const id=messageIdentifier(event.message_id);if(!id||!Number.isFinite(event.time)||event.time*1000<now()-MONITOR_AGE||event.time*1000>now()+60_000)return;
    const preview=monitorMessage(event.message),stamp=new Date(event.time*1000).toISOString();
    rememberMonitor({id:'in:'+id,botId,ownerId:settings.ownerId,at:stamp,updatedAt:new Date(now()).toISOString(),direction:'in',...preview,status:'received',messageId:id},{history:true});
  }
  async function backfillMonitor(generation) {
    const settings=effective();if(!current(generation)||!connected||!settings.ownerId)return;
    const ownerId=settings.ownerId,identity=botId;backfillState='loading';
    try {
      const history=await rpc('get_friend_msg_history',{user_id:ownerId,count:20},generation);
      if(!current(generation)||!connected||effective().ownerId!==ownerId||botId!==identity)return;
      for(const message of Array.isArray(history?.messages)?history.messages.slice(-20):[]){
        const sender=identifier(message.user_id??message.sender?.user_id),id=messageIdentifier(message.message_id);
        if(message.message_type!=='private'||![ownerId,identity].includes(sender)||!id||(message.self_id!==undefined&&identifier(message.self_id)!==identity)||!Number.isFinite(message.time)||message.time*1000<now()-MONITOR_AGE||message.time*1000>now()+60_000)continue;
        if((message.peer_id!==undefined&&identifier(message.peer_id)!==ownerId)||(message.target_id!==undefined&&identifier(message.target_id)!==(sender===identity?ownerId:identity)))continue;
        const stamp=new Date(message.time*1000).toISOString(),direction=sender===ownerId?'in':'out',preview=monitorMessage(message.message);
        rememberMonitor({id:direction+':'+id,botId:identity,ownerId,at:stamp,updatedAt:stamp,direction,...preview,status:direction==='in'?'received':'sent',messageId:id},{history:true});
      }
      backfillState='ready';
    }catch {if(current(generation)&&effective().ownerId===ownerId)backfillState='unavailable';}
  }

  function cancelWork() {
    for(const controller of groupPreparations)controller.abort();
    if(activeJob)activity(activeJob,'cancelled');
    for(const job of queue)activity(job,'cancelled');
    activeJob?.controller.abort();
    queue.length = 0;
    turns.clear();
    clearTimeout(busyTimer); busyTimer = null;
  }
  function cancelSessionWork(sessionId) {
    if(activeJob?.sessionId===sessionId){activity(activeJob,'cancelled');activeJob.controller.abort();}
    for(let index=queue.length-1;index>=0;index--)if(queue[index].sessionId===sessionId){activity(queue[index],'cancelled');queue[index].controller.abort();queue.splice(index,1);}
    turns.delete(sessionId);clearTimeout(busyTimer);busyTimer=null;queueMicrotask(wake);
  }
  function rejectRPC() {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure('QQ 网关连接已结束，发送结果未确认。', true)); }
    pending.clear();
  }
  function disconnect() {
    epoch++;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearTimeout(connectTimer);connectTimer=null;clearTimeout(healthTimer);healthTimer=null;nextRetryAt=null;healthChecking=false;
    cancelWork(); rejectRPC();
    const previous = socket; socket = null; connected = false;
    backfillState='idle';
    try { previous?.close(); } catch {}
  }
  function retry(generation) {
    if (disposed || generation !== epoch || !effective().enabled || reconnectTimer) return;
    const delay=Math.min(Math.max(retryDelayMs,retryMaxDelayMs),retryDelayMs*2**Math.min(retryAttempts,16));
    retryAttempts++;nextRetryAt=now()+delay;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; nextRetryAt=null;void reconcile(); }, delay);
    reconnectTimer.unref?.();
  }
  function scheduleHealth(generation) {
    if(!current(generation)||!connected||healthTimer||healthChecking)return;
    healthTimer=setTimeout(async()=>{
      healthTimer=null;if(!current(generation)||!connected)return;
      healthChecking=true;lastCheckedAt=now();
      try{
        const identity=identifier((await rpc('get_login_info',{},generation))?.user_id);
        if(!current(generation)||!connected)return;
        if(!identity)throw failure('QQ 登录身份暂时无法确认。');
        if(identity!==botId){disconnect();connectionSignature='';phase='error';safeError('QQ 网关登录账号与绑定的机器人账号不一致，请核对后重新连接。');return;}
        const status=await rpc('get_status',{},generation);
        if(!current(generation)||!connected)return;
        if(status?.online!==true){lost(generation);safeError('QQ 账号已离线，请在网关重新登录。');return;}
        lastHealthyAt=now();healthChecking=false;scheduleHealth(generation);
      }catch{
        if(current(generation)&&connected){lost(generation);safeError('QQ 网关未响应在线检查，正在重新连接；尚未确认的消息不会重复发送。');}
      }finally{if(generation===epoch)healthChecking=false;}
    },healthIntervalMs);
    healthTimer.unref?.();
  }
  function lost(generation, reconnect = true) {
    if (generation !== epoch || disposed) return;
    disconnect(); phase = 'error';
    safeError('QQ 网关连接已断开，尚未确认的消息不会重复发送。');
    connectionSignature = '';
    if (reconnect) retry(epoch);
  }
  function rpc(action, params = {}, generation = epoch) {
    if (disposed || generation !== epoch || !socket || socket.readyState !== 1) return Promise.reject(failure('QQ 网关尚未连接。'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(echo); reject(failure('QQ 网关没有确认操作结果，未重复发送。', true)); }, rpcTimeoutMs);
      timer.unref?.();
      pending.set(echo, { timer, resolve, reject });
      try { socket.send(JSON.stringify({ action, params, echo })); }
      catch { clearTimeout(timer); pending.delete(echo); reject(failure('QQ 网关发送结果未确认，未重复发送。', true)); }
    });
  }
  async function markSeen(event) {
    const messageId = typeof event.message_id === 'string' || Number.isSafeInteger(event.message_id) ? String(event.message_id) : '';
    if (!messageId || messageId.length > 100) return false;
    const key = event.message_type==='group' ? botId + ':group:' + identifier(event.group_id) + ':' + identifier(event.user_id) + ':' + messageId : botId + ':' + event.user_id + ':' + messageId;
    let fresh = false;
    await seen.mutate(value => {
      const entries = Array.isArray(value.messages) ? value.messages : [];
      if (entries.some(item => item.id === key)) return;
      fresh = true;
      value.messages = [...entries.filter(item => Number.isFinite(item.at) && item.at >= now() - 7 * 86_400_000), { id: key, at: now() }].slice(-MAX_SEEN);
    });
    return fresh;
  }
  async function deliver(text, ownerId, generation, controller, voice, job, songId,stickerId) {
    const admit=()=>admitJob(job);
    await admit();
    let messageSent=false,emotion;
    if (songId || (text&&voice)) {
      let audio,delivery;
      activity(job,'synthesizing');
      try {
        const result = await abortable(songId ? singing.read(songId, job.sessionId) : speech.synthesize(text, { sessionId: job.sessionId, signal: controller.signal }), controller.signal);
        const candidate = result?.audio;
        if (!(Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) || !candidate.length || candidate.length > MAX_AUDIO) throw failure('本句语音超出发送容量。');
        audio = candidate;
        delivery=monitorDelivery(result.delivery);
        emotion=delivery?.emotion??(songId?'joyful':undefined);
      } catch {
        await admit();
        if(songId)text='清唱音频暂时无法读取，请再试一次。';
        safeError(songId?'清唱音频暂时无法读取。':'本句语音未能生成，已改用文字回复。');
      }
      if (audio) {
        await admit();
        try {
          const sent=await rpc(job.groupId?'send_group_msg':'send_private_msg', { ...(job.groupId?{group_id:job.groupId}:{user_id:ownerId}), message: [{ type: 'record', data: { file: 'base64://' + Buffer.from(audio).toString('base64') } }] }, generation);
          outgoingMonitor(job,{kind:'voice',text,status:'sent',messageId:sent?.message_id,delivery,audioBytes:audio.length});activity(job,'sent');
          if(job.groupId)groupSentVoice++;else sentVoice++;messageSent=true;
        } catch (error) {
          if (!current(generation) || controller.signal.aborted) return;
          if (error.uncertain) { outgoingMonitor(job,{kind:'voice',text,status:'uncertain',delivery,audioBytes:audio.length,error:'语音发送结果未确认，未重复发送。'});activity(job,'uncertain');safeError('语音发送结果未确认，未重复发送。'); return; }
          outgoingMonitor(job,{kind:'voice',text,status:'failed',delivery,audioBytes:audio.length,error:'QQ 网关未接受本句语音，已改用文字回复。'});
          await admit();
          if(songId)text='清唱已生成，但QQ语音发送失败，请到桌面播放或稍后重试。';
          safeError('QQ 网关未接受本句语音，已改用文字回复。');
        }
      }
    }
    if(text&&!messageSent){
    await admit();
    try { const sent=await rpc(job.groupId?'send_group_msg':'send_private_msg', { ...(job.groupId?{group_id:job.groupId}:{user_id:ownerId}), message: [...(job.groupId?[{type:'at',data:{qq:ownerId}}]:[]),{ type: 'text', data: { text } }] }, generation);outgoingMonitor(job,{kind:'text',text,status:'sent',messageId:sent?.message_id});activity(job,'sent');if(job.groupId)groupSentText++;else sentText++;messageSent=true; }
    catch (error) { if (current(generation) && !controller.signal.aborted) {const message=error.uncertain?'文字发送结果未确认，未重复发送。':'QQ 网关没有接受本句回复。';outgoingMonitor(job,{kind:'text',text,status:error.uncertain?'uncertain':'failed',error:message});activity(job,error.uncertain?'uncertain':'failed');safeError(message);} return; }
    }
    if(!effective().stickerReplies||typeof stickers?.list!=='function'||typeof stickers?.read!=='function')return;
    if(!messageSent&&!stickerId)return;
    await admit();
    const scope=job.groupId?'group:'+job.groupId+':'+job.ownerId+':'+job.sessionId:'private:'+job.sessionId+':'+job.ownerId;
    let choices;
    try{
      const catalog=await abortable(stickers.list(),controller.signal);await admit();
      choices=rankQQStickerChoices(catalog,{emotion,text,preferredId:stickerId,recent:recentStickers.get(scope)});
    }catch{if(current(generation)&&!controller.signal.aborted)safeError('本轮表情目录暂时无法读取。');return;}
    let candidate;
    for(const choice of choices){
      await admit();
      try{
        const value=await abortable(stickers.read(choice.id,{signal:controller.signal}),controller.signal);await admit();
        if(value?.id!==choice.id||!Buffer.isBuffer(value.bytes)||!value.bytes.length||value.bytes.length>MAX_STICKER||!['image/png','image/gif','image/webp','image/jpeg'].includes(value.mime))continue;
        candidate=value;break;
      }catch{await admit();}
    }
    if(!candidate){safeError('本轮暂时没有可用的合适表情。');outgoingMonitor(job,{kind:'sticker',text:'[表情包]',status:'failed',error:'合适的表情暂时无法读取。'});return;}
    await admit();
    try{
      const sent=await rpc(job.groupId?'send_group_msg':'send_private_msg',{...(job.groupId?{group_id:job.groupId}:{user_id:ownerId}),message:[{type:'image',data:{file:'base64://'+candidate.bytes.toString('base64'),summary:candidate.summary,sub_type:1}}]},generation);
      const previous=recentStickers.get(scope)??[];recentStickers.delete(scope);recentStickers.set(scope,[candidate.id,...previous.filter(id=>id!==candidate.id)].slice(0,3));
      while(recentStickers.size>128)recentStickers.delete(recentStickers.keys().next().value);
      outgoingMonitor(job,{kind:'sticker',text:candidate.summary,status:'sent',messageId:sent?.message_id});if(job.groupId)groupSentSticker++;else sentSticker++;activity(job,'sent');
    }catch(error){if(current(generation)&&!controller.signal.aborted){const message=error.uncertain?'表情发送结果未确认，未重复发送。':'QQ网关暂时没有接受这张表情。';safeError(message);outgoingMonitor(job,{kind:'sticker',text:candidate.summary,status:error.uncertain?'uncertain':'failed',error:message});}}
  }

  async function process(job) {
    const generation = job.epoch, controller = job.controller;
    try {
      const agent = requireWhale(await resolveAgent(ctx, job.sessionId));
      if (!current(generation) || controller.signal.aborted || !jobConfigured(job) || !jobAgentAllowed(job,agent)) return;
      const hasImages=!!job.input?.images?.length;
      const begin=async()=>{
        await admitJob(job);
        const factory = makeMessage ?? (await import('@deepseek-ai/dsh-llm')).createUserMessage;
        let content=[{type:'text',text:job.text}];
        if(job.input?.images?.length||job.input?.faces?.length){
          try{
            const prepared=await abortable(mediaPrepare(ctx,agent,job.input,{signal:controller.signal,admit:()=>admitJob(job),rpc:(action,params)=>rpc(action,params,generation)}),controller.signal);
            await admitJob(job);content=prepared.content;
            if(!Array.isArray(content)||!content.length)throw failure('这张表情暂时无法读取。');
          }catch(error){
            await admitJob(job);
            const text=error?.name==='QQMediaError'?boundedText(error.message):'这张表情暂时没看清，可以换一张再发我呀。';
            safeError(text);activity(job,'failed',text);
            await deliver(text,job.ownerId,generation,controller,false,job);
            return;
          }
        }
        job.input=undefined;
        const message = factory({ content, source: { kind: 'user' } });
        if (typeof message?.id !== 'string' || !message.id) throw failure('QQ 消息暂时无法建立来源记录。');
        if (!current(generation) || controller.signal.aborted || !jobConfigured(job) || !jobAgentAllowed(job,agent)) return;
        requireWhale(agent);
        activity(job,'replying');
        job.userMessageId = message.id;
        const reply = new Promise((resolve, reject) => {
          job.finish = resolve;
          job.abort = () => reject(failure('本次 QQ 回复已停止。'));
          controller.signal.addEventListener('abort', job.abort, { once: true });
          job.timer = setTimeout(() => controller.abort(), turnTimeoutMs); job.timer.unref?.();
        });
        // Register the source identity before followup can synchronously emit events.
        const followup = Promise.resolve(agent.followup(message));
        followup.catch(() => { safeError('QQ 消息本次未能完成，未发送回复。'); controller.abort(); });
        return {reply,followup};
      };
      const serialize=ctx.sessionController?.agents?.serializeImageAdmission;
      const started=hasImages&&typeof serialize==='function'?await abortable(serialize.call(ctx.sessionController.agents,agent,begin),controller.signal):await begin();
      if(!started)return;
      const {reply,followup}=started;
      const result = await reply;
      if ((!result?.text&&!result?.songId&&!result?.stickerId) || result.reason !== 'completed' || !current(generation) || controller.signal.aborted) {activity(job,'cancelled');return;}
      await abortable(followup, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      await deliver(boundedText(result.text??''), job.ownerId, generation, controller, activeConfig.voiceReplies,job,result.songId,result.stickerId);
    } catch {
      activity(job,controller.signal.aborted?'cancelled':'failed');
      if (!controller.signal.aborted && current(generation)) safeError('本次 QQ 对话未能完成，未向其他会话转发。');
    } finally {
      clearTimeout(job.timer);
      job.input=undefined;job.selectedSticker=undefined;
      if (job.abort) controller.signal.removeEventListener('abort', job.abort);
      for (const [key, turn] of turns) if (turn.job === job) turns.delete(key);
    }
  }
  function wake() {
    if (disposed || drainPromise || !connected || !queue.length) return;
    drainPromise = (async () => {
      while (queue.length && connected && !disposed) {
        const job = queue[0];
        if (!current(job.epoch)) { queue.shift(); continue; }
        let agent;
        try { agent = await resolveAgent(ctx, job.sessionId); requireWhale(agent);if(!jobConfigured(job)||!jobAgentAllowed(job,agent))throw failure('QQ会话已停用。'); }
        catch { queue.shift();activity(job,'cancelled');job.controller.abort();safeError('请将绑定会话切换为鲸鱼娘模式后再聊天。');continue; }
        if (agent.status !== 'idle') {
          busyTimer = setTimeout(() => { busyTimer = null; wake(); }, 500); busyTimer.unref?.();
          break;
        }
        queue.shift(); activeJob = job;
        await process(job);
        if (activeJob === job) activeJob = null;
      }
    })().catch(() => safeError('QQ 通道暂时无法处理消息。')).finally(() => {
      drainPromise = null;
      if (queue.length && connected && !disposed && !busyTimer) queueMicrotask(wake);
    });
  }
  function sessionEvent(session, event) {
    if (disposed || !activeConfig || !session?.id || (session.id !== activeConfig.sessionId && !groupSessions.has(session.id)) || !event) return;
    const expected=groupSessions.has(session.id)?'whale-group':'whale';
    if (event.type === 'agent-preset/selected' && event.data?.agentPreset !== expected) { cancelSessionWork(session.id); return; }
    if (event.type === 'turn/start') { turns.set(session.id, { id: event.data?.turn ?? event.seq, job: null, foreignUser: false, text: '', calls:new Set(), song:null }); return; }
    const turn = turns.get(session.id);
    if (!turn) return;
    const song=observeSongResult(event,turn.calls);if(song)turn.song=song;
    if(['tool/call','tool/ptc-dispatch-start'].includes(event.type)&&event.data?.name===SINGING_TOOL&&turn.job){clearTimeout(turn.job.timer);turn.job.timer=setTimeout(()=>turn.job.controller.abort(),360_000);turn.job.timer.unref?.();}
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      if (activeJob && activeJob.sessionId===session.id && event.data.id === activeJob.userMessageId) turn.job = activeJob;
      else turn.foreignUser = true;
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message;
      const text = textOf(message?.content);
      if (text.trim() && !message.content.some(item => item?.type === 'tool-call')) turn.text = text;
    }
    if (event.type !== 'turn/end') return;
    turns.delete(session.id);
    if (turn.job) turn.job.finish?.({ text: turn.foreignUser ? '' : turn.text, reason: event.data?.reason?.kind, songId:turn.foreignUser?undefined:turn.song?.songId,stickerId:!turn.foreignUser&&turn.job.selectedSticker?.turn===turn.id?turn.job.selectedSticker.id:undefined });
    queueMicrotask(wake);
  }
  async function incoming(event, generation) {
    if (!current(generation) || !connected || event.post_type !== 'message' || event.message_type !== 'private' || !['friend', 'other', undefined].includes(event.sub_type)) return;
    const sender = identifier(event.user_id);
    if (!sender || identifier(event.self_id) !== botId || sender === botId || event.sub_type === 'self') return;
    if (!Number.isFinite(event.time) || event.time < Math.floor(readyAt / 1000) || event.time > Math.floor(now() / 1000) + 60) return;
    const text = privateText(event.message).trim();
    if (text.length > 4000) return;
    expirePairing();
    const settings = effective();
    // Pairing commands remain channel control messages after binding as well.
    if (settings.ownerId && /^配对(?:\s|$)/.test(text)) return;
    if (!settings.ownerId) {
      if (!pairing || !/^配对(?:\s|$)/.test(text)) return;
      if (!await markSeen(event) || !current(generation)) return;
      const match = /^配对\s+([a-f0-9]+)$/i.exec(text);
      if (!match || match[1].toUpperCase() !== pairing.code) {
        pairingAttempts++;
        if (pairingAttempts >= 5) { pairing = null; safeError('本次配对尝试已达上限，请重新生成配对码。'); }
        return;
      }
      const saved = await config.update({ qq: { ownerId: sender } });
      activeConfig = selection({ get: () => saved ?? config.get() });
      connectionSignature = signature(activeConfig) + connectionSignature.slice(connectionSignature.lastIndexOf('|'));
      pairing = null; lastError = null;
      if (!current(generation)) return;
      try { await rpc('send_private_msg', { user_id: sender, message: [{ type: 'text', data: { text: '配对好啦，以后在这里找本鱼就行。' } }] }, generation); sentText++; }
      catch { if (current(generation)) safeError('主人已绑定，QQ 尚未确认配对提示的送达。'); }
      void backfillMonitor(generation);
      return;
    }
    if(sender!==settings.ownerId)return;
    let input;try{input=parseQQContent(event.message);}catch{safeError('本条表情或图片格式不正确，请换一张重试。');return;}
    if(!text&&!input.images.length&&!input.faces.length)return;
    if (!await markSeen(event) || !current(generation)) return;
    received++;
    const job={id:randomUUID(),text,input,sessionId:settings.sessionId,ownerId:sender,botId,monitorId:'in:'+messageIdentifier(event.message_id),epoch:generation,controller:new AbortController()};
    if (queue.length >= MAX_QUEUE) {activity(job,'failed','待回复消息已达五条。');safeError('待回复消息已达五条，请等本鱼回复后再发。'); return; }
    activity(job,'queued');queue.push(job);
    wake();
  }
  async function incomingGroup(event,generation) {
    if(!current(generation)||!connected||event.post_type!=='message'||event.message_type!=='group')return;
    const groupId=identifier(event.group_id),senderId=identifier(event.user_id);
    if(!groupId||groupId==='0'||!senderId||senderId==='0'||identifier(event.self_id)!==botId||senderId===botId||event.sub_type==='self'||event.sub_type==='anonymous'||event.anonymous)return;
    if(!enabledGroup(groupId)||!Number.isFinite(event.time)||event.time<Math.floor(readyAt/1000)||event.time>Math.floor(now()/1000)+60)return;
    if(!Array.isArray(event.message)||!event.message.some(block=>block?.type==='at'&&identifier(block.data?.qq)===botId))return;
    const text=privateText(event.message).trim();if(text.length>4000||!messageIdentifier(event.message_id))return;
    let input;try{input=parseQQContent(event.message);}catch{safeError('本条群表情或图片格式不正确，请换一张重试。');return;}
    if(!text&&!input.images.length&&!input.faces.length)return;
    if(typeof groupConversations?.ensure!=='function'){safeError('群聊独立会话尚未准备，消息未进入私人会话。');return;}
    if(!await markSeen(event)||!current(generation)||!enabledGroup(groupId))return;
    groupReceived++;
    if(queue.length>=MAX_QUEUE){safeError('待回复消息已达五条，请等本鱼回复后再发。');return;}
    let selected;const preparation=new AbortController();groupPreparations.add(preparation);
    const preparationTimer=setTimeout(()=>preparation.abort(),groupPrepareTimeoutMs);preparationTimer.unref?.();
    try{selected=await abortable(groupConversations.ensure({groupId,senderId},{signal:preparation.signal}),preparation.signal);}
    catch{if(current(generation))safeError('群聊独立会话暂时无法准备。');return;}
    finally{clearTimeout(preparationTimer);groupPreparations.delete(preparation);}
    if(!current(generation)||!enabledGroup(groupId))return;
    const sessionId=selected?.sessionId;
    if(typeof sessionId!=='string'||!sessionId||sessionId===effective().sessionId){safeError('群聊独立会话无法确认。');return;}
    const old=groupSessions.get(sessionId);
    if(old&&(old.groupId!==groupId||old.senderId!==senderId)){safeError('群聊独立会话无法确认。');return;}
    let agent;try{agent=await resolveAgent(ctx,sessionId);}catch{safeError('群聊独立会话暂时无法打开。');return;}
    if(!isRoot(agent)||currentPreset(agent.session)!=='whale-group'){safeError('群聊会话需使用独立群聊模式。');return;}
    if(!current(generation)||!enabledGroup(groupId))return;
    groupSessions.set(sessionId,{groupId,senderId});
    const job={id:randomUUID(),text,input,sessionId,ownerId:senderId,groupId,botId,epoch:generation,controller:new AbortController()};
    queue.push(job);wake();
  }
  function onMessage(message, generation) {
    if (disposed || generation !== epoch) return;
    let event;
    try {
      const data = typeof message.data === 'string' ? message.data : Buffer.isBuffer(message.data) || message.data instanceof ArrayBuffer ? Buffer.from(message.data).toString('utf8') : '';
      if (!data || data.length > 1_000_000) return;
      event = JSON.parse(data);
    } catch { return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (connected && event.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' && event.status?.online === false) {
      lost(generation); safeError('QQ 账号已离线，请在网关重新登录。'); return;
    }
    if (typeof event.echo === 'string' && pending.has(event.echo)) {
      const item = pending.get(event.echo); pending.delete(event.echo); clearTimeout(item.timer);
      if (event.status === 'ok' && event.retcode === 0) item.resolve(event.data);
      else item.reject(failure('QQ 网关没有接受操作。', event.status !== 'failed' && !(Number.isFinite(event.retcode) && event.retcode !== 0)));
      return;
    }
    observePrivate(event,generation);
    inbound = inbound.then(() => event.message_type==='group'?incomingGroup(event,generation):incoming(event, generation)).catch(() => { if (current(generation)) safeError('QQ 消息来源暂时无法保存，本次未进入对话。'); });
  }
  async function tokenValue() {
    const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
    let token;
    try { token = await ctx.credentials.resolve(credentialRef('DAFEIYU_QQ_TOKEN')); }
    catch { throw failure('QQ 网关凭据暂时无法读取，请重新保存。'); }
    if (typeof token?.value !== 'string' || !token.value.trim()) throw failure('请先保存 QQ 网关连接令牌。');
    return token.value.trim();
  }
  async function reconcile() {
    const revision = ++reconciliation;
    if (disposed) return snapshot();
    const settings = effective();
    if (!settings.enabled) { disconnect(); retryAttempts=0;activeConfig = settings; connectionSignature = ''; pairing = null; phase = 'disabled'; lastError = null; return snapshot(); }
    if (activeConfig && signature(settings) !== signature(activeConfig)) { disconnect(); connectionSignature = ''; }
    try {
      const url = gatewayUrl(settings.wsUrl), token = await tokenValue();
      if (disposed || revision !== reconciliation) return snapshot();
      monitorSecrets=[token,...pairing?.code?[pairing.code]:[]];pruneMonitor();
      const digest = createHash('sha256').update(token).digest('hex');
      const key = signature(settings) + '|' + digest;
      if (key === connectionSignature && socket && [0, 1].includes(socket.readyState)) {
        const agent = settings.sessionId ? await resolveAgent(ctx, settings.sessionId).catch(() => null) : null;
        if (!agent || !isRoot(agent) || currentPreset(agent.session)!=='whale') cancelSessionWork(settings.sessionId);
        return snapshot();
      }
      disconnect(); activeConfig = settings; connectionSignature = key; botId = settings.botId; phase = 'connecting'; lastError = null; pairingAttempts = 0;
      if (typeof WebSocketImpl !== 'function') throw failure('当前运行环境不支持 QQ 网关连接。');
      url.searchParams.set('access_token', token);
      const generation = epoch;
      try{socket = new WebSocketImpl(url.href);}catch{lost(generation);safeError('QQ 网关暂时无法连接，正在重试本机服务。');return snapshot();}
      connectTimer=setTimeout(()=>{connectTimer=null;if(current(generation)&&!connected){lost(generation);safeError('QQ 网关连接超时，正在重新连接本机服务。');}},connectTimeoutMs);connectTimer.unref?.();
      socket.addEventListener('message', event => onMessage(event, generation));
      socket.addEventListener('close', () => lost(generation));
      socket.addEventListener('error', () => lost(generation));
      socket.addEventListener('open', async () => {
        if (!current(generation)) return;
        clearTimeout(connectTimer);connectTimer=null;
        phase = 'verifying';
        try {
          const identity = identifier((await rpc('get_login_info', {}, generation))?.user_id);
          if (!identity) throw failure('QQ 网关未返回有效登录身份。');
          if (settings.botId && settings.botId !== identity) {
            disconnect(); connectionSignature = ''; phase = 'error'; safeError('QQ 网关登录账号与绑定的机器人账号不一致，请核对后重新连接。'); return;
          }
          if (!current(generation)) return;
          const status = await rpc('get_status', {}, generation);
          if (status?.online !== true) throw failure('QQ 账号尚未在线，请先在网关完成登录。');
          if (!current(generation)) return;
          if (!settings.botId) {
            const saved = await config.update({ qq: { botId: identity } });
            if (disposed || generation !== epoch) return;
            activeConfig = selection({ get: () => saved ?? config.get() });
            connectionSignature = signature(activeConfig) + '|' + digest;
          }
          if (!current(generation)) return;
          botId = identity; connected = true; phase = 'ready'; readyAt = now(); lastError = null;retryAttempts=0;nextRetryAt=null;lastCheckedAt=readyAt;lastHealthyAt=readyAt;scheduleHealth(generation);wake();void backfillMonitor(generation);void groupConversations?.reconcile?.().catch(()=>{});
        } catch (error) { if (generation === epoch && !disposed) { lost(generation); safeError(error.message === 'QQ 账号尚未在线，请先在网关完成登录。' ? error.message : 'QQ 网关登录身份暂时无法确认，请检查网关。'); } }
      });
    } catch (error) {
      if (disposed || revision !== reconciliation) return snapshot();
      disconnect(); connectionSignature = ''; phase = 'error';
      safeError(['请填写本机 QQ 网关地址。', 'QQ 网关仅允许本机 WebSocket 地址。', 'QQ 网关凭据暂时无法读取，请重新保存。', '请先保存 QQ 网关连接令牌。', '当前运行环境不支持 QQ 网关连接。'].includes(error.message) ? error.message : 'QQ 网关暂时无法连接，请检查本机服务。');
    }
    return snapshot();
  }
  function snapshot() {
    expirePairing(); const settings = effective();
    if(pruneMonitor())scheduleMonitorFlush();const entries=settings.ownerId?monitorRows.filter(row=>row.botId===(botId||settings.botId)&&row.ownerId===settings.ownerId).map(({botId,ownerId,ordinal,...entry})=>structuredClone(entry)):[];
    return { phase, connected, botId: botId || settings.botId, ownerId: settings.ownerId, sessionId: settings.sessionId, paired: !!settings.ownerId, lastError, recovery:{attempts:retryAttempts,nextRetryAt,lastCheckedAt,lastHealthyAt,checking:healthChecking},sentVoice, sentText,sentSticker, received, queueLength: queue.filter(job=>!job.groupId).length, groupActivity:{received:groupReceived,sentVoice:groupSentVoice,sentText:groupSentText,sentSticker:groupSentSticker,queueLength:queue.filter(job=>!!job.groupId).length}, pairing: pairing ? { ...pairing } : null,monitor:{limit:MONITOR_LIMIT,retentionDays:MONITOR_DAYS,entries,backfillState,persisting:!!monitorFlushTimer||monitorWriting,...monitorError?{error:monitorError}:{}} };
  }
  async function reconnect(){if(disposed)return snapshot();reconciliation++;disconnect();connectionSignature='';retryAttempts=0;return reconcile();}
  async function listGroups() {
    const generation=epoch;if(!current(generation)||!connected)throw failure('请先连接已登录的QQ网关。');
    let rows;try{rows=await rpc('get_group_list',{},generation);}catch{throw failure('QQ群列表暂时无法读取，请检查QQ连接。');}
    if(!current(generation)||!connected)throw failure('QQ连接已改变，请重新读取群列表。');
    if(!Array.isArray(rows))throw failure('QQ网关没有返回有效群列表。');
    const groups=new Map();
    for(const row of rows){const id=identifier(row?.group_id);if(!id||id==='0'||groups.has(id))continue;groups.set(id,{id,name:monitorText(row.group_name,monitorSecrets).slice(0,100)||'QQ群',memberCount:Number.isSafeInteger(row.member_count)&&row.member_count>=0?row.member_count:0});}
    return [...groups.values()];
  }
  function startPairing() {
    if (disposed) throw failure('QQ 通道已停用。');
    if (effective().ownerId) throw failure('已绑定主人，请先解除绑定后再配对。');
    pairing = { code: randomBytes(12).toString('hex').toUpperCase(), expiresAt: now() + pairingTTL }; pairingAttempts = 0;
    monitorSecrets=[...monitorSecrets.slice(-4),pairing.code];
    return { ...pairing };
  }
  function stopPairing() { pairing = null; }
  function dispose() { if (disposed) return; disposed = true; reconciliation++; disconnect(); pairing = null;recentStickers.clear();clearTimeout(monitorFlushTimer);monitorFlushTimer=null;void flushMonitor();for (const remove of disposers) remove(); phase = 'disabled'; }
  const disposers = [ctx.on('session/event', sessionEvent), ctx.on('agent-preset/selected', id => {const expected=groupSessions.has(id)?'whale-group':id===activeConfig?.sessionId?'whale':null;const agent=ctx.agents.get(id);if(expected&&(!isRoot(agent)||currentPreset(agent.session)!==expected))cancelSessionWork(id);})];
  ctx.effect(() => { void reconcile(); return dispose; });
  function signalForTurn(agent) {
    if(!activeJob||agent?.id!==activeJob.sessionId)return undefined;
    const turn=turns.get(agent.id);
    if(turn?.job!==activeJob||turn.foreignUser)return undefined;
    return activeJob.controller.signal;
  }
  function stickerJob(agent) {
    const job=activeJob,turn=turns.get(agent?.id);
    if(!job||agent?.id!==job.sessionId||ctx.agents.get(agent.id)!==agent||turn?.job!==job||turn.foreignUser||!current(job.epoch)||job.controller.signal.aborted||!jobConfigured(job)||!jobAgentAllowed(job,agent))throw failure('表情工具仅用于当前真实QQ消息的回复。');
    if(!effective().stickerReplies||!stickers)throw failure('QQ表情回复尚未开启。');
    return {job,turn};
  }
  async function stickerCatalog(agent) {
    const {job,turn}=stickerJob(agent);const rows=await abortable(stickers.list(),job.controller.signal);
    const latest=stickerJob(agent);if(latest.job!==job||latest.turn!==turn)throw failure('QQ回合已经改变。');
    return {stickers:rows,selectionLimit:1};
  }
  async function chooseSticker(agent,stickerId) {
    const {job,turn}=stickerJob(agent);
    if(typeof stickerId!=='string'||!stickerId||stickerId.length>80)throw failure('请从表情目录选择有效编号。');
    const rows=await abortable(stickers.list(),job.controller.signal);
    if(!rows.some(row=>row.id===stickerId))throw failure('请从表情目录选择有效编号。');
    const latest=stickerJob(agent);if(latest.job!==job||latest.turn!==turn)throw failure('QQ回合已经改变。');
    if(job.selectedSticker&&job.selectedSticker.turn===turn.id&&job.selectedSticker.id!==stickerId)throw failure('这一轮已经选好一张表情啦。');
    job.selectedSticker={id:stickerId,turn:turn.id};
    return {status:'queued',stickerId};
  }
  return { snapshot, reconcile, reconnect, listGroups, startPairing, stopPairing, dispose, signalForTurn,stickerCatalog,chooseSticker };
}
