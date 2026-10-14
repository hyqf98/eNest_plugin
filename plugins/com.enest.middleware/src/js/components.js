/** 共享组件与格式化工具（全部页面通用；只依赖 DOM 与 @workbench，不直接碰 enest） */
import { escapeHtml, createDialog } from '@enest/plugin-kit/workbench'

export { escapeHtml }

/* —— 格式化 —— */
export const fmt = {
  num(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '—'
    return n.toLocaleString('zh-CN')
  },
  compact(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '—'
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1) + ' 亿'
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + 'w'
    return n.toLocaleString('zh-CN')
  },
  bytes(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return '—'
    if (n < 1024) return n + ' B'
    const units = ['KB', 'MB', 'GB', 'TB']
    let v = n / 1024, i = 0
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i]
  },
  ms(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '—'
    if (n < 1000) return Math.round(n) + 'ms'
    return (n / 1000).toFixed(1) + 's'
  },
  datetime(ts) {
    if (!ts || !Number.isFinite(Number(ts))) return '—'
    const d = new Date(Number(ts))
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  },
  datetimeMs(ts) {
    if (!ts || !Number.isFinite(Number(ts))) return '—'
    const d = new Date(Number(ts))
    const p = (x) => String(x).padStart(2, '0')
    return `${fmt.datetime(ts)}.${String(d.getMilliseconds()).padStart(3, '0')}`
  }
}

/* —— 类型识别 —— */
export const KIND_META = {
  kafka: { label: 'Kafka', color: 'var(--c-kafka)', port: 9092 },
  rabbitmq: { label: 'RabbitMQ', color: 'var(--c-rabbit)', port: 15672 },
  mqtt: { label: 'MQTT', color: 'var(--c-mqtt)', port: 1883 },
  rocketmq: { label: 'RocketMQ', color: 'var(--c-rocket)', port: 8080 }
}
export const ENV_LABEL = { prod: 'prod', staging: 'stg', test: 'test', dev: 'dev' }
export function kindDot(kind) { return `<span class="kind-dot" style="background:${KIND_META[kind]?.color ?? 'var(--text-3)'}"></span>` }
export function envChip(env) { return env ? `<span class="chip env-${escapeHtml(env)}">${escapeHtml(ENV_LABEL[env] ?? env)}</span>` : '' }

/* —— 能力门禁：caps[key] = { state, reason } —— */
export function gate(caps, key) {
  const cap = caps?.[key]
  if (!cap || cap.state === 'available') return { enabled: true }
  return { enabled: false, reason: cap.reason || '当前中间件/实例不支持此能力' }
}
export function capTitle(caps, key, fallback) {
  const g = gate(caps, key)
  return g.enabled ? (fallback ?? '') : g.reason
}

/* —— DOM 助手 —— */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'html') node.innerHTML = v
    else if (k === 'text') node.textContent = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

/* —— chip / 健康徽标 —— */
export function chip(text, cls = '', title = '') {
  return `<span class="chip ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`
}
export function healthChip(lag) {
  const n = Number(lag)
  if (!Number.isFinite(n)) return chip('未知', '')
  if (n <= 100) return chip('<span class="dot"></span>正常', 'ok')
  if (n <= 5000) return chip('<span class="dot"></span>轻微堆积', 'warn')
  return chip('<span class="dot"></span>堆积告警', 'bad')
}
export function lagBar(lag) {
  const n = Number(lag)
  if (!Number.isFinite(n)) return '<span style="color:var(--text-3)">—</span>'
  const pct = Math.min(100, Math.max(3, (Math.log10(n + 1) / 6) * 100))
  const cls = n <= 100 ? '' : n <= 5000 ? 'warn' : 'bad'
  return `<span class="lag-bar" title="堆积 ${fmt.num(n)}"><span class="track"><span class="fill ${cls}" style="width:${pct.toFixed(0)}%"></span></span>${fmt.compact(n)}</span>`
}

/* —— 通用表格渲染 ——
 * columns: [{ key, title, num?, width?, render?(row) }]
 * 返回 { root, update(rows), setSelected(key) }
 */
export function simpleGrid({ columns, rowKey, onRowClick, onRowCtx, onRowDblClick, emptyText = '暂无数据' }) {
  const tbody = el('tbody')
  const table = el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, columns.map(c => el('th', {
      class: c.num ? 'num' : '', ...(c.width ? { style: `width:${c.width}` } : {})
    }, c.title)))]),
    tbody
  ])
  const wrap = el('div', { class: 'table-wrap' }, [table])
  let current = []
  let selectedKey = null
  function update(rows) {
    current = rows
    tbody.innerHTML = ''
    if (!rows.length) {
      tbody.appendChild(el('tr', { class: 'empty-row' }, [el('td', { colspan: String(columns.length) }, emptyText)]))
      return
    }
    for (const row of rows) {
      const key = String(rowKey(row))
      const tr = el('tr', {
        class: row.__dim ? 'dim' : '',
        onclick: () => { setSelected(key); onRowClick?.(row) },
        ondblclick: () => onRowDblClick?.(row),
        oncontextmenu: (e) => { e.preventDefault(); setSelected(key); onRowCtx?.(e, row) }
      })
      if (key === selectedKey) tr.classList.add('sel')
      for (const c of columns) {
        const value = c.render ? c.render(row) : row[c.key]
        tr.appendChild(el('td', { class: `${c.num ? 'num' : ''} ${c.mono ? 'name' : ''}` }).html?.())
        // 直接 innerHTML 赋值（render 输出已 escapeHtml 或受控片段）
        const td = tr.lastChild
        td.innerHTML = value === undefined || value === null || value === '' ? '<span style="color:var(--text-3)">—</span>' : String(value)
      }
      tr.dataset.key = key
      tbody.appendChild(tr)
    }
  }
  function setSelected(key) {
    selectedKey = key
    for (const tr of tbody.children) tr.classList.toggle('sel', tr.dataset.key === key)
  }
  function getSelectedRow() { return current.find(r => String(rowKey(r)) === selectedKey) ?? null }
  return { root: wrap, update, setSelected, getSelectedRow }
}

