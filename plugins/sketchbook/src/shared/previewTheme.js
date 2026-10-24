/** 样式台与开发预览共用本包 manifest，不维护第二套语义色、字体或组件参数。 */
export async function loadPreviewTheme() {
  // Vite bundles the source manifest into assets/app; installed pages cannot fetch package metadata.
  const { default: manifest } = await import('../../plugin.json', { with: { type: 'json' } })
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
