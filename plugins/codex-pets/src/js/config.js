/**
 * 常量表 — 与 codex-pet-share（portons/codex-pet-share src/domain/config.ts）逐项对齐。
 * 只放纯数据与纯函数（tests/ 直接覆盖）。
 */

export const API_BASE = 'https://codex-pets.net'

/** 排序枚举（API sort 值 ↔ 中文标签） */
export const GALLERY_SORTS = [
  { id: 'new', label: '最新' },
  { id: 'popular', label: '最多赞' },
  { id: 'views', label: '最多浏览' },
  { id: 'discussed', label: '最多讨论' },
  { id: 'random', label: '随机' }
]

/** 内容分级（safe 隐藏 nsfw 标签宠物） */
export const CONTENT_MODES = [
  { id: 'safe', label: '安全' },
  { id: 'all', label: '全部' }
]

/** kind 筛选（object/animal/person/creature 同时是合法标签） */
export const KIND_OPTIONS = [
  { id: 'all', label: '全部类型' },
  { id: 'object', label: '物品' },
  { id: 'animal', label: '动物' },
  { id: 'person', label: '人物' },
  { id: 'creature', label: '生物' }
]

/** sprite 格式筛选 */
export const FORMAT_OPTIONS = [
  { id: 'all', label: '全部格式' },
  { id: 'v2', label: 'V2' },
  { id: 'v1', label: 'V1 旧版' }
]

/** 原站 allowedTags 全集（22 个） */
export const ALLOWED_TAGS = [
  'cute', 'weird', 'minimal', 'animated', 'pixel', 'hand-drawn', 'retro',
  'game', 'object', 'animal', 'person', 'creature', 'clippy', 'robot',
  'anime', 'spooky', 'soft', 'chaotic', 'utility', 'mascot', 'celeb', 'nsfw'
]

const PET_KIND_TAGS = ['object', 'animal', 'person', 'creature']

/** 筛选面板标签（排除 4 个 kind 标签后字母序，对齐原站 galleryFilterTags） */
export const FILTER_TAGS = ALLOWED_TAGS
  .filter(tag => !PET_KIND_TAGS.includes(tag))
  .sort((a, b) => a.localeCompare(b))

/** 基础动画行（9 行，v1/v2 共有） */
export const PET_STATES = [
  { id: 'idle', label: '待机', row: 0, frames: 6 },
  { id: 'running-right', label: '右跑', row: 1, frames: 8 },
  { id: 'running-left', label: '左跑', row: 2, frames: 8 },
  { id: 'waving', label: '挥手', row: 3, frames: 4 },
  { id: 'jumping', label: '跳跃', row: 4, frames: 5 },
  { id: 'failed', label: '失败', row: 5, frames: 8 },
  { id: 'waiting', label: '等待', row: 6, frames: 6 },
  { id: 'running', label: '奔跑', row: 7, frames: 6 },
  { id: 'review', label: '审视', row: 8, frames: 6 }
]

/** v2 视线行（row 9/10 × 8 列 = 16 个方向） */
export const PET_LOOK_ROWS = [
  { id: 'look-right-side', label: '环顾 · 右侧', row: 9, frames: 8 },
  { id: 'look-left-side', label: '环顾 · 左侧', row: 10, frames: 8 }
]

/** 按版本取动画行集合 */
export function petAnimationRows(version) {
  return version === 2 ? [...PET_STATES, ...PET_LOOK_ROWS] : PET_STATES
}

/** 光标跟随可用的状态（原站 CursorPreviewStateId） */
export const CURSOR_PREVIEW_STATES = ['idle', 'waiting', 'running-left', 'running-right']

/** sprite 图集几何（原站 cell 192×208 × 8 列；v1 9 行 / v2 11 行） */
export const SPRITE_CELL_W = 192
export const SPRITE_CELL_H = 208
export const SPRITE_ATLAS_COLUMNS = 8
export const SPRITE_ATLAS_ROWS = { 1: 9, 2: 11 }

export function spriteSheetHeight(version) {
  return SPRITE_CELL_H * SPRITE_ATLAS_ROWS[version === 2 ? 2 : 1]
}

/** 逐帧动画时长（原站：max(帧数 × 260ms, 1400ms)） */
export function spriteDurationMs(frames) {
  return Math.max(frames * 260, 1400)
}

/** 16 个视线方向名（原站顺序，顺时针自 Up 起） */
export const LOOK_DIRECTION_NAMES = [
  '上', '上偏右', '右上', '右偏上', '右', '右偏下', '右下', '下偏右',
  '下', '下偏左', '左下', '左偏下', '左', '左偏上', '左上', '上偏左'
]

/** 视线方向 → 图集格（row 9/10 × 8 列） */
export function lookDirectionCell(directionIndex) {
  const normalized = ((Math.round(directionIndex) % 16) + 16) % 16
  return {
    row: 9 + Math.floor(normalized / SPRITE_ATLAS_COLUMNS),
    frame: normalized % SPRITE_ATLAS_COLUMNS,
    name: LOOK_DIRECTION_NAMES[normalized]
  }
}

/**
 * 画廊卡片确定性选行动画（原站 pickGalleryPetState）：
 * hash = (hash * 31 + charCode) | 0，取 petStates[abs(hash) % 9]。
 */
export function pickGalleryPetState(petId) {
  let hash = 0
  for (let i = 0; i < petId.length; i += 1) {
    hash = (hash * 31 + petId.charCodeAt(i)) | 0
  }
  return PET_STATES[Math.abs(hash) % PET_STATES.length]
}

/** 光标跟随宠物参数（原站 cursorPreview* 常量） */
export const CURSOR_PET_W = 96
export const CURSOR_PET_H = 104
export const CURSOR_PET_OFFSET = 18
export const CURSOR_IDLE_DELAY_MS = 360
export const CURSOR_WAITING_DELAY_MS = 1800
export const CURSOR_TILT_MIN_DEG = 3
export const CURSOR_TILT_MAX_DEG = 12
export const CURSOR_TILT_SPEED_FACTOR = 16

/** 画廊分页（原站：标准 30/紧凑 60/随机 3） */
export const PAGE_SIZE = 30
export const RANDOM_PAGE_SIZE = 3

/** 默认画廊状态（对齐原站 defaultGalleryUrlState） */
export const DEFAULT_GALLERY_STATE = {
  query: '',
  tags: [],
  sort: 'new',
  page: 1,
  kind: 'all',
  format: 'all',
  content: 'safe'
}
