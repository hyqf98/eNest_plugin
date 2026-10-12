      const api = window.enest || window.zapi
      let items = []
      const $ = (id) => document.getElementById(id)
      const isPerm = (err) => String(err?.message || err).includes('permission denied')
      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }

      function fmtTime(ts) {
        const d = new Date(ts)
        return d.toLocaleString()
      }

      async function copyEntry(entry) {
        if (entry.type === 'text') {
          await api.clipboard.writeText(entry.text || '')
          toast('已复制文本', 'success')
          return
        }
        const full = await api.clipboard.history.get(entry.id)
        if (!full?.dataUrl) {
          toast('图片数据不可用', 'error')
          return
        }
        await api.clipboard.writeImage(full.dataUrl)
        toast('已复制图片', 'success')
      }

      async function load() {
        if (!api?.clipboard?.history) {
          $('list').innerHTML = '<div class="empty">eNest API 不可用</div>'
          return
        }
        try {
          const q = $('q').value.trim().toLowerCase()
          items = await api.clipboard.history.list({ limit: 100 })
          const filtered = q
            ? items.filter((e) => (e.text || e.preview || '').toLowerCase().includes(q))
            : items
          render(filtered)
          $('count').textContent = `${filtered.length} 条`
        } catch (e) {
          if (isPerm(e)) {
            $('list').innerHTML = '<div class="empty">缺少 clipboard.history 权限，请重新安装插件并授权</div>'
          } else {
            $('list').innerHTML = '<div class="empty">加载失败：' + String(e.message || e) + '</div>'
          }
        }
      }

      function render(list) {
        const root = $('list')
        root.innerHTML = ''
        if (!list.length) {
          root.innerHTML = '<div class="empty">暂无历史。复制文本或图片后会自动出现在这里。</div>'
          return
        }
        for (const entry of list) {
          const el = document.createElement('div')
          el.className = 'item' + (entry.pinned ? ' pinned' : '')
          const typeLabel = entry.type === 'image' ? '图片' : '文本'
          const pin = entry.pinned ? '<span class="pin-flag">已置顶</span>' : ''
          let bodyHtml = ''
          if (entry.type === 'image') {
            bodyHtml = '<div class="imgwrap"><img alt="图片"/></div>'
          } else {
            bodyHtml = '<div class="text"></div>'
          }
          el.innerHTML =
            '<div class="body">' +
            '<div class="type"><span>' + typeLabel + '</span>' + pin + '</div>' +
            bodyHtml +
            '<div class="meta">' + fmtTime(entry.ts) + (entry.bytes ? ' · ' + Math.round(entry.bytes / 1024) + ' KB' : '') + '</div>' +
            '</div>' +
            '<div class="actions">' +
            '<button class="btn" data-act="copy">复制</button>' +
            '<button class="btn" data-act="pin">' + (entry.pinned ? '取消置顶' : '置顶') + '</button>' +
            '<button class="btn danger" data-act="del">删除</button>' +
            '</div>'
          if (entry.type === 'text') {
            el.querySelector('.text').textContent = entry.text || entry.preview || ''
          } else {
            const img = el.querySelector('img')
            // 列表先用 preview；悬停/展开时再 get 完整图
            api.clipboard.history.get(entry.id).then((full) => {
              if (full?.dataUrl) img.src = full.dataUrl
            }).catch(() => {})
          }
          el.addEventListener('click', async (ev) => {
            const act = ev.target?.dataset?.act
            if (act === 'copy') {
              ev.stopPropagation()
              await copyEntry(entry).catch((e) => toast(String(e.message || e), 'error'))
              return
            }
            if (act === 'pin') {
              ev.stopPropagation()
              try {
                await api.clipboard.history.togglePin(entry.id)
                await load()
              } catch (e) {
                toast(String(e.message || e), 'error')
              }
              return
            }
            if (act === 'del') {
              ev.stopPropagation()
              try {
                await api.clipboard.history.remove(entry.id)
                await load()
              } catch (e) {
                toast(String(e.message || e), 'error')
              }
              return
            }
            // 点击主体 = 快速选中并回写剪贴板
            await copyEntry(entry).catch((e) => toast(String(e.message || e), 'error'))
          })
          root.appendChild(el)
        }
      }

      $('q').addEventListener('input', () => load())
      $('btn-refresh').onclick = () => load()
      $('btn-clear').onclick = async () => {
        if (!confirm('确定清空未置顶历史？置顶项会保留。')) return
        try {
          await api.clipboard.history.clear()
          await load()
          toast('已清空', 'success')
        } catch (e) {
          toast(String(e.message || e), 'error')
        }
      }
      $('btn-current').onclick = async () => {
        try {
          const img = await api.clipboard.readImage()
          if (img?.dataUrl) {
            await api.clipboard.writeImage(img.dataUrl)
            toast('已回写当前图片', 'success')
          } else {
            const text = await api.clipboard.readText()
            await api.clipboard.writeText(text || '')
            toast(text ? '已回写当前文本' : '剪贴板为空', text ? 'success' : 'warn')
          }
          await load()
        } catch (e) {
          toast(isPerm(e) ? '缺少剪贴板权限' : String(e.message || e), 'error')
        }
      }

      api?.onEnter?.(() => load())
      api?.ui?.setTitle?.('粘贴板')
      load()
    
