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
