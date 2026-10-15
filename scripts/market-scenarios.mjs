/** Exercise actual offline UI before photographing the rendered result. */
export async function runMarketScenario(page, id) {
  const fill = (selector, value) => page.locator(selector).fill(value)
  const click = selector => page.locator(selector).click()
  const wait = predicate => page.waitForFunction(predicate, undefined, { timeout: 8000 })
  switch (id) {
    case 'com.enest.calculator':
      await fill('#expr', '(1280 + 720) * 0.85'); await page.locator('#expr').press('Enter')
      await fill('#expr', 'sqrt(144) * 32'); await page.locator('#expr').press('Enter')
      await fill('#expr', '256 * 1.25')
      await wait(() => document.querySelector('#result').textContent.includes('320'))
      return '输入三组算式，显示即时结果与计算历史'
    case 'com.enest.code-shot':
      await fill('#card-title', 'workspace.ts')
      await fill('#code', "async function openWorkspace(name: string) {\n  const workspace = await enest.storage.get(name)\n  return {\n    ...workspace,\n    ready: true,\n    updatedAt: new Date().toISOString()\n  }\n}")
      await wait(() => !document.querySelector('#save-shot').disabled)
      return '输入 TypeScript 代码并生成截图画布'
    case 'com.enest.codec':
      await fill('#input', 'eNest — 让常用工具回到工作流里。\nBuild once. Work anywhere.')
      await click('#run'); await wait(() => document.querySelector('#output').value.length > 20)
      return '执行 Base64 编码并显示结果'
    case 'com.enest.diff':
      await fill('#source', 'name: eNest\nversion: 1.0.0\nmode: shell\nplugins:\n  - calculator\n  - notes\n  - clipboard')
      await fill('#target', 'name: eNest\nversion: 1.1.0\nmode: quick\nplugins:\n  - calculator\n  - markdown\n  - clipboard\n  - image-tools')
      await wait(() => !document.querySelector('#export-diff').disabled)
      return '比较两个版本配置，显示行级与行内差异'
    case 'com.enest.hash':
      await fill('#hash-input', 'eNest / local tools, thoughtful workflows')
      await wait(() => /[a-f0-9]{32}/.test(document.querySelector('#hash-list').textContent))
      return '计算演示文本的多算法摘要'
    case 'com.enest.image-tools':
      await click('#add-files'); await page.locator('#work-layout').waitFor({ state: 'visible' })
      await click('#thumb-grid .thumb')
      await click('#run-compress'); await wait(() => !document.querySelector('#save-result').disabled)
      return '通过模拟授权句柄读取演示图片，执行压缩并显示预览'
    case 'com.enest.json-tools':
      await fill('#input', '{"name":"eNest","version":"1.1.0","window":{"width":720,"height":420},"features":["local-first","sandboxed","responsive"],"enabled":true}')
      await click('[data-action="format"]'); await wait(() => document.querySelector('#output').value.includes('\n'))
      return '格式化嵌套 JSON 并显示结果'
    case 'com.enest.qrcode':
      await fill('#input', 'https://example.com/enest')
      await wait(() => !document.querySelector('#save-png').disabled)
      return '由演示 URL 实际生成二维码画布'
    case 'com.enest.password-kit':
      await fill('#count', '4'); await click('#generate'); await click('#mask')
      await wait(() => !document.querySelector('#copy-all').disabled)
      return '在本地生成四条演示密码并显示结果'
    case 'com.enest.regex':
      await fill('#pattern', '(\\d{4})-(\\d{2})-(\\d{2})')
      await fill('#samples', '发布日期：2026-10-13\n文档更新：2026-10-15\n下一版本：2026-11-02')
      await fill('#replacement', '$1 年 $2 月 $3 日')
      await wait(() => document.querySelector('#match-list').children.length >= 3)
      return '匹配三个日期并展示捕获组与替换结果'
    case 'com.enest.screen-assistant':
      await click('#import-image'); await page.locator('#canvas-wrap').waitFor({ state: 'visible' })
      return '通过模拟授权句柄打开演示图片，展示标注工作区'
    case 'com.enest.batch-rename':
    case 'com.enest.lan-share':
      await click('#pick-btn')
      return '使用模拟授权句柄加入两个演示文件'
    case 'com.enest.sysguard':
      await click('#refresh'); await wait(() => document.querySelector('#tab-body').textContent.includes('eNest'))
      return '通过模拟宿主进程接口读取两条演示进程'
    case 'com.enest.sticky-notes':
      await click('[data-id="demo-note-1"]')
      return '打开隔离存储中的演示笔记'
    case 'com.enest.todos':
      await click('[data-id="demo-task-1"] .task-title')
      return '打开演示任务，展示优先级与子任务'
    case 'com.enest.snippets':
      await click('.snippet')
      return '打开内置示例片段'
    case 'com.enest.codex-pets':
      await wait(() => document.querySelectorAll('.cp-card').length >= 3)
      await fill('#g-q', '像素')
      await page.locator('#g-search button[type=submit]').click()
      await wait(() => document.querySelector('#g-count').textContent.includes('1'))
      await fill('#g-q', '')
      await page.locator('#g-search button[type=submit]').click()
      await wait(() => document.querySelectorAll('.cp-card').length >= 3)
      return '隔离演示数据画廊：搜索过滤后恢复三只演示宠物'
    default:
      return '真实初始界面；如有外部服务数据，仅使用隔离模拟数据'
  }
}
