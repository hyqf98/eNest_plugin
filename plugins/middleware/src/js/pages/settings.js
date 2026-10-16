import { el } from '@mw/components.js'
import { COMMANDS, commands, displayShortcut, shortcutFor, shortcutFromEvent, isComposing, validateBindings } from '@mw/commands.js'
import { RULE_KINDS, PROTOCOLS } from '@mw/completionRules.js'
import { readProductivity, validateProductivity } from '@mw/preferences.js'

/** A retained workspace page: drafts never share state with the live completion engine. */
export default {
  id: 'settings',
  render(root, { store, api }) {
    let draft = structuredClone(readProductivity(store.ui.productivity)), baseline = JSON.stringify(draft)
    let section = 'shortcuts', selectedRule = draft.completion.rules[0]?.id, saving = false, search = ''
    const dirty = () => JSON.stringify(draft) !== baseline
    const status = el('span', { class: 'mw-settings-status', role: 'status', 'data-settings-status': '' })
    const save = el('button', { class: 'btn primary', 'data-save-settings': '', onclick: saveDraft }, '保存设置')
    const discard = el('button', { class: 'btn', 'data-discard-settings': '', onclick: () => { draft = JSON.parse(baseline); renderSection(); changed() } }, '放弃修改')
    const content = el('div', { class: 'mw-settings-content' })
    const nav = el('nav', { class: 'mw-settings-nav', 'aria-label': '设置分类' }, [
      ...[['shortcuts', '快捷键'], ['completion', '输入提示规则']].map(([id, name]) => el('button', { 'data-settings-section': id, onclick: () => { section = id; renderSection() } }, name))
    ])
    root.classList.add('mw-settings-page')
    root.append(el('header', { class: 'mw-settings-header' }, [el('div', {}, [el('h1', {}, '中间件设置'), el('p', {}, '快捷键与提示规则仅作用于此插件。')]), status, discard, save]), el('div', { class: 'mw-settings-layout' }, [nav, content]))
    function changed(message) {
      status.textContent = message || (dirty() ? '有未保存修改' : '已保存')
      status.dataset.state = 'idle'; discard.disabled = !dirty() || saving; save.disabled = saving || !dirty()
    }
    function feedback(error) { status.textContent = error.message || String(error); status.dataset.state = 'error' }
    async function saveDraft() {
      if (saving) return
      let next
      try { next = validateProductivity(draft) } catch (error) { feedback(error); return }
      const submittedDraft = JSON.stringify(draft)
      saving = true; changed('正在保存…')
      try {
        const saved = await store.saveProductivity(next)
        baseline = JSON.stringify(saved)
        if (JSON.stringify(draft) === submittedDraft) { draft = structuredClone(saved); renderSection() }
        commands.configure(saved.shortcuts)
        document.dispatchEvent(new CustomEvent('mw-productivity-changed'))
        saving = false; changed(dirty() ? '已保存；还有未保存修改' : '已保存并应用')
      } catch (error) { saving = false; changed(); feedback(new Error(`保存失败：${error.message}。输入已保留，可重试。`)) }
    }
    this.beforeClose = () => { if (!dirty() && !saving) return true; void api.toast('设置还有未保存修改，请保存或放弃修改后再关闭标签', 'warn'); return false }

    function renderSection() {
      nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-current', button.dataset.settingsSection === section ? 'page' : 'false'))
      content.replaceChildren()
      if (section === 'shortcuts') renderShortcuts()
      else renderRules()
    }
    function setBinding(id, value, input) {
      try { draft.shortcuts = validateBindings({ ...draft.shortcuts, [id]: value }); input.value = value ? displayShortcut(value) : ''; changed() }
      catch (error) { feedback(error) }
    }
    function renderShortcuts() {
      const filter = el('input', { type: 'search', value: search, placeholder: '搜索名称、作用域或快捷键', 'aria-label': '搜索快捷键', 'data-shortcut-search': '' })
      const list = el('div', { class: 'mw-shortcut-list' })
      const renderList = () => {
        list.replaceChildren()
        const query = search.toLowerCase()
        for (const command of COMMANDS.filter(item => `${item.label} ${item.group} ${displayShortcut(shortcutFor(item.id, draft.shortcuts))}`.toLowerCase().includes(query))) {
          const value = shortcutFor(command.id, draft.shortcuts)
          const input = el('input', { readonly: '', value: value ? displayShortcut(value) : '', placeholder: '未设置', 'aria-label': `${command.label}快捷键`, 'data-mw-shortcut': command.id })
          input.addEventListener('keydown', event => {
            if (isComposing(event) || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
            if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return
            event.preventDefault(); event.stopPropagation()
            if (event.key === 'Escape') { input.blur(); return }
            const value = ['Backspace', 'Delete'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey ? '' : shortcutFromEvent(event)
            setBinding(command.id, value, input)
          })
          list.append(el('div', { class: 'mw-shortcut-row', 'data-shortcut-row': command.id }, [
            el('div', {}, [el('strong', {}, command.label), el('small', {}, `${command.group} · 默认 ${displayShortcut(command.shortcut)}`)]), input,
            el('button', { class: 'btn ghost sm', 'aria-label': `清除${command.label}快捷键`, 'data-clear-shortcut': command.id, onclick: () => setBinding(command.id, '', input) }, '清除'),
            el('button', { class: 'btn ghost sm', 'aria-label': `恢复${command.label}快捷键`, 'data-reset-shortcut': command.id, onclick: () => setBinding(command.id, command.shortcut, input) }, '恢复')
          ]))
        }
        if (!list.childElementCount) list.append(el('p', { class: 'mw-settings-help' }, '没有匹配的快捷键'))
      }
      filter.addEventListener('input', () => { search = filter.value; renderList() })
      content.append(el('h2', {}, '快捷键'), el('p', { class: 'mw-settings-help' }, '点击输入框并按组合键。只在对应任务或编辑器内生效；输入法选词、文本编辑和提示列表的 Enter / Tab / Escape 保留原行为。'),
        el('div', { class: 'mw-settings-toolbar' }, [filter, el('button', { class: 'btn', 'data-reset-shortcuts': '', onclick: () => { draft.shortcuts = {}; renderList(); changed() } }, '恢复全部默认')]), list)
      renderList()
    }
    function renderRules() {
      const auto = el('input', { type: 'checkbox', 'data-completion-auto': '' }); auto.checked = draft.completion.autoSuggest
      const builtins = el('input', { type: 'checkbox', 'data-completion-builtins': '' }); builtins.checked = draft.completion.builtins
      auto.onchange = () => { draft.completion.autoSuggest = auto.checked; changed() }
      builtins.onchange = () => { draft.completion.builtins = builtins.checked; changed() }
      const type = el('select', { 'aria-label': '新增规则类型', 'data-new-rule-kind': '' }, Object.entries(RULE_KINDS).map(([value, label]) => el('option', { value }, label)))
      const list = el('div', { class: 'mw-rule-list', 'aria-label': '自定义提示规则' }), editor = el('div', { class: 'mw-rule-editor' })
      content.append(el('h2', {}, '输入提示规则'), el('p', { class: 'mw-settings-help' }, '规则只提供可选文本，不发送消息或执行脚本。保存后立即应用到已打开的任务。'),
        el('div', { class: 'mw-completion-options' }, [el('label', {}, [auto, ' 输入时自动提示']), el('label', {}, [builtins, ' 显示内置与当前连接的候选'])]),
        el('div', { class: 'mw-settings-toolbar' }, [type, el('button', { class: 'btn', 'data-add-rule': '', onclick: () => {
          if (draft.completion.rules.length >= 200) return feedback(new Error('提示规则最多 200 条'))
          const rule = { id: store.uid('rule'), enabled: true, kind: type.value, label: `新${RULE_KINDS[type.value]}规则`, trigger: '', value: '', field: '', connectionId: '', protocol: '' }
          draft.completion.rules.push(rule); selectedRule = rule.id; renderList(); renderEditor(); changed()
        } }, '＋ 新增规则')]), el('div', { class: 'mw-rules-layout' }, [list, editor]))
      function renderList() {
        list.replaceChildren()
        for (const rule of draft.completion.rules) {
          const connection = store.getConnection(rule.connectionId)
          list.append(el('button', { class: 'mw-rule-item', 'data-rule-id': rule.id, 'aria-pressed': String(rule.id === selectedRule), onclick: () => { selectedRule = rule.id; renderList(); renderEditor() } }, [
            el('strong', {}, rule.label || '未命名规则'), el('small', {}, [RULE_KINDS[rule.kind], rule.protocol || '全部协议', connection?.name || (rule.connectionId ? '已删除连接' : '全部连接'), rule.enabled ? '' : '已停用'].filter(Boolean).join(' · '))
          ]))
        }
        if (!draft.completion.rules.length) list.append(el('p', { class: 'mw-settings-help' }, '尚无自定义规则。可添加 Topic 别名、环境模板或常用 JSON 字段和值。'))
      }
      function renderEditor() {
        editor.replaceChildren()
        const rule = draft.completion.rules.find(item => item.id === selectedRule)
        if (!rule) { editor.append(el('p', { class: 'mw-settings-help' }, '选择规则以编辑内容和适用范围。')); return }
        const enabled = el('input', { type: 'checkbox', 'data-rule-enabled': '' }); enabled.checked = rule.enabled
        enabled.onchange = () => { rule.enabled = enabled.checked; renderList(); changed() }
        editor.append(el('div', { class: 'mw-rule-editor-head' }, [el('label', {}, [enabled, ' 启用此规则']), el('button', { class: 'btn ghost sm', 'data-delete-rule': '', onclick: () => { draft.completion.rules = draft.completion.rules.filter(item => item.id !== rule.id); selectedRule = draft.completion.rules[0]?.id; renderList(); renderEditor(); changed() } }, '删除规则')]))
        const form = el('div', { class: 'mw-rule-form' })
        const validation = el('p', { class: 'mw-rule-validation', role: 'status' })
        const preview = el('code', { class: 'mw-rule-preview', 'data-rule-preview': '' })
        const update = () => {
          changed(); renderList(); preview.textContent = rule.value || '填写内容后显示插入预览'
          try { validateProductivity(draft); validation.textContent = '规则有效，保存后生效'; validation.dataset.state = 'valid' }
          catch (error) { validation.textContent = error.message; validation.dataset.state = 'error' }
        }
        const field = (key, label, options = {}) => {
          const input = el(options.multiline ? 'textarea' : 'input', { ...(!options.multiline ? { type: 'text' } : { rows: '3' }), value: rule[key], placeholder: options.placeholder || '', 'data-rule-field': key, 'aria-label': label })
          if (options.multiline) input.value = rule[key]
          input.oninput = () => { rule[key] = input.value; update() }
          form.append(el('label', { class: options.wide ? 'wide' : '' }, [el('span', {}, label), input]))
        }
        field('label', '规则名称'); field('trigger', '触发词 / 别名（可选）', { placeholder: '例如 order、created' })
        const protocol = el('select', { 'data-rule-field': 'protocol', 'aria-label': '适用协议' }, [el('option', { value: '' }, '全部协议'), ...PROTOCOLS.map(value => el('option', { value }, value))]); protocol.value = rule.protocol
        const connections = [...store.connections]
        if (rule.connectionId && !connections.some(item => item.id === rule.connectionId)) connections.push({ id: rule.connectionId, name: '已删除连接（规则不会生效）' })
        const connection = el('select', { 'data-rule-field': 'connectionId', 'aria-label': '适用连接' }, [el('option', { value: '' }, '全部连接'), ...connections.map(item => el('option', { value: item.id }, item.name || item.id))]); connection.value = rule.connectionId
        protocol.onchange = () => { rule.protocol = protocol.value; update() }; connection.onchange = () => { rule.connectionId = connection.value; update() }
        form.append(el('label', {}, [el('span', {}, '适用协议'), protocol]), el('label', {}, [el('span', {}, '适用连接'), connection]))
        if (rule.kind === 'jsonValue') field('field', '匹配字段 / 路径', { wide: true, placeholder: 'status 或 customer.status' })
        if (rule.kind === 'jsonKey') field('field', '对象路径（可选）', { wide: true, placeholder: '留空匹配所有对象，例如 customer' })
        field('value', ({ topic: 'Topic / 队列名称或模板', header: 'Header 名称', jsonKey: 'JSON 字段名称', jsonValue: 'JSON 字段值' })[rule.kind], { wide: true, multiline: rule.kind === 'jsonValue', placeholder: rule.kind === 'jsonValue' ? '"created"、true、200 或 JSON 对象' : rule.kind === 'topic' ? 'orders.${environment}' : '' })
        const help = rule.kind === 'topic' ? '模板变量：${connection.id}、${connection.name}、${environment}、${protocol}、${input}。均按普通文本替换。' : rule.kind === 'jsonValue' ? '字符串需加双引号。字段路径按 JSON 大小写精确匹配，候选不会覆盖字段以外的内容。' : '字段名称会按 JSON 字符串转义。连接与协议范围同时满足时才提供候选。'
        editor.append(form, el('p', { class: 'mw-settings-help' }, help), el('small', {}, '插入内容'), preview, validation)
        preview.textContent = rule.value || '填写内容后显示插入预览'
      }
      renderList(); renderEditor()
    }
    renderSection(); changed()
  }
}