/* —— 两段式危险确认（输入名称 / 二次确认弹窗）——
 * 返回 true=用户确认执行。风格走 @workbench createDialog（按钮右对齐、间距统一）。
 */
export async function confirmDanger({ title, message, requireText, confirmLabel = '确认执行' }) {
  return new Promise(resolve => {
    const body = el('div', {}, [])
    if (message) body.appendChild(el('p', { style: 'font-size:12.5px;color:var(--text-2);line-height:1.7;margin-bottom:14px' }, message))
    let input = null
    if (requireText) {
      body.appendChild(el('div', { class: 'form-row' }, [
        el('label', {}, `输入 ${requireText} 以确认：`),
        (input = el('input', { type: 'text', placeholder: requireText, autocomplete: 'off' }))
      ]))
    }
    const footer = el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;padding-top:4px' })
    const dlg = createDialog({
      title,
      className: 'mw-danger-dialog',
      onClose: () => resolve(false)
    })
    // createDialog 的 content 支持 HTML 字符串；按钮区固定右对齐
    const hint = requireText
      ? `<p class="mw-confirm-msg">${escapeHtml(message ?? '')}</p><div class="form-row"><label>输入 <b>${escapeHtml(requireText)}</b> 以确认：</label><input type="text" data-confirm-input placeholder="${escapeHtml(requireText)}" autocomplete="off" /></div>`
      : `<p class="mw-confirm-msg">${escapeHtml(message ?? '')}</p>`
    dlg.body.innerHTML = hint
    dlg.footer.innerHTML = ''
    const cancel = el('button', { class: 'btn', onclick: () => { dlg.close(); resolve(false) } }, '取消')
    const ok = el('button', {
      class: 'btn danger',
      onclick: () => {
        if (requireText) {
          const val = dlg.body.querySelector('[data-confirm-input]')?.value?.trim()
          if (val !== requireText) { dlg.body.querySelector('[data-confirm-input]')?.focus(); return }
        }
        dlg.close()
        resolve(true)
      }
    }, confirmLabel)
    footer.append(cancel, ok)
    dlg.footer.appendChild(footer)
    body.remove()
    setTimeout(() => dlg.body.querySelector('[data-confirm-input]')?.focus(), 30)
  })
}

/* —— 普通信息弹窗（详情/表单宿主）——
 * 返回 { close, body, footer }
 */
export function infoDialog({ title, width = 520 }) {
  const dlg = createDialog({ title, className: 'mw-info-dialog' })
  if (width) dlg.root.style.maxWidth = `${width}px`
  dlg.footer.innerHTML = ''
  dlg.footer.appendChild(el('div', { style: 'display:flex;gap:10px;justify-content:flex-end;width:100%' }))
  return dlg
}

/* —— 右键菜单 ——
 * items: [{ label, icon?, danger?, disabled?, onClick }] 或 'hr'
 */
export function showContextMenu(x, y, items) {
  const root = document.getElementById('ctx-root')
  root.innerHTML = ''
  const menu = el('div', { class: 'ctxmenu' })
  for (const item of items) {
    if (item === 'hr') { menu.appendChild(el('hr')); continue }
    menu.appendChild(el('button', {
      class: `mi ${item.danger ? 'danger' : ''}`,
      disabled: item.disabled ? '' : undefined,
      title: item.disabled ? item.reason ?? '不可用' : undefined,
      onclick: () => { hide(); if (!item.disabled) item.onClick?.() }
    }, `${item.icon ? item.icon + ' ' : ''}${item.label}`))
  }
  root.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
  function hide(e) {
    if (e && menu.contains(e.target)) return
    root.innerHTML = ''
    document.removeEventListener('mousedown', hide)
    window.removeEventListener('blur', hide)
  }
  setTimeout(() => document.addEventListener('mousedown', hide), 0)
  window.addEventListener('blur', hide)
}

/* —— JSON 高亮（文本安全：先 escape 再着色）—— */
export function payloadHighlight(text) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const pretty = JSON.stringify(JSON.parse(trimmed), null, 2)
      return escapeHtml(pretty).replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        m => {
          let cls = 'j-n'
          if (/^"/.test(m)) cls = /:$/.test(m) ? 'j-k' : 'j-s'
          else if (/true|false|null/.test(m)) cls = 'j-b'
          return `<span class="${cls}">${m}</span>`
        }
      )
    } catch { /* 非法 JSON 走纯文本 */ }
  }
  return escapeHtml(raw)
}

/* —— sparkline 迷你趋势 —— */
export function sparkline(values, { stroke = 'var(--accent)', width = 160, height = 28 } = {}) {
  const pts = (values ?? []).map(Number).filter(Number.isFinite)
  if (pts.length < 2) return ''
  const max = Math.max(...pts), min = Math.min(...pts)
  const span = max - min || 1
  const step = width / (pts.length - 1)
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/><circle cx="${width - 1}" cy="${(height - 3 - ((last - min) / span) * (height - 6)).toFixed(1)}" r="2.2" fill="${stroke}"/></svg>`
}
