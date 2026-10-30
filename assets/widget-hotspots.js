// Click regions describe the bundled 610 × 610 portrait in source-image coordinates.
export const REGIONS = Object.freeze({
  head: { label: '头部', center: [0.57, 0.34], polygon: [[0.18, 0.34], [0.35, 0.1], [0.81, 0.1], [1, 0.34], [0.94, 0.56], [0.24, 0.56]] },
  face: { label: '脸颊', center: [0.55, 0.69], ellipse: [0.55, 0.69, 0.31, 0.145] },
  tail: { label: '鱼鳍', center: [0.14, 0.66], polygon: [[0.06, 0.66], [0.24, 0.56], [0.28, 0.7], [0.23, 0.77], [0.08, 0.72]] },
})

export const DEFAULT_WIDGET_CONFIG = Object.freeze({
  enabled: true,
  soundEnabled: false,
  volume: 0.7,
  regions: {
    head: { audio: 'audio/head.wav', text: '嗯？主人，本鱼在呢。' },
    face: { audio: 'audio/face.wav', text: '哼，别戳本鱼的脸啦。' },
    tail: { audio: 'audio/tail.wav', text: '鱼鳍才不是拿来拽的，坏主人。' },
  },
})

function finite(value) { return typeof value === 'number' && Number.isFinite(value) }

export function normalizeWidgetConfig(value = {}) {
  const source = value?.config?.widget ?? value?.widget ?? value ?? {}
  const config = {
    enabled: source.enabled !== false,
    soundEnabled: source.soundEnabled === true,
    volume: finite(source.volume) ? Math.max(0, Math.min(1, source.volume)) : DEFAULT_WIDGET_CONFIG.volume,
    regions: {},
  }
  for (const key of Object.keys(REGIONS)) {
    const region = source.regions?.[key] ?? {}
    config.regions[key] = {
      audio: typeof region.audio === 'string' ? region.audio.slice(0, 400) : DEFAULT_WIDGET_CONFIG.regions[key].audio,
      text: typeof region.text === 'string' ? region.text.slice(0, 200) : DEFAULT_WIDGET_CONFIG.regions[key].text,
    }
  }
  return config
}

// The base widget uses object-fit: contain; object-position: right bottom.
export function imageContentRect(rect, naturalWidth = 610, naturalHeight = 610, flipped = false) {
  if (!rect || !finite(rect.left) || !finite(rect.top) || !(rect.width > 0) || !(rect.height > 0) || !(naturalWidth > 0) || !(naturalHeight > 0)) return null
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return { left: flipped ? rect.left : rect.left + rect.width - width, top: rect.top + rect.height - height, width, height }
}

export function normalizedPoint(clientX, clientY, rect, flipped = false, naturalWidth = 610, naturalHeight = 610) {
  if (!finite(clientX) || !finite(clientY)) return null
  const content = imageContentRect(rect, naturalWidth, naturalHeight, flipped)
  if (!content) return null
  const x = (clientX - content.left) / content.width
  const y = (clientY - content.top) / content.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x: flipped ? 1 - x : x, y }
}

function inPolygon(point, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if ((yi > point.y) !== (yj > point.y) && point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function regionAtPoint(point) {
  if (!point || !finite(point.x) || !finite(point.y)) return null
  for (const key of ['tail', 'face', 'head']) {
    const region = REGIONS[key]
    if (region.ellipse) {
      const [x, y, rx, ry] = region.ellipse
      if (((point.x - x) / rx) ** 2 + ((point.y - y) / ry) ** 2 <= 1) return key
    } else if (inPolygon(point, region.polygon)) return key
  }
  return null
}

export function regionFromImagePoint(event, image, flipped = false) {
  return regionAtPoint(normalizedPoint(event?.clientX, event?.clientY, image?.getBoundingClientRect(), flipped, image?.naturalWidth || 610, image?.naturalHeight || 610))
}

export function isClickGesture(gesture, end, threshold = 3) {
  if (!gesture || gesture.moved || !finite(gesture.startX) || !finite(gesture.startY) || !finite(end?.clientX) || !finite(end?.clientY)) return false
  const dx = end.clientX - gesture.startX
  const dy = end.clientY - gesture.startY
  return dx * dx + dy * dy < threshold * threshold
}

export function audioAssetUrl(audio, assetBase = '/dsh-dafeiyu-dot/assets') {
  if (typeof audio !== 'string' || !audio) return null
  const base = assetBase.replace(/\/$/, '')
  const relative = audio.startsWith(base + '/') ? audio.slice(base.length + 1) : audio
  if (!/^audio\/[a-zA-Z0-9_-]+\.(wav|mp3|ogg|m4a)$/.test(relative)) return null
  return base + '/' + relative
}

// One active voice. A later click stops the previous voice, including pending decode.
export function createClickVoiceController({ createSound, stopSound, onCaption = () => {}, onError = () => {}, assetBase, config } = {}) {
  let prefs = normalizeWidgetConfig(config)
  let current = null
  let revision = 0
  function stop(clearCaption = true) {
    revision++
    if (current) stopSound(current)
    current = null
    if (clearCaption) onCaption('')
  }
  function setConfig(value) {
    prefs = normalizeWidgetConfig(value)
    if (!prefs.enabled || !prefs.soundEnabled || prefs.volume === 0) stop(!prefs.enabled)
    else if (current) current.volume = prefs.volume
    return prefs
  }
  async function playRegion(key) {
    if (!prefs.enabled || !REGIONS[key]) return false
    stop(false)
    const token = revision
    const region = prefs.regions[key]
    onCaption(region.text, { region: key, label: REGIONS[key].label })
    if (!prefs.soundEnabled || prefs.volume === 0 || !region.audio) return true
    const url = audioAssetUrl(region.audio, assetBase)
    if (!url) { onError('挂件音频路径不可用'); return false }
    try {
      const sound = createSound(url)
      sound.volume = prefs.volume
      current = sound
      sound.onended = () => { if (current === sound) current = null }
      await sound.play()
      return token === revision
    } catch (error) {
      if (token !== revision) return false
      current = null
      onError('挂件语音暂不可用', error)
      return false
    }
  }
  return { playRegion, setConfig, stop, getConfig: () => normalizeWidgetConfig(prefs) }
}
