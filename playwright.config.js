import { defineConfig } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
const port = Number(process.env.DB_UI_PORT || 4178)
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const pluginProjects = readdirSync(new URL('./plugins/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(new URL(`./plugins/${entry.name}/tests/`, import.meta.url)))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map(entry => ({ name: entry.name, testDir: `./plugins/${entry.name}/tests` }))
export default defineConfig({
  projects: [{ name: 'shared', testDir: './scripts/tests' }, ...pluginProjects],
  testMatch: '**/*.ui.js',
  testIgnore: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/release/**', '**/.cache/**', '**/.git/**'],
  timeout: 60000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, launchOptions: existsSync(chrome) ? { executablePath: chrome } : {}, trace: 'retain-on-failure' },
  webServer: { command: `PORT=${port} node scripts/dev-server.mjs`, url: `http://127.0.0.1:${port}/plugins/database/index.html`, reuseExistingServer: !process.env.CI }
})
