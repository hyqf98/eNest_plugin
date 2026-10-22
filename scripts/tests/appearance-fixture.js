import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const hostRoot = fileURLToPath(new URL('../../../', import.meta.url))
const compiled = await build({
  stdin: { contents: 'export { BUILTIN_THEME_PACKS } from "./src/shared/theme/builtinThemes"; export { resolveAppearance, migrateAppearanceSettings, validateThemePackV2 } from "./src/shared/theme/appearance";', resolveDir: hostRoot },
  tsconfig: `${hostRoot}/tsconfig.node.json`, bundle: true, write: false, platform: 'node', format: 'esm',
})
const { BUILTIN_THEME_PACKS, resolveAppearance, migrateAppearanceSettings, validateThemePackV2 } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const defaultPack = BUILTIN_THEME_PACKS.find(pack => pack.id === 'default' && pack.source === 'enest.builtin')
if (!defaultPack) throw new Error('The host default appearance is unavailable')

const source = 'com.example.appearance.contract'
const variant = mode => ({
  tokens: mode === 'dark'
    ? { '--bg': '#172329', '--surface': '#1f3038', '--text': '#edf3f4', '--accent': '#80bdc9' }
    : { '--bg': '#eef2f3', '--surface': '#ffffff', '--text': '#17262a', '--accent': '#246d78' },
  fonts: { body: 'Avenir Next, PingFang SC, sans-serif', heading: 'Georgia, serif', mono: 'Menlo, monospace', scale: 1 },
  components: { controlRadius: 4, cardRadius: 6, panelRadius: 5, borderWidth: 1 },
  background: { media: null, effect: 'none', texture: 'none', intensity: .5, speed: 1, direction: 0 },
  layout: { variant: 'studio-board', density: .9, gap: 8, sidebarWidth: 240, contentWidth: 1200, columns: 4 },
  animation: 'low',
})

// This independent extension fixture tests the public contract, not another bundled theme.
const contractPack = validateThemePackV2({
  schemaVersion: 2, version: 1, id: 'contract-theme', name: 'Third-party contract fixture', mode: 'system', tokens: {},
  variants: { light: variant('light'), dark: variant('dark') },
  settings: { version: 2, groups: [{ id: 'layout', title: 'Contract spacing', fields: [
    { key: 'gap', label: 'Content gap', type: 'slider', default: 8, min: 0, max: 32, step: 1, binding: { target: 'layout', key: 'gap' } },
  ] }] },
  home: { source, id: 'dashboard', variant: 'studio-board' },
}, source)
const legacy = { theme: { mode: 'light', overrides: {} }, general: {} }

export const appearanceCases = ['default', 'contract']

export function snapshotFor(kind, mode, revision) {
  const pack = kind === 'default' ? defaultPack : kind === 'contract' ? contractPack : null
  if (!pack) throw new Error(`Unknown appearance test case: ${kind}`)
  const settings = migrateAppearanceSettings({ version: 2, revision, mode, active: { source: pack.source, id: pack.id }, profiles: {}, legacy }, legacy)
  return resolveAppearance({ settings, pack, systemDark: mode === 'dark', reducedMotion: true })
}
