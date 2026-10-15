/** 工具面板 + 暂存片段：变换当前选中剪贴板文本、临时片段快捷复制。
    与 snippets 插件区分：这里是「临时」性质，最多 20 条，随取随丢。 */
import * as tk from './textkit.js'

const SNIPPET_KEY = 'clipboard.snippets.v1'
const SNIPPET_MAX = 20

export function createTools({ kit, api, getText, $ }) {
  const esc = PluginKit.escape
  let snippets = []
  let editingSnippet = null

  // —— 持久化 ——//
  async function loadSnippets() {
    try {
      const saved = await kit.load(SNIPPET_KEY, [])
      if (Array.isArray(saved)) snippets = saved.slice(0, SNIPPET_MAX)
    } catch {}
    renderSnippets()
  }
  function saveSnippets() {
    return kit.save(SNIPPET_KEY, snippets).catch(() => {})
  }

  // —— 面板开关 ——//
  const panel = $('tools-panel')
  $('open-tools').onclick = () => {
    const show = panel.hidden
    panel.hidden = !show
    $('open-tools').setAttribute('aria-expanded', String(show))
    $('open-tools').textContent = show ? '收起工具' : '工具'
  }

  // —— 变换 ——//
  async function transformAndWrite(kind) {
    try {
      const text = await getText()
      if (!text) return kit.toast('先在历史中选择一条文本记录', 'warn')
      const out = applyTransform(text, kind)
      await api.clipboard.writeText(out)
      kit.toast('已变换并写回剪贴板', 'success')
    } catch (err) {
      kit.toast(err.message || String(err), 'error')
    }
  }

  function applyTransform(text, kind) {
    switch (kind) {
      case 'json': return tk.formatJson(text)
      case 'json-min': return tk.formatJson(text, { minify: true })
      case 'unique': return tk.uniqueLines(text)
      case 'sort': return tk.sortLines(text, 'asc')
      case 'strip': return tk.stripFormatting(text)
      case 'upper': return tk.changeCase(text, 'upper')
      case 'lower': return tk.changeCase(text, 'lower')
      case 'camel': return tk.changeCase(text, 'camel')
      case 'snake': return tk.changeCase(text, 'snake')
      case 'kebab': return tk.changeCase(text, 'kebab')
      default: throw new Error('未知变换')
    }
  }

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('[data-xfmt]')
    if (button) void transformAndWrite(button.dataset.xfmt)
  })
  $('regex-apply').onclick = () => void applyRegex()

  // 正则替换走专用管道（需要两个输入值）
  async function applyRegex() {
    try {
      const text = await getText()
      if (!text) return kit.toast('先在历史中选择一条文本记录', 'warn')
      const out = tk.regexReplace(text, $('regex-pattern').value, $('regex-replacement').value)
      await api.clipboard.writeText(out)
      kit.toast('已替换并写回剪贴板', 'success')
    } catch (err) {
      kit.toast(err.message || String(err), 'error')
    }
  }

  // —— 暂存片段 ——//
  function renderSnippets() {
    const wrap = $('snippets')
    wrap.innerHTML = snippets.length
      ? snippets
          .map(
            (s) => `<div class="snippet" data-snippet="${esc(s.id)}">
  <button class="snippet-copy" data-snippet-copy title="复制此片段"><b>${esc(s.title)}</b><small>${esc(s.body.split(/\r?\n/)[0].slice(0, 60))}</small></button>
  <span class="snippet-tools">
    <button data-snippet-edit title="编辑">编辑</button>
    <button data-snippet-del title="删除">×</button>
  </span>
</div>`,
          )
          .join('')
      : '<p class="muted snippet-empty">暂无片段。选中文本后点「存入选中」，或新建空白片段。</p>'
  }

  function openSnippetDialog(snippet) {
    editingSnippet = snippet || null
    $('snippet-title').textContent = snippet ? '编辑片段' : '新建片段'
    $('snippet-name').value = snippet?.title || ''
    $('snippet-body').value = snippet?.body || ''
    $('snippet-error').hidden = true
    $('snippet-dialog').showModal()
    $('snippet-body').focus()
  }

  async function saveCurrentSelection() {
    try {
      const text = await getText()
      if (!text || !text.trim()) return kit.toast('先在历史中选择一条文本记录', 'warn')
      snippets.unshift(tk.normalizeSnippet({ body: text }))
      snippets = snippets.slice(0, SNIPPET_MAX)
      await saveSnippets()
      renderSnippets()
      kit.toast('已存入暂存片段', 'success')
    } catch (err) {
      kit.toast(err.message, 'error')
    }
  }

  $('snippet-save').onclick = () => void saveCurrentSelection()
  $('snippet-new').onclick = () => openSnippetDialog(null)
  $('snippet-cancel').onclick = () => $('snippet-dialog').close()
  $('snippet-form').onsubmit = (event) => {
    event.preventDefault()
    try {
      const normalized = tk.normalizeSnippet(
        { ...(editingSnippet || {}), title: $('snippet-name').value, body: $('snippet-body').value },
        undefined,
      )
      if (editingSnippet) {
        const i = snippets.findIndex((s) => s.id === editingSnippet.id)
        if (i >= 0) snippets[i] = normalized
      } else {
        snippets.unshift(normalized)
        snippets = snippets.slice(0, SNIPPET_MAX)
      }
      $('snippet-dialog').close()
      void saveSnippets()
      renderSnippets()
    } catch (err) {
      $('snippet-error').textContent = err.message
      $('snippet-error').hidden = false
    }
  }

  $('snippets').onclick = (event) => {
    const wrap = event.target.closest('[data-snippet]')
    if (!wrap) return
    const snippet = snippets.find((s) => s.id === wrap.dataset.snippet)
    if (!snippet) return
    if (event.target.closest('[data-snippet-del]')) {
      snippets = snippets.filter((s) => s.id !== snippet.id)
      void saveSnippets()
      renderSnippets()
      kit.toast('已删除片段')
      return
    }
    if (event.target.closest('[data-snippet-edit]')) return openSnippetDialog(snippet)
    if (event.target.closest('[data-snippet-copy]')) {
      void api.clipboard.writeText(snippet.body).then(() => kit.toast('已复制片段', 'success')).catch((err) => kit.toast(err.message, 'error'))
    }
  }

  // 暴露给主脚本：正则应用绑定
  return { loadSnippets, applyRegex, applyTransform, transformAndWrite }
}
