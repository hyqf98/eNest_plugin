import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
const port = Number(process.env.DB_UI_PORT || 4178)
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export default defineConfig({
  testDir: './scripts/tests', testMatch: '**/*.ui.js', timeout: 60000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, launchOptions: existsSync(chrome) ? { executablePath: chrome } : {}, trace: 'retain-on-failure' },
  webServer: { command: `PORT=${port} node scripts/dev-server.mjs`, url: `http://127.0.0.1:${port}/plugins/database/index.html`, reuseExistingServer: !process.env.CI }
})
