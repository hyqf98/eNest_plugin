/**
 * modelMenu.mjs — composer 的模型座（对齐 deepseek-harness 的 ModelSelect）
 *
 * 两级下拉，和 DSH 的交互一致：
 *   · 根菜单 = 「模型」「思考程度」两行（标签 + 当前值 + 右箭头）
 *   · 点进各自钻进列表：模型列表按供应商分组、超过 4 条显示搜索；
 *     思考程度列表列出该供应商声明的档位
 *   · Escape / Shift+Tab 先退回根菜单，再关；↑/↓ 在行间移动；Enter 选中
 *
 * 触发按钮只显示「模型名 · 档位」（档位用 caption 色，空间不足时先省略档位），
 * 与 DSH 的 trigger 语义一致。
 *
 * 数据面：listProviders() 给供应商列表；当前选中项存在 state.ui 里
 * （aiModelProviderId 缺省时取 isDefault），思考程度存 aiReasoningEffort。
 */

import { listProviders, defaultProvider, normalizeBaseUrl, REASONING_EFFORTS, effortName } from './models.mjs'
import { state, setUiPref } from '../store.js'

const esc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** 当前生效的供应商：用户显式选过的优先，否则取默认。 */
export function currentProvider(providers) {
  const wanted = state.ui.aiModelProviderId
  return providers.find((p) => p.id === wanted) || defaultProvider(providers)
}

/** 触发按钮上的文字：「模型名 · 档位」。 */
export function modelTriggerLabel(provider, effort) {
  if (!provider) return '配置模型'
  const name = provider.model || provider.name || '未命名模型'
  const supportsEffort = (provider.reasoningEfforts || []).length > 0
  return supportsEffort ? `${name} · ${effortName(effort)}` : name
}

/**
 * 挂载模型座。
 * @param root 承载触发按钮的容器
 * @param options.onChange 选择变化后回调（用于持久化后刷新界面）
 * @returns { refresh, destroy }
 */
