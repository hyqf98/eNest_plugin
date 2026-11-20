/**
 * capture-plugin-ui.mjs — 插件 UI 视觉基线/对比截图工具
 * 用法:
 *   node scripts/capture-plugin-ui.mjs <pluginId> [outDir]            # {light,dark} × {shell,quick}
 *   node scripts/capture-plugin-ui.mjs <pluginId> [outDir] --panel     # 只截 panel 小组件图（按 views.panel.size）
 *   node scripts/capture-plugin-ui.mjs <pluginId> [outDir] --panel --write
 *       直接写入插件包的 public/assets/market/screenshots/panel.png（用于声明 views.panel.preview）
 * 对插件 vite 起 dev server，模拟宿主注入主题变量。
 * 依赖插件仓根 node_modules（vite / playwright-core），需 Chrome。
 */
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPreviewFixture } from './preview-fixture.mjs'

const args = process.argv.slice(2)
const flags = new Set(args.filter(arg => arg.startsWith('--')))
const positional = args.filter(arg => !arg.startsWith('--'))
const pluginId = positional[0]
if (!pluginId) {
  console.error('usage: node scripts/capture-plugin-ui.mjs <pluginId> [outDir] [--panel] [--write]')
  process.exit(1)
}
/** --panel：只截小组件形态，视口取 manifest 的 views.panel.size（缺省 320×260） */
const panelOnly = flags.has('--panel')
/** --write：把 panel 图直接写进插件包，供 views.panel.preview 引用 */
const writeToPackage = flags.has('--write')
const outDir = positional[1] || `capture/${pluginId}`
mkdirSync(outDir, { recursive: true })

const here = path.dirname(path.resolve(fileURLToPath(import.meta.url)))
const pluginRoot = path.join(here, '..', 'plugins', pluginId)
if (!existsSync(pluginRoot)) {
  console.error(`plugin not found: ${pluginRoot}`)
  process.exit(1)
}

const server = await createServer({
  // 不设 configFile:false —— 插件自带 vite.config.js（如 JSX automatic）需要生效；
  // 无 config 的 vanilla 插件自然跳过。
  root: pluginRoot,
  base: './',
  server: { port: 0 },
})
await server.listen()
const baseUrl = Array.isArray(server.resolvedUrls?.local) ? server.resolvedUrls.local[0] : server.resolvedUrls.local
console.log('dev server:', baseUrl)

const executablePath =
  process.env.ENEST_CHROME_PATH ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
if (!executablePath) { console.error('no chromium executable'); process.exit(1) }

/** 模拟宿主 themeAware 注入的标准 token（与 docs/developer/ui-standard.md token 表一致） */
const THEME_TOKENS = {
  light: {
    '--bg': '#f6f7f9', '--surface': '#ffffff', '--surface-2': '#f0f2f5', '--text': '#252a32', '--text-2': '#747c88',
    '--border': '#d9dfe6', '--line': '#d9dfe6', '--accent': '#bd542b', '--accent-soft': 'rgba(189,84,43,.12)',
    '--accent-contrast': '#ffffff', '--warn': '#b07c2a', '--danger': '#b44c50', '--ok': '#3e9c61',
  },
  dark: {
    '--bg': '#1c2129', '--surface': '#252b35', '--surface-2': '#2c333f', '--text': '#e8ecf2', '--text-2': '#98a2b0',
    '--border': '#3a4250', '--line': '#3a4250', '--accent': '#e0763f', '--accent-soft': 'rgba(224,118,63,.16)',
    '--accent-contrast': '#1c2129', '--warn': '#d9a441', '--danger': '#e07a7e', '--ok': '#5cb87e',
  },
}

const browser = await chromium.launch({ executablePath })
let failed = 0
// 小组件视口：优先 manifest 声明的 views.panel.size（与宿主添加组件时的初始尺寸一致），
// 缺省回落到 320×260（与多数 panel 插件声明值同档）。
function panelViewport() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'))
    const size = manifest?.views?.panel?.size
    if (Number.isFinite(size?.width) && Number.isFinite(size?.height) && size.width > 0 && size.height > 0) {
      return { width: Math.round(size.width), height: Math.round(size.height) }
    }
  } catch { /* 用缺省尺寸 */ }
  return { width: 320, height: 260 }
}

const modes = panelOnly ? ['panel'] : ['shell', 'quick']
for (const mode of modes) {
  for (const theme of ['light', 'dark']) {
    // panel 只截浅色：首页「小组件」区块是浅色上下文，深色图没有使用场景。
    if (panelOnly && theme === 'dark') continue
    const viewport = mode === 'panel' ? panelViewport()
      : mode === 'quick' ? { width: 718, height: 480 } : { width: 980, height: 640 }
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
    page.on('pageerror', (err) => console.log(`[pageerror ${mode}/${theme}]`, String(err).slice(0, 200)))
    // panel 模式注入宿主 API fixture：没有它插件会走「请更新 eNest」降级分支，
    // 截图里会出现错误气泡盖住主体。fixture 是隔离的假数据，不碰真实文件/网络。
    if (panelOnly) await page.addInitScript(installPreviewFixture, { pluginId, mode: 'panel' })
    await page.goto(`${baseUrl}?mode=${mode}`, { waitUntil: 'networkidle' })
    // 等待业务 JS 真正执行。
    // panel 模式没有统一的选择器（每个插件的小组件结构不同），
    // 用「body 有可见子元素」+ 固定等待代替；shell/quick 仍用 calculator 的探针。
    if (panelOnly) {
      await page.waitForFunction(() => {
        const root = document.getElementById('root') ?? document.body
        return root && root.children.length > 0 && root.getBoundingClientRect().height > 40
      }, { timeout: 8000 }).catch(() => {
        console.log(`WARN: panel content did not render for ${pluginId}`)
      })
    } else {
      try {
        await page.waitForSelector('#keypad button, .history-list .record, .error-boundary', { state: 'attached', timeout: 8000 })
      } catch {
        await page.reload({ waitUntil: 'networkidle' }).catch(() => {})
        await page.waitForSelector('#keypad button, .history-list .record', { state: 'attached', timeout: 8000 }).catch(() => {
          console.log(`WARN: app script did not render for ${mode}/${theme}`)
        })
      }
    }
    await page.evaluate(([m, t, tokens]) => {
      const root = document.documentElement
      root.dataset.mode = m
      root.dataset.theme = t
      root.style.colorScheme = t === 'dark' ? 'dark' : 'light'
      for (const [k, v] of Object.entries(tokens[t])) root.style.setProperty(k, v)
    }, [mode, theme, THEME_TOKENS])
    await page.waitForTimeout(700)
    // panel 模式固定命名 panel.png 并可直接写进插件包：
    // 声明 views.panel.preview 时必须与文件名一致，构建期会校验它真实存在。
    const file = panelOnly && writeToPackage
      ? path.join(pluginRoot, 'public', 'assets', 'market', 'screenshots', 'panel.png')
      : path.join(outDir, mode === 'panel' ? 'panel.png' : `${mode}-${theme}.png`)
    if (panelOnly && writeToPackage) mkdirSync(path.dirname(file), { recursive: true })
    await page.screenshot({ path: file })
    console.log('saved', file)
    await page.close()
  }
}
await browser.close()
await server.close()
console.log('done ->', outDir)
