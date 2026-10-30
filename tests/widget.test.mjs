import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  REGIONS, DEFAULT_WIDGET_CONFIG, normalizeWidgetConfig, imageContentRect,
  normalizedPoint, regionAtPoint, regionFromImagePoint, isClickGesture,
  audioAssetUrl, createClickVoiceController,
} from '../assets/widget-hotspots.js'
import { installWidget } from '../lib/widget.js'

const root = fileURLToPath(new URL('../', import.meta.url))

test('head, cheek and fin source points remain stable at multiple scales and both anchors', () => {
  for (const width of [60, 148, 375]) {
    const rect = { left: 113, top: 51, width, height: width }
    const image = { naturalWidth: 610, naturalHeight: 610, getBoundingClientRect: () => rect }
    for (const flipped of [false, true]) {
      for (const [key, value] of Object.entries(REGIONS)) {
        const [x, y] = value.center
        const event = { clientX: rect.left + (flipped ? 1 - x : x) * width, clientY: rect.top + y * width }
        assert.equal(regionFromImagePoint(event, image, flipped), key)
      }
    }
  }
  assert.equal(regionAtPoint({ x: 0, y: 0 }), null)
  assert.equal(regionAtPoint({ x: 0.6, y: 0.95 }), null)
})

test('object-fit contain respects letterboxing and mirrored right-bottom alignment', () => {
  const rect = { left: 100, top: 200, width: 200, height: 100 }
  for (const [flipped, left] of [[false, 200], [true, 100]]) {
    const content = imageContentRect(rect, 610, 610, flipped)
    assert.ok(Math.abs(content.left - left) < 1e-9)
    assert.ok(Math.abs(content.top - 200) < 1e-9)
    assert.ok(Math.abs(content.width - 100) < 1e-9)
    assert.ok(Math.abs(content.height - 100) < 1e-9)
  }
  assert.equal(normalizedPoint(150, 250, rect), null)
  const point = normalizedPoint(150, 250, rect, true)
  assert.ok(Math.abs(point.x - 0.5) < 1e-9 && Math.abs(point.y - 0.5) < 1e-9)
  assert.equal(normalizedPoint(NaN, 0, rect), null)
  assert.equal(normalizedPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }), null)
})

test('dragged, cancelled, or missing-coordinate gestures cannot become a click', () => {
  const start = { startX: 30, startY: 40, moved: false }
  assert.equal(isClickGesture(start, { clientX: 31, clientY: 41 }), true)
  assert.equal(isClickGesture(start, { clientX: 33, clientY: 40 }), false)
  assert.equal(isClickGesture({ ...start, moved: true }, { clientX: 30, clientY: 40 }), false)
  assert.equal(isClickGesture(start, {}), false)
})

test('preferences expose only widget controls and media stays within the bundled audio directory', () => {
  const config = normalizeWidgetConfig({ widget: { volume: 9, regions: { face: { text: '主人。', audio: 'audio/face.wav' } } }, apiKey: 'private-value' })
  assert.equal(config.volume, 1)
  assert.equal(config.regions.face.text, '主人。')
  assert.equal(config.regions.head.audio, 'audio/head.wav')
  assert.equal('apiKey' in config, false)
  assert.equal(audioAssetUrl('/dsh-dafeiyu-dot/assets/audio/head.wav'), '/dsh-dafeiyu-dot/assets/audio/head.wav')
  for (const value of ['https://remote/audio.wav', 'audio/../config.json', 'audio/%2e%2e/key.wav', '/etc/passwd', 'audio/a.wav?token=x']) assert.equal(audioAssetUrl(value), null)
})

