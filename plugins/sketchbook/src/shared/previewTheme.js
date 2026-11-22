/** 样式台与开发预览共用本包 manifest，不维护第二套语义色、字体或组件参数。 */
export async function loadPreviewTheme() {
  // Vite 把 JSON 转成 ES 模块（dev 走 ?import，build 时内联），所以不能再声明
  // `with { type: 'json' }`：那会让浏览器按严格 JSON 模块校验 MIME，而 dev 服务返回
  // text/javascript，整条 import 会被拒绝。安装后的页面同样不 fetch 包元数据。
  const { default: manifest } = await import('../../plugin.json')
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
