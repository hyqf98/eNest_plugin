/**
 * capture-plugin-ui.mjs — 插件 UI 视觉基线/对比截图工具
 * 用法:
 *   node scripts/capture-plugin-ui.mjs <pluginId> [outDir]            # {light,dark} × {shell,quick}
 * 对插件 vite 起 dev server，模拟宿主注入主题变量。
 * 依赖插件仓根 node_modules（vite / playwright-core），需 Chrome。
 */
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const [pluginId, output] = args
if (!pluginId || args.some(value => value.startsWith('--')) || args.length > 2) {
  console.error('usage: node scripts/capture-plugin-ui.mjs <pluginId> [outDir]')
  process.exit(1)
}
const outDir = output || `capture/${pluginId}`
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
const modes = ['shell', 'quick']
for (const mode of modes) {
  for (const theme of ['light', 'dark']) {
    const viewport = mode === 'quick' ? { width: 718, height: 480 } : { width: 980, height: 640 }
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
    page.on('pageerror', (err) => console.log(`[pageerror ${mode}/${theme}]`, String(err).slice(0, 200)))
    await page.goto(`${baseUrl}?mode=${mode}`, { waitUntil: 'networkidle' })
    try {
      await page.waitForSelector('#keypad button, .history-list .record, .error-boundary', { state: 'attached', timeout: 8000 })
    } catch {
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {})
      await page.waitForSelector('#keypad button, .history-list .record', { state: 'attached', timeout: 8000 }).catch(() => {
        console.log(`WARN: app script did not render for ${mode}/${theme}`)
      })
    }
    await page.evaluate(([m, t, tokens]) => {
      const root = document.documentElement
      root.dataset.mode = m
      root.dataset.theme = t
      root.style.colorScheme = t === 'dark' ? 'dark' : 'light'
      for (const [k, v] of Object.entries(tokens[t])) root.style.setProperty(k, v)
    }, [mode, theme, THEME_TOKENS])
    await page.waitForTimeout(700)
    const file = path.join(outDir, `${mode}-${theme}.png`)
    await page.screenshot({ path: file })
    console.log('saved', file)
    await page.close()
  }
}
await browser.close()
await server.close()
console.log('done ->', outDir)
