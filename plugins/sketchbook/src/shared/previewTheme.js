/** 样式台与开发预览共用本包 manifest，不维护第二套语义色、字体或组件参数。 */
export async function loadPreviewTheme(manifestUrl) {
  // 相对 HTML 而非脚本定位：源码与 Vite 的 assets/app 哈希脚本均读取包根 plugin.json。
  // build-plugin 会在构建完成后把 manifest 写到 dist/plugin.json，随包一起分发。
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error('无法读取本包 plugin.json')
  const manifest = await response.json()
  const pack = manifest.contributes?.themePacks?.find(item =>
    item.schemaVersion === 2 && item.source === manifest.id && item.id === 'sketchbook')
  if (!pack?.variants?.light || !pack.variants.dark) throw new Error('素描本缺少浅色或深色主题声明')
  return pack
}

/** 只生成本文档的预览快照；不注册、激活主题，也不写宿主 Profile。 */
export function createPreviewAppearance(pack, mode, revision = 0) {
  const colorMode = mode === 'dark' ? 'dark' : 'light'
  const variant = pack.variants[colorMode]
  return {
    ...variant,
    version: 2,
    revision,
    theme: { source: pack.source, id: pack.id, name: pack.name, version: pack.version, legacy: false },
    requestedMode: 'system',
    mode: colorMode,
    tokens: { ...pack.tokens, ...variant.tokens },
    animation: { requested: variant.animation, effective: variant.animation, continuous: variant.animation !== 'low' },
    home: pack.home,
    diagnostics: [],
  }
}