export function mountModelMenu(root, { onChange } = {}) {
  let providers = []
  let open = false
  let pane = 'root' // root | model | effort
  let query = ''
  let highlighted = 0
  let menuEl = null
  let removeOutside = null

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'dbai-model-trigger'
  trigger.setAttribute('aria-haspopup', 'menu')
  trigger.setAttribute('aria-expanded', 'false')
  root.append(trigger)

  function currentEffort() {
    const provider = currentProvider(providers)
    const declared = provider?.reasoningEfforts || []
    const wanted = state.ui.aiReasoningEffort
    return declared.includes(wanted) ? wanted : undefined
  }

  function renderTrigger() {
    const provider = currentProvider(providers)
    const effort = currentEffort()
    const label = modelTriggerLabel(provider, effort)
    const supportsEffort = (provider?.reasoningEfforts || []).length > 0
    // 模型名与档位分开着色：档位用 caption 色，和 DSH 的 triggerEffort 一致。
    const name = provider ? (provider.model || provider.name) : '配置模型'
    trigger.innerHTML = provider && supportsEffort
      ? `<span class="dbai-model-name">${esc(name)}</span><span class="dbai-model-effort">${esc(effortName(effort))}</span>`
      : `<span class="dbai-model-name">${esc(label)}</span>`
    trigger.title = label
    trigger.classList.toggle('dbai-unset', !provider)
    trigger.innerHTML += `<svg class="dbai-model-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  }

  async function reload() {
    providers = await listProviders()
    renderTrigger()
    if (open) renderMenu()
  }

  /* ── 菜单 ── */

  function closeMenu(restoreFocus = false) {
    if (!open) return
    open = false
    pane = 'root'
    query = ''
    trigger.setAttribute('aria-expanded', 'false')
    menuEl?.remove()
    menuEl = null
    removeOutside?.()
    removeOutside = null
    if (restoreFocus) trigger.focus()
  }

  function openMenu() {
    open = true
    pane = 'root'
    query = ''
    highlighted = 0
    trigger.setAttribute('aria-expanded', 'true')
    menuEl = document.createElement('div')
    menuEl.className = 'dbai-model-menu'
    menuEl.setAttribute('role', 'menu')
    document.body.append(menuEl)
    renderMenu()
    positionMenu()
    // 点外部关闭；菜单内部点击不关（各行的 onclick 自己决定）
    removeOutside = () => document.removeEventListener('pointerdown', onOutside, true)
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0)
    menuEl.querySelector('button')?.focus()
  }

  function onOutside(event) {
    if (menuEl?.contains(event.target) || trigger.contains(event.target)) return
    closeMenu()
  }

  /** 贴着触发按钮上方展开（composer 在底部，向上弹更自然）。 */
  function positionMenu() {
    if (!menuEl) return
    const rect = trigger.getBoundingClientRect()
    const gap = 6
    const width = Math.max(240, Math.min(360, rect.width + 120))
    menuEl.style.width = `${width}px`
    const height = menuEl.offsetHeight
    let left = rect.left
    let top = rect.top - height - gap
    if (top < 8) top = rect.bottom + gap // 上方放不下就向下
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
    menuEl.style.left = `${left}px`
    menuEl.style.top = `${top}px`
  }

  function effortChoices() {
    const provider = currentProvider(providers)
    const declared = provider?.reasoningEfforts || []
    // 只列该供应商声明支持的档位；一个都没声明就不展示思考程度行。
    return REASONING_EFFORTS.filter((item) => item.id === undefined || declared.includes(item.id))
  }

  function renderMenu() {
    if (!menuEl) return
    const provider = currentProvider(providers)
    const effort = currentEffort()

    if (pane === 'root') {
      const canEffort = (provider?.reasoningEfforts || []).length > 0
      menuEl.innerHTML = `
        <button type="button" role="menuitem" class="dbai-menu-cell" data-pane="model">
          <span class="dbai-cell-label">模型</span>
          <span class="dbai-cell-value">${esc(provider ? (provider.model || provider.name) : '未配置')}</span>
          <span class="dbai-cell-chevron" aria-hidden="true">›</span>
        </button>
        ${canEffort ? `
        <button type="button" role="menuitem" class="dbai-menu-cell" data-pane="effort">
          <span class="dbai-cell-label">思考程度</span>
          <span class="dbai-cell-value">${esc(effortName(effort))}</span>
          <span class="dbai-cell-chevron" aria-hidden="true">›</span>
        </button>` : ''}
        <button type="button" role="menuitem" class="dbai-menu-config" data-pane="settings">配置供应商…</button>
      `
      menuEl.querySelectorAll('[data-pane]').forEach((button) => {
        button.onclick = () => {
          const next = button.dataset.pane
          if (next === 'settings') {
            closeMenu()
            document.dispatchEvent(new CustomEvent('database-open-settings', { detail: { section: 'ai' } }))
            return
          }
          pane = next
          query = ''
          highlighted = 0
          renderMenu()
          positionMenu()
          menuEl.querySelector('.dbai-menu-search input')?.focus()
        }
      })
      return
    }

    if (pane === 'model') {
      const showSearch = providers.length > 4
      const filtered = query
        ? providers.filter((p) => `${p.name} ${p.model} ${p.baseUrl}`.toLowerCase().includes(query.toLowerCase()))
        : providers
      const rows = filtered.map((p, index) => {
        const selected = p.id === provider?.id
        return `
          <button type="button" role="menuitemradio" aria-checked="${selected}"
                  class="dbai-menu-option${selected ? ' selected' : ''}${index === highlighted ? ' active' : ''}"
                  data-provider="${esc(p.id)}">
            <span class="dbai-option-copy">
              <span class="dbai-option-name">${esc(p.model || p.name)}</span>
              <span class="dbai-option-meta">${esc(p.name)} · ${esc(normalizeBaseUrl(p.baseUrl).replace(/^https?:\/\//, ''))}</span>
            </span>
            <span class="dbai-option-check">${selected ? '✓' : ''}</span>
          </button>`
      }).join('')
      menuEl.innerHTML = `
        ${showSearch ? `<div class="dbai-menu-search"><input type="search" placeholder="搜索模型" aria-label="搜索模型" value="${esc(query)}"></div>` : ''}
        <div class="dbai-menu-groups">${rows || '<div class="dbai-menu-empty">没有匹配的模型</div>'}</div>
      `
      const input = menuEl.querySelector('.dbai-menu-search input')
      if (input) {
        input.oninput = () => { query = input.value; highlighted = 0; renderMenu(); positionMenu(); menuEl.querySelector('.dbai-menu-search input')?.focus() }
      }
      menuEl.querySelectorAll('[data-provider]').forEach((button) => {
        button.onclick = async () => {
          setUiPref('aiModelProviderId', button.dataset.provider)
          await reload()
          closeMenu(true)
          onChange?.()
        }
      })
      return
    }

    // pane === 'effort'
    const choices = effortChoices()
    const rows = choices.map((item, index) => {
      const selected = item.id === effort
      return `
        <button type="button" role="menuitemradio" aria-checked="${selected}"
                class="dbai-menu-option${selected ? ' selected' : ''}${index === highlighted ? ' active' : ''}"
                data-effort="${item.id ?? ''}">
          <span class="dbai-option-copy">
            <span class="dbai-option-name">${esc(item.name)}</span>
            ${item.hint ? `<span class="dbai-option-meta">${esc(item.hint)}</span>` : ''}
          </span>
          <span class="dbai-option-check">${selected ? '✓' : ''}</span>
        </button>`
    }).join('')
    menuEl.innerHTML = `<div class="dbai-menu-groups">${rows || '<div class="dbai-menu-empty">该供应商未声明思考程度</div>'}</div>`
    menuEl.querySelectorAll('[data-effort]').forEach((button) => {
      button.onclick = async () => {
        const value = button.dataset.effort || undefined
        setUiPref('aiReasoningEffort', value)
        await reload()
        closeMenu(true)
        onChange?.()
      }
    })
  }

  /** 键盘：↑/↓ 移动、Enter 激活、Escape/Shift+Tab 逐级退出。 */
  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (open && pane !== 'root') { pane = 'root'; query = ''; renderMenu(); positionMenu(); return }
      closeMenu(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const rows = [...menuEl.querySelectorAll('.dbai-menu-option, .dbai-menu-cell')]
      if (!rows.length) return
      highlighted = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      rows.forEach((row, index) => row.classList.toggle('active', index === highlighted))
      rows[highlighted]?.focus()
      return
    }
    if (event.key === 'Enter') {
      const active = menuEl.querySelector('.dbai-menu-option.active, .dbai-menu-cell.active') || document.activeElement
      if (active && menuEl.contains(active) && active.tagName === 'BUTTON') {
        event.preventDefault()
        active.click()
      }
    }
  }

  trigger.onclick = () => { open ? closeMenu(true) : openMenu() }
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) openMenu()
    } else {
      onKeyDown(event)
    }
  })
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('resize', () => { if (open) positionMenu() })

  void reload()

  return {
    refresh: () => { void reload() },
    destroy() {
      closeMenu()
      document.removeEventListener('keydown', onKeyDown, true)
      trigger.remove()
    }
  }
}
