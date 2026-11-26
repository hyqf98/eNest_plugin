/**
 * 左侧树：关联目录 → 子文件夹 → 文件。
 * 点文件夹名打开右侧内容；点箭头切换折叠；文件在文件夹展开时列出。
 * 文件与文件夹都可作为拖拽源；文件夹是拖拽目标（真实移动）。
 */

import { memo, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { CaretDown, CaretRight, FileImage, FileVideo, Folder } from '@phosphor-icons/react'
import type { FolderNode, MediaItem } from '../shared/contracts'

/** 拖拽时写进 dataTransfer 的自定义类型；只认自己人的拖拽，不接外部文件 */
export const DRAG_TYPE = 'application/x-enest-media-ids'

export interface TreeActions {
  openFolder(node: FolderNode): void
  toggleCollapse(node: FolderNode): void
  clickTree(node: FolderNode | MediaItem, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void
  /** 把拖拽的条目放进目标文件夹 */
  dropOnFolder(target: FolderNode, event: DragEvent): void
  /** 右键菜单 */
  contextMenu(node: FolderNode | MediaItem, event: MouseEvent): void
}

/** 按节点取它在树里的子内容 */
export interface TreeLookup {
  isCollapsed(entryId: string): boolean
  childrenOf(entryId: string): FolderNode[]
  filesOf(entryId: string): MediaItem[]
}

interface TreeProps {
  roots: FolderNode[]
  lookup: TreeLookup
  selected: Set<string>
  currentId: string | null
  actions: TreeActions
}

function isOwnDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(DRAG_TYPE)
}

function FileRow({ item, depth, selected, onClick, onContextMenu }: { item: MediaItem; depth: number; selected: boolean; onClick: (event: MouseEvent) => void; onContextMenu: (event: MouseEvent) => void }) {
  // 与文件夹行同一套缩进基准，再深一级：文件落在父文件夹内容的下方
  const rowStyle = { '--mb-depth': depth } as CSSProperties
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      draggable
      className={`mb-tree-row mb-tree-file${selected ? ' is-selected' : ''}`}
      style={rowStyle}
      title={item.name}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, JSON.stringify([item.entryId])); event.dataTransfer.effectAllowed = 'move' }}
    >
      {/* 文件没有折叠箭头，留一个等宽占位，让图标与同级文件夹的图标左沿对齐 */}
      <span className="mb-tree-caret" aria-hidden="true" />
      {item.kind === 'video' ? <FileVideo size={14} aria-hidden="true" /> : <FileImage size={14} aria-hidden="true" />}
      <span className="mb-tree-label">{item.name}</span>
    </div>
  )
}

interface FolderRowProps {
  node: FolderNode
  depth: number
  lookup: TreeLookup
  selected: Set<string>
  currentId: string | null
  actions: TreeActions
}

function FolderRow({ node, depth, lookup, selected, currentId, actions }: FolderRowProps) {
  const [dropActive, setDropActive] = useState(false)
  const collapsed = lookup.isCollapsed(node.entryId)
  const children = lookup.childrenOf(node.entryId)
  const files = lookup.filesOf(node.entryId)
  const hasContent = node.hasChildren || node.mediaCount > 0
  const isSelected = selected.has(node.entryId)
  const isCurrent = currentId === node.entryId
  const rowStyle = { '--mb-depth': depth } as CSSProperties

  return (
    <>
      <div
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasContent ? !collapsed : undefined}
        draggable
        tabIndex={0}
        className={['mb-tree-row', 'mb-tree-folder', depth === 0 ? 'is-root' : '', isSelected ? 'is-selected' : '', isCurrent ? 'is-current' : '', dropActive ? 'is-drop-target' : ''].filter(Boolean).join(' ')}
        style={rowStyle}
        onClick={event => {
          // 带修饰键的点击只改选择，不切换当前文件夹
          if (!(event.shiftKey || event.metaKey || event.ctrlKey)) actions.openFolder(node)
          actions.clickTree(node, event)
        }}
        onKeyDown={(event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.openFolder(node) } }}
        onContextMenu={event => actions.contextMenu(node, event)}
        onDragStart={event => { event.dataTransfer.setData(DRAG_TYPE, JSON.stringify([node.entryId])); event.dataTransfer.effectAllowed = 'move' }}
        onDragOver={event => {
          // 只有自己发起的拖拽才能落下；阻止默认行为才能触发 drop
          if (!isOwnDrag(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropActive(true)
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={event => {
          setDropActive(false)
          if (isOwnDrag(event)) actions.dropOnFolder(node, event)
        }}
      >
        <button
          type="button"
          className="mb-tree-caret"
          tabIndex={-1}
          aria-label={collapsed ? '展开' : '折叠'}
          disabled={!hasContent}
          onClick={event => { event.stopPropagation(); actions.toggleCollapse(node) }}
        >
          {hasContent ? (collapsed ? <CaretRight size={12} weight="bold" aria-hidden="true" /> : <CaretDown size={12} weight="bold" aria-hidden="true" />) : null}
        </button>
        <Folder size={14} weight={isCurrent ? 'fill' : 'regular'} aria-hidden="true" />
        <span className="mb-tree-label" title={node.name}>{node.name}</span>
        {node.mediaCount > 0 ? <span className="mb-tree-count">{node.mediaCount}</span> : null}
      </div>
      {!collapsed ? (
        <div className="mb-tree-children" role="group">
          {files.map(item => <FileRow key={item.entryId} item={item} depth={depth + 1} selected={selected.has(item.entryId)} onClick={event => actions.clickTree(item, event)} onContextMenu={event => actions.contextMenu(item, event)} />)}
          {children.map(child => <FolderRowMemo key={child.entryId} node={child} depth={depth + 1} lookup={lookup} selected={selected} currentId={currentId} actions={actions} />)}
        </div>
      ) : null}
    </>
  )
}

const FolderRowMemo = memo(FolderRow)

export function FolderTree({ roots, lookup, selected, currentId, actions }: TreeProps) {
  return (
    <div className="mb-tree" role="tree">
      {roots.map(node => <FolderRowMemo key={node.entryId} node={node} depth={0} lookup={lookup} selected={selected} currentId={currentId} actions={actions} />)}
    </div>
  )
}
