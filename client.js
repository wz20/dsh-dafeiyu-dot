window.__ModuleLoader__.load({
  id: 'dsh-dafeiyu-dot',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const {useState, useEffect, useRef, useCallback} = React;
    const BASE = '/dsh-dafeiyu-dot', ASSET = BASE + '/assets/';
    const SPEECH_FALLBACK_NOTICE = '这次语气判断暂未完成，已用温暖亲近的语气回应。';
    const EMOTIONS = Object.freeze({neutral:{label:'平静清晰',note:'把想说的话，慢慢讲清楚'},warm:{label:'温暖亲近',note:'有一点笑意，也有一点牵挂'},joyful:{label:'轻快开心',note:'开心的时候，声音也会亮起来'},playful:{label:'俏皮撒娇',note:'一点小得意，藏在语调里'},soothing:{label:'温柔安抚',note:'把语气放轻，陪你缓一缓'},concerned:{label:'认真关心',note:'你说的每一句，我都在意'},apologetic:{label:'轻声歉意',note:'认真回应，也愿意好好解释'},sad:{label:'轻声低落',note:'有些失落，也会轻轻说出来'}});
    function readSpeechDelivery(response) {
      const mode = response.headers.get('x-dafeiyu-delivery');
      if (!['model','preview','natural-fallback','unsupported','disabled','singing'].includes(mode)) return null;
      const rawEmotion = response.headers.get('x-dafeiyu-emotion'), emotion = ['model','preview','natural-fallback'].includes(mode) && Object.hasOwn(EMOTIONS, rawEmotion) ? rawEmotion : null;
      const rawMs = response.headers.get('x-dafeiyu-preparation-ms'), ms = rawMs === null ? NaN : Number(rawMs);
      return {mode, emotion, preparationMs:Number.isSafeInteger(ms) && ms >= 0 && ms <= 180000 ? ms : null};
    }
    function startAudioPlayback(player, {signal, timeoutMs = 12000} = {}) {
      return new Promise((resolve, reject) => {
        let settled = false, timer;
        const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => { player.pause(); finish(new DOMException('Playback cancelled', 'AbortError')); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, {once:true});
        timer = setTimeout(() => { player.pause(); finish(new Error('声音播放未能启动，请检查系统声音设备后重播。')); }, timeoutMs);
        try {
          Promise.resolve(player.play()).then(() => { if (settled) { player.pause(); return; } finish(); }, error => finish(error));
        } catch (error) { finish(error); }
      });
    }
    const listeners = new Set(), audioStops = new Set();
    const callReplyOwners = new Map(), completedCallReplies = new Set();
    let messageReadVersion = 0;
    function observeCallReplies(sessionId, data, readVersion) {
      const owner = callReplyOwners.get(sessionId);
      // A read begun before this call turn cannot settle its ownership.
      if (!owner || data.running || !Number.isSafeInteger(readVersion) || readVersion <= owner.readVersion) return;
      const completed = (data.messages || []).filter(message => message.role === 'assistant' && !owner.before.has(message.id) && (message.terminal || message.speakable));
      const ended = data.lastTurnEnd?.id != null && data.lastTurnEnd.id !== owner.turnEnd;
      if (!completed.length && !ended) return;
      for (const message of completed) completedCallReplies.add(JSON.stringify([sessionId,message.id]));
      while (completedCallReplies.size > 512) completedCallReplies.delete(completedCallReplies.values().next().value);
      callReplyOwners.delete(sessionId);
    }
    function isCallReply(sessionId, replyId) { return completedCallReplies.has(JSON.stringify([sessionId,replyId])); }
    const SETTINGS_PANEL_ID = 'dsh-dafeiyu-dot';
    let mainLayout = null;
    let navigation = {view: null, sessionId: '', placement:'overlay'};
    function publishNavigation(next) {
      navigation = next;
      listeners.forEach(fn => fn(navigation));
      window.dispatchEvent(new CustomEvent('dafeiyu:view', {detail:{view:navigation.view}}));
    }
    function open(view, sessionId, settingsTab) {
      const placement = view === 'settings' && mainLayout ? 'panel' : 'overlay';
      if (placement !== navigation.placement) stopAudio();
      publishNavigation({view, sessionId: sessionId ?? navigation.sessionId ?? '', placement, settingsTab:view==='settings'&&['role','voice','memory','widget','qq'].includes(settingsTab)?settingsTab:undefined});
      if (placement === 'panel') mainLayout.selectPanel(SETTINGS_PANEL_ID);
      else if (mainLayout?.panelInfo.getSnapshot().activePanelId === SETTINGS_PANEL_ID) mainLayout.selectPanel(null);
    }
    function navigationFor(placement) {
      return navigation.placement === placement ? navigation : {view:null,sessionId:'',placement};
    }
    function isConversationView(view) { return view === 'immersive' || view === 'call'; }
    function stopAudio(id) { audioStops.forEach(fn => fn(id)); }
    function stopWidgetAudio() { window.dispatchEvent(new CustomEvent('dafeiyu:stop-audio', {detail: {source: 'dot'}})); }
    function copy(value) { return JSON.parse(JSON.stringify(value)); }
    function errorText(error) {
      if (error?.name === 'NotAllowedError') return '麦克风访问已被拒绝，请检查 DeepSeek Harness 的麦克风授权后重试。';
      if (error?.name === 'NotReadableError') return '麦克风或音频设备暂不可用，请检查设备连接和系统声音设置后重试。';
      if (/audio device|WebAudio renderer/i.test(error?.message || '')) return '音频设备启动失败，请检查系统声音设备后重试。';
      if (error?.name === 'NotFoundError') return '没有找到可用的麦克风。';
      if (error?.name === 'AbortError') return '操作已取消或连接超时，请重试。';
      return error?.message || '暂时连接不上，请稍后再试。';
    }
    async function request(path, body, options = {}) {
      const controller = new AbortController(), abort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener('abort', abort, {once: true});
      const timer = setTimeout(abort, options.timeout || 30000);
      try {
        const response = await fetch(BASE + path, {
          method: options.method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin',
          ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}), signal: controller.signal,
        });
        if (options.audio && response.ok && !(response.headers.get('content-type') || '').includes('json')) { const blob = await response.blob(); options.onAudioResponse?.(response); return blob; }
        const data = await response.json().catch(() => ({ok: false, error: '服务返回了无法读取的内容。'}));
        if (!response.ok || data.ok === false) throw new Error(data.error || '服务暂时不可用。');
        return data;
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    }
    function Icon({name, size = 20}) { return h('img', {className: 'dfj-icon', src: ASSET + 'icons/' + name + '.svg', width: size, height: size, alt: '', 'aria-hidden': true}); }
    function Button({icon, children, variant = '', className = '', ...props}) {
      return h('button', {...props, type: props.type || 'button', className: 'dfj-button ' + (variant ? 'dfj-button-' + variant : '') + ' ' + className}, icon && h(Icon, {name: icon, size: 18}), children);
    }
    function Toggle({value, onChange, label, disabled = false}) {
      return h('button', {type: 'button', className: 'dfj-toggle', role: 'switch', 'aria-checked': !!value, 'aria-label': label, disabled, onClick: () => onChange(!value)}, h('span'));
    }
    function Field({label, note, children, wide = false}) { return h('label', {className: 'dfj-field' + (wide ? ' dfj-field-wide' : '')}, h('span', {className: 'dfj-field-label'}, label), children, note && h('span', {className: 'dfj-field-note'}, note)); }
    function Card({title, note, children, action, className = ''}) {
      return h('section', {className: 'dfj-card ' + className}, h('div', {className: 'dfj-card-heading'}, h('div', null, h('h2', null, title), note && h('p', null, note)), action), children);
    }
    function HeaderMode({sessionId, useSessions, useSession}) {
      const preset = useSessions ? useSessions(s => s.byId[sessionId]?.projectionValues?.agentPreset) : undefined;
      const running = useSession ? useSession(s => s.running) : false;
      const [pending, setPending] = useState(false), [committed, setCommitted] = useState(null), [error, setError] = useState('');
      const mounted = useRef(true), nativeSeen = useRef(new Set()), nativeReady = useRef(false), nativeConfig = useRef(null);
      useEffect(() => {
        const update = event => { nativeConfig.current = event.detail; }; window.addEventListener('dafeiyu:config', update);
        return () => window.removeEventListener('dafeiyu:config', update);
      }, []);
      useEffect(() => { nativeSeen.current.clear(); nativeReady.current = false; return () => stopAudio(sessionId); }, [sessionId]);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      useEffect(() => { setCommitted(null); }, [preset, sessionId]);
      const current = committed || preset || 'standard', supported = current === 'whale' || current === 'standard';
      useEffect(() => {
        const controller = new AbortController(); let timer;
        if (!sessionId || current !== 'whale') { stopAudio(sessionId); nativeReady.current = false; return () => controller.abort(); }
        async function observe() {
          try {
            const readVersion = ++messageReadVersion;
            const [state, data] = await Promise.all([request('/state?sessionId=' + encodeURIComponent(sessionId), undefined, {signal: controller.signal}), request('/messages?sessionId=' + encodeURIComponent(sessionId), undefined, {signal: controller.signal})]);
            if (controller.signal.aborted) return;
            nativeConfig.current = state.config;
            observeCallReplies(sessionId, data, readVersion);
            const first = !nativeReady.current, observed = observeMessages(data.messages || [], nativeSeen.current, first, !!data.running); nativeReady.current = true;
            if (!first && !running && !data.running && observed.speakable && !callReplyOwners.has(sessionId) && !isCallReply(sessionId,observed.speakable.id) && state.session?.preset === 'whale' && (observed.speakable.songId || nativeConfig.current?.tts.autoRead !== false) && !(isConversationView(navigation.view) && navigation.sessionId === sessionId)) {
              window.dispatchEvent(new CustomEvent('dafeiyu:read', {detail: {sessionId, replyId: observed.speakable.id, text: observed.speakable.text, songId:observed.speakable.songId, config: nativeConfig.current}}));
            }
          } catch (e) { if (!controller.signal.aborted && mounted.current) setError(errorText(e)); }
          finally { if (!controller.signal.aborted) timer = setTimeout(observe, running ? 750 : 2200); }
        }
        observe(); return () => { controller.abort(); clearTimeout(timer); };
      }, [sessionId, current, running]);
      async function change() {
        if (pending || running || !supported) return;
        stopWidgetAudio(); stopAudio(sessionId);
        setPending(true); setError('');
        try {
          const result = await request('/mode', {sessionId, agentPreset: current === 'whale' ? 'standard' : 'whale', expectedPreset: current});
          if (result.agentPreset === 'standard') stopAudio(sessionId);
          if (mounted.current) setCommitted(result.agentPreset);
          window.dispatchEvent(new CustomEvent('dafeiyu:mode', {detail: {sessionId, preset: result.agentPreset}}));
        } catch (e) { if (mounted.current) setError(errorText(e)); }
        finally { if (mounted.current) setPending(false); }
      }
      return h('span', {className: 'dfj-native-mode'}, h('button', {
        className: 'dfj-mode-chip', type: 'button', disabled: pending || running || !supported,
        title: error || (running ? '等待当前回复结束后切换模式' : current === 'whale' ? '切换到标准模式' : '切换到鲸鱼娘模式'),
        onClick: change, 'aria-label': current === 'whale' ? '鲸鱼娘模式，点击回到标准模式' : '标准模式，点击进入鲸鱼娘模式', 'aria-busy': pending, 'data-whale': current === 'whale',
      }, h(Icon, {name: current === 'whale' ? 'headphones' : 'sparkles', size: 16}), pending ? '切换中…' : current === 'whale' ? '鲸鱼娘模式' : current === 'standard' ? '标准模式' : current), error && h('span', {className: 'dfj-native-error', role: 'status'}, error));
    }
    function HeaderEntry({sessionId}) { return h(Button, {icon:'phone',className:'dfj-native-call',title:'与大肥鱼通话','aria-label':'与大肥鱼通话',disabled:!sessionId,onClick:()=>open('call',sessionId)}); }
    function SidebarIcon({size=16}) { return h(Icon,{name:'settings',size}); }
    function observeMessages(messages, seen, initial, running) {
      const fresh = initial ? [] : messages.filter(x => x.role === 'assistant' && !seen.has(x.id));
      const settled = fresh.filter(x => x.terminal === true || x.speakable === true);
      if (initial) messages.filter(x => x.role === 'assistant').forEach(x => seen.add(x.id));
      else if (!running) settled.forEach(x => seen.add(x.id));
      return {fresh, settled: running ? [] : settled, speakable: running ? null : settled.filter(x => x.speakable === true).at(-1)};
    }
    const TEXT_DRAFT_PREFIX = 'dsh-dafeiyu-dot:text-draft:v1:';
    const AMBIENT_MOTION_KEY = 'dsh-dafeiyu-dot:ambient-motion:v1';
    function readAmbientMotion() { try { return window.localStorage?.getItem(AMBIENT_MOTION_KEY) === 'paused' ? 'paused' : 'active'; } catch { return 'active'; } }
    function textDraftKey(sessionId) { return TEXT_DRAFT_PREFIX + encodeURIComponent(sessionId); }
    function readTextDrafts() {
      const drafts = Object.create(null);
      try {
        const storage = window.localStorage;
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (!key?.startsWith(TEXT_DRAFT_PREFIX)) continue;
          let id; try { id = decodeURIComponent(key.slice(TEXT_DRAFT_PREFIX.length)); } catch { continue; }
          const value = storage.getItem(key); if (id && typeof value === 'string') drafts[id] = value;
        }
      } catch { /* The composer remains usable when browser storage is unavailable. */ }
      return drafts;
    }
    function saveTextDraft(sessionId, text) {
      if (!sessionId) return false;
      try { window.localStorage.setItem(textDraftKey(sessionId), text); return true; } catch { return false; }
    }
    function removeSentTextDraft(sessionId, text) {
      try { const key = textDraftKey(sessionId); if (window.localStorage.getItem(key) === text) window.localStorage.removeItem(key); return true; } catch { return false; }
    }
    function memoryDate(value) {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
    }
    function palaceSummary(palace) {
      if (!palace) return {text: '尚未取得后台整理状态', tone: 'unknown'};
      const pending = Number.isFinite(palace.pendingJobs) ? palace.pendingJobs : null;
      const failed = Number.isFinite(palace.failedJobs) ? palace.failedJobs : null;
      if (pending === null || failed === null) return {text: '后台整理状态暂不可用', tone: 'unknown'};
      if (pending && failed) return {text: '待整理 ' + pending + ' 项，另有 ' + failed + ' 项等待重试', tone: 'pending'};
      if (pending) return {text: '后台有 ' + pending + ' 项待整理', tone: 'pending'};
      if (failed) return {text: failed + ' 项整理任务等待重试', tone: 'failed'};
      return {text: '当前没有待整理任务', tone: 'idle'};
    }
    function indexedMemories(memories, spaceId, facet, index) {
      const entries = Array.isArray(index?.[facet.kind]) ? index[facet.kind] : [];
      const selected = facet.value ? entries.find(entry => (facet.kind === 'dates' ? entry.date : entry.name) === facet.value) : null;
      const ids = facet.value ? new Set(selected?.ids || []) : null;
      return memories.filter(memory => (!spaceId || memory.spaceId === spaceId) && (!ids || ids.has(memory.id)));
    }
    function memorySources(memory) {
      const sources = [memory.source, ...(Array.isArray(memory.sources) ? memory.sources : [])].filter(source => source && typeof source === 'object');
      const seen = new Set();
      return sources.filter(source => { const key = JSON.stringify(source); if (seen.has(key)) return false; seen.add(key); return true; });
    }
    function detailText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
    function encodeWav(samples, sampleRate) {
      const ratio = sampleRate / 16000, length = Math.floor(samples.length / ratio);
      const view = new DataView(new ArrayBuffer(44 + length * 2));
      const word = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
      word(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); word(8, 'WAVE'); word(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, length * 2, true);
      for (let i = 0; i < length; i++) {
        const from = Math.floor(i * ratio), to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
        let sum = 0; for (let n = from; n < to; n++) sum += samples[n];
        const value = Math.max(-1, Math.min(1, sum / (to - from))); view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
      }
      return new Uint8Array(view.buffer);
    }
    function base64(bytes) { let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(binary); }
    class Microphone {
      constructor(canListen, onUtterance, onLevel, {onPhase = () => {}} = {}) {
        this.canListen = canListen; this.onUtterance = onUtterance; this.onLevel = onLevel; this.onPhase = onPhase;
        this.closed = false; this.startAbort = new AbortController(); this.phase = 'idle'; this.permissionQuery = 'unknown'; this.reset();
      }
      reset() { this.chunks = []; this.pre = []; this.speechMs = 0; this.quietMs = 0; this.totalMs = 0; }
      report(phase) { this.phase = phase; if (!this.closed) this.onPhase({phase, audioState:this.context?.state || 'unavailable', permissionQuery:this.permissionQuery}); }
      wait(promise, timeout, message) {
        const signal = this.startAbort.signal;
        return new Promise((resolve,reject) => {
          let timer, settled = false;
          const finish = (callback,value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort',abort); callback(value); };
          const abort = () => finish(reject,new DOMException('Aborted','AbortError'));
          Promise.resolve(promise).then(value => finish(resolve,value), error => finish(reject,error));
          if (signal.aborted) abort(); else { signal.addEventListener('abort',abort,{once:true}); timer = setTimeout(() => finish(reject,new Error(message)),timeout); }
        });
      }
      async start({signal, permissionTimeoutMs = 30000, audioTimeoutMs = 10000} = {}) {
        const cancel = () => this.dispose();
        if (signal?.aborted || this.closed) { this.dispose(); throw new DOMException('Aborted','AbortError'); }
        signal?.addEventListener('abort',cancel,{once:true});
        try {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前窗口暂不支持麦克风，请继续使用文字交流。');
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (!AudioContext) throw new Error('当前版本暂不支持语音采集，请继续使用文字交流。');
          this.context = new AudioContext({sinkId:{type:'none'}});
          this.audioStateListener = () => this.report(this.phase); this.context.addEventListener?.('statechange',this.audioStateListener);
          const resumed = Promise.resolve(this.context.resume());
          resumed.then(() => this.report(this.phase), () => {});
          this.report('waiting-permission');
          const granted = Promise.resolve(navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})).then(stream => {
            if (this.closed || signal?.aborted) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Aborted','AbortError'); }
            this.stream = stream; return stream;
          });
          if (navigator.permissions?.query) {
            try { Promise.resolve(navigator.permissions.query({name:'microphone'})).then(result => { if (!this.closed) { this.permissionQuery = result?.state || 'unknown'; this.report(this.phase); } }, () => {}); } catch { /* Device acquisition remains the authorization source. */ }
          }
          const stream = await this.wait(granted,permissionTimeoutMs,'麦克风授权或设备响应超时，请确认麦克风可用后重试。');
          this.report('starting-audio');
          await this.wait(resumed,audioTimeoutMs,'音频启动超时，请结束语音后重新开启。');
          if (this.closed) throw new DOMException('Aborted','AbortError');
          if (this.context.state !== 'running') throw new Error('音频尚未启动，请结束语音后重新开启。');
          this.source = this.context.createMediaStreamSource(stream); this.processor = this.context.createScriptProcessor(4096,1,1); this.silent = this.context.createGain(); this.silent.gain.value = 0;
          this.processor.onaudioprocess = event => this.process(event.inputBuffer.getChannelData(0));
          this.source.connect(this.processor); this.processor.connect(this.silent); this.silent.connect(this.context.destination); this.report('ready');
        } catch (error) { this.dispose(); throw error; }
        finally { signal?.removeEventListener('abort',cancel); }
      }
      process(input) {
        if (this.closed) return;
        if (!this.canListen()) { this.reset(); this.onLevel(0); return; }
        const sample = new Float32Array(input); let power = 0; for (let i = 0; i < sample.length; i++) power += sample[i] * sample[i];
        const rms = Math.sqrt(power / sample.length), ms = sample.length / this.context.sampleRate * 1000; this.onLevel(Math.min(1, rms * 9));
        if (!this.chunks.length && rms < 0.014) { this.pre.push(sample); if (this.pre.length > 3) this.pre.shift(); return; }
        if (!this.chunks.length) { this.chunks.push(...this.pre); this.pre = []; }
        this.chunks.push(sample); this.totalMs += ms;
        if (rms >= 0.014) { this.speechMs += ms; this.quietMs = 0; } else this.quietMs += ms;
        if (this.quietMs > 720 || this.totalMs > 14000) {
          const chunks = this.chunks, speechMs = this.speechMs; this.reset(); if (speechMs < 260) return;
          const merged = new Float32Array(chunks.reduce((n, x) => n + x.length, 0)); let index = 0; chunks.forEach(x => { merged.set(x, index); index += x.length; });
          this.onUtterance(base64(encodeWav(merged, this.context.sampleRate)));
        }
      }
      dispose() {
        this.closed = true; this.startAbort.abort(); this.reset(); if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }
        this.source?.disconnect(); this.silent?.disconnect(); this.stream?.getTracks().forEach(t => t.stop()); this.context?.removeEventListener?.('statechange',this.audioStateListener);
        if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {}); this.onLevel(0);
      }
    }
    function App(props) {
      const placement = props?.placement || 'overlay';
      const [nav, setNav] = useState(() => placement === 'panel' && navigation.placement !== 'panel' ? {view:'settings',sessionId:'',placement} : navigationFor(placement)), [snapshot, setSnapshot] = useState(null), [draft, setDraft] = useState(null), [tab, setTab] = useState(() => navigation.placement===placement?navigation.settingsTab||'role':'role');
      const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
      const [voices, setVoices] = useState([]), [speechPreparing, setSpeechPreparing] = useState(false), [apiKey, setApiKey] = useState(''), [health, setHealth] = useState(null);
      const [qqToken, setQQToken] = useState(''), [qqStatus, setQQStatus] = useState(null);
      const [qqReconnecting,setQQReconnecting]=useState(false);
      const [qqView, setQQView] = useState('monitor');
      const [qqGroups, setQQGroups] = useState([]), [qqGroupsLoading, setQQGroupsLoading] = useState(false);
      const [widgetPreviewRegion, setWidgetPreviewRegion] = useState('head');
      const [messages, setMessages] = useState([]), [messagesReady, setMessagesReady] = useState(false), [running, setRunning] = useState(false), [sending, setSending] = useState(false), [history, setHistory] = useState(false);
      const [call, setCall] = useState(false), [micMuted, setMicMuted] = useState(false), [readEnabled, setReadEnabled] = useState(true), [playing, setPlaying] = useState(false), [phase, setPhase] = useState('idle'), [level, setLevel] = useState(0), [micStage, setMicStage] = useState({phase:'idle',audioState:'closed'});
      const [callTextOpen, setCallTextOpen] = useState(false);
      const [textDrafts, setTextDrafts] = useState(readTextDrafts), [modeBusy, setModeBusy] = useState(false);
      const [modelCatalog, setModelCatalog] = useState(null), [modelLoading, setModelLoading] = useState(false), [modelBusy, setModelBusy] = useState(false), [modelError, setModelError] = useState('');
      const [ambientMotion, setAmbientMotion] = useState(readAmbientMotion), [sceneVisible, setSceneVisible] = useState(() => !document.hidden), [readExpanded, setReadExpanded] = useState(false), [copied, setCopied] = useState(false);
      const [speechDelivery, setSpeechDelivery] = useState(null), [voiceWaitSeconds, setVoiceWaitSeconds] = useState(0), [previewEmotion, setPreviewEmotion] = useState('warm');
      const [memories, setMemories] = useState([]), [spaces, setSpaces] = useState([]), [spaceId, setSpaceId] = useState(''), [memoryQuery, setMemoryQuery] = useState(''), [memoryContent, setMemoryContent] = useState(''), [memoryId, setMemoryId] = useState(''), [memoryBusy, setMemoryBusy] = useState(false);
      const [palace, setPalace] = useState(null), [memoryIndex, setMemoryIndex] = useState(null), [memoryFacet, setMemoryFacet] = useState({kind:'people',value:''}), [forgetId, setForgetId] = useState(''), [maintenance, setMaintenance] = useState(''), [editingId, setEditingId] = useState(''), [readingId, setReadingId] = useState(''), [expandedRecords, setExpandedRecords] = useState({});
      const [MemoryExplorer, setMemoryExplorer] = useState(null), [graphLoadError, setGraphLoadError] = useState(''), [graphAttempt, setGraphAttempt] = useState(0);
      const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
      useEffect(() => {
        if (nav.view !== 'settings' || tab !== 'memory' || MemoryExplorer) return;
        let active = true;
        import(ASSET + 'memory-explorer.js?v=4').then(module => {
          if (active) { setMemoryExplorer(() => module.createMemoryExplorer(React, {Icon, Button, assetRoot:ASSET})); setGraphLoadError(''); }
        }).catch(error => { if (active) setGraphLoadError('关系图暂未加载成功，仍可在下方管理记忆。' + errorText(error)); });
        return () => { active = false; };
      }, [nav.view, tab, graphAttempt, MemoryExplorer]);
      const draftsRef = useRef(textDrafts); draftsRef.current = textDrafts;
      const settingsScrollRef = useRef(null);
      useEffect(()=>{if(nav.view==='settings'&&tab!=='memory'&&settingsScrollRef.current)settingsScrollRef.current.scrollTop=0;},[nav.view,tab]);
      const root = useRef(null), lifecycle = useRef(0), selection = useRef(''), microphone = useRef(null), callReady = useRef(false), recording = useRef(false);
      const callEpoch = useRef(0), replyReadContext = useRef(null);
      const replyScroll = useRef(null), copyTimer = useRef(null), latestReplyId = useRef(null), composer = useRef(null);
      const modelGate = useRef(false), modelVersion = useRef(0), modelAbort = useRef(null), modelLoadAbort = useRef(null);
      const playbackSession = useRef(''), audio = useRef(null), audioURL = useRef(null), audioEpoch = useRef(0), audioAbort = useRef(null), recognitionAbort = useRef(null), prepareAbort = useRef(null), memoryAbort = useRef(null), memorySearch = useRef(''), memoryEditAbort = useRef(null), memoryReadAbort = useRef(null);
      const assistantSeen = useRef(new Set()), replyStarted = useRef(0), observedRunning = useRef(false), lastTurnEnd = useRef(null), replyTurnBaseline = useRef(null), awaitingReply = useRef(false), sendGate = useRef(false), savingGate = useRef(false), speakerGate = useRef(true), flags = useRef({});
      flags.current = {call, micMuted, playing, running, sending, readEnabled, readExpanded, nav, config: snapshot?.config}; selection.current = nav.sessionId;
      const currentSession = snapshot?.session?.id === nav.sessionId ? snapshot.session : snapshot?.sessions?.find(x => x.id === nav.sessionId);
      const currentPreset = currentSession?.preset || '', text = textDrafts[nav.sessionId] || '';
      const lastReply = [...messages].reverse().find(x => x.role === 'assistant'), lastUser = [...messages].reverse().find(x => x.role === 'user');
      latestReplyId.current = lastReply?.id;
      const dirty = draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.config);
      useEffect(() => {
        const visibility = () => setSceneVisible(!document.hidden);
        document.addEventListener?.('visibilitychange', visibility);
        return () => document.removeEventListener?.('visibilitychange', visibility);
      }, []);
      useEffect(() => {
        setVoiceWaitSeconds(0);
        if (phase !== 'synthesizing' && phase !== 'starting-playback') return;
        const started = Date.now(); let timer, active = true;
        const tick = () => { if (!active) return; setVoiceWaitSeconds(Math.floor((Date.now() - started) / 1000)); timer = setTimeout(tick, 1000); };
        timer = setTimeout(tick, 1000);
        return () => { active = false; clearTimeout(timer); };
      }, [phase]);
      useEffect(() => {
        setCopied(false); clearTimeout(copyTimer.current);
        if (replyScroll.current) replyScroll.current.scrollTop = Math.max(0, (replyScroll.current.querySelector('.dfj-current-reply')?.offsetTop || 0) - 20);
        return () => clearTimeout(copyTimer.current);
      }, [nav.sessionId, lastReply?.id]);
      useEffect(() => { if (composer.current) { composer.current.style.height = 'auto'; composer.current.style.height = Math.min(132, composer.current.scrollHeight) + 'px'; } }, [text, nav.view]);
      function toggleAmbientMotion() {
        const next = ambientMotion === 'active' ? 'paused' : 'active'; setAmbientMotion(next);
        try { window.localStorage?.setItem(AMBIENT_MOTION_KEY, next); } catch { /* The current page still honors the selected motion state. */ }
      }
      function moveOcean(event) {
        if (ambientMotion !== 'active' || !sceneVisible) return;
        const element = event.currentTarget, box = element.getBoundingClientRect();
        element.style.setProperty('--dfj-pointer-x', ((event.clientX - box.left) / Math.max(1, box.width) - .5) * 12 + 'px');
        element.style.setProperty('--dfj-pointer-y', ((event.clientY - box.top) / Math.max(1, box.height) - .5) * 8 + 'px');
      }
      async function copyReply() {
        if (!lastReply?.text || running || sending) return;
        const id = nav.sessionId, generation = lifecycle.current, replyId = lastReply.id;
        try {
          if (!navigator.clipboard?.writeText) throw new Error('暂时无法复制，请选中文字后复制。');
          await navigator.clipboard.writeText(lastReply.text);
          if (generation !== lifecycle.current || selection.current !== id || latestReplyId.current !== replyId) return;
          setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => { if (generation === lifecycle.current && selection.current === id && latestReplyId.current === replyId) setCopied(false); }, 2200);
        } catch (e) { if (generation === lifecycle.current && selection.current === id && latestReplyId.current === replyId) setError(errorText(e)); }
      }
      function updateTextDraft(sessionId, value) {
        if (!sessionId) return;
        draftsRef.current = {...draftsRef.current, [sessionId]: value};
        if (!saveTextDraft(sessionId, value)) setError('文字仍保留在当前页面；暂时无法保存草稿，请在关闭窗口前复制文字。');
        setTextDrafts(current => ({...current, [sessionId]: value}));
      }
      function clearSentDraft(sessionId, submitted) {
        if (draftsRef.current[sessionId] !== submitted) return;
        const next = {...draftsRef.current}; delete next[sessionId]; draftsRef.current = next;
        if (!removeSentTextDraft(sessionId, submitted)) setError('消息已发送；草稿保存暂不可用，重新打开时请核对发送记录。');
        setTextDrafts(current => { if (current[sessionId] !== submitted) return current; const updated = {...current}; delete updated[sessionId]; return updated; });
      }
      useEffect(() => {
        function syncDraft(event) {
          if (!event.key?.startsWith(TEXT_DRAFT_PREFIX)) return;
          try { if (event.storageArea && event.storageArea !== window.localStorage) return; if (window.localStorage.getItem(event.key) !== event.newValue) return; } catch { return; }
          let id; try { id = decodeURIComponent(event.key.slice(TEXT_DRAFT_PREFIX.length)); } catch { return; }
          if (!id) return;
          const next = {...draftsRef.current}; if (typeof event.newValue === 'string') next[id] = event.newValue; else delete next[id];
          draftsRef.current = next; setTextDrafts(next);
        }
        window.addEventListener('storage', syncDraft); return () => window.removeEventListener('storage', syncDraft);
      }, []);
      function setSection(section, patch) { setDraft(d => ({...d, [section]: {...d[section], ...patch}})); setNotice(''); }
      const haltAudio = useCallback(() => {
        audioEpoch.current++; playbackSession.current = ''; audioAbort.current?.abort(); audioAbort.current = null;
        if (audio.current) { audio.current.pause(); audio.current.onended = null; audio.current.onerror = null; audio.current.src = ''; audio.current = null; }
        if (audioURL.current) { URL.revokeObjectURL(audioURL.current); audioURL.current = null; }
        speakerGate.current = true; setPlaying(false); setPhase('idle');
      }, []);
      const endCall = useCallback(() => {
        callEpoch.current++; flags.current.call = false; flags.current.micMuted = false;
        callReady.current = false; recording.current = false; prepareAbort.current?.abort(); prepareAbort.current = null; recognitionAbort.current?.abort(); recognitionAbort.current = null; microphone.current?.dispose(); microphone.current = null;
        setCall(false); setMicMuted(false); setMicStage({phase:'idle',audioState:'closed'}); setLevel(0); setPhase('idle');
      }, []);
      const stopAll = useCallback(() => { endCall(); haltAudio(); }, [endCall, haltAudio]);
      const close = useCallback(() => { stopAll(); open(null); }, [stopAll]);
      useEffect(() => {
        const update = () => { setNav(navigationFor(placement));if(navigation.placement===placement&&navigation.view==='settings'&&navigation.settingsTab)setTab(navigation.settingsTab); };
        listeners.add(update);
        if (placement === 'panel' && navigation.placement !== 'panel') open('settings','');
        return () => {
          listeners.delete(update);
          if (placement === 'panel' && navigation.placement === 'panel') publishNavigation({...navigation,view:null,placement:'overlay'});
        };
      }, [placement]);
      useEffect(() => { const stop = id => { if (!id || selection.current === id || playbackSession.current === id) stopAll(); }; audioStops.add(stop); return () => { audioStops.delete(stop); stopAll(); }; }, [stopAll]);
      useEffect(() => {
        const onMode = event => {
          if (event.detail.sessionId !== selection.current) return;
          if (event.detail.preset !== 'whale') { stopAll(); awaitingReply.current = false; sendGate.current = false; setSending(false); }
          setSnapshot(s => s ? {...s, session: {...s.session, preset: event.detail.preset}, sessions: s.sessions?.map(x => x.id === selection.current ? {...x, preset: event.detail.preset} : x)} : s);
        };
        const onExternalAudio = event => { if (event.detail?.source !== 'dot') stopAll(); };
        window.addEventListener('dafeiyu:mode', onMode); window.addEventListener('dafeiyu:stop-audio', onExternalAudio);
        return () => { window.removeEventListener('dafeiyu:mode', onMode); window.removeEventListener('dafeiyu:stop-audio', onExternalAudio); };
      }, [stopAll]);
      useEffect(() => {
        lifecycle.current++; const generation = lifecycle.current, controller = new AbortController();
        modelVersion.current++; modelAbort.current?.abort(); modelAbort.current = null; modelLoadAbort.current?.abort(); modelGate.current = false; setModelBusy(false); setModelCatalog(null); setModelError('');
        stopAll(); setError(''); setNotice(''); setMessages([]); setMessagesReady(false); setHistory(false); setCallTextOpen(false); setReadExpanded(false); setCopied(false); setSpeechDelivery(null); setSpeechPreparing(false); setRunning(false); setSending(false); assistantSeen.current.clear(); lastTurnEnd.current = null; replyTurnBaseline.current = null; awaitingReply.current = false; replyReadContext.current = null; sendGate.current = false;
        if (!nav.view) return () => controller.abort();
        setLoading(true);
        (async () => {
          const id = nav.sessionId;
          if (!id && nav.view === 'immersive') { const created = await request('/session', {}, {signal: controller.signal}); if (generation === lifecycle.current) open('immersive', created.sessionId); return; }
          const data = await request('/state' + (id ? '?sessionId=' + encodeURIComponent(id) : ''), undefined, {signal: controller.signal});
          if (generation !== lifecycle.current) return;
          setSnapshot(data); setDraft(d => d || copy(data.config)); setReadEnabled(data.config.tts.autoRead !== false);
          request('/health', undefined, {signal: controller.signal}).then(x => { if (generation === lifecycle.current) setHealth(x); }).catch(() => {});
          request('/voices', undefined, {signal: controller.signal}).then(x => { if (generation === lifecycle.current) setVoices(x.voices || []); }).catch(() => {});
        })().catch(e => { if (!controller.signal.aborted && generation === lifecycle.current) setError(errorText(e)); }).finally(() => { if (generation === lifecycle.current) setLoading(false); });
        return () => { controller.abort(); modelAbort.current?.abort(); modelLoadAbort.current?.abort(); memoryAbort.current?.abort(); memoryEditAbort.current?.abort(); memoryReadAbort.current?.abort(); stopAll(); };
      }, [nav.view, nav.sessionId, stopAll]);
      async function loadModels() {
        const id = selection.current; if (!id || !isConversationView(flags.current.nav.view)) return;
        modelLoadAbort.current?.abort(); const controller = new AbortController(); modelLoadAbort.current = controller; const version = modelVersion.current;
        setModelLoading(true); setModelError('');
        try {
          const data = await request('/models?sessionId=' + encodeURIComponent(id), undefined, {signal:controller.signal});
          if (controller.signal.aborted || selection.current !== id) return;
          setModelCatalog(current => ({...data, selected:version === modelVersion.current ? data.selected : current?.selected ?? data.selected}));
        } catch (e) { if (!controller.signal.aborted && selection.current === id) setModelError(errorText(e)); }
        finally { if (modelLoadAbort.current === controller) setModelLoading(false); }
      }
      useEffect(() => { if (isConversationView(nav.view) && nav.sessionId) loadModels(); }, [nav.view, nav.sessionId]);
      async function changeModel(next) {
        if (!nav.sessionId || currentPreset !== 'whale' || modelGate.current || modelLoading || sendGate.current || running || recording.current) return;
        const id = nav.sessionId, generation = lifecycle.current, controller = new AbortController();
        modelGate.current = true; modelVersion.current++; modelAbort.current = controller; setModelBusy(true); setModelError('');
        try {
          const result = await request('/model', {sessionId:id, provider:next.provider, model:next.model, ...(next.reasoningEffort ? {reasoningEffort:next.reasoningEffort} : {})}, {signal:controller.signal});
          if (controller.signal.aborted || generation !== lifecycle.current || selection.current !== id) return;
          setModelCatalog(current => current ? {...current, selected:result.selected} : current);
          setSnapshot(current => current?.session?.id === id ? {...current, session:{...current.session, model:result.selected.model, modelSelection:result.selected}} : current);
        } catch (e) { if (!controller.signal.aborted && generation === lifecycle.current && selection.current === id) setModelError(errorText(e)); }
        finally { if (modelAbort.current === controller) { modelGate.current = false; modelAbort.current = null; setModelBusy(false); } }
      }
      useEffect(() => {
        if (!nav.view) return;
        const previous = document.activeElement, timer = setTimeout(() => root.current?.querySelector('button, input, textarea, select')?.focus(), 30);
        function onKey(event) {
          if (placement === 'panel' && !root.current?.contains(event.target)) return;
          if (event.key === 'Escape') { event.preventDefault(); if (history) setHistory(false); else if (flags.current.readExpanded) setReadExpanded(false); else close(); }
          if (event.key !== 'Tab' || placement === 'panel') return;
          const items = [...(root.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter(x => x.getClientRects().length);
          if (!items.length) return;
          if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
          if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
        }
        window.addEventListener('keydown', onKey); return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); };
      }, [!!nav.view, history, close, placement]);
      async function speak(content, preview = false, native = null, options = {}) {
        setNotice(current => current === SPEECH_FALLBACK_NOTICE ? '' : current);
        setSpeechDelivery(null);
        stopWidgetAudio(); haltAudio(); playbackSession.current = native?.sessionId || selection.current; const epoch = audioEpoch.current, controller = new AbortController(), replyId = preview ? null : native?.replyId ?? options.replyId ?? latestReplyId.current; audioAbort.current = controller; setPhase('synthesizing'); speakerGate.current = false;
        try {
          const blob = await request('/synthesize', {text: content, ...(preview ? {preview: true,...options.previewEmotion?{previewEmotion:options.previewEmotion}:{}} : {sessionId: playbackSession.current,replyId})}, {audio: true, timeout: 150000, signal: controller.signal, onAudioResponse: response => { if (controller.signal.aborted || epoch !== audioEpoch.current) return; const delivery = readSpeechDelivery(response); if (delivery) setSpeechDelivery({...delivery,text:content,replyId,sessionId:playbackSession.current}); if (delivery?.mode === 'natural-fallback') setNotice(SPEECH_FALLBACK_NOTICE); }});
          if (controller.signal.aborted || epoch !== audioEpoch.current || (!native && !flags.current.nav.view) || (native && isConversationView(navigation.view) && navigation.sessionId === native.sessionId)) return;
          const url = URL.createObjectURL(blob); audioURL.current = url; const player = new Audio(url); audio.current = player; player.volume = Math.max(0, Math.min(1, native?.config?.tts.volume ?? flags.current.config?.tts.volume ?? 0.8));
          const done = () => { if (epoch !== audioEpoch.current) return; haltAudio(); setPhase(flags.current.call ? 'listening' : 'idle'); };
          player.onended = done; player.onerror = () => { if (epoch !== audioEpoch.current) return; done(); setError('语音播放失败，请检查音频服务。'); }; setPhase('starting-playback'); await startAudioPlayback(player, {signal:controller.signal});
          if (epoch !== audioEpoch.current) { player.pause(); return; } setPlaying(true); setPhase('speaking');
        } catch (e) { if (!controller.signal.aborted && epoch === audioEpoch.current) { haltAudio(); setPhase('idle'); setError(e?.name === 'NotAllowedError' ? '声音播放暂未获得允许，请点击重播。' : e?.name === 'NotSupportedError' ? '当前设备暂时无法播放这段声音，请检查声音设备后重播。' : errorText(e)); } }
      }
      useEffect(() => {
        const onRead = event => { const detail = event.detail; if (navigation.placement !== placement || !detail?.sessionId || !detail.text || (detail.config?.tts.autoRead === false && !detail.songId) || (isConversationView(navigation.view) && navigation.sessionId === detail.sessionId)) return; speak(detail.text, false, detail); };
        window.addEventListener('dafeiyu:read', onRead); return () => window.removeEventListener('dafeiyu:read', onRead);
      }, [placement]);
      useEffect(() => {
        if (!nav.sessionId || !isConversationView(nav.view)) return;
        let disposed = false, timer, initial = true; const controller = new AbortController();
        async function poll() {
          try {
            const version = modelVersion.current, selecting = modelGate.current, readVersion = ++messageReadVersion;
            const data = await request('/messages?sessionId=' + encodeURIComponent(nav.sessionId), undefined, {signal: controller.signal});
            if (disposed) return;
            observeCallReplies(nav.sessionId, data, readVersion);
            const list = data.messages || []; setMessages(list); setMessagesReady(true); setRunning(!!data.running);
            if (data.modelSelection && !selecting && version === modelVersion.current && !modelGate.current) setModelCatalog(current => current && JSON.stringify(current.selected) !== JSON.stringify(data.modelSelection) ? {...current, selected:data.modelSelection} : current);
            if (awaitingReply.current && data.running) observedRunning.current = true;
            const observed = observeMessages(list, assistantSeen.current, initial, !!data.running);
            lastTurnEnd.current = data.lastTurnEnd?.id ?? null;
            const ended = lastTurnEnd.current !== null && lastTurnEnd.current !== replyTurnBaseline.current;
            const expired = Date.now() - replyStarted.current > 180000;
            if (!initial && !data.running && awaitingReply.current && (observed.settled.length || ended || expired)) {
              awaitingReply.current = false; sendGate.current = false; setSending(false); const reply = observed.speakable, context = replyReadContext.current; replyReadContext.current = null;
              const canRead = context?.callEpoch != null ? flags.current.call && context.callEpoch === callEpoch.current : reply?.songId || flags.current.readEnabled;
              if (reply && canRead && currentPreset === 'whale') speak(reply.text, false, null, {replyId:reply.id});
              else { setPhase(flags.current.call ? 'listening' : 'idle'); if (expired && !ended && !observed.settled.length) setError('暂未确认回复完成，自动朗读尚未开始，请检查对话记录。'); }
            }
            initial = false;
          } catch (e) { if (!disposed && !controller.signal.aborted) setError(errorText(e)); }
          finally { if (!disposed) timer = setTimeout(poll, flags.current.running || awaitingReply.current ? 750 : 2200); }
        }
        poll(); return () => { disposed = true; clearTimeout(timer); controller.abort(); };
      }, [nav.view, nav.sessionId, currentPreset]);
      async function sendMessage(content, fromVoice = false) {
        const value = content.trim(); if (!value || !nav.sessionId || modelGate.current || sendGate.current || running || !messagesReady || currentPreset !== 'whale') return false;
        sendGate.current = true; awaitingReply.current = true; replyReadContext.current = {callEpoch:flags.current.call ? callEpoch.current : null}; replyTurnBaseline.current = lastTurnEnd.current; replyStarted.current = Date.now(); observedRunning.current = false; setSending(true); setError(''); haltAudio(); setPhase('thinking'); const id = nav.sessionId, generation = lifecycle.current;
        const callOwner = flags.current.call ? {before:new Set(messages.filter(message=>message.role==='assistant').map(message=>message.id)),turnEnd:lastTurnEnd.current,readVersion:messageReadVersion} : null;
        if (callOwner) callReplyOwners.set(id,callOwner);
        try {
          const accepted = await request('/send', {sessionId: id, text: value, requestId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)});
          if (accepted.accepted !== true) throw new Error('消息尚未被接收，文字草稿已保留。');
          if (!fromVoice) clearSentDraft(id, content);
          if (generation !== lifecycle.current) return false; return true;
        } catch (e) { if (callOwner && callReplyOwners.get(id) === callOwner) callReplyOwners.delete(id); if (generation === lifecycle.current) { setError(errorText(e)); awaitingReply.current = false; sendGate.current = false; setSending(false); setPhase('idle'); } return false; }
      }
      async function acceptUtterance(audioBase64) {
        if (!callReady.current || recording.current || !flags.current.call || flags.current.micMuted || modelGate.current || sendGate.current) return;
        recording.current = true; setPhase('transcribing'); const generation = lifecycle.current, epoch = callEpoch.current, controller = new AbortController(); recognitionAbort.current = controller;
        try {
          const result = await request('/transcribe', {audioBase64, language: 'zh', sessionId: selection.current}, {signal: controller.signal, timeout: 60000});
          if (generation !== lifecycle.current || epoch !== callEpoch.current || !flags.current.call || flags.current.micMuted || controller.signal.aborted) return;
          if (result.text?.trim()) await sendMessage(result.text, true); else setPhase('listening');
        } catch (e) { if (!controller.signal.aborted && generation === lifecycle.current) { setError(errorText(e)); setPhase('listening'); } }
        finally { if (recognitionAbort.current === controller) recording.current = false; }
      }
      async function prepareSpeech(signal) {
        setPhase('preparing');
        await request('/speech/prepare', {sessionId: selection.current}, {signal, timeout: 120000});
        for (let attempt = 0; attempt < 90; attempt++) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          const data = await request('/health', undefined, {signal}); if (signal.aborted) throw new DOMException('Aborted','AbortError'); setHealth(data);
          if (data.asr?.available === true || data.asr?.phase === 'ready') return true;
          if (data.asr?.phase === 'error' || data.asr?.phase === 'unavailable') throw new Error(data.asr.message || '语音识别准备失败，请稍后重试。');
          await new Promise((resolve, reject) => { if (signal.aborted) { reject(new DOMException('Aborted','AbortError')); return; } const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000); const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }; signal.addEventListener('abort', abort, {once:true}); });
        }
        throw new Error('语音识别仍在准备中，请稍后再试。');
      }
      async function startCall() {
        if (!nav.sessionId || currentPreset !== 'whale' || call || microphone.current || !messagesReady || running || sendGate.current || modelGate.current) return;
        const epoch = ++callEpoch.current; flags.current.call = true; flags.current.micMuted = false;
        stopWidgetAudio(); haltAudio(); setError(''); setPhase('preparing'); setCall(true); setMicMuted(false); callReady.current = false;
        const preparation = new AbortController(); prepareAbort.current = preparation;
        const mic = new Microphone(() => callReady.current && flags.current.call && !flags.current.micMuted && !flags.current.running && !flags.current.sending && !recording.current && speakerGate.current && !modelGate.current && !sendGate.current, acceptUtterance, setLevel, {onPhase:setMicStage}); microphone.current = mic;
        const microphoneStart = mic.start({signal:preparation.signal});
        const speechReady = prepareSpeech(preparation.signal);
        try {
          await Promise.all([microphoneStart,speechReady]);
          if (preparation.signal.aborted || epoch !== callEpoch.current || mic.closed || microphone.current !== mic) return;
          callReady.current = true; setPhase('listening');
        } catch (error) {
          const cancelled = preparation.signal.aborted; preparation.abort(); mic.dispose(); callReady.current = false;
          if (microphone.current === mic) { microphone.current = null; flags.current.call = false; setCall(false); setPhase('idle'); if (!cancelled) setError(errorText(error)); }
        }
      }
      function toggleCallMicrophone() {
        const muted = !flags.current.micMuted; flags.current.micMuted = muted; setMicMuted(muted); microphone.current?.reset();
        if (muted) { recognitionAbort.current?.abort(); recognitionAbort.current = null; recording.current = false; setPhase('listening'); }
      }
      async function interruptReply() {
        const pending = running || sending || awaitingReply.current, id = nav.sessionId, generation = lifecycle.current;
        haltAudio(); awaitingReply.current = false; replyReadContext.current = null;
        if (!pending) { setPhase(flags.current.call ? 'listening' : 'idle'); return; }
        try { await request('/stop', {sessionId:id}); if (generation === lifecycle.current) { sendGate.current = false; setSending(false); setPhase(flags.current.call ? 'listening' : 'idle'); } }
        catch (error) { if (generation === lifecycle.current) setError(errorText(error)); }
      }
      async function saveConfig() {
        if (!draft || savingGate.current) return null;
        savingGate.current = true; setSaving(true); setError(''); setNotice('');
        const generation = lifecycle.current, submitted = copy(draft), submittedKey = apiKey, submittedQQToken = qqToken;
        try {
          const payload = copy(submitted); if (submittedKey) payload.apiKey = submittedKey;
          if (submittedQQToken) payload.qqToken = submittedQQToken;
          const result = await request('/config', payload);
          setSnapshot(s => s ? {...s, config: result.config} : s);
          setDraft(current => JSON.stringify(current) === JSON.stringify(submitted) ? copy(result.config) : current);
          setApiKey(current => current === submittedKey ? '' : current);
          setQQToken(current => current === submittedQQToken ? '' : current);
          setReadEnabled(result.config.tts.autoRead !== false); if (result.config.tts.autoRead === false) haltAudio();
          window.dispatchEvent(new CustomEvent('dafeiyu:config', {detail: result.config}));
          if (generation !== lifecycle.current) return null;
          setNotice('设置已保存'); return result.config;
        } catch (e) { if (generation === lifecycle.current) setError(errorText(e)); return null; }
        finally { savingGate.current = false; setSaving(false); }
      }
      async function loadQQ(signal) {
        const result=await request('/qq/state',undefined,{signal});
        if(signal?.aborted)return;
        setQQStatus(result.qq);
        if(result.config){
          setSnapshot(s=>s?{...s,qq:result.qq,config:{...s.config,qq:result.config}}:s);
          setDraft(d=>d?{...d,qq:{...d.qq,botId:result.config.botId,ownerId:result.config.ownerId,tokenConfigured:result.config.tokenConfigured}}:d);
        }
      }
      async function loadQQGroups(signal) {
        setQQGroupsLoading(true);
        try{const result=await request('/qq/groups',undefined,{signal});if(!signal?.aborted)setQQGroups(Array.isArray(result.groups)?result.groups:[]);}
        finally{if(!signal?.aborted)setQQGroupsLoading(false);}
      }
      useEffect(()=>{
        if(nav.view!=='settings'||tab!=='qq'||qqView!=='groups'||!qqStatus?.connected)return;
        const controller=new AbortController();
        loadQQGroups(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});
        return()=>controller.abort();
      },[nav.view,tab,qqView,qqStatus?.connected,qqStatus?.botId]);
      useEffect(()=>{
        if(nav.view!=='settings'||tab!=='qq')return;
        const controller=new AbortController();
        const refresh=()=>loadQQ(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});
        refresh();const timer=setInterval(refresh,3000);
        return()=>{controller.abort();clearInterval(timer);};
      },[nav.view,tab]);
      async function switchMode(next) {
        if (!nav.sessionId || modeBusy || running) return; stopWidgetAudio(); setModeBusy(true); setError(''); const id = nav.sessionId;
        try {
          const result = await request('/mode', {sessionId: id, agentPreset: next ? 'whale' : 'standard', expectedPreset: currentPreset}); if (!next) stopAll();
          if (selection.current !== id) return;
          setSnapshot(s => ({...s, session: {...s.session, preset: result.agentPreset}, sessions: s.sessions?.map(x => x.id === id ? {...x, preset: result.agentPreset} : x)}));
          window.dispatchEvent(new CustomEvent('dafeiyu:mode', {detail: {sessionId: id, preset: result.agentPreset}}));
        } catch (e) { if (selection.current === id) setError(errorText(e)); } finally { setModeBusy(false); }
      }
      async function loadMemories(query = memoryQuery, {quiet = false} = {}) {
        memoryAbort.current?.abort(); const controller = new AbortController(); memoryAbort.current = controller;
        memorySearch.current = query; if (!quiet) setMemoryBusy(true);
        try {
          const data = await request(query ? '/memories?q=' + encodeURIComponent(query) : '/memory/graph', undefined, {signal: controller.signal});
          if (controller.signal.aborted) return;
          const records = data.records || data.memories || [];
          setMemories(records);
          setExpandedRecords(current => Object.fromEntries(Object.entries(current).filter(([id, full]) => records.some(record => record.id === id && record.updatedAt === full.updatedAt))));
          setSpaces(data.spaces || []); setPalace(data.palace || null); setMemoryIndex(data.index || null);
          setSpaceId(id => id || data.spaces?.[0]?.id || ''); return true;
        } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); return false; }
        finally { if (memoryAbort.current === controller && !quiet) setMemoryBusy(false); }
      }
      useEffect(() => { if (nav.view === 'settings' && tab === 'memory') loadMemories(MemoryExplorer ? '' : memoryQuery); }, [nav.view, tab, MemoryExplorer]);
      useEffect(() => {
        if (nav.view !== 'settings' || tab !== 'memory' || !palace?.pendingJobs) return;
        const timer = setTimeout(() => loadMemories(memorySearch.current, {quiet:true}), 4000);
        return () => clearTimeout(timer);
      }, [nav.view, tab, palace]);
      async function readMemory(id) {
        if (expandedRecords[id]) { setExpandedRecords(current => { const next = {...current}; delete next[id]; return next; }); return; }
        memoryReadAbort.current?.abort(); const controller = new AbortController(); memoryReadAbort.current = controller; setReadingId(id);
        try {
          const data = await request('/memory?id=' + encodeURIComponent(id), undefined, {signal:controller.signal});
          if (controller.signal.aborted) return;
          if (!data.memory || typeof data.memory.content !== 'string') throw new Error('暂时无法读取这条记忆的完整正文。');
          setExpandedRecords(current => ({...current, [id]:data.memory}));
        } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
        finally { if (memoryReadAbort.current === controller) setReadingId(''); }
      }
      async function editMemory(id) {
        memoryEditAbort.current?.abort(); const controller = new AbortController(); memoryEditAbort.current = controller; setEditingId(id); setForgetId('');
        try {
          const data = await request('/memory?id=' + encodeURIComponent(id), undefined, {signal:controller.signal});
          if (controller.signal.aborted) return;
          if (!data.memory || typeof data.memory.content !== 'string') throw new Error('暂时无法读取这条记忆的完整正文。');
          setMemoryId(data.memory.id); setMemoryContent(data.memory.content); setSpaceId(data.memory.spaceId); return data.memory;
        } catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
        finally { if (memoryEditAbort.current === controller) setEditingId(''); }
      }
      async function saveMemory() {
        if (!memoryContent.trim() || !spaceId || memoryBusy) return; setMemoryBusy(true);
        const content = memoryContent.trim(), id = memoryId;
        try {
          await request('/memories', {spaceId, content, ...(id ? {id} : {})});
          setMemoryContent(value => value.trim() === content ? '' : value); setMemoryId(value => value === id ? '' : value);
          await loadMemories(memorySearch.current); setNotice('记忆已保存'); return true;
        } catch (e) { setError(errorText(e)); return false; } finally { setMemoryBusy(false); }
      }
      async function deleteMemory(id, {confirmed = false} = {}) {
        if ((!confirmed && forgetId !== id) || memoryBusy) return; setMemoryBusy(true);
        try {
          await request('/memories', {id}, {method:'DELETE'}); setForgetId('');
          if (memoryId === id) { setMemoryId(''); setMemoryContent(''); }
          await loadMemories(memorySearch.current); setNotice('这条记忆已被忘记'); return true;
        } catch (e) { setError(errorText(e)); return false; } finally { setMemoryBusy(false); }
      }
      async function maintainMemory(action) {
        if (maintenance || memoryBusy) return;
        setMaintenance(action); setError(''); setNotice('');
        try {
          await request('/memory/' + action, {}, {timeout:60000});
          const refreshed = await loadMemories(memorySearch.current);
          setNotice((action === 'reindex' ? '索引重建请求已提交' : action === 'projects/reconcile' ? '项目记忆已整理，来源记录完整保留' : '重试整理请求已提交') + (refreshed ? '，整理状态已刷新' : '，稍后可刷新状态查看进度'));
        } catch (e) { setError(errorText(e)); } finally { setMaintenance(''); }
      }
      async function copyPalacePath() {
        if (!palace?.palaceRoot) return;
        try { await navigator.clipboard.writeText(palace.palaceRoot); setNotice('记忆宫殿路径已复制'); }
        catch { setError('暂时无法直接复制，请选中宫殿路径后复制。'); }
      }
      const statusText = call && !callReady.current && micStage.phase === 'waiting-permission' ? '等待麦克风授权或设备响应' : call && !callReady.current && micStage.phase === 'starting-audio' ? '正在启动音频' : phase === 'preparing' ? '正在准备语音识别' : phase === 'connecting' ? '正在连接麦克风' : phase === 'transcribing' ? '正在听懂你的话' : running || phase === 'thinking' ? '正在想怎么回答你' : phase === 'synthesizing' ? '正在准备声音' : phase === 'starting-playback' ? '正在启动声音播放' : playing ? '正在和你说话' : call ? micMuted ? '麦克风已静音' : '我在听，你慢慢说' : '文字和声音，都能找到我';
      function sessionSelect() { return h(Field, {label: '会话'}, h('select', {value: nav.sessionId, onChange: e => { stopAll(); open(nav.view, e.target.value); }}, h('option', {value: '', disabled: true}, '选择一个会话'), ...(snapshot?.sessions || []).map(s => h('option', {key: s.id, value: s.id}, s.title || s.id)))); }
      function rolePage() {
        const role = draft.role, active = currentPreset === 'whale';
        return h('div', {className:'dfc-role-layout'},
          h(Card, {title:'角色预览',className:'dfc-block dfc-role-preview'},
            h('div', {className:'dfc-role-portrait'}, h('img', {src:ASSET+'role-preview.png',alt:'大肥鱼角色预览'})),
            h('div', {className:'dfc-role-identity'}, h('h3', null, role.name || '大肥鱼'), h('p', null, '称呼你为「'+(role.address || '主人')+'」')),
            h('div', {className:'dfc-role-preview-note'}, h('span', {className:'dfc-role-preview-dot','aria-hidden':true}), h('p', null, '让她成为你熟悉的大肥鱼', h('br'), '把语气、性格与相处方式，写进角色设定。'))),
          h('div', {className:'dfc-role-editor-stack'},
            h(Card, {title:h('span', {className:'dfc-role-section-title'}, h(Icon,{name:'user'}),'基础设定'),className:'dfc-block dfc-role-basics'},
              h('div', {className:'dfc-role-identity-fields'},
                h(Field, {label:'她的名字'}, h('input', {value:role.name,'aria-label':'她的名字',onChange:e=>setSection('role',{name:e.target.value})})),
                h(Field, {label:'她如何称呼你'}, h('input', {value:role.address,'aria-label':'她如何称呼你',onChange:e=>setSection('role',{address:e.target.value})})))),
            h(Card, {title:h('span', {className:'dfc-role-section-title'}, h(Icon,{name:'file-text'}),'角色提示词'),className:'dfc-block dfc-role-prompt-card',action:h(Button,{icon:'refresh',variant:'quiet',onClick:async()=>{
              try { const response=await fetch(ASSET+'persona.md',{credentials:'same-origin'}); if(!response.ok)throw new Error('暂时无法载入角色原稿。'); setSection('role',{prompt:await response.text()}); setNotice('完整角色设定已载入，保存后生效'); } catch(e) { setError(errorText(e)); }
            }},'恢复默认')},
              h('div', {className:'dfc-role-prompt-frame'},
                h('textarea', {className:'dfj-prompt dfc-role-prompt',value:role.prompt,onChange:e=>setSection('role',{prompt:e.target.value}),'aria-label':'完整角色提示词',spellCheck:false,rows:14}),
                h('div', {className:'dfc-role-prompt-footer'}, h('span', null, '共 '+(role.prompt?.length || 0).toLocaleString()+' 个字'), h('span', null, '完整设定，保存后生效')))),
            h(Card, {title:h('span', {className:'dfc-role-section-title'}, h(Icon,{name:'message-circle'}),'当前会话'),className:'dfc-block dfc-role-session'},
              h('div', {className:'dfc-role-session-row'},
                h('div', {className:'dfc-role-session-picker'}, sessionSelect()),
                h('div', {className:'dfc-role-mode-control'},
                  h('div', {className:'dfc-role-mode-label'}, h('strong', null, '鲸鱼娘模式'), h(Toggle,{value:active,disabled:!nav.sessionId || modeBusy || running || currentSession?.running,label:'切换鲸鱼娘模式',onChange:switchMode})),
                  h('p', {role:'status','aria-live':'polite'}, modeBusy ? '正在切换会话模式…' : !nav.sessionId ? '选择会话后可切换鲸鱼娘模式' : active ? '角色、陪伴记忆与自动朗读已接入' : '当前会话使用标准模式'))),
              h('p', {className:'dfc-role-session-note'}, '模式在同一会话内切换，保留当前对话。'))));
      }
      function voicePage() {
        const local = draft.tts.source === 'local', prefix = local ? 'local' : 'api', emotionalAvailable = local && draft.tts.localModel?.trim() === 'audiocpp';
        const voiceBusy = playing || phase === 'synthesizing' || phase === 'starting-playback', emotionalEnabled = draft.tts.emotional !== false;
        const speed = draft.tts.speed ?? 1, volume = draft.tts.volume ?? 0.8, selectedId = draft.tts[prefix + 'Voice'] || '';
        const selectedVoice = voices.find(voice => voice.id === selectedId);
        const selectedName = selectedVoice?.name || (health?.tts?.source === draft.tts.source && health?.tts?.voice === selectedId ? health.tts.voiceName : '') || '当前选择的音色';
        const heading = (icon, text) => h('span', {className:'dfc-voice-heading'}, h(Icon, {name:icon,size:23}), text);
        const previewStatus = phase === 'synthesizing' ? '正在准备声音 · ' + voiceWaitSeconds + ' 秒' : phase === 'starting-playback' ? '正在启动声音播放 · ' + voiceWaitSeconds + ' 秒' : playing ? '正在试听，随时可以停止' : speechDelivery?.mode === 'preview' && speechDelivery.emotion ? EMOTIONS[speechDelivery.emotion].label + ' · 试听已准备好' : '点选语气后，再点击试听';
        const wave = 'M0 62 C12 62 14 30 24 30 S36 94 48 94 S60 16 72 16 S84 106 96 106 S108 38 120 38 S132 86 144 86 S156 54 168 54 S180 68 192 68 S204 60 216 60 S228 64 240 64 S252 60 264 60 S276 64 288 64 S300 48 312 48 S324 82 336 82 S348 26 360 26 S372 100 384 100 S396 34 408 34 S420 88 432 88 S444 52 456 52 S468 64 480 64 S492 62 504 62 S516 62 528 62';
        return h('div', {className:'dfc-voice-workbench'},
          h('div', {className:'dfc-voice-config'},
            h(Card, {title:heading('volume','声音来源'),note:'选择语音服务与音色，让大肥鱼用喜欢的声音陪伴你。',className:'dfc-block dfc-voice-source'},
              h('div', {className:'dfc-voice-source-tabs',role:'group','aria-label':'语音合成来源'},
                h(Button, {icon:'volume',className:local?'is-active':'','aria-pressed':local,onClick:()=>{setSection('tts',{source:'local'});setHealth(null);}}, '本地语音'),
                h(Button, {icon:'network',className:!local?'is-active':'','aria-pressed':!local,onClick:()=>{setSection('tts',{source:'api'});setHealth(null);}}, 'API 语音')),
              h('div', {className:'dfc-voice-form'},
                h(Field, {label:'音色',note:'选择已保存的音色，或填写音色 ID'},
                  h('input', {list:'dfj-voices',value:selectedId,placeholder:'大肥鱼',onChange:e=>setSection('tts',{[prefix+'Voice']:e.target.value})}),
                  h('datalist', {id:'dfj-voices'}, ...voices.map(voice=>h('option',{key:voice.id,value:voice.id},voice.name)))),
                h(Field, {label:local?'本地服务地址':'API 服务地址',wide:true,note:local?'连接本机的语音合成服务':'支持兼容 OpenAI 的语音合成接口'},
                  h('input', {type:'url',value:draft.tts[prefix+'Url']||'',placeholder:local?'http://127.0.0.1:3900/v1':'https://api.example.com/v1',onChange:e=>setSection('tts',{[prefix+'Url']:e.target.value})})),
                h('div', {className:'dfc-voice-model-row'},
                  h(Field, {label:'语音模型'}, h('input',{value:draft.tts[prefix+'Model']||'',placeholder:'模型名称',onChange:e=>setSection('tts',{[prefix+'Model']:e.target.value})})),
                  h(Button, {icon:'refresh',className:'dfc-voice-check',disabled:saving||voiceBusy,onClick:async()=>{if(!await saveConfig())return;try{setHealth(await request('/health'));setNotice('连接检查已完成');}catch(e){setError(errorText(e));}}}, '保存并检查连接')),
                !local && h(Field, {label:'API 密钥',wide:true,note:draft.tts.keyConfigured?'密钥已保存。留空继续使用当前密钥。':'仅在服务需要时填写，保存后由宿主保管'},
                  h('input',{type:'password',value:apiKey,autoComplete:'new-password',placeholder:draft.tts.keyConfigured?'已配置':'填写密钥',onChange:e=>setApiKey(e.target.value)}))),
              h('div', {className:'dfc-voice-connection'},
                h('div', {className:'dfc-voice-health'+(health?.tts?.available?' is-available':health?.tts?' needs-attention':''),role:'status'},
                  h('span',{className:'dfc-voice-status-dot','aria-hidden':true}),
                  h('div',null,h('strong',null,health?.tts?'上次连接检查':'尚未检查连接'),h('p',null,health?.tts?.message||'填写服务信息后，点击“保存并检查连接”。'))),
                h(Button, {icon:voiceBusy?'player-pause':'player-play',variant:'quiet',className:'dfc-voice-quick-preview',disabled:saving,onClick:async()=>{if(voiceBusy){haltAudio();return;}if(await saveConfig())speak('主人，大肥鱼在这里，慢慢来，我陪着你。',true);}}, voiceBusy?'停止声音':'试听当前音色'))),
            h(Card, {title:heading('sparkles','情绪表达'),note:'调整大肥鱼说话时的情绪风格，让回应更符合你的喜好。',className:'dfc-block dfc-voice-expression'},
              h('div', {className:'dfc-voice-toggle-row'},
                h('span',{className:'dfc-voice-label'},'情绪语音'),
                h(Toggle,{value:emotionalEnabled,disabled:!emotionalAvailable||voiceBusy,label:'情绪语音',onChange:value=>setSection('tts',{emotional:value})}),
                h('p',null,emotionalAvailable?'根据这句话的心情，生成自然的语气':'当前服务提供基础语音；情绪表达已适配本地 Breeze')),
              h('div', {className:'dfc-voice-style-row'}, h('span',{className:'dfc-voice-label'},'情绪风格'),
                h('div',{className:'dfc-voice-style',role:'group','aria-label':'情绪表达方式'}, ...[['gentle','轻柔'],['natural','自然'],['vivid','鲜明']].map(([value,label])=>h(Button,{key:value,className:(draft.tts.expressiveness||'natural')===value?'is-active':'','aria-pressed':(draft.tts.expressiveness||'natural')===value,disabled:!emotionalAvailable||!emotionalEnabled||voiceBusy,onClick:()=>setSection('tts',{expressiveness:value})},label)))),
              h('div', {className:'dfc-voice-slider'}, h('span',{className:'dfc-voice-label'},'说话语速'),
                h('input',{type:'range','aria-label':'说话语速','aria-valuetext':Number(speed).toFixed(2)+' 倍',min:.75,max:1.5,step:.05,value:speed,disabled:voiceBusy,style:{'--dfc-voice-fill':Math.max(0,Math.min(100,(speed-.75)/.75*100))+'%'},onChange:e=>setSection('tts',{speed:Number(e.target.value)})}),
                h('output',{'aria-hidden':true},Number(speed).toFixed(2)+' ×')),
              h('p',{className:'dfc-voice-control-note'},'QQ与桌面语音一起生效'),
              h('div', {className:'dfc-voice-slider'}, h('span',{className:'dfc-voice-label'},'声音大小'),
                h('input',{type:'range','aria-label':'声音大小','aria-valuetext':Math.round(volume*100)+'%',min:0,max:1,step:.05,value:volume,style:{'--dfc-voice-fill':Math.max(0,Math.min(100,volume*100))+'%'},onChange:e=>setSection('tts',{volume:Number(e.target.value)})}),
                h('output',{'aria-hidden':true},Math.round(volume*100)+'%')),
              h('div',{className:'dfc-voice-autoread'},
                h('div',null,h('strong',null,'DSH自动朗读'),h('p',null,'在鲸鱼娘模式下朗读她的回复。QQ语音回复在QQ页单独设置。')),
                h(Toggle,{value:draft.tts.autoRead,label:'自动朗读回复',onChange:value=>setSection('tts',{autoRead:value})}))),
            h('details',{className:'dfc-voice-asr'},
              h('summary',null,h(Icon,{name:'microphone',size:18}),h('span',null,'语音识别'),h('small',null,speechPreparing?'正在准备':health?.asr?.available?'已准备好':'沿用 DSH 配置'),h(Icon,{name:'chevron-down',size:16})),
              h('div',{className:'dfc-voice-asr-content'},
                h('p',{role:'status'},health?.asr?.available?'DSH 语音识别已准备好。':health?.asr?.phase==='preparing'||speechPreparing?'正在准备语音识别，你可以先使用文字交流。':'可在这里准备并检查 DSH 当前选择的语音识别。'),
                h(Button,{icon:'microphone',disabled:speechPreparing||call,onClick:async()=>{const controller=new AbortController();prepareAbort.current=controller;setSpeechPreparing(true);setError('');try{await prepareSpeech(controller.signal);if(!controller.signal.aborted){setNotice('语音识别已准备好');setPhase('idle');}}catch(e){if(!controller.signal.aborted)setError(errorText(e));}finally{setSpeechPreparing(false);}}},speechPreparing?'正在准备…':health?.asr?.available?'检查语音识别':'准备语音识别')))),
          h(Card,{title:heading('headphones','听听她的声音'),note:'选择不同的心情，试听大肥鱼的声音效果。',className:'dfc-block dfc-voice-preview'},
            h('div',{className:'dfc-voice-stage','data-preview-state':phase},
              h('svg',{className:'dfc-voice-wave',viewBox:'0 0 528 124',preserveAspectRatio:'none','aria-hidden':true},
                h('path',{d:wave,transform:'translate(0 -7)',opacity:.18}),h('path',{d:wave,opacity:.75}),h('path',{d:wave,transform:'translate(0 7)',opacity:.18})),
              h('span',{className:'dfc-voice-bubble dfc-voice-bubble-one','aria-hidden':true}),h('span',{className:'dfc-voice-bubble dfc-voice-bubble-two','aria-hidden':true}),h('span',{className:'dfc-voice-bubble dfc-voice-bubble-three','aria-hidden':true}),
              h('div',{className:'dfc-voice-avatar'},h('img',{src:ASSET+'portrait.png',alt:'大肥鱼头像'})),
              h('p',{className:'dfc-voice-selected-name'},selectedName),
              h('blockquote',{className:'dfc-voice-line'},'主人，我在这里呢。今天也想陪你说说话。')),
            h('div',{className:'dfc-voice-preview-controls'},
              h('p',{className:'dfc-voice-preview-label'},'选择心情'),
              h('div',{className:'dfc-voice-emotions',role:'group','aria-label':'试听语气'}, ...[['warm','温暖'],['joyful','开心'],['soothing','安抚'],['playful','俏皮'],['concerned','关心'],['sad','低落']].map(([emotion,label])=>h(Button,{key:emotion,className:previewEmotion===emotion?'is-active':'','aria-label':EMOTIONS[emotion].label,'aria-pressed':previewEmotion===emotion,disabled:voiceBusy||!emotionalAvailable||!emotionalEnabled,onClick:()=>setPreviewEmotion(emotion)},label))),
              h('div',{className:'dfc-voice-preview-actions'},
                h(Button,{icon:voiceBusy?'player-pause':'player-play',variant:'primary',className:'dfc-voice-preview-primary',disabled:saving||!emotionalAvailable||!emotionalEnabled,onClick:async()=>{if(voiceBusy){haltAudio();return;}if(await saveConfig())speak('主人，我在这里呢。今天也想陪你说说话。',true,null,{previewEmotion});}},voiceBusy?'停止声音':'试听这份心情'),
                h(Button,{icon:'player-pause',className:'dfc-voice-preview-stop','aria-label':'停止情绪试听',disabled:!voiceBusy,onClick:haltAudio},'停止')),
              h('p',{className:'dfc-voice-preview-status',role:'status'},previewStatus))));
      }
      function memoryRecordDetails(memory) {
        const sources = memorySources(memory), revisions = Array.isArray(memory.revisions) ? memory.revisions : [];
        const hasDetails = sources.length || memory.evidence || memory.supersedes || memory.supersededBy || revisions.length || memory.filePath;
        if (!hasDetails) return null;
        return h('details', {className:'dfj-memory-details'}, h('summary', null, '来源、证据与更正记录'),
          h('div', {className:'dfj-memory-provenance'},
            sources.map((source, index) => h('div', {className:'dfj-memory-source', key:index},
              source.kind && h('span', {className:'dfj-memory-source-kind'}, ({manual:'手工记录',conversation:'陪伴对话',legacy:'导入记忆',mnemon:'导入记忆'}[source.kind] || source.kind)),
              source.sessionId && h('dl', null, h('dt', null, '来源会话'), h('dd', null, source.sessionId)),
              source.userEventId && h('dl', null, h('dt', null, '用户消息'), h('dd', null, source.userEventId)),
              source.assistantEventId && h('dl', null, h('dt', null, '回复消息'), h('dd', null, source.assistantEventId)),
              source.evidence && h('blockquote', null, detailText(source.evidence)))),
            memory.evidence && !sources.some(source => detailText(source.evidence) === detailText(memory.evidence)) && h('blockquote', null, detailText(memory.evidence)),
            (memory.supersedes || memory.supersededBy) && h('div', {className:'dfj-memory-correction-links'},
              memory.supersedes && h('dl', null, h('dt', null, '更正自'), h('dd', null, memory.supersedes)),
              memory.supersededBy && h('dl', null, h('dt', null, '已更正为'), h('dd', null, memory.supersededBy))),
            revisions.length > 0 && h('div', {className:'dfj-memory-revisions'}, h('strong', null, '更正历史'), ...revisions.map((revision,index) => h('article', {key:index}, revision.updatedAt && h('time', null, memoryDate(revision.updatedAt)), h('p', null, detailText(revision.content || revision.value))))),
            memory.filePath && h('dl', {className:'dfj-memory-file'}, h('dt', null, '记忆文件'), h('dd', null, memory.filePath))));
      }
      function memoryPage() {
        const settingsAction = draft && (dirty || apiKey || qqToken) && h(Button,{icon:'check',variant:'primary',disabled:saving,onClick:saveConfig},saving?'正在保存…':'保存设置');
        if (!MemoryExplorer || !draft) return h('div', {className:'dfg-initializing'},
          h('header',{className:'dfg-header'},h(Button,{icon:'arrow-left',variant:'quiet',className:'dfg-back',onClick:close},'返回工作区'),h('div',{className:'dfg-brand'},h('h1',null,'记忆宫殿'))),
          graphLoadError ? h('div', {className:'dfg-load-error',role:'alert'}, graphLoadError, h(Button, {onClick:()=>{setGraphLoadError('');setGraphAttempt(value=>value+1);}}, '重新加载关系图')) : h('p', {className:'dfj-loading',role:'status'}, '正在展开记忆星图…'),
          graphLoadError && draft && h('div',{className:'dfj-settings-scroll'},memoryManagementPage()),
          settingsAction && h('footer',{className:'dfg-footer'},settingsAction));
        const summary = palaceSummary(palace);
        const management = h('div', {className:'dfg-manage'},
          h('h3',null,'记忆状态'), h('p',{className:'dfg-subtle',role:'status'},summary.text),
          h('div',{className:'dfg-manage-status'}, h('span',null,(palace?.memoryCount??memories.length)+' 条记忆'),h('span',null,(palace?.pendingJobs??0)+' 待整理'),h('span',null,(palace?.failedJobs??0)+' 待重试')),
          h('div',{className:'dfj-switch-row'},h('div',null,h('strong',null,'陪伴记忆'),h('p',null,'相处时，记住你明确告诉她的人与事')),h(Toggle,{value:draft.memory.enabled,label:'启用陪伴记忆',onChange:value=>setSection('memory',{enabled:value})})),
          h(Button,{icon:'check',disabled:saving||!dirty,onClick:saveConfig},saving?'正在保存…':'保存设置'),
          h('h3',null,'宫殿目录'),h('div',{className:'dfj-palace-path'},h('label',null,h('input',{readOnly:true,value:palace?.palaceRoot||'','aria-label':'记忆宫殿实际路径',onFocus:event=>event.target.select()})),h(Button,{icon:'copy',disabled:!palace?.palaceRoot,onClick:copyPalacePath},'复制路径')),
          h('h3',null,'索引与整理'),h('div',{className:'dfj-inline-actions'},h(Button,{icon:'refresh',disabled:memoryBusy||!!maintenance,onClick:()=>loadMemories('')},'刷新状态'),h(Button,{disabled:memoryBusy||!!maintenance,onClick:()=>maintainMemory('reindex')},maintenance==='reindex'?'正在提交…':'重建索引'),h(Button,{disabled:memoryBusy||!!maintenance,onClick:()=>maintainMemory('projects/reconcile')},maintenance==='projects/reconcile'?'正在整理…':'整理项目记忆'),h(Button,{disabled:memoryBusy||!!maintenance||!palace?.failedJobs,onClick:()=>maintainMemory('retry')},maintenance==='retry'?'正在提交…':'重试整理')),
          h('p',{className:'dfg-subtle'},memoryIndex?.builtAt?'索引更新于 '+memoryDate(memoryIndex.builtAt):'索引更新时间暂不可用'));
        const editor = h(React.Fragment,null,
          h(Field,{label:'记忆归属',wide:true},h('select',{className:'dfg-editor-space','aria-label':'记忆归属',value:spaceId,disabled:memoryBusy||!!editingId,onChange:event=>setSpaceId(event.target.value)},...spaces.map(space=>h('option',{key:space.id,value:space.id},space.name)))),
          h('textarea',{className:'dfj-memory-editor dfg-editor-text',disabled:!!editingId||memoryBusy,value:memoryContent,'aria-label':'记忆内容',placeholder:'写下一件希望她记住的事…',maxLength:8000,onChange:event=>setMemoryContent(event.target.value)}),
          h('p',{className:'dfg-editor-note'},'保存后，这段记忆会连接到对应的人物与主题。你可以随时回来修改。'));
        return h(MemoryExplorer,{onPanelChange:setMemoryPanelOpen,settingsAction,records:memories,spaces,palace,busy:memoryBusy,summary,memoryId,canSave:!!memoryContent.trim()&&!!spaceId&&!editingId,
          onClose:close,onSettings:()=>setTab('role'),onRefresh:()=>loadMemories(''),
          onSearch:(query,signal)=>request('/memory/graph/search?q='+encodeURIComponent(query),undefined,{signal}).then(data=>{if(!Array.isArray(data.ids))throw new Error('暂时无法检索完整记忆。');return data.ids;}),
          onRead:(id,signal)=>request('/memory?id='+encodeURIComponent(id),undefined,{signal}).then(data=>{if(!data.memory||typeof data.memory.content!=='string')throw new Error('暂时无法读取完整记忆。');return data.memory;}),
          onNew:()=>{memoryEditAbort.current?.abort();setEditingId('');if(memoryId){setMemoryId('');setMemoryContent('');}setSpaceId(value=>value||spaces[0]?.id||'');},
          onEdit:editMemory,onSave:saveMemory,onForget:id=>deleteMemory(id,{confirmed:true}),renderDetails:memoryRecordDetails,management,editor});
      }
      function memoryManagementPage() {
        const filtered = indexedMemories(memories, spaceId, memoryFacet, memoryIndex), summary = palaceSummary(palace);
        const entries = Array.isArray(memoryIndex?.[memoryFacet.kind]) ? memoryIndex[memoryFacet.kind] : [];
        const indexedAt = memoryIndex?.builtAt || palace?.index?.builtAt;
        return h('div', {className:'dfj-palace-page'},
          h(Card, {title:'记忆宫殿', note:'按人物、主题和时间，找到相处的点滴', className:'dfj-palace-overview', action:h(Toggle, {value:draft.memory.enabled,label:'启用陪伴记忆',onChange:value=>setSection('memory',{enabled:value})})},
            h('div', {className:'dfj-palace-path'}, h('label', null, h('span', null, '宫殿位置'), h('input', {readOnly:true,value:palace?.palaceRoot || '',placeholder:memoryBusy?'正在读取宫殿位置…':'尚未取得宫殿路径','aria-label':'记忆宫殿实际路径',onFocus:e=>e.target.select()})), h(Button, {disabled:!palace?.palaceRoot,onClick:copyPalacePath}, '复制路径')),
            h('div', {className:'dfj-palace-status-row'}, h('div', {className:'dfj-palace-state','data-tone':summary.tone,role:'status'}, h('i'), h('span', null, summary.text)), h('div', {className:'dfj-palace-counts'}, ...[['记忆',palace?.memoryCount],['待整理',palace?.pendingJobs],['待重试',palace?.failedJobs]].map(([label,count])=>h('span', {key:label}, h('strong', null, Number.isFinite(count)?count:'—'), label)))),
            h('div', {className:'dfj-palace-tools'}, h('span', null, indexedAt?'索引更新于 '+memoryDate(indexedAt):'尚未读取到索引更新时间'), h('div', null,
              h(Button, {icon:'refresh',variant:'quiet',disabled:!!maintenance || memoryBusy,onClick:()=>loadMemories(memorySearch.current)}, '刷新状态'),
              h(Button, {disabled:!!maintenance || memoryBusy,onClick:()=>maintainMemory('reindex')}, maintenance==='reindex'?'正在提交…':'重建索引'),
              h(Button, {disabled:!!maintenance || memoryBusy,onClick:()=>maintainMemory('projects/reconcile')}, maintenance==='projects/reconcile'?'正在整理…':'整理项目记忆'),
              h(Button, {disabled:!!maintenance || memoryBusy || !palace?.failedJobs,onClick:()=>maintainMemory('retry')}, maintenance==='retry'?'正在提交…':'重试整理')))),
          h('div', {className:'dfj-memory-layout'}, h(Card, {title:'陪伴记忆',note:'鲸鱼娘自己的故事，也有她眼里的你'},
            h('div', {className:'dfj-segments'}, ...spaces.map(space=>h(Button, {key:space.id,className:space.id===spaceId?'is-active':'',onClick:()=>{memoryEditAbort.current?.abort();memoryReadAbort.current?.abort();setEditingId('');setReadingId('');setSpaceId(space.id);setMemoryFacet(facet=>({...facet,value:''}));setForgetId('');setMemoryContent('');setMemoryId('');}},space.name))),
            h('div', {className:'dfj-memory-index'}, h('div', {className:'dfj-memory-index-tabs',role:'group','aria-label':'记忆索引分类'}, ...[['people','人物'],['topics','主题'],['dates','时间']].map(([kind,label])=>h('button', {key:kind,type:'button',className:memoryFacet.kind===kind?'is-active':'',onClick:()=>{setMemoryFacet({kind,value:''});setForgetId('');}},label))),
              h('p',{className:'dfj-memory-index-note'},'索引覆盖整个宫殿，结果在当前空间展示'),
              h('div', {className:'dfj-memory-index-chips'}, h('button', {type:'button',className:!memoryFacet.value?'is-active':'',onClick:()=>{setMemoryFacet(facet=>({...facet,value:''}));setForgetId('');}},'全部'),
                ...entries.map(entry=>{const value=memoryFacet.kind==='dates'?entry.date:entry.name;return h('button',{key:value,type:'button',className:memoryFacet.value===value?'is-active':'',onClick:()=>{setMemoryFacet(facet=>({...facet,value}));setForgetId('');}},h('span',null,value),Number.isFinite(entry.count)&&h('small',null,entry.count));}),
                !entries.length && h('span',{className:'dfj-memory-index-empty'},memoryIndex?'这个分类还没有索引条目':memoryBusy?'正在读取索引…':'索引暂不可用'))),
            h('form', {className:'dfj-search',onSubmit:e=>{e.preventDefault();setForgetId('');loadMemories();}},h(Icon,{name:'search',size:18}),h('input',{value:memoryQuery,placeholder:'搜索记忆内容与线索','aria-label':'搜索记忆',onChange:e=>setMemoryQuery(e.target.value)}),h(Button,{type:'submit',disabled:memoryBusy},'搜索')),
            h('div',{className:'dfj-memory-results-label'},h('span',null,memoryFacet.value?'索引：'+memoryFacet.value:'当前空间'),h('span',null,filtered.length+' 条显示结果')),
            h('div',{className:'dfj-memory-list'},filtered.length?filtered.map(memory=>h('article',{key:memory.id,className:'dfj-memory-item'},
              h('p',null,expandedRecords[memory.id]?.content || memory.content || memory.text),
              memory.truncated===true && h('div',{className:'dfj-memory-excerpt'},h('span',null,Number.isFinite(memory.contentLength)?'全文 '+memory.contentLength.toLocaleString()+' 字':'内容摘录'),h(Button,{variant:'quiet',disabled:readingId===memory.id,onClick:()=>readMemory(memory.id)},readingId===memory.id?'正在读取…':expandedRecords[memory.id]?'收起正文':'阅读全文')),
              h('div',{className:'dfj-memory-record-meta'},memory.subject&&h('span',null,memory.subject),...(Array.isArray(memory.tags)?memory.tags:[]).map(tag=>h('span',{key:tag},tag)),memory.updatedAt&&h('time',{dateTime:memory.updatedAt},'更新于 '+memoryDate(memory.updatedAt))),
              memoryRecordDetails(expandedRecords[memory.id] || memory),
              forgetId===memory.id?h('div',{className:'dfj-forget-confirm',role:'group','aria-label':'确认忘记这条记忆'},h('strong',null,'忘记这条记忆及其旧版本？'),h('p',null,'确认后，这条记忆及旧版本会退出检索和后续使用。此页面不提供恢复操作。'),h('div',null,h(Button,{disabled:memoryBusy,onClick:()=>setForgetId('')},'保留'),h(Button,{disabled:memoryBusy,className:'dfj-forget-action',onClick:()=>deleteMemory(memory.id)},'确认忘记'))):
              h('div',{className:'dfj-memory-item-actions'},h(Button,{variant:'quiet',disabled:memoryBusy || !!editingId,onClick:()=>editMemory(memory.id)},'编辑'),h(Button,{icon:'trash',variant:'quiet',disabled:memoryBusy,'aria-label':'忘记这条记忆',onClick:()=>setForgetId(memory.id)},'忘记')))):
              h('p',{className:'dfj-empty'},memoryBusy?'正在读取记忆…':memoryFacet.value?'这个索引下暂时没有匹配的记忆。':'这里会留下你们相处的点滴。'))),
            h(Card,{title:editingId?'正在读取完整记忆…':memoryId?'编辑记忆':'添加一条记忆',note:spaces.find(space=>space.id===spaceId)?.name || '选择记忆空间',className:'dfj-memory-editor-card'},
              h('textarea',{className:'dfj-memory-editor',disabled:!!editingId,value:memoryContent,'aria-label':'记忆内容',placeholder:'写下一件希望她记住的事…',onChange:e=>setMemoryContent(e.target.value)}),
              h('div',{className:'dfj-inline-actions'},h(Button,{icon:'plus',variant:'primary',disabled:!memoryContent.trim() || !spaceId || memoryBusy || !!editingId,onClick:saveMemory},memoryBusy?'保存中…':'保存记忆'),memoryId&&h(Button,{onClick:()=>{setMemoryId('');setMemoryContent('');}},'取消编辑')))));
      }
      function widgetPage() {
        const widget = draft.widget;
        const regions = [{key:'head',label:'头部',icon:'user'},{key:'face',label:'脸颊',icon:'heart'},{key:'tail',label:'鱼鳍',icon:'sparkles'}];
        const selectedKey = regions.some(region=>region.key===widgetPreviewRegion) ? widgetPreviewRegion : 'head';
        const selected = regions.find(region=>region.key===selectedKey), selectedText = widget.regions?.[selectedKey]?.text || '为这个触点写一句小回应。';
        return h('div', {className:'dfc-widget-layout'},
          h(Card, {title:'工作区挂件预览',note:'只在DSH窗口内陪伴',className:'dfc-block dfc-widget-preview-card'},
            h('div', {className:'dfc-widget-stage','aria-label':'挂件静态预览'},
              h('span', {className:'dfc-widget-static-tag'}, '静态预览'),
              h('div', {className:'dfc-widget-mini-window','aria-hidden':true},
                h('div', {className:'dfc-widget-mini-bar'}, h('i'),h('i'),h('i')),
                h('div', {className:'dfc-widget-mini-body'},
                  h('div', {className:'dfc-widget-mini-sidebar'}, ...Array.from({length:5},(_,i)=>h('span',{key:i},h('i'),h('b')))),
                  h('div', {className:'dfc-widget-mini-chat'}, ...Array.from({length:6},(_,i)=>h('span',{key:i}))))),
              h('div', {className:'dfc-widget-preview-character'}, h('img', {src:'/dsh-whale/image.png?v=2',alt:'鲸鱼娘挂件预览'})),
              h('div', {className:'dfc-widget-preview-bubble','aria-live':'polite'}, selectedText),
              ...regions.map(region=>h('button',{key:region.key,type:'button',className:'dfc-widget-hotspot dfc-widget-hotspot-'+region.key+(selectedKey===region.key?' is-active':''),'aria-label':'查看'+region.label+'触点短句','aria-pressed':selectedKey===region.key,onClick:()=>setWidgetPreviewRegion(region.key)},h('span',{'aria-hidden':true}),region.label))),
            h('div', {className:'dfc-widget-preview-footer'},
              h('div', null, h('h3', null, '外观与触点预览'), h('p', null, '选择触点，查看对应的气泡短句。')),
              h('label', {className:'dfc-widget-region-picker'}, h('span', null, '当前选中'), h('select', {value:selectedKey,'aria-label':'挂件预览触点',onChange:e=>setWidgetPreviewRegion(e.target.value)}, ...regions.map(region=>h('option',{key:region.key,value:region.key},region.label))))),
            h('p', {className:'dfc-widget-preview-note'}, '回到工作区，点击挂件即可听到预制短句。')),
          h('div', {className:'dfc-widget-editor-stack'},
            h(Card, {title:'基础设置',className:'dfc-block dfc-widget-basics'},
              h('div', {className:'dfc-widget-switch-row'}, h(Toggle,{value:widget.enabled,label:'显示记账挂件',onChange:value=>setSection('widget',{enabled:value})}),h('div',null,h('strong',null,'显示记账挂件'),h('p',null,'可以独立于鲸鱼娘模式开关'))),
              h('div', {className:'dfc-widget-switch-row'}, h(Toggle,{value:widget.soundEnabled,label:'挂件点击音效',onChange:value=>setSection('widget',{soundEnabled:value})}),h('div',null,h('strong',null,'点击时播放声音'),h('p',null,'不同位置，触发不同的小回应'))),
              h(Field, {label:'挂件音量 · '+Math.round((widget.volume ?? 0.7)*100)+'%'},
                h('div',{className:'dfc-widget-volume-row'},h(Icon,{name:'volume'}),h('input',{type:'range',min:0,max:1,step:0.05,value:widget.volume ?? 0.7,'aria-label':'挂件音量','aria-valuetext':Math.round((widget.volume ?? 0.7)*100)+'%',onChange:e=>setSection('widget',{volume:Number(e.target.value)})})))),
            h(Card, {title:'点击短句',note:'气泡文字与预制声音分别设置',className:'dfc-block dfc-widget-regions'},
              ...regions.map(region=>h('div',{key:region.key,className:'dfc-widget-region'+(selectedKey===region.key?' is-active':'')},
                h('button',{type:'button',className:'dfc-widget-region-label','aria-label':'预览'+region.label+'触点','aria-pressed':selectedKey===region.key,onClick:()=>setWidgetPreviewRegion(region.key)},h(Icon,{name:region.icon}),h('span',null,region.label)),
                h('div',{className:'dfc-widget-region-fields'},
                  h(Field,{label:'回应文字'},h('div',{className:'dfc-widget-copy-input'},h('input',{value:widget.regions?.[region.key]?.text || '','aria-label':region.label+'回应文字',onFocus:()=>setWidgetPreviewRegion(region.key),onChange:e=>setSection('widget',{regions:{...widget.regions,[region.key]:{...widget.regions?.[region.key],text:e.target.value}}})}),h('span',{'aria-hidden':true},(widget.regions?.[region.key]?.text?.length || 0)+' 字'))),
                  h('details',{className:'dfc-widget-audio-file'},h('summary',null,h(Icon,{name:'volume'}),'预制声音'),h(Field,{label:'声音文件'},h('input',{value:widget.regions?.[region.key]?.audio || '',placeholder:'audio/'+region.key+'.wav','aria-label':region.label+'声音文件',onFocus:()=>setWidgetPreviewRegion(region.key),onChange:e=>setSection('widget',{regions:{...widget.regions,[region.key]:{...widget.regions?.[region.key],audio:e.target.value}}})}))))))),
            h('div',{className:'dfc-widget-accounting-note'},h(Icon,{name:'list'}),h('p',null,'余额、用量与账务记录，继续在右下角挂件查看。')),
            h('div',{className:'dfc-widget-stop-row'},h(Button,{icon:'player-pause',className:'dfc-widget-stop',onClick:stopWidgetAudio},'停止挂件声音'),h('p',null,'触点语音从本机 assets/audio 目录读取，配置后可点击挂件试听。'))));
      }
      function qqPage() {
        const q=draft.qq||{enabled:false,wsUrl:'ws://127.0.0.1:13001',sessionId:'',voiceReplies:true};
        const status=qqStatus||snapshot?.qq, pairing=status?.pairing, monitor=status?.monitor;
        const entries=Array.isArray(monitor?.entries)?monitor.entries:[];
        const phase=status?.connected?'ready':status?.phase==='ready'?'connecting':status?.phase||'loading';
        const connectionLabel=({ready:'QQ在线',disabled:'QQ连接已关闭',connecting:'正在连接网关',verifying:'正在核对QQ登录',error:'QQ连接异常',loading:'正在读取QQ状态'})[phase]||'等待QQ连接';
        const recovery=status?.recovery,retrySeconds=Number.isFinite(recovery?.nextRetryAt)?Math.max(0,Math.ceil((recovery.nextRetryAt-Date.now())/1000)):null;
        const reconnect=async()=>{if(qqReconnecting)return;setQQReconnecting(true);setError('');try{const r=await request('/qq/reconnect',{});setQQStatus(r.qq);setNotice('已开始重新连接已保存的QQ网关');}catch(e){setError(errorText(e));}finally{setQQReconnecting(false);}};
        const number=value=>Number.isFinite(value)?value:'—';
        const selectedGroups=Array.isArray(q.groups)?q.groups:[], appliedGroups=snapshot?.config?.qq?.groups;
        const enabledGroups=selectedGroups.filter(g=>g.enabled).length;
        const groupPending=Array.isArray(appliedGroups)&&JSON.stringify(selectedGroups)!==JSON.stringify(appliedGroups);
        const rows=new Map(qqGroups.map(g=>[g.id,g]));for(const g of selectedGroups)if(!rows.has(g.id))rows.set(g.id,g);
        const statusLabels={received:'已收到',queued:'等待回复',replying:'正在回复',synthesizing:'正在生成语音',sent:'已发送',failed:'发送失败',uncertain:'待核对',cancelled:'已停止'};
        const kindLabels={voice:'语音',control:'配对',image:'图片',face:'QQ表情',sticker:'表情包'};
        const badge=(text,tone='quiet')=>h('span',{className:'dfc-qq-badge','data-tone':tone},text);
        const jump=(title,note,view,icon='network',extra)=>h('button',{type:'button',className:'dfc-qq-shortcut',onClick:()=>setQQView(view)},
          h(Icon,{name:icon,size:20}),h('span',null,h('strong',null,title),note&&h('small',null,note)),extra&&badge(extra,extra==='待保存'?'pending':'good'),h(Icon,{name:'chevron-down',size:16}));
        const replySettings=h(Card,{title:'回复方式',className:'dfc-block dfc-qq-card'},h('div',{className:'dfc-qq-card-body'},
          h('div',{className:'dfc-qq-reply-switch'},h(Icon,{name:'microphone',size:23}),h('div',null,h('strong',null,'QQ语音回复'),h('p',null,'用当前音色与本句情绪生成语音条')),h(Toggle,{value:q.voiceReplies!==false,label:'QQ语音回复',onChange:value=>setSection('qq',{voiceReplies:value})})),
          h('div',{className:'dfc-qq-reply-switch'},h(Icon,{name:'message-circle',size:23}),h('div',null,h('strong',null,'每条回复附带表情'),h('p',null,'按本句情绪搭配一张主题表情')),h(Toggle,{value:q.stickerReplies!==false,label:'QQ表情包回复',onChange:value=>setSection('qq',{stickerReplies:value})})),
          h('p',{className:'dfc-qq-footnote'},'语音与表情开关保存后生效。语音生成失败时保留文字。'),
          h('p',{className:'dfc-qq-footnote'},'私聊可发图片和表情；已启用群仍需@她，动图按静态画面理解。')));
        const accessScope=h(Card,{title:'接入范围',className:'dfc-block dfc-qq-card'},h('div',{className:'dfc-qq-card-body'},
          jump('主号私聊','仅与已配对主号交流','connection','user',status?.paired?'已配对':undefined),
          jump('已启用群聊（需@）',groupPending?'已选 '+enabledGroups+' 个群，保存后生效':'已启用 '+enabledGroups+' 个群，真实@触发回复','groups','network',groupPending?'待保存':undefined),
          h(Button,{className:'dfc-qq-manage',variant:'quiet',onClick:()=>setQQView('groups')},'去管理群聊'),
          h('p',{className:'dfc-qq-footnote'},'每个群、每位成员分别保存对话与记忆。群聊信息不会进入主号私聊监控。')));
        const connectionShortcut=h(Card,{title:'连接与配对',className:'dfc-block dfc-qq-card'},h('div',{className:'dfc-qq-card-body'},
          jump('连接与配对','查看QQ连接、会话和配对设置','connection','network'),
          status?.lastError&&phase!=='error'?h('p',{className:'dfc-qq-notice',role:'status'},h('strong',null,'最近提示'),status.lastError):h('p',{className:'dfc-qq-footnote'},'保持DSH与QQ网关运行，语音回复还需要语音服务。')));
        const sidebar=h('aside',{className:'dfc-qq-sidebar','aria-label':'QQ回复与接入设置'},replySettings,accessScope,connectionShortcut);
        const subnav=h('div',{className:'dfc-qq-subnav',role:'group','aria-label':'QQ功能'},
          ...[['monitor','私聊监控'],['groups','群聊@回复'],['connection','连接与配对']].map(([id,label])=>h(Button,{key:id,className:qqView===id?'is-active':'','aria-pressed':qqView===id,onClick:()=>setQQView(id)},label)));
        const liveBar=h('div',{className:'dfc-qq-livebar',role:'status','aria-live':'polite'},
          h('span',{className:'dfc-qq-live-state','data-phase':phase},h('i',{'aria-hidden':true}),connectionLabel),
          h('span',{className:'dfc-qq-pair-state','data-paired':status?.paired===true},h(Icon,{name:'heart',size:18}),!status?'正在读取配对状态':status.paired?'主人已配对':'等待主人配对'),
          h('span',{className:'dfc-qq-live-counts'},'私聊本次收到 ',h('strong',null,number(status?.received)),' 条',h('i',{'aria-hidden':true}),'发出 ',h('strong',null,number(status?.sentVoice)),' 条语音 · ',h('strong',null,number(status?.sentText)),' 条文字 · ',h('strong',null,number(status?.sentSticker)),' 张表情'),
          Number.isFinite(status?.queueLength)&&status.queueLength>0&&badge('待回复 '+status.queueLength+' 条','pending'));
        const connectionError=phase==='error'&&h('div',{className:'dfc-qq-connection-error',role:'status'},h(Icon,{name:'network',size:19}),h('div',null,h('strong',null,'QQ连接需要检查'),h('p',null,status?.lastError||'请检查本机QQ网关与登录状态。'),retrySeconds!==null&&h('p',null,retrySeconds+'秒后自动重连')),q.enabled&&h(Button,{variant:'quiet',disabled:qqReconnecting,onClick:reconnect},qqReconnecting?'正在重连…':'重新连接'),qqView!=='connection'&&h(Button,{variant:'quiet',onClick:()=>setQQView('connection')},'检查连接设置'));
        let content;
        if(qqView==='monitor'){
          const log=!status?h('div',{className:'dfc-qq-empty',role:'status'},h('p',null,'正在读取QQ状态…')):!status.paired?h('div',{className:'dfc-qq-empty'},h(Icon,{name:'user',size:34}),h('strong',null,'先和主号建立联系'),h('p',null,'完成配对后，这里会显示你与大肥鱼的消息和回复状态。'),h(Button,{variant:'primary',onClick:()=>setQQView('connection')},'前往连接与配对')):entries.length?
            h('div',{className:'dfc-qq-log',role:'feed','aria-label':'QQ近期收发动态','aria-live':'polite'},...entries.slice(0,12).map(entry=>{
              const outgoing=entry.direction==='out',speaker=outgoing?(draft.role.name||'大肥鱼'):(draft.role.address||'主人');
              const tone=entry.delivery?.mode==='singing'?'清唱试听':entry.delivery?.emotion&&EMOTIONS[entry.delivery.emotion]?.label;
              const kind=kindLabels[entry.kind]||'文字',media=['voice','image','face','sticker'].includes(entry.kind);
              const state=!outgoing&&entry.status==='sent'?'已回复':statusLabels[entry.status]||'已记录';
              return h('article',{key:entry.id,className:'dfc-qq-message '+(outgoing?'is-out':'is-in'),'data-state':entry.status},
                h('div',{className:'dfc-qq-avatar','aria-hidden':true},outgoing?h('img',{src:ASSET+'portrait.png',alt:''}):h(Icon,{name:'user',size:24})),
                h('div',{className:'dfc-qq-message-body'},
                  h('header',null,h('strong',null,speaker),h('time',{dateTime:entry.at},memoryDate(entry.at)),h('span',{className:'dfc-qq-message-state','data-state':entry.status},state)),
                  media&&h('div',{className:'dfc-qq-media','data-kind':entry.kind},h(Icon,{name:entry.kind==='voice'?'volume':entry.kind==='face'?'message-circle':'file-text',size:20}),h('span',null,kind)),
                  h('div',{className:'dfc-qq-bubble'},h('p',null,String(entry.text||(entry.kind==='voice'?'语音消息':'消息已记录')))),
                  (tone||Number.isFinite(entry.delivery?.preparationMs)||entry.delivery?.cached===true)&&h('div',{className:'dfc-qq-delivery'},tone&&h('span',null,tone),Number.isFinite(entry.delivery?.preparationMs)&&h('span',null,'声音准备 '+(entry.delivery.preparationMs/1000).toFixed(1)+' 秒'),entry.delivery?.cached===true&&h('span',null,'同句重播')),
                  entry.error&&h('p',{className:'dfc-qq-message-error'},String(entry.error))));
            })):h('div',{className:'dfc-qq-empty'},h(Icon,{name:'message-circle',size:34}),h('strong',null,'等一句新的问候'),h('p',null,'用已配对主号发一条消息，回复过程会显示在这里。'));
          const timeline=h(Card,{title:'最近私聊动态',note:'核对收发进度与送达结果，仅展示已配对主号',className:'dfc-block dfc-qq-card dfc-qq-monitor-card',action:h(Button,{icon:'refresh',variant:'quiet',onClick:()=>loadQQ().catch(e=>setError(errorText(e)))},'刷新消息')},
            monitor?.backfillState==='loading'&&h('p',{className:'dfc-qq-inline-status',role:'status'},'正在读取最近的私聊消息…'),
            monitor?.backfillState==='unavailable'&&h('p',{className:'dfc-qq-inline-status',role:'status'},'历史消息暂未载入，在线后会继续记录新消息。'),
            monitor?.error&&h('p',{className:'dfc-qq-inline-status is-error',role:'status'},monitor.error),log,
            h('footer',{className:'dfc-qq-log-footer'},h('span',null,'最近 '+Math.min(entries.length,12)+' 条收发动态 · 完整对话在QQ中查看')));
          content=h('div',{className:'dfc-qq-columns'},timeline,sidebar);
        }else if(qqView==='groups'){
          const activity=status?.groupActivity;
          const groupList=h(Card,{title:'群聊@回复',note:'选择允许大肥鱼回应的QQ群',className:'dfc-block dfc-qq-card',action:h(Button,{icon:'refresh',variant:'quiet',disabled:!status?.connected||qqGroupsLoading,onClick:()=>loadQQGroups().catch(e=>setError(errorText(e)))},qqGroupsLoading?'正在读取…':'刷新群列表')},
            h('div',{className:'dfc-qq-card-body'},
              h('div',{className:'dfc-qq-group-intro'},h('div',null,h('strong',null,'真实@，就能接上话'),h('p',null,'仅已启用的群接收回复；群内任意成员都可以@大肥鱼。')),badge('已选择 '+enabledGroups+' 个群',groupPending?'pending':'quiet')),
              !status?.connected&&h('div',{className:'dfc-qq-inline-status'},h('p',null,'连接QQ网关后可以刷新群列表，已配置的群仍可在下方调整。'),h(Button,{variant:'quiet',onClick:()=>setQQView('connection')},'前往连接与配对')),
              h('div',{className:'dfc-qq-group-list'},...[...rows.values()].map(g=>{
                const enabled=selectedGroups.some(x=>x.id===g.id&&x.enabled);
                const applied=Array.isArray(appliedGroups)?appliedGroups.some(x=>x.id===g.id&&x.enabled):enabled;
                return h('div',{key:g.id,className:'dfc-qq-group-row','data-enabled':enabled},
                  h('div',{className:'dfc-qq-group-mark','aria-hidden':true},h(Icon,{name:'network',size:23})),
                  h('div',{className:'dfc-qq-group-info'},h('strong',null,g.name),h('p',null,'群号 '+g.id+(Number.isInteger(g.memberCount)?' · '+g.memberCount+' 位成员':''))),
                  badge(enabled!==applied?(enabled?'待启用':'待关闭'):enabled?'已启用':'未启用',enabled!==applied?'pending':enabled?'good':'quiet'),
                  h(Toggle,{label:'启用群聊 '+g.name,value:enabled,onChange:value=>setSection('qq',{groups:[...selectedGroups.filter(x=>x.id!==g.id),{id:g.id,name:g.name,enabled:value}]})}));
              })),
              status?.connected&&!rows.size&&!qqGroupsLoading&&h('div',{className:'dfc-qq-empty'},h(Icon,{name:'network',size:32}),h('p',null,'暂未找到QQ群，可以稍后刷新。')),
              activity&&h('div',{className:'dfc-qq-group-stats'},...[[activity.received,'收到消息'],[activity.sentVoice,'发出语音'],[activity.sentText,'发出文字'],[activity.sentSticker,'发出表情'],[activity.queueLength,'待回复']].map(([value,label])=>h('div',{key:label},h('strong',null,number(value)),h('span',null,label)))),
              h('p',{className:'dfc-qq-footnote'},'每个群、每位成员分别保存对话与记忆；语音与表情沿用右侧的回复设置。')),
            h('footer',{className:'dfc-qq-action-footer'},h('span',null,groupPending?'群选择有待保存的更改':'群开关保存后生效'),h(Button,{icon:'check',variant:'primary',disabled:saving,onClick:saveConfig},'保存群聊设置')));
          content=h('div',{className:'dfc-qq-columns'},groupList,sidebar);
        }else{
          const gateway=h(Card,{title:'QQ里的大肥鱼',note:'连接已配对私聊与单独启用的QQ群',className:'dfc-block dfc-qq-card'},h('div',{className:'dfc-qq-card-body'},
            h('div',{className:'dfc-qq-connection-switch'},h('div',null,h('strong',null,'连接QQ小号'),h('p',null,'沿用当前角色、记忆与有情绪的声音')),h(Toggle,{value:q.enabled,label:'启用QQ连接',onChange:value=>setSection('qq',{enabled:value,sessionId:q.sessionId||nav.sessionId||''})})),
            h(Field,{label:'陪伴会话',note:'主号私聊与这个鲸鱼娘会话共用对话和记忆'},h('select',{'aria-label':'QQ陪伴会话',value:q.sessionId||'',onChange:e=>setSection('qq',{sessionId:e.target.value})},h('option',{value:''},'选择鲸鱼娘会话'),...(snapshot?.sessions||[]).filter(s=>s.preset==='whale').map(s=>h('option',{key:s.id,value:s.id},s.title)))),
            h('details',{className:'dfc-qq-advanced',open:!q.tokenConfigured},h('summary',null,'网关连接参数',h('span',null,q.tokenConfigured?'令牌已由DSH保管':'填写本机网关信息')),
              h('div',{className:'dfc-qq-advanced-fields'},
                h(Field,{label:'本机QQ网关',note:'OneBot正向WebSocket，仅接受本机地址'},h('input',{'aria-label':'本机QQ网关',value:q.wsUrl||'',onChange:e=>setSection('qq',{wsUrl:e.target.value})})),
                h(Field,{label:'网关令牌',note:q.tokenConfigured?'已由DSH保管，留空继续使用':'保存后由DSH凭据服务保管'},h('input',{'aria-label':'网关令牌',type:'password',value:qqToken,autoComplete:'new-password',placeholder:q.tokenConfigured?'已配置':'填写本机网关令牌',onChange:e=>setQQToken(e.target.value)})))),
            h('div',{className:'dfc-qq-connect-actions'},h(Button,{icon:'refresh',variant:'primary',disabled:saving,onClick:async()=>{if(await saveConfig())try{await loadQQ();}catch(e){setError(errorText(e));}}},'保存并连接'),phase!=='error'&&h(Button,{variant:'quiet',disabled:!q.enabled||qqReconnecting,onClick:reconnect},qqReconnecting?'正在重连…':'重新连接'),h('a',{href:'http://127.0.0.1:16099/webui',target:'_blank',rel:'noopener noreferrer'},'打开本机QQ登录页面')),
            h('p',{className:'dfc-qq-footnote'},'首次或登录失效时，在本机QQ网关页面用手机扫码。请保持QQ网关运行。'),h('div',{className:'dfc-qq-account',role:'status'},h('span',null,h('strong',null,'连接状态：'),connectionLabel),(status?.botId||q.botId)&&h('span',null,h('strong',null,'QQ小号：'),status?.botId||q.botId))));
          const pairCard=h(Card,{title:'主人配对',note:'从你的主号私聊大肥鱼，完成一次绑定',className:'dfc-block dfc-qq-card'},h('div',{className:'dfc-qq-card-body'},
            h('div',{className:'dfc-qq-pair-summary'},h('div',{className:'dfc-qq-group-mark','aria-hidden':true},h(Icon,{name:'user',size:24})),h('div',null,h('strong',null,status?.ownerId?'主人已绑定':'等待一次私聊配对'),h('p',null,status?.ownerId?'已绑定主人：'+status.ownerId:'配对后，仅已绑定主号可以通过私聊唤起大肥鱼。'))),
            pairing?.code&&h('div',{className:'dfc-qq-pair-code',role:'status'},h('p',null,'请用主号在QQ私聊发送：'),h('strong',null,'配对 '+pairing.code),h('p',null,'有效期十分钟，仅本人使用。'),h(Button,{icon:'copy',variant:'quiet',onClick:async()=>{try{await navigator.clipboard.writeText('配对 '+pairing.code);setNotice('配对句已复制，粘贴到QQ私聊即可');}catch{setError('暂时无法复制，请选中上方配对句复制。');}}},'复制配对句')),
            h('div',{className:'dfc-qq-pair-actions'},h(Button,{icon:'user',variant:'primary',disabled:saving||!q.enabled||!!status?.ownerId,onClick:async()=>{if(!await saveConfig())return;try{const r=await request('/qq/pairing',{});setQQStatus(r.qq);setNotice('请用主号向大肥鱼小号发送配对码');}catch(e){setError(errorText(e));}}},pairing?'更新配对码':'生成配对码'),status?.ownerId&&h(Button,{variant:'quiet',className:'dfc-qq-unpair',onClick:async()=>{try{await request('/qq/unpair',{});await loadQQ();setNotice('已解除主人绑定，QQ聊天已暂停');}catch(e){setError(errorText(e));}}},'解除绑定'))));
          content=h('div',{className:'dfc-qq-columns'},h('div',{className:'dfc-qq-connection-stack'},gateway,pairCard),sidebar);
        }
        return h('div',{className:'dfc-qq-page'},liveBar,connectionError,subnav,content);
      }
      function settingsNavigation() {
        return h('nav', {className:'dfj-tabs','aria-label':'配置分类'},... [['role','模式与角色'],['voice','语音'],['memory','记忆'],['widget','挂件与音效'],['qq','QQ']].map(([id,label])=>h('button',{key:id,type:'button',className:tab===id?'is-active':'',onClick:()=>setTab(id),'aria-current':tab===id?'page':undefined},label)));
      }
      function settingsPage() {
        const pendingChanges = !!(dirty || apiKey || qqToken);
        return h('div', {className: 'dfj-settings dfc-settings-shell', 'data-settings-tab': tab},
          h('div', {className:'dfc-category-rail',inert:tab==='memory'&&memoryPanelOpen?'':undefined,'aria-hidden':tab==='memory'&&memoryPanelOpen?true:undefined}, settingsNavigation()),
          tab === 'memory' ? memoryPage() : h('div',{className:'dfc-settings dfc-settings-content'},
          h('header', {className:'dfc-header'},
            h('div', {className:'dfc-header-leading'}, h(Button, {icon:'arrow-left',variant:'quiet',className:'dfc-back',onClick:close}, '返回工作区'),
              h('div', {className:'dfc-brand'}, h('img', {src:ASSET+'icon.png',alt:'',width:36,height:36}), h('div', null, h('h1', null, '大肥鱼配置中心'), h('p', null, ({role:'让她成为你熟悉的大肥鱼',voice:'让每一句话，都有自己的心情',widget:'在工作旁边，留一点陪伴',qq:'QQ连接与消息监控'})[tab] || '管理你的陪伴设置')))),
            h('div', {className:'dfc-header-actions'}, h(Button,{icon:'phone',className:'dfc-call-entry',disabled:!nav.sessionId,onClick:()=>open('call',nav.sessionId)},'语音通话'), h('span', {className:'dfc-mode', 'data-active':currentPreset==='whale'}, h('i'), currentPreset==='whale'?'鲸鱼娘模式':currentPreset==='standard'?'标准模式':'未选择会话'))),
          h('div', {className: 'dfj-settings-scroll',ref:settingsScrollRef}, loading ? h('p', {className: 'dfj-loading'}, '正在准备你的鲸鱼娘…') : draft && (tab === 'role' ? rolePage() : tab === 'voice' ? voicePage() : tab === 'memory' ? memoryPage() : tab === 'qq' ? qqPage() : widgetPage())),
          h('footer', {className:'dfj-settings-footer dfc-savebar'}, h('span', {className:'dfc-save-state', 'data-pending':pendingChanges, role:'status'}, h('i'), saving?'正在保存…':pendingChanges?'有尚未保存的修改':draft?'设置已保存':'正在读取设置'), h(Button, {icon:'check',variant:'primary',disabled:saving||!draft,onClick:saveConfig}, saving?'正在保存…':'保存设置'))));
      }
      function modelControls() {
        const groups = modelCatalog?.groups || [], selected = modelCatalog?.selected || currentSession?.modelSelection;
        const key = selected ? JSON.stringify([selected.provider, selected.model]) : '';
        const info = groups.find(group => group.id === selected?.provider)?.models?.find(model => model.id === selected?.model);
        const disabled = loading || modelLoading || modelBusy || sending || running || phase === 'transcribing' || !nav.sessionId || currentPreset !== 'whale';
        return h('div', {className:'dfj-model-controls', 'aria-busy':modelLoading || modelBusy},
          h('label', {className:'dfj-model-select'}, h('span', null, '模型'), h('select', {
            'aria-label':'对话模型', value:key, disabled:disabled || !groups.length,
            title:running || sending ? '等待当前回复结束后切换模型' : '选择当前会话使用的模型',
            onChange:e=>{try { const [provider, model] = JSON.parse(e.target.value); changeModel({provider, model}); } catch { setModelError('请选择可用的模型。'); }},
          }, !info && h('option', {value:key,disabled:true}, selected?.model || (modelLoading ? '正在读取模型…' : '选择模型')),
          ...groups.map(group=>h('optgroup', {key:group.id,label:group.name}, ...group.models.map(model=>h('option', {key:model.id,value:JSON.stringify([group.id,model.id])}, model.name || model.id)))))),
          info?.reasoning?.efforts?.length > 0 && h('label', {className:'dfj-model-select dfj-model-effort'}, h('span', null, '思考'), h('select', {
            'aria-label':'思考强度', value:selected?.reasoningEffort || '', disabled,
            onChange:e=>changeModel({...selected, reasoningEffort:e.target.value || undefined}),
          }, h('option', {value:''}, '自动'), ...info.reasoning.efforts.map(effort=>h('option', {key:effort.id,value:effort.id}, effort.name || effort.id)))),
          h(Button, {icon:'refresh',variant:'quiet',className:'dfj-model-refresh',disabled:modelLoading || modelBusy || sending || running,'aria-label':'刷新模型列表',title:'刷新模型列表',onClick:loadModels}),
          h('span', {className:'dfj-model-status' + (modelError ? ' is-error' : ''),role:modelError?'alert':'status'}, modelBusy ? '切换中…' : modelLoading ? '正在读取模型…' : modelError || (!groups.length ? '暂无可用模型，请检查DSH模型配置' : modelCatalog?.failures?.length ? '部分服务暂时无法读取' : '')));
      }
      function oceanAtmosphere() {
        const particle = (index, bubble) => h('span', {key:index, style:{
          '--x':((index * (bubble ? 27 : 37) + (bubble ? 4 : 11)) % 100) + '%',
          '--y':((index * 23 + 9) % 100) + '%',
          '--delay':-(index * (bubble ? 2.3 : 1.7) + 3) + 's',
          '--duration':((bubble ? 20 : 13) + index % 5 * 3) + 's',
          '--size':((bubble ? 7 : 2) + index % (bubble ? 5 : 3) * (bubble ? 2 : .6)) + 'px',
        }});
        return h('div', {className:'dfj-ocean-atmosphere', 'aria-hidden':true},
          h('div', {className:'dfj-ocean-panorama'}), h('div', {className:'dfj-ocean-light'}), h('div', {className:'dfj-ocean-caustics'}),
          h('div', {className:'dfj-ocean-motes'}, ...Array.from({length:18}, (_, index) => particle(index, false))),
          h('div', {className:'dfj-ocean-bubbles'}, ...Array.from({length:12}, (_, index) => particle(index, true))),
          h('div', {className:'dfj-ocean-vignette'}));
      }
      function callPage() {
        const name = snapshot?.config.role.name || '大肥鱼', audioBusy = playing || phase === 'synthesizing' || phase === 'starting-playback';
        const delivery = speechDelivery?.sessionId === nav.sessionId && speechDelivery.replyId === lastReply?.id ? speechDelivery : null;
        const tone = delivery?.emotion && EMOTIONS[delivery.emotion]?.label;
        const voiceId = snapshot?.config.tts.source === 'api' ? snapshot?.config.tts.apiVoice : snapshot?.config.tts.localVoice;
        const voiceName = voices.find(voice=>voice.id === voiceId)?.name || voiceId || '当前音色';
        const state = playing ? 'speaking' : audioBusy || call && !callReady.current ? 'preparing' : running || sending || phase === 'transcribing' ? 'thinking' : call ? micMuted ? 'muted' : 'listening' : 'idle';
        const canStart = !loading && messagesReady && !!nav.sessionId && currentPreset === 'whale' && !running && !sending && !modelBusy;
        return h('div',{className:'dfj-call-page','data-state':state,style:{'--dfj-level':level}},
          h('header',{className:'dfj-call-header'},
            h(Button,{icon:'arrow-left',variant:'quiet',onClick:close},nav.sessionId?'返回会话':'返回工作区'),
            h('div',{className:'dfj-call-brand'},h('small',null,'VOICE CALL'),h('strong',null,name)),
            h(Button,{icon:'settings',variant:'quiet','aria-label':'通话设置',title:call?'结束通话并打开声音设置':'打开声音设置',onClick:()=>{open('settings',nav.sessionId,'voice');}})),
          h('main',{className:'dfj-call-main'},
            h('div',{className:'dfj-call-session'},h('label',null,h('span',null,'当前会话'),h('select',{'aria-label':'通话会话',value:nav.sessionId,disabled:call||loading,onChange:e=>open('call',e.target.value)},
              h('option',{value:'',disabled:true},'选择陪伴会话'),...(snapshot?.sessions||[]).filter(s=>s.preset==='whale'||s.id===nav.sessionId).map(s=>h('option',{key:s.id,value:s.id},s.title||s.id))))),
            h('section',{className:'dfj-call-stage','aria-label':'大肥鱼语音通话','data-state':state,'data-call-ready':callReady.current,'data-microphone-stage':micStage.phase},
              h('div',{className:'dfj-call-avatar'},h('img',{src:ASSET+'portrait.png',alt:name})),
              h('div',{className:'dfj-call-wave','aria-hidden':true},...Array.from({length:8},(_,i)=>h('span',{key:i,style:{'--i':i}}))),
              h('p',{className:'dfj-call-status',role:'status'},loading?'正在读取陪伴会话…':!nav.sessionId?'先选一个熟悉的会话':call||audioBusy||running||sending?statusText:'准备好了，就拨给我吧'),
              h('p',{className:'dfj-call-tone'},voiceName,' · ',snapshot?.config.tts.speed||1,'×',tone?' · '+tone:'')),
            h('div',{className:'dfj-call-transcript',role:'region','aria-label':'最近一句对话',tabIndex:0},
              lastUser&&h('div',{className:'dfj-call-utterance','data-role':'user'},h('small',null,'你刚刚说'),h('p',null,lastUser.text)),
              lastReply&&h('div',{className:'dfj-call-utterance','data-role':'assistant'},h('small',null,running||sending?'正在回应你':name),h('p',null,lastReply.text)),
              !lastUser&&!lastReply&&h('p',{className:'dfj-call-empty'},'接通后自然说话，停顿片刻就会收到回应。')),
            currentPreset&&currentPreset!=='whale'&&h('div',{className:'dfj-call-mode'},h('p',null,'这个会话当前使用标准模式。'),h(Button,{variant:'primary',disabled:modeBusy||running,onClick:()=>switchMode(true)},modeBusy?'切换中…':'开启鲸鱼娘模式')),
            h('div',{className:'dfj-call-actions'},
              call?h(Button,{icon:micMuted?'microphone-off':'microphone','aria-pressed':micMuted,onClick:toggleCallMicrophone},micMuted?'取消静音':'麦克风静音'):h(Button,{icon:'phone',variant:'primary',disabled:!canStart,onClick:startCall},'开始通话'),
              (audioBusy||running||sending)&&h(Button,{icon:'player-pause',onClick:interruptReply},'打断回复'),
              call&&h(Button,{icon:'phone-off',className:'dfj-call-hangup',onClick:stopAll},'挂断')),
            h('p',{className:'dfj-call-note'},call?'说完停顿片刻。她思考和说话时，麦克风会暂停收音。':'点击开始才会打开麦克风；通话时自动用声音回应。'),
            h(Button,{icon:'message-circle',variant:'quiet',className:'dfj-call-text-toggle','aria-expanded':callTextOpen,onClick:()=>setCallTextOpen(value=>!value)},callTextOpen?'收起文字与模型':'文字与模型'),
            callTextOpen&&h('form',{className:'dfj-call-composer',onSubmit:event=>{event.preventDefault();sendMessage(text);}},
              h('div',{className:'dfj-call-composer-row'},h('textarea',{ref:composer,value:text,rows:2,'aria-label':'给大肥鱼发消息',placeholder:'也可以打字说给我听…',onChange:event=>updateTextDraft(nav.sessionId,event.target.value),onKeyDown:event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();sendMessage(text);}}}),h(Button,{type:'submit',icon:'send',variant:'primary','aria-label':'发送消息',disabled:!text.trim()||loading||modelBusy||sending||running||!messagesReady||currentPreset!=='whale'},'发送')),
              h('details',{className:'dfj-call-models',open:true},h('summary',null,'当前会话的模型'),modelControls()))),
          h('footer',{className:'dfj-call-footer'},'同一DSH会话 · 情绪语音 · ',snapshot?.config.memory.enabled===false?'记忆已关闭':'记忆宫殿'));
      }
      function immersivePage() {
        const name = snapshot?.config.role.name || '大肥鱼', audioBusy = playing || phase === 'synthesizing' || phase === 'starting-playback';
        const emotionalVoice = snapshot?.config.tts.emotional !== false && snapshot?.config.tts.source === 'local' && snapshot?.config.tts.localModel?.trim() === 'audiocpp';
        const delivery = speechDelivery?.sessionId === nav.sessionId && speechDelivery.replyId === lastReply?.id && speechDelivery.text === lastReply?.text && !running && !sending ? speechDelivery : null;
        const emotion = delivery?.emotion, tone = emotion ? EMOTIONS[emotion] : null;
        const voiceState = playing ? 'speaking' : phase === 'starting-playback' ? 'starting-playback' : phase === 'synthesizing' ? 'preparing' : running || sending ? 'thinking' : call && !micMuted ? 'listening' : 'idle';
        const toneLabel = delivery?.mode === 'singing' ? '大肥鱼清唱试听' : tone?.label || (delivery?.mode === 'natural-fallback' ? '自然语气' : delivery?.mode === 'disabled' || delivery?.mode === 'unsupported' || !emotionalVoice ? '自然朗读，陪你慢慢聊' : '心情，会藏在声音里');
        const replayReady = lastReply?.speakable === true && currentPreset === 'whale' && !running && !sending && lastReply.text.length <= 4000;
        return h('div', {className:'dfj-immersive', 'data-motion':sceneVisible ? ambientMotion : 'paused', 'data-reading':readExpanded ? 'expanded' : 'normal', 'data-emotion':emotion || 'none', 'data-voice-state':voiceState, style:{'--dfj-level':level}, onPointerMove:moveOcean, onPointerLeave:event=>{event.currentTarget.style.setProperty('--dfj-pointer-x','0px');event.currentTarget.style.setProperty('--dfj-pointer-y','0px');}},
          oceanAtmosphere(),
          h('header', {className:'dfj-immersive-header'},
            h(Button, {icon:'arrow-left', variant:'quiet', onClick:close}, '返回工作区'),
            h('div', {className:'dfj-identity'}, h('strong', null, name), h('span', {role:'status'}, h('i'), statusText)),
            h('div', {className:'dfj-immersive-tools'},
              h(Button, {icon:ambientMotion === 'active' ? 'player-pause' : 'player-play', variant:'quiet', className:'dfj-atmosphere-toggle', 'aria-label':ambientMotion === 'active' ? '暂停动态效果' : '开启动效', 'aria-pressed':ambientMotion === 'paused', title:ambientMotion === 'active' ? '暂停光影、浮游微光与气泡' : '开启深海动态效果', onClick:toggleAmbientMotion}, ambientMotion === 'active' ? '暂停动效' : '开启动效'),
              h(Button, {icon:'settings', variant:'quiet', 'aria-label':'打开配置中心', onClick:()=>open('settings',nav.sessionId)}))),
          h('main', {className:'dfj-ocean-room'},
            h('section', {className:'dfj-ocean-stage', 'aria-label':'鲸鱼娘陪伴', 'data-speaking':playing, 'data-microphone-stage':micStage.phase, 'data-audio-state':micStage.audioState, 'data-permission-query':micStage.permissionQuery || 'unknown', 'data-call-ready':callReady.current, 'data-listening':call && !micMuted && !running, style:{'--dfj-level':level}},
              h('div', {className:'dfj-character-orbits', 'aria-hidden':true}, h('div', {className:'dfj-orbit-one'}), h('div', {className:'dfj-orbit-two'})),
              h('div', {className:'dfj-orb'}, h('div', {className:'dfj-emotion-aura','aria-hidden':true}), h('img', {src:ASSET + 'orb.png', alt:'深海中的鲸鱼娘'})),
              h('div', {className:'dfj-character-caption'}, h('span', {className:'dfj-eyebrow'}, '把心情，说给你听'), h('strong', null, name), h('p', null, call ? micMuted ? '我在呢，想说时再打开麦克风。' : '说完稍停片刻，我就会回答。' : '打字也好，说话也好，我都在。'),
                h('div', {className:'dfj-emotion-stamp',role:'status'}, h('span', null, tone ? '本句语气' : phase === 'synthesizing' ? '声音准备中' : '声音里的心情'), h('strong', null, phase === 'starting-playback' ? '正在启动声音播放' : phase === 'synthesizing' ? emotionalVoice ? '正在把心情放进声音里' : '正在准备这一句声音' : toneLabel)),
                h(Button, {icon:'volume',variant:'quiet',className:'dfj-voice-settings-entry',onClick:()=>{open('settings',nav.sessionId,'voice');}}, '声音与情绪')),
              h('div', {className:'dfj-voice-wave', 'aria-hidden':true}, ...Array.from({length:8}, (_, index)=>h('span', {key:index})))),
            h('section', {className:'dfj-dialogue-panel', 'data-expanded':readExpanded},
              h('div', {className:'dfj-dialogue-heading'},
                h('div', null, h('span', {className:'dfj-eyebrow'}, '此刻，和你在一起'), h('h2', null, '我们的对话'), tone && h('span', {className:'dfj-reply-tone','aria-label':'本句语气：' + tone.label}, h('i', {'aria-hidden':true}), tone.label)),
                h('div', {className:'dfj-reading-actions'},
                  h(Button, {icon:audioBusy ? 'player-pause' : 'player-play', variant:'quiet', 'aria-label':audioBusy ? '停止声音' : '重播回复', disabled:!audioBusy && !replayReady, title:lastReply?.text?.length > 4000 ? '这段回复较长，可以完整阅读和复制' : audioBusy ? '停止声音' : '重新听这条回复', onClick:()=>audioBusy ? haltAudio() : replayReady ? speak(lastReply.text) : undefined}, audioBusy ? '停止' : '重播'),
                  h(Button, {icon:copied ? 'check' : 'copy', variant:'quiet', 'aria-label':'复制回复', disabled:!lastReply?.text || running || sending, onClick:copyReply}, copied ? '已复制' : '复制'),
                  h(Button, {icon:readExpanded ? 'arrows-minimize' : 'arrows-maximize', variant:'quiet', 'aria-label':readExpanded ? '恢复沉浸布局' : '展开阅读', 'aria-pressed':readExpanded, onClick:()=>setReadExpanded(value=>!value)}, readExpanded ? '收起' : '展开'))),
              h('div', {className:'dfj-reply-scroll', ref:replyScroll, tabIndex:0, role:'region', 'aria-label':'当前对话'},
                lastUser && h('div', {className:'dfj-user-quote'}, h('span', null, '你刚刚说'), h('p', null, lastUser.text)),
                h('div', {className:'dfj-current-reply'}, h('span', {className:'dfj-eyebrow'}, running || sending ? '正在回应你' : name + '说'), h('p', {className:'dfj-reply-text'}, loading ? '正在走近你的海域…' : lastReply?.text || '主人，你来啦。今天也在这里陪着你。')),
                (phase === 'synthesizing' || phase === 'starting-playback') && h('div', {className:'dfj-voice-preparing',role:'status'}, h('span', {className:'dfj-voice-preparing-pulse','aria-hidden':true}), h('span', null, phase === 'starting-playback' ? '正在启动声音播放' : voiceWaitSeconds < 12 ? '正在准备这一句声音' : '声音还在准备，文字可以先看'), h('small', {'aria-hidden':true}, voiceWaitSeconds + ' 秒')),
                (running || sending) && h('div', {className:'dfj-thinking-dots', 'aria-hidden':true}, h('span'), h('span'), h('span'))),
              h('div', {className:'dfj-dialogue-footer'},
                h('div', {className:'dfj-session-line'}, h('span', null, currentSession?.title || '当前陪伴会话'), currentPreset && currentPreset !== 'whale' ? h(Button, {disabled:modeBusy || running, onClick:()=>switchMode(true)}, modeBusy ? '切换中…' : '开启鲸鱼娘模式') : h('span', {className:'dfj-dot-status'}, '鲸鱼娘模式')),
                h('form', {className:'dfj-composer', onSubmit:event=>{event.preventDefault();sendMessage(text);}},
                  h('div', {className:'dfj-composer-row'},
                    h('textarea', {ref:composer, value:text, rows:2, 'aria-label':'给鲸鱼娘发消息', placeholder:'想说什么，慢慢写给我…', onChange:event=>updateTextDraft(nav.sessionId,event.target.value), onKeyDown:event=>{if(event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing){event.preventDefault();sendMessage(text);}}}),
                    h(Button, {type:'submit', icon:'send', variant:'primary', disabled:!text.trim() || loading || modelBusy || sending || running || !nav.sessionId || !messagesReady || currentPreset !== 'whale', 'aria-label':'发送消息'}, '发送')),
                  modelControls()),
                h('div', {className:'dfj-call-controls'},
                  call ? h(Button, {icon:micMuted ? 'microphone-off' : 'microphone', className:'dfj-round-control' + (micMuted ? ' is-muted' : ''), onClick:()=>{setMicMuted(value=>!value);microphone.current?.reset();}, 'aria-pressed':micMuted}, micMuted ? '取消静音' : '静音') : h(Button, {icon:'microphone', className:'dfj-round-control', disabled:loading || currentPreset !== 'whale', onClick:startCall}, '开始语音'),
                  h(Button, {icon:readEnabled ? 'volume' : 'volume-off', className:'dfj-round-control', 'aria-pressed':!readEnabled, onClick:()=>{setReadEnabled(value=>!value);if(readEnabled)haltAudio();}}, readEnabled ? '暂停朗读' : '开启朗读'),
                  call && h(Button, {icon:'phone-off', className:'dfj-round-control dfj-hangup', onClick:()=>{endCall();haltAudio();}}, '结束语音'),
                  running && h(Button, {icon:'x', className:'dfj-round-control', onClick:async()=>{const id=nav.sessionId,generation=lifecycle.current;haltAudio();awaitingReply.current=false;try{await request('/stop',{sessionId:id});if(generation===lifecycle.current){setSending(false);sendGate.current=false;setPhase('idle');}}catch(error){if(generation===lifecycle.current)setError(errorText(error));}}}, '停止回复'),
                  h(Button, {icon:'message-circle', className:'dfj-round-control', 'aria-expanded':history, onClick:()=>setHistory(value=>!value)}, '对话记录')),
                h('p', {className:'dfj-call-hint', role:'status'}, copied ? '回复已复制到剪贴板。' : call ? '说完稍停片刻，麦克风和朗读可以分别开关。' : 'Enter 发送 · Shift + Enter 换行 · 也可以开启语音')))),
          history && h('aside', {className:'dfj-history', 'aria-label':'陪伴对话记录'},
            h('div', {className:'dfj-history-heading'}, h('h2', null, '我们的对话'), h(Button, {icon:'x', variant:'quiet', 'aria-label':'关闭对话记录', onClick:()=>setHistory(false)})),
            sessionSelect(), h('div', {className:'dfj-history-list'}, messages.length ? messages.map(message=>h('article', {className:'dfj-history-message', key:message.id, 'data-role':message.role}, h('strong', null, message.role === 'user' ? '你' : name), h('p', null, message.text))) : h('p', {className:'dfj-empty'}, '第一句话，从这里开始。'))));
      }
      if (!nav.view) return null;
      const content = h('div', {className: 'dfj-root'+(placement==='panel'?' dfj-panel-root':''), ref: root, role: placement==='panel'?'region':'dialog', 'aria-modal': placement==='panel'?undefined:true, 'aria-label': nav.view === 'settings' ? '大肥鱼配置中心' : nav.view === 'call' ? '大肥鱼语音通话' : '鲸鱼娘沉浸空间'}, nav.view === 'settings' ? settingsPage() : nav.view === 'call' ? callPage() : immersivePage(), (error || notice) && h('div', {className: 'dfj-banner ' + (error ? 'dfj-banner-error' : ''), role: error ? 'alert' : 'status'}, h('span', null, error || notice), h(Button, {icon: 'x', variant: 'quiet', 'aria-label': '关闭提示', onClick: () => { setError(''); setNotice(''); }})));
      return placement==='panel'?h('div',{className:'dfj-panel-host'},content):content;
    }
    return {
      inject: ['slots','layout'],
      apply(ctx) {
        mainLayout = ctx.layout || null;
        ctx.effect(() => {
          const onOpen = event => { if (event.detail && ['settings', 'immersive', 'call'].includes(event.detail.view)) open(event.detail.view==='call'?'call':'settings', event.detail.sessionId); };
          window.addEventListener('dafeiyu:open', onOpen);
          const onViewRequest = () => window.dispatchEvent(new CustomEvent('dafeiyu:view', {detail:{view:navigation.view}}));
          window.addEventListener('dafeiyu:view-request', onViewRequest); onViewRequest();
          const stylesheets = ['client.css?v=4', 'immersive.css?v=2', 'emotional.css?v=1', 'memory-graph.css?v=4', 'settings.css?v=2', 'call.css?v=1'].map(file => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ASSET + file; link.dataset.dafeiyu = 'styles'; document.head.appendChild(link); return link; });
          return () => { stopAudio(); open(null); mainLayout = null; window.removeEventListener('dafeiyu:open', onOpen); window.removeEventListener('dafeiyu:view-request', onViewRequest); stylesheets.forEach(link => link.remove()); listeners.clear(); audioStops.clear(); callReplyOwners.clear(); completedCallReplies.clear(); };
        });
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({name: 'shell.overlay', id: 'dsh-dafeiyu-dot'}, App));
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({name: 'conversation.session.header.actions', id: 'agent-preset', priority: -200, order: -10}, HeaderMode));
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({name: 'conversation.session.header.utilities', id: 'dsh-dafeiyu-dot', order: 5}, HeaderEntry));
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({name:'main',key:SETTINGS_PANEL_ID,inject:()=>({placement:'panel'})},App);
          const stopEntry = ctx.slots.register({name:'sidebar.panellist',id:SETTINGS_PANEL_ID,order:2,label:()=> '大肥鱼'},SidebarIcon);
          return () => { if(mainLayout?.panelInfo.getSnapshot().activePanelId===SETTINGS_PANEL_ID)mainLayout.selectPanel(null);stopEntry();stopMain(); };
        }));
      },
    };
  },
});
