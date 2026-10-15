;(() => {
  const api = window.enest || window.zapi,
    $ = (id) => document.getElementById(id),
    esc = PluginKit.escape,
    KEY = 'todos_v2'
  let tasks = [],
    query = '',
    view = 'all',
    list = '全部清单',
    selected = '',
    checked = new Set(),
    ready = false,
    undo = null,
    lists = ['收件箱'],
    saveTimer
  const labels = {
    all: '全部',
    today: '今天',
    important: '重要',
    done: '已完成',
    archived: '归档',
  }
  const kit = PluginKit.create({
    title: '待办清单',
    quickPlaceholder: '搜索待办，回车完成选中任务',
    height: 480,
    defaults: { defaultView: 'all', showCompleted: false },
    onQuery: (value) => {
      query = value
      render()
    },
    onAction: (action) => {
      if (!ready) return
      const rows = visible()
      let i = rows.findIndex((t) => t.id === selected)
      if (action === 'next' || action === 'previous') {
        i = Math.max(
          0,
          Math.min(rows.length - 1, i + (action === 'next' ? 1 : -1)),
        )
        selected = rows[i]?.id || ''
        render()
      }
      if (action === 'submit' && selected) toggle(selected)
    },
  })
  const uid = () => globalThis.crypto.randomUUID(),
    today = () => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
  // order 为可选字段：旧数据没有 order 时走默认排序，完全向后兼容
  const normalize = (t) => ({
    id: typeof t.id === 'string' ? t.id : uid(),
    text: String(t.text || '').slice(0, 500),
    done: !!t.done,
    pinned: !!t.pinned,
    createdAt: Number(t.createdAt) || Date.now(),
    updatedAt: Number(t.updatedAt) || Date.now(),
    due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : '',
    priority: ['normal', 'high', 'low'].includes(t.priority)
      ? t.priority
      : 'normal',
    list: String(t.list || '收件箱'),
    tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
    note: String(t.note || ''),
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks
          .filter((s) => s && typeof s.text === 'string')
          .map((s) => ({ text: s.text, done: !!s.done }))
      : [],
    archived: !!t.archived,
    order: Number.isFinite(t.order) ? t.order : null,
  })
  async function persist() {
    if (!ready) return
    $('save-state').textContent = '保存中…'
    try {
      await kit.save(KEY, { version: 2, tasks, lists })
      $('save-state').textContent = '已保存'
    } catch (e) {
      $('save-state').textContent = '保存失败 · 点击重试'
      kit.toast(e.message, 'error')
    }
  }
  function save() {
    clearTimeout(saveTimer)
    void persist()
  }
  function visible() {
    const day = today(),
      hasOrder = tasks.some((t) => t.order !== null)
    return tasks
      .filter(
        (t) =>
          (list === '全部清单' || t.list === list) &&
          (view === 'archived' ? t.archived : !t.archived) &&
          (view === 'done'
            ? t.done
            : view === 'today'
              ? !t.done && t.due && t.due <= day
              : view === 'important'
                ? !t.done && (t.pinned || t.priority === 'high')
                : view === 'all'
                  ? kit.settings.showCompleted || !t.done
                  : true) &&
          `${t.text} ${t.note} ${t.tags.join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .sort((a, b) => {
        if (Number(a.done) !== Number(b.done)) return Number(a.done) - Number(b.done)
        if (hasOrder) {
          // 手动排序：order 值小在前，null 兜底按时间（完成项始终沉底）
          const ao = a.order ?? Number.MAX_SAFE_INTEGER,
            bo = b.order ?? Number.MAX_SAFE_INTEGER
          if (ao !== bo) return ao - bo
        }
        return (
          Number(b.pinned) - Number(a.pinned) ||
          Number(b.priority === 'high') - Number(a.priority === 'high') ||
          (a.due || '9999').localeCompare(b.due || '9999') ||
          b.createdAt - a.createdAt
        )
      })
  }
  function dueState(t) {
    if (!t.due || t.done) return ''
    const day = today()
    if (t.due < day) return 'overdue'
    if (t.due === day) return 'due-today'
    return ''
  }
  function dueLabel(t) {
    if (!t.due) return ''
    const day = today(),
      state = dueState(t)
    if (state === 'overdue') return `已过期 ${t.due.slice(5)}`
    if (state === 'due-today') return '今天到期'
    return t.due
  }
  function render() {
    const day = today(),
      open = tasks.filter((t) => !t.done && !t.archived)
    // 统计条口径：今日完成 / 今日全部（未完成且到期≤今天 + 今天完成过的）
    const doneToday = tasks.filter(
        (t) => t.done && !t.archived && t.updatedAt && sameDay(t.updatedAt),
      ).length,
      pendingToday = tasks.filter(
        (t) => !t.done && !t.archived && t.due && t.due <= day,
      ).length,
      totalToday = doneToday + pendingToday,
      pct = totalToday ? Math.round((doneToday / totalToday) * 100) : 0
    $('day-fill').style.width = pct + '%'
    $('day-label').innerHTML = totalToday
      ? `今日 <b>${doneToday}</b>/${totalToday}`
      : '今日 0/0'
    $('filters').innerHTML = Object.entries(labels)
      .map(([key, label]) => {
        const count = countFor(key)
        return `<button data-view="${key}" class="${view === key ? 'active' : ''}">${label}${count ? `<span class="f-count">${count}</span>` : ''}</button>`
      })
      .join('')
    $('lists').innerHTML = ['全部清单', ...lists]
      .map((name) => {
        const count =
          name === '全部清单'
            ? open.length
            : tasks.filter((t) => t.list === name && !t.done && !t.archived)
                .length
        return `<button data-list="${esc(name)}" class="${name === list ? 'active' : ''}">${esc(name)}${count ? `<span class="nav-count">${count}</span>` : ''}</button>`
      })
      .join('')
    const rows = visible()
    if (!rows.some((t) => t.id === selected)) selected = rows[0]?.id || ''
    $('tasks').innerHTML = rows.length
      ? rows
          .map((t) => taskRow(t, day))
          .join('')
      : '<div class="empty">' + emptyArt() + '这里已整理好<br><small>添加新任务，或换个筛选看看</small></div>'
    $('count').textContent = `${rows.length} 条 · ${open.length} 待完成`
    $('quick-count').textContent = open.length
    if ($('detail').classList.contains('open') || kit.mode === 'shell')
      renderDetail()
  }
  function sameDay(ts) {
    const d = new Date(ts),
      n = new Date()
    return (
      d.getFullYear() === n.getFullYear() &&
      d.getMonth() === n.getMonth() &&
      d.getDate() === n.getDate()
    )
  }
  function countFor(key) {
    const day = today()
    if (key === 'all')
      return tasks.filter(
        (t) => !t.done && !t.archived && (kit.settings.showCompleted || !t.done),
      ).length
    if (key === 'today')
      return tasks.filter((t) => !t.done && !t.archived && t.due && t.due <= day)
        .length
    if (key === 'important')
      return tasks.filter(
        (t) => !t.done && !t.archived && (t.pinned || t.priority === 'high'),
      ).length
    if (key === 'done')
      return tasks.filter((t) => t.done && !t.archived).length
    if (key === 'archived') return tasks.filter((t) => t.archived).length
    return 0
  }
  function taskRow(t, day) {
    const ds = dueState(t),
      subDone = t.subtasks.filter((s) => s.done).length,
      subAll = t.subtasks.length
    return `<div class="task ${t.done ? 'done' : ''} ${selected === t.id ? 'selected' : ''}" role="listitem" data-id="${esc(t.id)}" tabindex="0"><span class="drag-handle shell-only" data-act="drag" aria-label="拖动排序" title="拖动排序">⠿</span><input class="shell-only" type="checkbox" data-act="select" aria-label="选择任务" ${checked.has(t.id) ? 'checked' : ''}><button class="check" data-act="done" aria-label="${t.done ? '标记未完成' : '完成任务'}">${t.done ? '✓' : ''}</button><div class="task-body"><div class="task-title">${esc(t.text)}</div><div class="meta">${t.due ? `<span class="${ds}">${esc(dueLabel(t))}</span>` : ''}<span>${esc(t.list)}</span>${t.priority === 'high' ? '<span class="flag">⚑ 高优先级</span>' : ''}${subAll ? `<span class="subtask-progress"><span class="subtask-mini"><i style="width:${Math.round((subDone / subAll) * 100)}%"></i></span>${subDone}/${subAll}</span>` : ''}${t.tags.map((tag) => `<span>#${esc(tag)}</span>`).join('')}</div></div><button data-act="pin" class="pin" aria-label="${t.pinned ? '取消置顶' : '置顶'}">${t.pinned ? '★' : '☆'}</button><button class="remove" data-act="delete" aria-label="删除任务">×</button></div>`
  }
  function emptyArt() {
    return `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="18" y="14" width="60" height="72" rx="8" fill="none" stroke="var(--line)" stroke-width="2.5"/><path d="M30 34h24M30 48h36M30 62h30" stroke="var(--mark)" stroke-width="2.5" stroke-linecap="round" opacity=".55"/><path d="M56 24l6 6 12-12" fill="none" stroke="var(--mark)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  }
  function renderDetail() {
    const t = tasks.find((t) => t.id === selected)
    if (!t) {
      $('detail').innerHTML = '<div class="empty">选择任务，安排下一步</div>'
      return
    }
    const subDone = t.subtasks.filter((s) => s.done).length,
      subAll = t.subtasks.length,
      subPct = subAll ? Math.round((subDone / subAll) * 100) : 0
    $('detail').innerHTML =
      `<div class="detail-actions"><h2>任务详情</h2><button id="close-detail" style="margin-left:auto">收起</button></div><label>任务<input data-field="text" value="${esc(t.text)}" maxlength="500"></label><label>截止日期<input data-field="due" type="date" value="${esc(t.due)}"></label><label>优先级<select data-field="priority">${[
        ['normal', '普通'],
        ['high', '高'],
        ['low', '低'],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}" ${t.priority === v ? 'selected' : ''}>${l}</option>`,
        )
        .join(
          '',
        )}</select></label><label>清单<select data-field="list">${lists.map((l) => `<option ${t.list === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label><label>标签（逗号分隔）<input data-field="tags" value="${esc(t.tags.join(', '))}"></label><label>备注<textarea data-field="note" rows="4">${esc(t.note)}</textarea></label><label>子任务</label>${subAll ? `<div class="sub-progress"><div class="progress-track"><div class="progress-fill" style="width:${subPct}%"></div></div><span>${subDone}/${subAll}</span></div>` : ''}<div>${t.subtasks.map((s, i) => `<div class="subtask"><input type="checkbox" data-sub="${i}" ${s.done ? 'checked' : ''} aria-label="完成子任务"><span ${s.done ? 'style="text-decoration:line-through;color:var(--muted)"' : ''}>${esc(s.text)}</span><button data-remove-sub="${i}" aria-label="删除子任务">×</button></div>`).join('')}</div><form id="subform"><input id="subinput" placeholder="添加子任务" maxlength="300"><button>＋</button></form><div class="detail-actions" style="margin-top:20px"><button id="archive-task">${t.archived ? '恢复到清单' : '归档任务'}</button><button id="delete-task">删除</button></div>`
    $('detail')
      .querySelectorAll('[data-field]')
      .forEach((el) => {
        // kit 自定义下拉同时派发 input+change；原生 select 只派发 change，双监听保证两种形态一致
        const handler = () => {
          const key = el.dataset.field
          t[key] =
            key === 'tags'
              ? el.value
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : el.value
          t.updatedAt = Date.now()
          clearTimeout(saveTimer)
          saveTimer = setTimeout(persist, 250)
        }
        el.addEventListener('input', handler)
        el.addEventListener('change', handler)
      })
    $('detail')
      .querySelectorAll('[data-sub]')
      .forEach(
        (el) =>
          (el.onchange = () => {
            t.subtasks[Number(el.dataset.sub)].done = el.checked
            save()
            render()
          }),
      )
    $('detail')
      .querySelectorAll('[data-remove-sub]')
      .forEach(
        (el) =>
          (el.onclick = () => {
            t.subtasks.splice(Number(el.dataset.removeSub), 1)
            save()
            renderDetail()
          }),
      )
    $('subform').onsubmit = (e) => {
      e.preventDefault()
      const text = $('subinput').value.trim()
      if (text) {
        t.subtasks.push({ text, done: false })
        save()
        renderDetail()
      }
    }
    $('archive-task').onclick = () => {
      checkpoint()
      t.archived = !t.archived
      save()
      render()
    }
    $('delete-task').onclick = () => remove(t.id)
    $('close-detail').onclick = () => {
      $('detail').classList.remove('open')
      if (kit.mode === 'shell')
        $('detail').innerHTML = '<div class="empty">选择任务，安排下一步</div>'
    }
  }
  function remove(id) {
    checkpoint()
    tasks = tasks.filter((t) => t.id !== id)
    checked.delete(id)
    save()
    render()
    kit.toast('任务已删除，可撤销')
  }
  // —— 拖拽排序：Pointer Events + setPointerCapture，1:1 跟随，松手即提交 ——
  const listEl = $('tasks')
  let drag = null
  function rowsIn(el) {
    return [...el.querySelectorAll('.task:not(.dragging)')]
  }
  function commitOrder(orderedIds) {
    checkpoint()
    const now = Date.now()
    orderedIds.forEach((id, i) => {
      const t = tasks.find((t) => t.id === id)
      if (t) {
        t.order = i
        t.updatedAt = now
      }
    })
    save()
  }
  listEl.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-act="drag"]')
    if (!handle || kit.mode !== 'shell') return
    const row = handle.closest('[data-id]')
    if (!row) return
    e.preventDefault()
    row.setPointerCapture(e.pointerId)
    const rect = row.getBoundingClientRect()
    drag = {
      row,
      id: row.dataset.id,
      startY: e.clientY,
      height: rect.height,
      insertAt: -1,
    }
    row.classList.add('dragging')
    rowsIn(listEl).forEach((r) => r.classList.add('shift'))
  })
  listEl.addEventListener('pointermove', (e) => {
    if (!drag) return
    const dy = e.clientY - drag.startY
    drag.row.style.transform = `translateY(${dy}px)`
    const rowRect = drag.row.getBoundingClientRect(),
      center = rowRect.top + rowRect.height / 2
    const others = rowsIn(listEl)
    let insertAt = 0
    others.forEach((other) => {
      const r = other.getBoundingClientRect(),
        mid = r.top + r.height / 2,
        before = drag.row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING
      let shift = 0
      if (before && center > mid) shift = -drag.height
      if (!before && center < mid) shift = drag.height
      other.style.transform = shift ? `translateY(${shift}px)` : ''
      // 让位后的中点在拖行中心之上 → 插入点后移一位
      if (mid + shift < center) insertAt++
    })
    drag.insertAt = insertAt
  })
  const endDrag = () => {
    if (!drag) return
    const { row, id, insertAt } = drag
    row.classList.remove('dragging')
    rowsIn(listEl).forEach((r) => {
      r.classList.remove('shift')
      r.style.transform = ''
    })
    row.style.transform = ''
    drag = null
    if (insertAt < 0) return
    const ids = visible().map((t) => t.id).filter((x) => x !== id)
    ids.splice(Math.min(insertAt, ids.length), 0, id)
    commitOrder(ids)
    render()
  }
  listEl.addEventListener('pointerup', endDrag)
  listEl.addEventListener('pointercancel', endDrag)
  $('composer').onsubmit = (e) => {
    e.preventDefault()
    if (!ready) return
    const text = $('new-task').value.trim()
    if (!text) return
    const t = normalize({
      id: uid(),
      text,
      list: list === '全部清单' ? '收件箱' : list,
    })
    tasks.unshift(t)
    selected = t.id
    view = 'all'
    $('new-task').value = ''
    save()
    render()
    $('new-task').focus()
  }
  $('tasks').onclick = (e) => {
    const row = e.target.closest('[data-id]')
    if (!row) return
    const id = row.dataset.id,
      act = e.target.closest('[data-act]')?.dataset.act,
      t = tasks.find((t) => t.id === id)
    if (act === 'drag') return
    if (act === 'done') return toggle(id)
    if (act === 'delete') return remove(id)
    if (act === 'select') {
      e.target.checked ? checked.add(id) : checked.delete(id)
      return
    }
    if (act === 'pin') {
      t.pinned = !t.pinned
      save()
      render()
      return
    }
    selected = id
    $('detail').classList.add('open')
    render()
  }
  $('tasks').onkeydown = (e) => {
    if (e.isComposing || e.target.matches('input,textarea')) return
    const row = e.target.closest('[data-id]')
    if (row && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault()
      toggle(row.dataset.id)
    }
    // 键盘排序：Ctrl/Cmd + 上下箭头 移动任务
    if (
      row &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      (e.metaKey || e.ctrlKey) &&
      kit.mode === 'shell' &&
      view !== 'archived' && view !== 'done'
    ) {
      e.preventDefault()
      const rows = visible().map((t) => t.id),
        i = rows.indexOf(row.dataset.id),
        j = i + (e.key === 'ArrowUp' ? -1 : 1)
      if (i < 0 || j < 0 || j >= rows.length) return
      ;[rows[i], rows[j]] = [rows[j], rows[i]]
      commitOrder(rows)
      render()
      listEl
        .querySelector(`[data-id="${CSS.escape(row.dataset.id)}"]`)
        ?.focus()
    }
  }
  $('filters').onclick = (e) => {
    if (e.target.dataset.view) {
      view = e.target.dataset.view
      render()
    }
  }
  $('lists').onclick = (e) => {
    if (e.target.dataset.list) {
      list = e.target.dataset.list
      render()
    }
  }
  $('search').oninput = (e) => {
    query = e.target.value
    kit.setQuery(query)
    render()
  }
  $('new-list').onclick = () => {
    $('list-form').hidden = false
    $('list-name').focus()
  }
  $('cancel-list').onclick = () => ($('list-form').hidden = true)
  $('list-form').onsubmit = (e) => {
    e.preventDefault()
    const name = $('list-name').value.trim()
    if (name && !lists.includes(name)) {
      lists.push(name)
      list = name
      $('list-form').hidden = true
      $('list-name').value = ''
      save()
      render()
    }
  }
  $('batch-done').onclick = () => {
    checkpoint()
    tasks.filter((t) => checked.has(t.id)).forEach((t) => (t.done = true))
    checked.clear()
    save()
    render()
  }
  $('batch-archive').onclick = () => {
    checkpoint()
    tasks.filter((t) => checked.has(t.id)).forEach((t) => (t.archived = true))
    checked.clear()
    save()
    render()
  }
  $('clear-done').onclick = () => {
    checkpoint()
    tasks.filter((t) => t.done).forEach((t) => (t.archived = true))
    save()
    render()
  }
  $('undo').onclick = () => {
    if (undo) {
      ;({ tasks, lists } = undo)
      undo = null
      $('undo').hidden = true
      save()
      render()
    }
  }
  $('save-state').onclick = () => void persist()
  $('export').onclick = () =>
    kit
      .saveText(
        '待办清单.json',
        JSON.stringify({ version: 2, tasks, lists }, null, 2),
      )
      .catch((e) => kit.toast(e.message, 'error'))
  $('import').onclick = async () => {
    try {
      const [f] = await api.localFiles.pick({ kind: 'file', access: 'read' })
      if (!f) return
      if (f.size > 5e6) throw Error('导入文件不能超过 5 MB')
      const data = JSON.parse(await api.localFiles.read({ handleId: f.id, encoding: 'text', maxBytes: 5000000 }))
      const incoming = Array.isArray(data) ? data : data.tasks
      if (
        !Array.isArray(incoming) ||
        incoming.some((t) => !t || typeof t.text !== 'string')
      )
        throw Error('任务文件格式不正确')
      checkpoint()
      tasks.push(...incoming.map((t) => normalize({ ...t, id: uid() })))
      lists = [...new Set([...lists, ...tasks.map((t) => t.list)])]
      save()
      render()
      kit.toast(`已导入 ${incoming.length} 条任务`)
    } catch (e) {
      kit.toast(e.message, 'error')
    }
  }
  const initialized = (async () => {
    try {
      await kit.ready
      view = Object.hasOwn(labels, kit.settings.defaultView)
        ? kit.settings.defaultView
        : 'all'
      const data = await kit.load(KEY, null)
      if (data) {
        if (data.version !== 2 || !Array.isArray(data.tasks))
          throw Error('待办数据格式异常，未覆盖原数据')
        tasks = data.tasks.map(normalize)
        lists = [
          ...new Set([
            '收件箱',
            ...(data.lists || []),
            ...tasks.map((t) => t.list),
          ]),
        ]
      } else {
        const old = await kit.load('todos_v1', [])
        if (!Array.isArray(old)) throw Error('旧待办数据格式异常')
        await kit.save('todos_v1_backup', old)
        tasks = old
          .filter((t) => t && typeof t.text === 'string')
          .map(normalize)
        await kit.save(KEY, { version: 2, tasks, lists })
      }
      ready = true
      render()
    } catch (e) {
      $('tasks').innerHTML =
        '<div class="empty">读取失败，原数据已保留。请重新打开插件。</div>'
      kit.toast(e.message, 'error')
      $('new-task').disabled = true
    }
  })()
  api?.onEnter?.(async ({ payload }) => {
    await initialized
    const text =
      typeof payload === 'string'
        ? payload
        : payload?.type === 'text'
          ? payload.text
          : ''
    if (text) {
      $('new-task').value = text
      $('new-task').focus()
    }
  })
  api?.onBeforeClose?.(async () => {
    await initialized
    clearTimeout(saveTimer)
    return persist()
  })
  kit.onMode(() => {
    if (ready) render()
  })
  kit.onSettings(() => {
    if (ready) render()
  })
})()
