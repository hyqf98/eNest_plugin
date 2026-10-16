import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'

const root = new URL('../../plugins/', import.meta.url)
function load(relative, name) {
  const context = vm.createContext({ structuredClone })
  vm.runInContext(readFileSync(new URL(relative, root), 'utf8'), context)
  return context[name]
}
/** editor-core.js React 迁移后带 ESM 命名导出，vm 不支持 export 语法，走动态 import */
async function loadEsm(relative) {
  return import(pathToFileURL(fileURLToPath(new URL(relative, root))).href)
}
const color = load('color-picker/src/js/color-math.js', 'ColorMath')
const editor = await loadEsm('screen-assistant/src/js/editor-core.js')
const plain = (value) => JSON.parse(JSON.stringify(value))

test('CSS colors support shorthand alpha HEX and modern RGB/HSL syntax', () => {
  assert.deepEqual(plain(color.parse('#ABC')), { r: 170, g: 187, b: 204, a: 1 })
  assert.equal(color.hex(color.parse('#0f08')), '#00FF0088')
  assert.equal(color.hex(color.parse('rgb(100% 0% 0% / 50%)')), '#FF000080')
  assert.equal(color.hex(color.parse('hsl(.5turn 100% 50% / .25)')), '#00FFFF40')
  assert.equal(color.hex(color.parse('hsla(-120, 100%, 50%, 1)')), '#0000FF')
  assert.equal(color.rgb(color.parse('#12345680')), 'rgba(18, 52, 86, 0.502)')
  assert.equal(color.hsl(color.parse('#FF0000')), 'hsl(0, 100%, 50%)')
})

test('invalid color input is rejected instead of being silently interpreted', () => {
  for (const value of ['#12345', '#GGGGGG', 'rgb(256,0,0)', 'rgb(0, 0, 0, 3)', 'hsl(120,20,30)', 'hsl(120,101%,20%)', 'rgb(0,0,NaN)', 'var(--accent)', 'rgb(10deg 0 0)', 'rgba(0,0,0,10deg)', '']) assert.equal(color.parse(value), null, value)
})

test('contrast follows WCAG linear luminance including alpha composition', () => {
  assert.equal(color.contrast(color.parse('#000'), color.parse('#fff')), 21)
  assert.equal(color.contrast(color.parse('#fff'), color.parse('#fff')), 1)
  assert.equal(color.contrast(color.parse('transparent'), color.parse('#fff')), 1)
  const ratio = color.contrast(color.parse('rgba(0,0,0,.5)'), color.parse('#fff'))
  assert.ok(ratio > 3.9 && ratio < 4.1)
  assert.equal(color.contrast(color.parse('#000'), color.parse('transparent')), 21)
})

test('palette CSS generates valid stable variable names and preserves alpha', () => {
  const css = color.cssPalette('我的色板', [{ color: color.parse('#F008') }, { color: color.parse('#fff') }])
  assert.match(css, /--palette-1: rgba\(255, 0, 0, 0\.533\)/)
  assert.match(css, /--palette-2: rgb\(255, 255, 255\)/)
})

test('crop rectangle is normalized and constrained to image pixel bounds', () => {
  assert.deepEqual(plain(editor.selection({ x: 80, y: 50 }, { x: -5, y: 200 }, 100, 80)), { x: 0, y: 50, width: 80, height: 30 })
  assert.deepEqual(plain(editor.selection({ x: 12, y: 12 }, { x: 12, y: 12 }, 100, 80)), { x: 12, y: 12, width: 0, height: 0 })
})

test('undo/redo preserves original commands and branches after undo', () => {
  const history = new editor.EditHistory(3)
  const arrow = { type: 'arrow', start: { x: 1, y: 2 } }
  history.push(arrow); arrow.start.x = 900
  history.push({ type: 'crop' }); history.push({ type: 'mosaic' })
  assert.equal(history.push({ type: 'text' }), false)
  assert.equal(history.current()[0].start.x, 1)
  history.undo(); assert.equal(history.canRedo, true)
  history.redo(); assert.equal(history.cursor, 3)
  history.undo(); history.push({ type: 'rect' })
  assert.equal(history.canRedo, false); assert.equal(history.current()[2].type, 'rect')
  history.clear(); assert.equal(history.canUndo, false); assert.equal(history.canRedo, false)
})

test('elapsed recording duration handles hours and negative input', () => {
  assert.equal(editor.elapsed(0), '00:00')
  assert.equal(editor.elapsed(-12), '00:00')
  assert.equal(editor.elapsed(3661000), '1:01:01')
})

test('visual tools declare real entry settings and portable shared assets', async () => {
  for (const id of ['color-picker', 'screen-assistant']) {
    const manifest = JSON.parse(readFileSync(new URL(`${id}/plugin.json`, root), 'utf8'))
    assert.ok(manifest.contributes.settings[0].items.length >= 3)
    const entry = readFileSync(new URL(`${id}/src/entry.js`, root), 'utf8')
    // React 化后的级联契约：业务 CSS 必须先于 plugin-kit CSS（SOP「CSS 级联顺序」）
    assert.ok(entry.indexOf("import './css/main.css'") < entry.indexOf("import '@enest/plugin-kit/style.css'"))
    assert.match(entry, /@enest\/plugin-kit\/style.css/)
    assert.match(entry, /jsx\/App\.jsx/)
    const app = readFileSync(new URL(`${id}/src/jsx/App.jsx`, root), 'utf8')
    assert.match(app, /kit\.onMode|onModeChange/)
    assert.match(app, /kit\.onSettings|onSettings/)
    assert.ok(!app.includes('window.confirm('))
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`${id}/src/entry.js`, root))])
  }
})