test('rapid region clicks replace the active voice and pending starts cannot report success', async () => {
  const events = []
  const starts = []
  const captions = []
  const controller = createClickVoiceController({
    config: {soundEnabled: true},
    createSound(url) {
      const sound = { url, play() { events.push('play:' + url); return new Promise(resolve => starts.push(resolve)) } }
      return sound
    },
    stopSound(sound) { events.push('stop:' + sound.url) },
    onCaption(text) { captions.push(text) },
  })
  const first = controller.playRegion('head')
  const second = controller.playRegion('face')
  assert.deepEqual(events.map(value => value.split(':')[0]), ['play', 'stop', 'play'])
  assert.equal(captions.at(-1), DEFAULT_WIDGET_CONFIG.regions.face.text)
  starts[0](); starts[1]()
  assert.equal(await first, false)
  assert.equal(await second, true)
  controller.stop()
  assert.equal(captions.at(-1), '')
})

test('muting stops the current audio; muted clicks still show the matching Chinese caption', async () => {
  const events = []
  let caption
  const controller = createClickVoiceController({
    config: {soundEnabled: true},
    createSound: () => ({ play: async () => { events.push('play') } }),
    stopSound: () => events.push('stop'), onCaption: value => { caption = value },
  })
  await controller.playRegion('head')
  controller.setConfig({ soundEnabled: false })
  await controller.playRegion('tail')
  assert.deepEqual(events, ['play', 'stop'])
  assert.equal(caption, DEFAULT_WIDGET_CONFIG.regions.tail.text)
  controller.setConfig({ enabled: false })
  assert.equal(await controller.playRegion('face'), false)
  assert.equal(caption, '')
})

test('unavailable voice reports a visible error while leaving region and accounting interaction available', async () => {
  const errors = []
  const controller = createClickVoiceController({
    config: {soundEnabled: true},
    createSound: () => ({ play: async () => { throw new Error('decode unavailable') } }),
    stopSound: () => {}, onError: message => errors.push(message),
  })
  assert.equal(await controller.playRegion('head'), false)
  assert.deepEqual(errors, ['挂件语音暂不可用'])
  assert.equal(controller.getConfig().enabled, true)
})

test('owning context installs once; configuration callback cannot leak other plugin settings', () => {
  const calls = []
  let disposeCount = 0
  const ctx = { plugin: (plugin, options) => { calls.push({ plugin, options }); return { dispose() { disposeCount++ } } }, effect() {} }
  const first = installWidget(ctx, { getConfig: () => ({ widget: { soundEnabled: false }, tts: { apiKey: 'private-value' } }) })
  assert.equal(installWidget(ctx), first)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.getConfig().soundEnabled, false)
  assert.equal('tts' in calls[0].options.getConfig(), false)
  first.dispose(); first.dispose()
  assert.equal(disposeCount, 1)
})

test('pinned accounting attribution and manual sound defaults are available', () => {
  const packageJson = JSON.parse(readFileSync(root + 'vendor/widget/package.json'))
  assert.equal(packageJson.version, '0.4.2')
  assert.equal(packageJson.name, 'dsh-whale-widget')
  for (const file of ['LICENSE', 'PROVENANCE.md', 'lib/accounting.mjs', 'assets/DSniang1.png']) assert.ok(existsSync(root + 'vendor/widget/' + file))
  assert.equal(DEFAULT_WIDGET_CONFIG.soundEnabled,false)
  assert.equal(normalizeWidgetConfig({soundEnabled:true}).soundEnabled,true)
})

