/**
 * main — 路由装配与生命周期。
 * 路由：#/ 画廊 · #/pets/<id> 详情 · #/installed 已安装管理。
 */
import { createKit } from './kit.js'
import { renderGallery, refreshInstalledMarks } from './gallery.js'
import { renderDetail } from './detail.js'
import { renderInstalled } from './installed.js'
import { CursorPet } from './sprite.js'

const body = document.getElementById('body')
const statusEl = document.getElementById('foot-status')
const cursorPet = new CursorPet(document.getElementById('cursor-pet'))
const kit = createKit({})

function onNavigate(hash) {
  if (location.hash === hash) route()
  else location.hash = hash
}

let routing = false
async function route() {
  if (routing) return
  routing = true
  cursorPet.hide()
  const hash = location.hash || '#/'
  syncNav(hash)
  try {
    if (hash.startsWith('#/pets/')) {
      const petId = decodeURIComponent(hash.slice('#/pets/'.length).split('?')[0])
      statusEl.textContent = `宠物详情 · ${petId}`
      await renderDetail(body, kit, { petId, onNavigate })
    } else if (hash.startsWith('#/installed')) {
      statusEl.textContent = '已安装管理'
      await renderInstalled(body, kit, { onNavigate })
    } else {
      statusEl.textContent = '画廊'
      await refreshInstalledMarks()
      await renderGallery(body, kit, { onNavigate, cursorPet })
    }
  } catch (err) {
    body.innerHTML = `<div class="cp-empty">页面渲染失败：${escapeHtml(err?.message ?? String(err))}</div>`
  } finally {
    routing = false
  }
}

function syncNav(hash) {
  for (const btn of document.querySelectorAll('.cp-nav-btn')) {
    const active = hash.startsWith('#/installed') ? btn.dataset.route === '#/installed' : btn.dataset.route === '#/'
    btn.classList.toggle('is-active', active)
  }
}

window.addEventListener('hashchange', route)
for (const btn of document.querySelectorAll('.cp-nav-btn')) {
  btn.addEventListener('click', () => onNavigate(btn.dataset.route))
}

// 外链统一走宿主门禁（shell.openExternal）
document.getElementById('origin-link').addEventListener('click', async event => {
  event.preventDefault()
  const enest = window.enest || window.zapi
  try {
    await enest.shell.openExternal('https://codex-pets.net/')
  } catch (err) {
    kit.toast(err?.message ?? '无法打开外部链接', 'error')
  }
})

// 关闭前收起光标宠物
;(window.enest || window.zapi)?.onBeforeClose?.(() => cursorPet.hide())

void route()

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
