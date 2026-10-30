/** Exercise actual offline UI before photographing the rendered result. */
export async function runMarketScenario(page, id) {
  const fill = (selector, value) => page.locator(selector).fill(value)
  const click = selector => page.locator(selector).click()
  const wait = predicate => page.waitForFunction(predicate, undefined, { timeout: 8000 })
  // 插件目录已切换为短名，case 标签保持 com.github.eNest.<短名> 全名形态
  const fullId = id.includes('.') ? id : `com.github.eNest.${id}`
  switch (fullId) {
    case 'com.github.eNest.calculator':
      await fill('#expr', '(1280 + 720) * 0.85'); await page.locator('#expr').press('Enter')
      await fill('#expr', 'sqrt(144) * 32'); await page.locator('#expr').press('Enter')
      await fill('#expr', '256 * 1.25')
      await wait(() => document.querySelector('#result').textContent.includes('320'))
      return '输入三组算式，显示即时结果与计算历史'
    case 'com.github.eNest.codec':
      await fill('#input', 'eNest — 让常用工具回到工作流里。\nBuild once. Work anywhere.')
      await click('#run'); await wait(() => document.querySelector('#output').value.length > 20)
      return '执行 Base64 编码并显示结果'
    case 'com.github.eNest.diff':
      await fill('#source', 'name: eNest\nversion: 1.0.0\nmode: shell\nplugins:\n  - calculator\n  - notes\n  - clipboard')
      await fill('#target', 'name: eNest\nversion: 1.1.0\nmode: quick\nplugins:\n  - calculator\n  - markdown\n  - clipboard\n  - image-tools')
      await wait(() => !document.querySelector('#export-diff').disabled)
      return '比较两个版本配置，显示行级与行内差异'
    case 'com.github.eNest.hash':
      await fill('#hash-input', 'eNest / local tools, thoughtful workflows')
      await wait(() => /[a-f0-9]{32}/.test(document.querySelector('#hash-list').textContent))
      return '计算演示文本的多算法摘要'
    case 'com.github.eNest.image-tools':
      await click('#add-files'); await page.locator('#work-layout').waitFor({ state: 'visible' })
      await click('#thumb-grid .thumb')
      await click('#run-compress'); await wait(() => !document.querySelector('#save-result').disabled)
      return '通过模拟授权句柄读取演示图片，执行压缩并显示预览'
    case 'com.github.eNest.json-tools':
      await fill('#input', '{"name":"eNest","version":"1.1.0","window":{"width":720,"height":420},"features":["local-first","sandboxed","responsive"],"enabled":true}')
      await click('[data-action="format"]'); await wait(() => document.querySelector('#output').value.includes('\n'))
      return '格式化嵌套 JSON 并显示结果'
    case 'com.github.eNest.password-kit':
      await fill('#count', '4'); await click('#generate'); await click('#mask')
      await wait(() => !document.querySelector('#copy-all').disabled)
      return '在本地生成四条演示密码并显示结果'
    case 'com.github.eNest.regex':
      await fill('#pattern', '(\\d{4})-(\\d{2})-(\\d{2})')
      await fill('#samples', '发布日期：2026-10-13\n文档更新：2026-10-15\n下一版本：2026-11-02')
      await fill('#replacement', '$1 年 $2 月 $3 日')
      await wait(() => document.querySelector('#match-list').children.length >= 3)
      return '匹配三个日期并展示捕获组与替换结果'
    case 'com.github.eNest.screen-assistant':
      await click('#import-image'); await page.locator('#canvas-wrap').waitFor({ state: 'visible' })
      return '通过模拟授权句柄打开演示图片，展示标注工作区'
    case 'com.github.eNest.batch-rename':
    case 'com.github.eNest.lan-share':
      await click('#pick-btn')
      return '使用模拟授权句柄加入两个演示文件'
    case 'com.github.eNest.sysguard':
      await click('#refresh'); await wait(() => document.querySelector('#tab-body').textContent.includes('eNest'))
      return '通过模拟宿主进程接口读取两条演示进程'
    case 'com.github.eNest.sticky-notes':
      await click('[data-id="demo-note-1"]')
      return '打开隔离存储中的演示笔记'
    case 'com.github.eNest.todos':
      await click('[data-id="demo-task-1"] .task-title')
      return '打开演示任务，展示优先级与子任务'
    case 'com.github.eNest.anything':
      await fill('#query', 'md')
      await wait(() => document.querySelectorAll('#list .row').length >= 2)
      await page.locator('#list .row').nth(1).click()
      return '在演示索引中搜索并选中一条结果，展示命中高亮与预览'
    case 'com.github.eNest.codex-pets':
      await wait(() => document.querySelectorAll('.cp-card').length >= 3)
      await fill('#g-q', '像素')
      await page.locator('#g-search button[type=submit]').click()
      await wait(() => document.querySelector('#g-count').textContent.includes('1'))
      await fill('#g-q', '')
      await page.locator('#g-search button[type=submit]').click()
      await wait(() => document.querySelectorAll('.cp-card').length >= 3)
      return '隔离演示数据画廊：搜索过滤后恢复三只演示宠物'
    case 'com.github.eNest.drawboard':
      await wait(() => {
        if (window.__drawboardDemo && !window.__drawboardSeeded) {
          window.__drawboardSeeded = true
          window.__drawboardDemo()
        }
        const status = document.querySelector('.db-status')?.textContent || ''
        return window.__drawboardSeeded && /\d+ 项/.test(status) && !/(^|\s)0 项/.test(status)
      })
      return '画出示例墨迹、手绘图形与手写体文字'
    case 'com.github.eNest.env-vars':
      await wait(() => document.querySelectorAll('.table-body .row').length >= 8)
      await fill('#query', 'JAVA')
      await wait(() => document.querySelectorAll('.table-body .row').length >= 1 && document.querySelectorAll('.table-body .row').length < 8)
      await page.locator('.table-body .row').first().click()
      return '搜索过滤环境变量并展开一条详情'
    case 'com.github.eNest.dev-env':
      await wait(() => document.querySelectorAll('.env-list .env-row, .env-row').length >= 5)
      await page.locator('.env-row').nth(2).click()
      return '探测到多个开发环境，选中一个展示详情页签'
    case 'com.github.eNest.password-book':
      await wait(() => document.querySelectorAll('.entry-card').length >= 5)
      await page.locator('.entry-card').first().click()
      return '打开密码本演示条目，展示掩码密码与详情面板'
    default:
      return '真实初始界面；如有外部服务数据，仅使用隔离模拟数据'
  }
}
