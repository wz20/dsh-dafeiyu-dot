import widgetPlugin from '../vendor/widget/lib/index.js'
import { normalizeWidgetConfig } from '../assets/widget-hotspots.js'

const installations = new WeakMap()

/** Mount the bundled accounting implementation once in this owning context. */
export function installWidget(ctx, { getConfig = () => ({}), assetBase = '/dsh-dafeiyu-dot/assets', configUrl = '/dsh-dafeiyu-dot/widget' } = {}) {
  if (installations.has(ctx)) return installations.get(ctx)
  const plugin = ctx.plugin(widgetPlugin, { getConfig: () => normalizeWidgetConfig(getConfig()), assetBase, configUrl })
  let disposed = false
  const installation = {
    plugin,
    dispose() {
      if (disposed) return
      disposed = true
      installations.delete(ctx)
      return typeof plugin?.dispose === 'function' ? plugin.dispose() : undefined
    },
  }
  installations.set(ctx, installation)
  ctx.effect?.(() => () => { installations.delete(ctx) })
  return installation
}
