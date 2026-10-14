#!/usr/bin/env node
import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repositoryRoot, pluginIds } from './plugin-contract.mjs'
import { createPreviewServer } from './dev-server.mjs'
import { installPreviewFixture } from './preview-fixture.mjs'
import { buildPlugin } from './build-plugin.mjs'
import { runMarketScenario } from './market-scenarios.mjs'
const requested = process.argv.slice(2).filter(value => !value.startsWith('--')), ids = requested.length ? requested : pluginIds()
if (process.argv.includes('--build')) for (const id of ids) await buildPlugin(id, { release: false, runtime: false })
const executablePath = process.env.CHROME_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
const browser = await chromium.launch({ executablePath, headless: true })
const { server, url } = await createPreviewServer()
const results = []
try {
  for (const id of ids) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' })
    const errors = [], resources = [], csp = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.status() >= 400) resources.push(`${response.status()} ${response.url()}`) })
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) csp.push(message.text()) })
    await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort())
    await page.addInitScript(installPreviewFixture, { pluginId: id, mode: id === 'com.enest.dsh' ? 'quick' : 'shell' })
    await page.goto(`${url}/plugins/${id}/index.html`, { waitUntil: 'networkidle' })
    await page.evaluate(() => window.__preview.enter()).catch(error => errors.push(error.message))
    const scenario = await runMarketScenario(page, id)
    await page.waitForTimeout(250)
    const destination = process.argv.includes('--check') ? join(repositoryRoot, 'dist/visuals', id) : join(repositoryRoot, 'plugins', id, 'public/assets/market/screenshots')
    await mkdir(destination, { recursive: true })
    await page.screenshot({ path: join(destination, '01-main.png'), fullPage: false })
    const sizes = []
    for (const [mode, width, height, font] of [['shell',720,420,13], ['shell',480,320,13], ['shell',960,640,13], ['quick',720,420,13], ['quick',480,320,13], ['shell',720,420,20]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(({ mode, font }) => { window.__preview.mode(mode); document.documentElement.style.setProperty('--font-size-base', font + 'px'); document.documentElement.style.fontSize = font + 'px' }, { mode, font }).catch(error => errors.push(error.message))
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const measurements = await page.evaluate(id => {
        const modeMarkers = [...document.querySelectorAll('[data-mode="quick"], [data-mode="shell"], [data-launch-mode], [data-surface="quick"], [data-surface="shell"]')].map(node => node.dataset.mode || node.dataset.launchMode || node.dataset.surface)
        if (id === 'com.enest.ccswitch') modeMarkers.push(document.body.classList.contains('quick-mode') ? 'quick' : 'shell')
        return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1, content: document.body.innerText.trim().length, modeMarkers }
      }, id)
      if ((!measurements.modeMarkers.length && !['com.example.hello', 'com.enest.theme-demo'].includes(id)) || measurements.modeMarkers.some(value => value !== mode)) errors.push(`Mode transition to ${mode} did not update the rendered surface: ${measurements.modeMarkers.join(',')}`)
      sizes.push({ mode, font, ...measurements })
    }
    results.push({ id, scenario, errors: [...new Set(errors)], resources: [...new Set(resources)], csp: [...new Set(csp)], sizes })
    console.log(`${errors.length || resources.length || csp.length ? 'FAIL' : 'OK'} ${id} ${errors.join('; ')}`)
    await page.close()
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
await mkdir(join(repositoryRoot, 'dist'), { recursive: true })
await writeFile(join(repositoryRoot, 'dist/visual-audit.json'), JSON.stringify({ fixtures: 'Isolated demonstration data; no user resources or real services', results }, null, 2))
if (results.some(item => item.errors.length || item.resources.length || item.csp.length || item.sizes.some(size => size.overflow || !size.content))) process.exitCode = 1