function panelVisibilityFixture({ enabled = true, currentView } = {}) {
  const script = readFileSync(root + 'vendor/widget/assets/whale-widget.js', 'utf8')
  const start = script.indexOf('function installDotPanelVisibility(')
  const end = script.indexOf('// Region interaction extends', start)
  assert.ok(start >= 0 && end > start)
  class ViewEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
  const install = runInNewContext('(' + script.slice(start, end).trim() + ')', { CustomEvent: ViewEvent })
  const listeners = new Map()
  const target = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event) },
  }
  const emitView = view => target.dispatchEvent(new ViewEvent('dafeiyu:view', { detail: { view } }))
  let requests = 0, stops = 0
  if (currentView !== undefined) target.addEventListener('dafeiyu:view-request', () => { requests++; emitView(currentView) })
  const prefs = { enabled }, dimensions = { left: 718, top: 405, width: 375, height: 375 }, writes = []
  const style = new Proxy({ display: '', visibility: '', pointerEvents: '', left: '718px', top: '405px', right: 'auto', bottom: 'auto', transform: 'scaleX(-1)' }, {
    set(object, key, value) { writes.push(key); object[key] = value; return true },
  })
  const element = {
    style, inert: false,
    get offsetWidth() { return style.display === 'none' ? 0 : dimensions.width },
    get offsetHeight() { return style.display === 'none' ? 0 : dimensions.height },
    getBoundingClientRect() {
      const width = this.offsetWidth, height = this.offsetHeight
      return { left: width ? dimensions.left : 0, top: height ? dimensions.top : 0, width, height, right: width ? dimensions.left + width : 0, bottom: height ? dimensions.top + height : 0 }
    },
  }
  const mount = () => install(element, target, () => prefs, () => { stops++ })
  return { prefs, element, target, emitView, mount, listeners, writes, get requests() { return requests }, get stops() { return stops } }
}

test('full-screen settings and immersive views hide the widget, stop its audio and restore the workspace', () => {
  const fixture = panelVisibilityFixture(), binding = fixture.mount()
  assert.equal(binding.isVisible(), true)
  fixture.emitView('settings')
  assert.equal(binding.isVisible(), false)
  assert.equal(fixture.element.style.visibility, 'hidden')
  assert.equal(fixture.element.style.pointerEvents, 'none')
  assert.equal(fixture.element.inert, true)
  assert.equal(fixture.prefs.enabled, true)
  assert.ok(fixture.stops > 0)
  // A configuration refresh while the page is open cannot reveal the widget.
  fixture.prefs.volume = 0.4; binding.refresh()
  assert.equal(binding.isVisible(), false)
  fixture.emitView('immersive'); binding.refresh()
  assert.equal(binding.isVisible(), false)
  fixture.emitView(null)
  assert.equal(binding.isVisible(), true)
  assert.equal(fixture.element.style.visibility, '')
  assert.equal(fixture.element.style.pointerEvents, '')
  assert.equal(fixture.element.inert, false)
  binding.dispose()
})

test('disabled preference stays hidden across panel close and updates during an open panel', () => {
  const fixture = panelVisibilityFixture({ enabled: false }), binding = fixture.mount()
  fixture.emitView('settings'); fixture.emitView(null)
  assert.equal(binding.isVisible(), false)
  assert.equal(fixture.prefs.enabled, false)
  fixture.emitView('immersive')
  fixture.prefs.enabled = true; binding.refresh()
  assert.equal(binding.isVisible(), false)
  fixture.emitView(null)
  assert.equal(binding.isVisible(), true)
  fixture.prefs.enabled = false; binding.refresh()
  assert.equal(binding.isVisible(), false)
  binding.dispose()
})

test('late widget load requests and receives the already-active plugin view', () => {
  const fixture = panelVisibilityFixture({ currentView: 'immersive' }), binding = fixture.mount()
  assert.equal(fixture.requests, 1)
  assert.equal(binding.isVisible(), false)
  assert.equal(fixture.element.style.visibility, 'hidden')
  fixture.emitView(null)
  assert.equal(binding.isVisible(), true)
  binding.dispose()
})

test('the call view hides accounting without changing its enabled preference and restores on hangup navigation', () => {
  const fixture = panelVisibilityFixture({ currentView: 'call' }), binding = fixture.mount()
  assert.equal(binding.isVisible(), false)
  assert.equal(fixture.element.inert, true)
  assert.equal(fixture.prefs.enabled, true)
  fixture.emitView('settings'); binding.refresh()
  assert.equal(binding.isVisible(), false)
  fixture.emitView('call'); binding.refresh()
  assert.equal(binding.isVisible(), false)
  fixture.emitView(null)
  assert.equal(binding.isVisible(), true)
  assert.equal(fixture.element.inert, false)
  assert.equal(fixture.prefs.enabled, true)
  binding.dispose()
})

