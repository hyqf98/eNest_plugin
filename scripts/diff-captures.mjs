/**
 * 像素级对比两组截图：node ui-diff.tmp.mjs /tmp/ui-before /tmp/ui-after
 * 输出每张图的差异像素比例与差异区域 bbox，阈值 0.5% 判定通过。
 */
import { chromium } from 'playwright-core'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const [dirA, dirB] = [process.argv[2], process.argv[3]]
if (!dirA || !dirB) { console.error('usage: node ui-diff.tmp.mjs <dirA> <dirB>'); process.exit(1) }

const executablePath =
  process.env.ENEST_CHROME_PATH ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(existsSync)
const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
await page.goto('about:blank')

const files = readdirSync(dirA).filter((f) => f.endsWith('.png')).sort()
let failed = 0
for (const file of files) {
  const pb = path.join(dirB, file)
  if (!existsSync(pb)) { console.log(`MISSING  ${file} (no counterpart)`); failed++; continue }
  const dataA = readFileSync(path.join(dirA, file)).toString('base64')
  const dataB = readFileSync(pb).toString('base64')
  const result = await page.evaluate(async ([a, b]) => {
    const load = (data) => new Promise((res, rej) => {
      const img = new Image()
      img.onload = () => res(img)
      img.onerror = () => rej(new Error('img load'))
      img.src = `data:image/png;base64,${data}`
    })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height)
    const mk = (img) => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d', { willReadFrequently: true })
      ctx.fillStyle = '#ff00ff'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0)
      return ctx.getImageData(0, 0, w, h).data
    }
    const da = mk(ia), db = mk(ib)
    let diff = 0
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
        if (d > 24) {
          diff++
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    const total = w * h
    return {
      ratio: +(diff / total * 100).toFixed(3),
      bbox: maxX < 0 ? null : { minX, minY, maxX, maxY },
      size: `${ia.width}x${ia.height} / ${ib.width}x${ib.height}`,
    }
  }, [dataA, dataB])
  const ok = result.ratio <= 0.5
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'DIFF'}  ${file}  ${result.ratio}%  bbox=${result.bbox ? JSON.stringify(result.bbox) : '-'}  size=${result.size}`)
}
await browser.close()
console.log(failed === 0 ? 'ALL PASS' : `${failed} files differ beyond 0.5%`)
process.exit(failed === 0 ? 0 : 1)
