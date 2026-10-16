/**
 * sprite — 逐帧 sprite 引擎 + 光标跟随宠物（复刻 codex-pets.net 动效）。
 * 机制与原站一致：div 背景图 = spritesheet.webp，CSS 变量驱动
 * background-position 逐帧步进（steps）；画廊卡片默认 poster 静帧，
 * hover 才加载完整 spritesheet 并播放按 petId hash 选中的动画行。
 */
import {
  SPRITE_CELL_W,
  SPRITE_CELL_H,
  spriteSheetHeight,
  spriteDurationMs,
  pickGalleryPetState,
  petAnimationRows,
  lookDirectionCell,
  CURSOR_PET_OFFSET,
  CURSOR_IDLE_DELAY_MS,
  CURSOR_WAITING_DELAY_MS,
  CURSOR_TILT_MIN_DEG,
  CURSOR_TILT_MAX_DEG,
  CURSOR_TILT_SPEED_FACTOR
} from './config.js'

/**
 * 生成 sprite 元素（.sprite）并应用动画行样式变量。
 * row: 动画行号；frames: 帧数；staticFrame: 给定时停在指定帧（不播放）。
 */
export function applySpriteStyle(el, { url, row, frames, version, staticFrame }) {
  el.style.backgroundImage = `url(${url})`
  el.style.setProperty('--sprite-x', `${(staticFrame || 0) * -SPRITE_CELL_W}px`)
  el.style.setProperty('--sprite-y', `${row * -SPRITE_CELL_H}px`)
  el.style.setProperty('--sprite-end-x', `${frames * -SPRITE_CELL_W}px`)
  el.style.setProperty('--sprite-frames', String(frames))
  el.style.setProperty('--sprite-duration', `${spriteDurationMs(frames)}ms`)
  el.style.setProperty('--sprite-atlas-height', `${spriteSheetHeight(version)}px`)
  el.classList.toggle('staticSprite', staticFrame !== undefined)
}

/** 画廊卡片 hover 预览状态（hash 确定性选行） */
export function galleryCardState(pet) {
  return pickGalleryPetState(pet.id)
}

/** 详情页动画 tabs（v2 → 11 个状态；v1 → 9 个） */
export function detailTabs(version) {
  return petAnimationRows(version)
}

/** 视线罗盘 16 方向格 */
export function lookCell(directionIndex) {
  return lookDirectionCell(directionIndex)
}

/**
 * 光标跟随宠物（复刻原站 CursorPreview）：
 * - 固定定位层跟随 mousemove，宠物显示在光标右下 offset 18px；
 * - 倾斜角随水平速度：|vx| 映射 3°–12°（速度因子 16）；
 * - 静止 360ms → idle 行；1800ms → waiting 行；快速移动 → running-left/right。
 */
export class CursorPet {
  constructor(rootEl) {
    this.el = rootEl
    this.sprite = rootEl.querySelector('.sprite')
    this.visible = false
    this.pet = null
    this.stateId = 'idle'
    this.lastX = 0
    this.lastY = 0
    this.lastMoveAt = 0
    this.lastVx = 0
    this.timer = null
    this.raf = null
    this.onMove = event => this.track(event)
    this.onLeave = () => this.hide()
  }

  show(pet, sheetUrl) {
    if (!pet || !sheetUrl) return
    this.pet = pet
    this.el.style.backgroundImage = 'none'
    applySpriteStyle(this.sprite, {
      url: sheetUrl,
      row: 0,
      frames: 6,
      version: pet.spriteVersionNumber
    })
    this.el.classList.add('is-visible')
    this.visible = true
    this.stateId = 'idle'
    this.lastMoveAt = performance.now()
    this.scheduleStateCheck()
    window.addEventListener('mousemove', this.onMove, { passive: true })
  }

  hide() {
    this.visible = false
    this.el.classList.remove('is-visible')
    window.removeEventListener('mousemove', this.onMove)
    clearTimeout(this.timer)
    cancelAnimationFrame(this.raf)
  }

  track(event) {
    if (!this.visible) return
    const now = performance.now()
    const dt = Math.max(1, now - this.lastMoveAt)
    const vx = (event.clientX - this.lastX) / dt * 1000 // px/s
    this.lastX = event.clientX
    this.lastY = event.clientY
    this.lastMoveAt = now
    this.lastVx = this.lastVx * 0.7 + vx * 0.3
    const tilt = Math.min(CURSOR_TILT_MAX_DEG,
      CURSOR_TILT_MIN_DEG + Math.min(1, Math.abs(this.lastVx) / (CURSOR_TILT_SPEED_FACTOR * 100)) * (CURSOR_TILT_MAX_DEG - CURSOR_TILT_MIN_DEG))
    const sign = this.lastVx < 0 ? -1 : 1
    this.el.style.transform =
      `translate(${event.clientX + CURSOR_PET_OFFSET}px, ${event.clientY + CURSOR_PET_OFFSET}px) rotate(${sign * tilt}deg)`
    // 快速水平移动 → 奔跑行；否则按静止时长切 idle / waiting
    if (Math.abs(this.lastVx) > 600) {
      this.applyState(this.lastVx > 0 ? 'running-right' : 'running-left')
    } else {
      this.applyState('idle')
    }
    this.scheduleStateCheck()
  }

  scheduleStateCheck() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (!this.visible) return
      const idleFor = performance.now() - this.lastMoveAt
      this.applyState(idleFor >= CURSOR_WAITING_DELAY_MS ? 'waiting' : 'idle')
      if (idleFor < CURSOR_WAITING_DELAY_MS) this.scheduleStateCheck()
    }, CURSOR_IDLE_DELAY_MS)
  }

  applyState(stateId) {
    if (this.stateId === stateId || !this.pet) return
    const rows = petAnimationRows(this.pet.spriteVersionNumber)
    const state = rows.find(s => s.id === stateId) ?? rows[0]
    this.stateId = stateId
    applySpriteStyle(this.sprite, {
      url: this.sprite.style.backgroundImage.slice(4, -1).replace(/["']/g, ''),
      row: state.row,
      frames: state.frames,
      version: this.pet.spriteVersionNumber
    })
  }
}
