      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)
      const KEY = 'todos_v1'
      const CHECK_SVG =
        '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.4l2.3 2.3 4.7-5.4" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      const PIN_SVG =
        '<svg viewBox="0 0 16 16" fill="none"><path d="M9.5 1.5l5 5-1.8 1.8-1-1-2.6 2.6.3 2.8a.8.8 0 0 1-1.4.6L5.9 11 2.4 14.5a.8.8 0 0 1-1.1-1.1L4.8 9.9 3.6 8.7a.8.8 0 0 1 .6-1.4l2.8.3 2.6-2.6-1-1L9.5 1.5z" fill="currentColor"/></svg>'
      const X_SVG =
        '<svg viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      const EMPTY_SVG =
        '<svg viewBox="0 0 56 56" fill="none"><circle cx="28" cy="28" r="26" stroke="rgba(61,220,151,0.28)" stroke-width="2"/><path d="M17.5 28.5l7 7 14-15" stroke="#3ddc97" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'

      /** @type {Array<{id:string,text:string,done:boolean,pinned:boolean,createdAt:number}>} */
      let todos = []

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }
      const isPerm = (err) => String(err?.message || err).includes('permission denied')

      // —— 持久化 ——
      async function load() {
        try {
          const saved = await api?.storage?.get?.(KEY)
          if (Array.isArray(saved)) {
            todos = saved.filter(
              (t) => t && typeof t.id !== 'undefined' && typeof t.text === 'string'
            )
          }
        } catch (e) {
          if (isPerm(e)) toast('缺少 storage.local 权限，数据不会保存', 'warn')
        }
        render()
      }
      async function persist() {
        try {
          await api?.storage?.set?.(KEY, todos)
        } catch (e) {
          if (isPerm(e)) toast('缺少 storage.local 权限，数据不会保存', 'warn')
        }
      }

      // —— 排序：未完成在前（置顶最前），已完成沉底，各按 createdAt 倒序 ——
      function sorted() {
        return [...todos].sort((a, b) => {
          if (a.done !== b.done) return a.done ? 1 : -1
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          return b.createdAt - a.createdAt
        })
      }

      function byId(id) {
        return todos.find((t) => t.id === id)
      }

      // —— 渲染 ——
      function render(enterId) {
        const list = $('list-inner')
        list.textContent = ''
        const items = sorted()
        if (!items.length) {
          const empty = document.createElement('div')
          empty.className = 'empty'
          empty.innerHTML =
            '<div class="glyph">' + EMPTY_SVG + '</div>' +
            '<div class="empty-title">还没有待办</div>' +
            '<div class="empty-sub">回车添加第一条待办</div>'
          list.appendChild(empty)
        } else {
          let prevDone = false
          for (const t of items) {
            // 已完成沉底区顶部：1px 分隔线 + 小标
            if (t.done && !prevDone) {
              const sep = document.createElement('div')
              sep.className = 'group-sep'
              const label = document.createElement('span')
              label.className = 'group-label'
              const doneCount = todos.filter((x) => x.done).length
              label.textContent = '已完成 ' + doneCount
              sep.appendChild(label)
              list.appendChild(sep)
            }
            prevDone = t.done
            list.appendChild(renderItem(t, t.id === enterId))
          }
        }
        const active = todos.filter((t) => !t.done).length
        $('count').textContent = '进行中 ' + active
        $('btn-clear').disabled = !todos.some((t) => t.done)
      }

      function renderItem(t, enter) {
        const row = document.createElement('div')
        row.className = 'todo' + (t.done ? ' done' : '') + (t.pinned ? ' pinned' : '') + (enter ? ' enter' : '')
        row.dataset.id = t.id

        const cb = document.createElement('button')
        cb.className = 'checkbox'
        cb.type = 'button'
        cb.title = t.done ? '标记为未完成' : '标记为已完成'
        cb.setAttribute('aria-label', cb.title)
        cb.innerHTML = CHECK_SVG
        cb.onclick = () => toggleDone(t.id)

        const text = document.createElement('div')
        text.className = 'todo-text'
        text.textContent = t.text
        text.title = '双击编辑'
        text.ondblclick = () => startEdit(row, t.id)

        const pin = document.createElement('button')
        pin.className = 'pin-btn' + (t.pinned ? ' active' : '')
        pin.type = 'button'
        pin.title = t.pinned ? '取消置顶' : '置顶'
        pin.setAttribute('aria-label', pin.title)
        pin.innerHTML = PIN_SVG
        pin.onclick = () => togglePin(t.id)

        const del = document.createElement('button')
        del.className = 'del-btn'
        del.type = 'button'
        del.innerHTML = X_SVG
        del.title = '删除'
        del.setAttribute('aria-label', '删除')
        del.onclick = () => removeTodo(t.id, del)

        row.append(cb, text, pin, del)
        return row
      }

      // —— 行内编辑：回车保存 / Esc 取消 / 失焦保存 ——
      function startEdit(row, id) {
        if (row.querySelector('.todo-edit')) return
        const t = byId(id)
        if (!t) return
        const old = row.querySelector('.todo-text')
        const input = document.createElement('input')
        input.className = 'todo-edit'
        input.type = 'text'
        input.value = t.text
        input.maxLength = 500
        row.replaceChild(input, old)
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)

        let done = false
        const finish = (save) => {
          if (done) return
          done = true
          const cur = byId(id)
          const next = save ? input.value.trim() : ''
          if (cur && next && next !== cur.text) {
            cur.text = next
            persist()
          }
          render()
        }
        input.onkeydown = (e) => {
          if (e.key === 'Enter') finish(true)
          else if (e.key === 'Escape') finish(false)
        }
        input.onblur = () => finish(true)
      }

      // —— 增删改 ——
      function addTodo() {
        const raw = $('input').value
        const text = raw.trim()
        if (!text) return
        const t = {
          id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          text,
          done: false,
          pinned: false,
          createdAt: Date.now()
        }
        todos.push(t)
        $('input').value = ''
        $('input').focus()
        persist()
        render(t.id)
      }

      function toggleDone(id) {
        const t = byId(id)
        if (!t) return
        t.done = !t.done
        if (t.done) t.pinned = false // 已完成不再置顶
        persist()
        render()
      }

      function togglePin(id) {
        const t = byId(id)
        if (!t) return
        if (t.done) { toast('已完成事项无需置顶', 'info'); return }
        t.pinned = !t.pinned
        persist()
        render()
      }

      // 二次确认：首点变「确认？」，再点删除；一段时间不动自动还原
      let confirmTimer = null
      function removeTodo(id, btn) {
        if (!btn.classList.contains('confirm')) {
          document.querySelectorAll('.del-btn.confirm').forEach((b) => resetConfirm(b))
          btn.classList.add('confirm')
          btn.textContent = '确认？'
          clearTimeout(confirmTimer)
          confirmTimer = setTimeout(() => resetConfirm(btn), 2500)
          return
        }
        clearTimeout(confirmTimer)
        todos = todos.filter((t) => t.id !== id)
        persist()
        render()
      }
      function resetConfirm(btn) {
        btn.classList.remove('confirm')
        btn.innerHTML = X_SVG
      }

      function clearDone() {
        const n = todos.filter((t) => t.done).length
        if (!n) return
        todos = todos.filter((t) => !t.done)
        persist()
        render()
        toast('已清理 ' + n + ' 条已完成待办', 'success')
      }

      // —— 事件 ——
      $('btn-add').onclick = addTodo
      $('input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addTodo()
      })
      $('btn-clear').onclick = clearDone

      // —— 进入载荷 ——
      api?.onEnter?.(({ payload }) => {
        if (
          payload &&
          typeof payload === 'object' &&
          payload.type === 'text' &&
          typeof payload.text === 'string' &&
          payload.text.trim()
        ) {
          $('input').value = payload.text
          $('input').focus()
        }
      })

      api?.ui?.setTitle?.('待办清单')
      load()
      $('input').focus()
    
