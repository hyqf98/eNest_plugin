import { SelectionModel } from '@enest/plugin-kit/workbench'

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const join = (path, name) => (path === '/' ? '/' : path.replace(/\/$/, '') + '/') + name
const size = n => n < 1024 ? `${n || 0} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

/** Remote explorer keeps selection, current paths and expanded folders per SSH session. */
export class RemoteFiles {
  constructor(element, context) {
    this.el = element; this.ctx = context; this.states = new Map(); this.clipboard = null; this.local = null; this.exportId = null; this.sequence = 0
    this.el.classList.add('wb-explorer'); this.el.tabIndex = 0
    this.el.addEventListener('keydown', event => this.keydown(event))
    this.el.addEventListener('dragover', event => {
      event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-enest-remote') ? (event.ctrlKey || event.altKey ? 'copy' : 'move') : 'copy'; this.el.classList.add('drop-active')
      const list = this.el.querySelector('.wb-file-list'), rect = list?.getBoundingClientRect()
      if (rect && event.clientY >= rect.top && event.clientY <= rect.bottom) { if (event.clientY < rect.top + 28) list.scrollTop -= 24; else if (event.clientY > rect.bottom - 28) list.scrollTop += 24 }
      const target = event.target.closest('[data-path]'), path = target?.dataset.path
      if (path !== this.hoverPath) {
        clearTimeout(this.hoverTimer); this.hoverPath = path
        this.el.querySelector('.drop-target')?.classList.remove('drop-target')
        if (this.rows().some(row => row.path === path && row.type === 'dir')) {
          target.classList.add('drop-target')
          if (!this.state.expanded.has(path)) this.hoverTimer = setTimeout(() => { if (this.hoverPath === path) void this.expand(path) }, 650)
        }
      }
    })
    this.el.addEventListener('dragleave', event => { if (!this.el.contains(event.relatedTarget)) { this.el.classList.remove('drop-active'); clearTimeout(this.hoverTimer); this.hoverPath = null; this.el.querySelector('.drop-target')?.classList.remove('drop-target') } })
    this.el.addEventListener('drop', event => { event.preventDefault(); this.el.classList.remove('drop-active'); void this.drop(event).catch(error => this.ctx.error(error)) })
    this.el.addEventListener('contextmenu', event => { event.preventDefault(); this.menu(event) })
    this.el.addEventListener('dragend', () => { clearTimeout(this.hoverTimer); this.hoverPath = null; this.el.classList.remove('drop-active'); window.enest?.localFiles?.endDrag?.() })
  }
  get session() { return this.ctx.session() }
  get state() {
    const key = this.session?.sessionId || 'none'
    if (!this.states.has(key)) this.states.set(key, { path: '.', entries: [], expanded: new Set(), children: new Map(), selection: new SelectionModel(), view: 'tree', hidden: false, history: [], scrollTop: 0, filter: '', loading: false, error: '' })
    return this.states.get(key)
  }
  request(action, values = {}) { return this.ctx.request(action, values) }
  async refresh(path) {
    const session = this.session, state = this.state, sequence = ++this.sequence
    if (!session?.sessionId) { this.render(); return }
    if (path !== undefined && path !== state.path) { state.history.push(state.path); state.path = path; state.scrollTop = 0; state.filter = ''; state.expanded.clear(); state.children.clear(); state.selection.clear() }
    state.loading = true; state.error = ''; this.render()
    try {
      const result = await window.enest.ssh.sftp.list({ sessionId: session.sessionId, path: state.path })
      if (sequence !== this.sequence) return
      state.entries = result.map(x => ({ ...x, path: x.path || join(state.path, x.name) }))
      state.children.clear(); state.expanded.clear(); state.selection.retain(state.entries.map(x => x.path))
    } catch (error) { state.error = error.message }
    finally { if (sequence === this.sequence) { state.loading = false; this.render() } }
  }
  rows(entries = this.state.entries, depth = 0) {
    const out = []
    for (const entry of entries) {
      if (!this.state.hidden && entry.name.startsWith('.')) continue
      out.push({ ...entry, depth })
      if (this.state.view === 'tree' && this.state.expanded.has(entry.path)) out.push(...this.rows(this.state.children.get(entry.path) || [], depth + 1))
    }
    return depth === 0 && this.state.filter ? out.filter(row => row.name.toLowerCase().includes(this.state.filter.toLowerCase())) : out
  }
  selected() { const selection = this.state.selection.selected; return this.rows().filter(row => selection.has ? selection.has(row.path) : selection.includes(row.path)) }
  render() {
    const state = this.state, connected = !!this.session?.sessionId, rows = this.rows(), selected = new Set(this.selected().map(x => x.path))
    const start = rows.length > 250 ? Math.max(0, Math.floor((state.scrollTop || 0) / 29) - 12) : 0, end = rows.length > 250 ? Math.min(rows.length, start + 100) : rows.length
    const visibleRows = rows.slice(start, end)
    this.el.innerHTML = `<div class="wb-pane-title"><strong>远程文件</strong><span>${selected.size ? selected.size + ' 项已选' : ''}</span><button data-act="local" title="本地 / 远程双栏">双栏</button><button data-act="view">${state.view === 'tree' ? '列表' : '树形'}</button></div>
      <div class="wb-file-path"><button data-act="back" title="返回">←</button><button data-act="up" title="上一级">↑</button><input aria-label="远程路径" value="${escape(state.path)}"><button data-act="refresh" title="刷新">↻</button></div>
      <div class="wb-file-actions"><button data-act="upload" ${connected ? '' : 'disabled'}>上传</button><button data-act="download" ${selected.size ? '' : 'disabled'}>下载${selected.size > 1 ? ' (' + selected.size + ')' : ''}</button><button data-act="new" ${connected ? '' : 'disabled'}>新建</button><button data-act="hidden" title="显示隐藏文件" aria-pressed="${state.hidden}">隐藏项</button></div>
      <div class="wb-file-filter"><input data-file-filter placeholder="过滤当前目录" aria-label="过滤远程文件" value="${escape(state.filter)}"></div>
      <div class="wb-file-list" role="tree" aria-label="远程目录" aria-multiselectable="true">${!connected ? '<div class="wb-empty">连接服务器后浏览文件</div>' : state.loading ? '<div class="wb-empty">正在读取目录…</div>' : state.error ? `<div class="wb-inline-error">${escape(state.error)}<button data-act="refresh">重试</button></div>` : rows.length ? `<div style="height:${start * 29}px"></div>` + visibleRows.map(row => `<div class="wb-file-row ${selected.has(row.path) ? 'selected' : ''}" role="treeitem" tabindex="-1" aria-selected="${selected.has(row.path)}" ${row.type === 'dir' ? `aria-expanded="${state.expanded.has(row.path)}"` : ''} draggable="true" data-path="${escape(row.path)}" style="--depth:${row.depth}"><button class="wb-file-expand" aria-label="展开目录" tabindex="-1">${row.type === 'dir' ? state.expanded.has(row.path) ? '⌄' : '›' : '·'}</button><span class="wb-file-name">${escape(row.name)}</span><span class="wb-file-size">${row.type === 'dir' ? '目录' : size(row.size)}</span><span class="wb-file-time">${row.mtime ? new Date(row.mtime).toLocaleDateString() : ''}</span></div>`).join('') + `<div style="height:${(rows.length - end) * 29}px"></div>` : '<div class="wb-empty">空目录<br><small>将文件或文件夹拖到这里上传</small></div>'}</div>
      ${this.exportId ? '<div class="wb-export" draggable="true">文件已准备好 · 从这里拖到桌面<button data-act="export-dismiss">×</button></div>' : ''}
      ${this.local ? `<div class="wb-local-title"><strong>本地目录</strong><button data-act="local">更换</button><button data-act="local-close">×</button></div><div class="wb-local-path">${escape(this.local.displayPath)}</div><div class="wb-local-list" tabindex="0"><span>将远程所选文件拖到这里下载</span></div>` : ''}`
    this.el.querySelectorAll('[data-act]').forEach(button => button.onclick = () => void this.action(button.dataset.act).catch(error => this.ctx.error(error)))
    const list = this.el.querySelector('.wb-file-list'); list.scrollTop = state.scrollTop || 0
    list.onscroll = () => { state.scrollTop = list.scrollTop; if (rows.length > 250 && Math.abs(Math.max(0, Math.floor(list.scrollTop / 29) - 12) - start) > 8) this.render() }
    const filter = this.el.querySelector('[data-file-filter]'); filter.oninput = () => { const position = filter.selectionStart; state.filter = filter.value; state.scrollTop = 0; this.render(); const next = this.el.querySelector('[data-file-filter]'); next.focus(); next.setSelectionRange(position, position) }
    this.el.querySelector('.wb-file-path input').onkeydown = event => { if (event.key === 'Enter') { event.stopPropagation(); void this.refresh(event.target.value.trim() || '.') } }
    for (const row of this.el.querySelectorAll('[data-path]')) {
      row.onclick = event => { if (event.target.closest('.wb-file-expand')) { void this.expand(row.dataset.path); return }; this.state.selection.select(row.dataset.path, rows.map(x => x.path), { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }); this.render(); this.el.focus() }
      row.ondblclick = () => { const entry = rows.find(x => x.path === row.dataset.path); if (entry.type === 'dir') void this.refresh(entry.path); else void this.ctx.edit(entry.path) }
      row.ondragstart = event => { if (!selected.has(row.dataset.path)) state.selection.select(row.dataset.path, rows.map(x => x.path)); event.dataTransfer.setData('application/x-enest-remote', JSON.stringify({ sessionId: this.session.sessionId, paths: this.selected().map(x => x.path) })); event.dataTransfer.effectAllowed = 'copyMove' }
    }
    const exportEl = this.el.querySelector('.wb-export')
    if (exportEl) exportEl.ondragstart = event => { event.preventDefault(); window.enest.localFiles.startDrag(this.exportId).catch(error => this.ctx.error(error)) }
    const local = this.el.querySelector('.wb-local-list')
    if (local) {
      local.ondragover = event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy' }
      local.ondrop = event => { event.preventDefault(); event.stopPropagation(); const data = event.dataTransfer.getData('application/x-enest-remote'); if (data) { const payload = JSON.parse(data); if (payload.sessionId !== this.session.sessionId) return this.ctx.error(new Error('请在来源服务器的文件管理器中下载')); void this.download(payload.paths, this.local) } }
      void this.renderLocal(local)
    }
  }
  async renderLocal(element) {
    try {
      const data = await window.enest.localFiles.list({ handleId: this.local.id })
      if (!element.isConnected) return
      for (const entry of data.entries) {
        const row = document.createElement('button'); row.className = 'wb-local-row'; row.textContent = `${entry.kind === 'directory' ? '▸' : '·'} ${entry.name}`; row.draggable = true
        row.ondblclick = () => { if (entry.kind === 'directory') { this.local = entry; this.render() } else window.enest.localFiles.reveal(entry.id) }
        row.ondragstart = event => { event.dataTransfer.setData('application/x-enest-local', JSON.stringify({ id: entry.id, name: entry.name })); event.dataTransfer.effectAllowed = 'copy' }
        element.append(row)
      }
    } catch (error) { element.textContent = error.message }
  }
  async expand(path) {
    const state = this.state, entry = this.rows().find(x => x.path === path)
    if (entry?.type !== 'dir') return
    if (state.expanded.has(path)) state.expanded.delete(path)
    else {
      try { const entries = await window.enest.ssh.sftp.list({ sessionId: this.session.sessionId, path }); state.children.set(path, entries.map(x => ({ ...x, path: x.path || join(path, x.name) }))); state.expanded.add(path) }
      catch (error) { this.ctx.error(error) }
    }
    this.render()
  }
  async action(action) {
    const state = this.state, selected = this.selected(), sessionId = this.session?.sessionId
    const request = (action, values = {}) => this.request(action, { sessionId, ...values })
    if (action === 'refresh') return this.refresh()
    if (action === 'up') return this.refresh(state.path.replace(/\/?[^/]+\/?$/, '') || '/')
    if (action === 'back') { const path = state.history.pop(); if (path != null) { state.path = path; return this.refresh() } return }
    if (action === 'view') { state.view = state.view === 'tree' ? 'list' : 'tree'; this.render(); return }
    if (action === 'hidden') { state.hidden = !state.hidden; this.render(); return }
    if (action === 'local-close') { this.local = null; this.render(); return }
    if (action === 'local') { const handles = await window.enest.localFiles.pick({ kind: 'directory', access: 'write' }); if (handles?.[0]) { this.local = handles[0]; this.render() } return }
    if (action === 'export-dismiss') { this.exportId = null; this.render(); return }
    if (action === 'upload') { const handles = await window.enest.localFiles.pick({ kind: 'any', multiple: true }); return this.upload(handles || [], state.path) }
    if (action === 'download') return this.download(selected.map(x => x.path))
    if (action === 'drag') { this.ctx.message('正在准备拖出，下载进度见传输面板'); const result = await request('files.prepareDrag', { paths: selected.map(x => x.path) }); this.exportId = result.exportId; this.render(); return }
    if (action === 'new' || action === 'new-file') {
      const name = await this.ctx.prompt(action === 'new' ? '新建文件夹' : '新建文件', '名称', '')
      if (!name) return
      if (/[/\\]/.test(name)) throw new Error('请输入文件名，不要包含路径')
      if (action === 'new') await window.enest.ssh.sftp.mkdir(sessionId, join(state.path, name))
      else await request('files.write', { path: join(state.path, name), content: '' })
      return this.refresh()
    }
    if (action === 'copy' || action === 'cut') { this.clipboard = { sessionId: sessionId, paths: selected.map(x => x.path), mode: action === 'cut' ? 'move' : 'copy' }; this.ctx.message(`已${action === 'cut' ? '剪切' : '复制'} ${selected.length} 项`); return }
    if (action === 'paste') {
      if (!this.clipboard) return
      if (this.clipboard.sessionId !== sessionId) return this.copyAcross(this.clipboard.sessionId, this.clipboard.paths, state.path)
      const result = await request(`files.${this.clipboard.mode}`, { paths: this.clipboard.paths, destination: state.path }); this.checkResults(result); if (this.clipboard.mode === 'move') this.clipboard = null; return this.refresh()
    }
    if (action === 'rename') {
      if (selected.length === 1) return this.renameInline(selected[0])
      if (!selected.length) return
      const pattern = await this.ctx.prompt('批量重命名', '使用 {name} 原名、{n} 序号，例如 backup-{n}-{name}', '{name}')
      if (!pattern) return
      const entries = selected.map((item, i) => ({ path: item.path, name: pattern.replaceAll('{name}', item.name).replaceAll('{n}', String(i + 1)) }))
      if (!await this.ctx.confirm(entries.map((x, i) => `${selected[i].name} → ${x.name}`).join('\n'), { title: '确认重命名', okText: '重命名' })) return
      this.checkResults(await request('files.renameBatch', { entries })); return this.refresh()
    }
    if (action === 'delete') {
      if (!selected.length || !await this.ctx.confirm(`将永久删除 ${selected.length} 项，文件夹中的内容也会删除。\n\n${selected.map(x => x.path).join('\n')}`, { title: '删除远程文件', okText: '删除', danger: true })) return
      const failures = []
      for (const item of selected) try { await window.enest.ssh.sftp.delete(sessionId, item.path, item.type === 'dir') } catch (error) { failures.push(item.name + ': ' + error.message) }
      await this.refresh(); if (failures.length) throw new Error(failures.join('\n')); return
    }
    if (action === 'path') { await this.ctx.copy(selected.map(x => x.path).join('\n')); return }
    if (action === 'permissions') {
      const mode = await this.ctx.prompt('修改权限', '八进制，例如 0644。只修改所选项目，不递归目录。', '0644')
      if (!mode) return
      for (const item of selected) await window.enest.ssh.sftp.chmod(sessionId, item.path, mode)
      return this.refresh()
    }
    if (action === 'properties') {
      const items = await Promise.all(selected.map(x => this.request('files.stat', { path: x.path })))
      this.ctx.inspect('文件属性', items.map(x => `${x.path}\n${x.type} · ${size(x.size)} · ${new Date(x.mtime).toLocaleString()}\n权限 ${(x.mode & 0o7777).toString(8)} · uid ${x.uid ?? '—'} · gid ${x.gid ?? '—'}`).join('\n\n')); return
    }
  }
  renameInline(entry) {
    const row = [...this.el.querySelectorAll('[data-path]')].find(x => x.dataset.path === entry.path), label = row?.querySelector('.wb-file-name')
    if (!label) return
    const sessionId = this.session?.sessionId
    const input = document.createElement('input'); input.value = entry.name; label.replaceChildren(input); input.focus(); input.setSelectionRange(0, entry.type === 'dir' || !entry.name.includes('.') ? entry.name.length : entry.name.lastIndexOf('.'))
    input.onclick = event => event.stopPropagation()
    input.onkeydown = event => {
      event.stopPropagation()
      if (event.key === 'Escape') { this.render(); this.el.focus() }
      if (event.key === 'Enter') { event.preventDefault(); void this.request('files.renameBatch', { sessionId, entries: [{ path: entry.path, name: input.value }] }).then(result => { this.checkResults(result); return this.refresh() }).catch(error => this.ctx.error(error)) }
    }
  }
  checkResults(results) { const errors = results.filter(x => x.error); if (errors.length) throw new Error(errors.map(x => `${x.path}: ${x.error}`).join('\n')) }
  async copyAcross(sourceSessionId, paths, destination) {
    const sessionId = this.session?.sessionId
    if (!sessionId) return
    for (const path of paths) await this.request('transfer.remoteCopy', { sessionId, sourceSessionId, path, destination: join(destination, path.split('/').filter(Boolean).at(-1)) })
    this.ctx.transfers(); this.ctx.message(`已添加 ${paths.length} 项跨服务器复制任务，源文件保留`)
  }
  async upload(handles, destination) {
    const sessionId = this.session?.sessionId
    if (!sessionId || !handles.length) return
    for (const handle of handles) await this.request('transfer.upload', { sessionId, localHandleId: handle.id, destination: join(destination, handle.name) })
    this.ctx.transfers(); this.ctx.message(`已添加 ${handles.length} 项上传任务`)
  }
  async download(paths, target = this.local) {
    const sessionId = this.session?.sessionId
    if (!paths.length || !sessionId) return
    if (!target) target = (await window.enest.localFiles.pick({ kind: 'directory', access: 'write' }))?.[0]
    if (!target) return
    for (const path of paths) await this.request('transfer.download', { sessionId, path, localHandleId: target.id })
    this.ctx.transfers(); this.ctx.message(`已添加 ${paths.length} 项下载任务`)
  }
  async drop(event) {
    if (!this.session?.sessionId) throw new Error('请先连接服务器')
    const row = event.target.closest('[data-path]'), entry = row ? this.rows().find(x => x.path === row.dataset.path) : null
    const destination = entry?.type === 'dir' ? entry.path : this.state.path
    const remote = event.dataTransfer.getData('application/x-enest-remote')
    if (remote) {
      const value = JSON.parse(remote)
      if (value.sessionId !== this.session.sessionId) return this.copyAcross(value.sessionId, value.paths, destination)
      this.checkResults(await this.request(event.ctrlKey || event.altKey ? 'files.copy' : 'files.move', { paths: value.paths, destination })); return this.refresh()
    }
    const local = event.dataTransfer.getData('application/x-enest-local')
    if (local) { const handle = JSON.parse(local); return this.upload([handle], destination) }
    const handles = await window.enest.localFiles.fromDrop(Array.from(event.dataTransfer.files || []))
    return this.upload(handles, destination)
  }
  menu(event) {
    const row = event.target.closest('[data-path]'), ordered = this.rows().map(x => x.path)
    if (row && !this.selected().some(x => x.path === row.dataset.path)) { this.state.selection.select(row.dataset.path, ordered); this.render() }
    const selected = this.selected(), entries = []
    const item = (label, action, extra = {}) => ({ label, ...extra, onAct: () => this.action(action).catch(error => this.ctx.error(error)) })
    if (selected.length) {
      if (selected.length === 1 && selected[0].type !== 'dir') entries.push({ label: '打开 / 编辑', onAct: () => this.ctx.edit(selected[0].path) })
      entries.push(item(`下载所选 (${selected.length})`, 'download'), item('准备拖到桌面', 'drag'), { sep: true }, item('复制', 'copy'), item('剪切', 'cut'), item(selected.length > 1 ? '批量重命名…' : '重命名', 'rename'), item('复制路径', 'path'), item('权限…', 'permissions'), item('属性', 'properties'), { sep: true }, item('删除…', 'delete', { danger: true }))
    } else entries.push(item('上传文件 / 文件夹…', 'upload'), item('新建文件夹…', 'new'), item('新建文件…', 'new-file'))
    entries.push({ sep: true }, item('粘贴到当前目录', 'paste', { disabled: !this.clipboard }), item('刷新', 'refresh'))
    this.ctx.menu(event.clientX, event.clientY, entries)
  }
  keydown(event) {
    if (event.target.matches('input,textarea')) return
    const mac = /Mac/.test(navigator.platform), meta = mac ? event.metaKey : event.ctrlKey
    let action
    if (meta && event.key.toLowerCase() === 'a') { event.preventDefault(); for (const row of this.rows()) if (!this.selected().some(x => x.path === row.path)) this.state.selection.select(row.path, this.rows().map(x => x.path), { additive: true }); this.render(); this.el.focus(); return }
    if (meta && event.key.toLowerCase() === 'c') action = event.shiftKey ? 'path' : 'copy'
    if (meta && event.key.toLowerCase() === 'x') action = 'cut'
    if (meta && event.key.toLowerCase() === 'v') { if (event.altKey && this.clipboard) this.clipboard.mode = 'move'; action = 'paste' }
    if (event.key === 'F2' || (mac && event.key === 'Enter' && !meta)) action = 'rename'
    if ((!mac && event.key === 'Delete') || (mac && meta && event.key === 'Backspace')) action = 'delete'
    if ((!mac && event.key === 'Backspace') || (mac && meta && event.key === 'ArrowUp')) action = 'up'
    if (event.key === 'F5') action = 'refresh'
    if (action) { event.preventDefault(); void this.action(action).catch(error => this.ctx.error(error)); return }
    if (event.key === 'Escape') { this.state.selection.clear(); this.render(); this.el.focus(); return }
    if ((!mac && event.key === 'Enter') || (mac && meta && event.key === 'ArrowDown')) { event.preventDefault(); const item = this.selected()[0]; if (item) { if (item.type === 'dir') void this.refresh(item.path); else void this.ctx.edit(item.path) } return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const rows = this.rows(), last = this.selected().at(-1), index = rows.findIndex(x => x.path === last?.path), next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next) { this.state.selection.select(next.path, rows.map(x => x.path), { range: event.shiftKey }); const list = this.el.querySelector('.wb-file-list'), y = rows.indexOf(next) * 29; if (list && (y < list.scrollTop || y + 29 > list.scrollTop + list.clientHeight)) this.state.scrollTop = Math.max(0, y - list.clientHeight / 2); this.render(); this.el.focus(); [...this.el.querySelectorAll('[data-path]')].find(x => x.dataset.path === next.path)?.scrollIntoView({ block: 'nearest' }) }
    }
  }
}