test('repeated mount and cleanup release view listeners and late refresh cannot revive an unloaded widget', () => {
  const fixture = panelVisibilityFixture()
  for (let index = 0; index < 5; index++) {
    const binding = fixture.mount()
    assert.equal(fixture.listeners.get('dafeiyu:view').size, 1)
    fixture.emitView('settings')
    binding.dispose(); binding.dispose()
    assert.equal(fixture.listeners.get('dafeiyu:view').size, 0)
    fixture.emitView(null); binding.refresh()
    assert.equal(binding.isVisible(), false)
    assert.equal(fixture.element.style.visibility, 'hidden')
    assert.equal(fixture.element.inert, true)
  }
  assert.equal(fixture.prefs.enabled, true)
})

test('hidden panels retain measurable dimensions and preserve the existing position and anchors', () => {
  const fixture = panelVisibilityFixture(), binding = fixture.mount()
  const originalRect = fixture.element.getBoundingClientRect()
  const originalPosition = Object.fromEntries(['left', 'top', 'right', 'bottom', 'transform'].map(key => [key, fixture.element.style[key]]))
  for (const view of ['settings', 'call', 'immersive', null, 'settings', null]) {
    fixture.emitView(view)
    binding.refresh()
    assert.equal(fixture.element.offsetWidth, 375)
    assert.equal(fixture.element.offsetHeight, 375)
    assert.deepEqual(fixture.element.getBoundingClientRect(), originalRect)
    assert.deepEqual(Object.fromEntries(Object.keys(originalPosition).map(key => [key, fixture.element.style[key]])), originalPosition)
  }
  assert.equal(fixture.writes.includes('display'), false)
  assert.equal(fixture.writes.some(key => Object.hasOwn(originalPosition, key)), false)
  binding.dispose()
})

test('independent disable and re-enable retain widget geometry without restoring a hard-coded location', () => {
  const fixture = panelVisibilityFixture({ enabled: false }), binding = fixture.mount()
  const originalRect = fixture.element.getBoundingClientRect()
  assert.equal(fixture.element.style.visibility, 'hidden')
  assert.equal(fixture.element.offsetWidth, 375)
  fixture.prefs.enabled = true; binding.refresh()
  assert.equal(binding.isVisible(), true)
  assert.deepEqual(fixture.element.getBoundingClientRect(), originalRect)
  assert.equal(fixture.element.style.left, '718px')
  assert.equal(fixture.element.style.top, '405px')
  assert.equal(fixture.writes.includes('display'), false)
  binding.dispose()
})

function nativeSoundFixture(playBehavior = () => Promise.resolve()) {
  const script = readFileSync(root + 'vendor/widget/assets/whale-widget.js', 'utf8')
  const stopStart = script.indexOf('function dshwvSoundStop('), stopEnd = script.indexOf('function dshwvStopAllSounds(', stopStart)
  const createStart = script.indexOf('function createDotNativeSound('), createEnd = script.indexOf('// v766', createStart)
  assert.ok(stopStart >= 0 && stopEnd > stopStart && createStart >= 0 && createEnd > createStart)
  const registry = new Set(), instances = []
  class FakeAudio {
    constructor() { this.listeners = new Map(); this.src = ''; this.preload = ''; this.volume = 1; this.currentTime = 0; this.paused = true; this.pauseCalls = 0; this.loadCalls = 0; this.playCalls = 0; instances.push(this) }
    play() { this.playCalls++; this.paused = false; return playBehavior(this) }
    pause() { this.pauseCalls++; this.paused = true }
    load() { this.loadCalls++ }
    removeAttribute(name) { if (name === 'src') this.src = '' }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn) }
    dispatch(name) { for (const fn of this.listeners.get(name) ?? []) fn({ type: name, target: this }); this['on' + name]?.({ type: name, target: this }) }
  }
  // No AudioContext or decode API is present in this production-helper runtime.
  const context = { Audio: FakeAudio, dshwvAllSounds: registry, Promise, Error }
  const createSound = runInNewContext('(' + script.slice(createStart, createEnd).trim() + ')', context)
  const stopSound = runInNewContext('(' + script.slice(stopStart, stopEnd).trim() + ')', context)
  return { createSound, stopSound, registry, instances }
}

