import { createElement, useState } from 'react'

/** 骨架屏行：masonry 占位 + 底部转圈提示条（长等待必须有转圈，用户硬性偏好） */
export function SkeletonMasonry({ count = 18 }) {
  const heights = [180, 220, 160, 240, 200, 140, 260, 190, 170, 230, 150, 210]
  return createElement('div', { className: 'mm-skel-wrap' },
    createElement('div', { className: 'mm-masonry mm-skel' },
      Array.from({ length: count }, (_, i) => createElement('div', {
        key: i,
        className: 'mm-skel-card',
        style: { aspectRatio: `1 / ${(heights[i % heights.length] / 168).toFixed(2)}` },
      })),
    ),
    createElement('div', { className: 'mm-loading-row' },
      createElement('span', { className: 'mm-spinner' }),
      createElement('span', null, '正在加载表情包…'),
    ),
  )
}

/** 加载更多转圈条 */
export function LoadingMore() {
  return createElement('div', { className: 'mm-loading-row is-more' },
    createElement('span', { className: 'mm-spinner' }),
    createElement('span', null, '加载更多…'),
  )
}

/** 错误态：说明 + 重试 */
export function ErrorState({ message, onRetry }) {
  return createElement('div', { className: 'mm-state' },
    createElement('div', { className: 'mm-state-icon' }, '⚠️'),
    createElement('div', { className: 'mm-state-text' }, message || '加载失败'),
    onRetry && createElement('button', { type: 'button', className: 'mm-retry', onClick: onRetry }, '重试'),
  )
}

/** 空态 */
export function EmptyState({ text, hint }) {
  return createElement('div', { className: 'mm-state' },
    createElement('div', { className: 'mm-state-icon' }, '🔍'),
    createElement('div', { className: 'mm-state-text' }, text || '没有找到表情包'),
    hint && createElement('div', { className: 'mm-state-hint' }, hint),
  )
}

/**
 * 筛选 chips 行：按源元数据渲染；超出两行自动折叠，「展开 N 项 / 收起」切换。
 * 折叠态用 max-height 限制高度并淡出末行，选中的项始终可见（展开时高亮）。
 */
export function FilterChips({ group, value, onChange }) {
  const [expanded, setExpanded] = useState(false)
  const options = group.options ?? []
  const active = value ?? ''
  const overflow = options.length > 8
  return createElement('div', { className: 'mm-filter-row' },
    createElement('span', { className: 'mm-filter-name' }, group.name),
    createElement('div', { className: `mm-chips${overflow && !expanded ? ' is-clamped' : ''}` },
      createElement('button', {
        type: 'button',
        className: `mm-chip${active === '' ? ' is-active' : ''}`,
        onClick: () => onChange(''),
      }, '全部'),
      options.map(option => createElement('button', {
        key: option.value,
        type: 'button',
        className: `mm-chip${active === option.value ? ' is-active' : ''}`,
        onClick: () => onChange(active === option.value ? '' : option.value),
      }, option.name)),
    ),
    overflow && createElement('button', {
      type: 'button',
      className: 'mm-chips-toggle',
      onClick: () => setExpanded(prev => !prev),
    }, expanded ? '收起' : `展开 ${options.length}`),
  )
}