test('bundled region media uses HTMLAudio and its play promise waits for actual native startup', async () => {
  let start
  const fixture = nativeSoundFixture(() => new Promise(resolve => { start = resolve }))
  const sound = fixture.createSound('/dsh-dafeiyu-dot/assets/audio/head.wav')
  assert.equal(sound.preload, 'auto')
  assert.equal(sound.src, '/dsh-dafeiyu-dot/assets/audio/head.wav')
  let resolved = false
  const playing = sound.play().then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false)
  assert.equal(fixture.registry.has(sound), true)
  start(); await playing
  assert.equal(resolved, true)
  sound.dispatch('ended')
  assert.equal(fixture.registry.size, 0)
})

test('HTMLAudio playback rejection reaches the region error feedback and releases the registry', async () => {
  const fixture = nativeSoundFixture(() => Promise.reject(new Error('output device unavailable'))), errors = []
  const controller = createClickVoiceController({ ...fixture, onError: message => errors.push(message), config: { soundEnabled: true, volume: 0.35 } })
  assert.equal(await controller.playRegion('face'), false)
  assert.deepEqual(errors, ['挂件语音暂不可用'])
  assert.equal(fixture.registry.size, 0)
  assert.equal(fixture.instances[0].volume, 0.35)
})

test('rapid native region clicks cancel pending startup, clear the old source and keep one active voice', async () => {
  const starts = [], fixture = nativeSoundFixture(() => new Promise(resolve => starts.push(resolve))), errors = []
  const controller = createClickVoiceController({ ...fixture, config: {soundEnabled: true}, onError: message => errors.push(message) })
  const first = controller.playRegion('head'), old = fixture.instances[0]
  const second = controller.playRegion('tail'), current = fixture.instances[1]
  assert.equal(old.paused, true)
  assert.equal(old.src, '')
  assert.equal(old.loadCalls, 1)
  assert.equal(fixture.registry.has(old), false)
  assert.equal(fixture.registry.has(current), true)
  starts[0](); starts[1]()
  assert.equal(await first, false)
  assert.equal(await second, true)
  assert.deepEqual(errors, [])
  controller.setConfig({ soundEnabled: true, volume: 0.2 })
  assert.equal(current.volume, 0.2)
  controller.stop()
  assert.equal(current.paused, true)
  assert.equal(current.src, '')
  assert.equal(current.loadCalls, 1)
  assert.equal(fixture.registry.size, 0)
})

test('unified stopping handles native elements and legacy buffer sounds through their respective lifecycles', async () => {
  const fixture = nativeSoundFixture(), native = fixture.createSound('/dsh-dafeiyu-dot/assets/audio/head.wav')
  await native.play()
  let legacyStops = 0
  const legacy = { _token: 0, _node: { stop() { legacyStops++ } }, _playingSince: 3 }
  fixture.registry.add(legacy)
  Array.from(fixture.registry).forEach(fixture.stopSound)
  assert.equal(native.paused, true)
  assert.equal(native.src, '')
  assert.equal(native.loadCalls, 1)
  assert.equal(legacyStops, 1)
  assert.equal(legacy._node, null)
  assert.equal(fixture.registry.size, 0)
})
