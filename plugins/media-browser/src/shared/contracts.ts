/**
 * 前后端共享契约：方法名与 DTO。
 * 渲染层只持有 entryId（后端签发的不透明条目标识），不接触绝对路径。
 */

export const METHODS = {
  systemHello: 'system.hello',
  /** 根目录 */
  rootsList: 'roots.list',
  rootsAdd: 'roots.add',
  rootsRemove: 'roots.remove',
  /** 浏览 */
  treeLoad: 'tree.load',
  folderSubfolders: 'folder.subfolders',
  folderList: 'folder.list',
  /** 文件操作 */
  itemsMove: 'items.move',
  itemsDelete: 'items.delete',
  /** 媒体 */
  mediaOrigin: 'media.origin',
} as const

export type MediaKind = 'image' | 'video'

/** 关联的根目录 */
export interface RootEntry {
  rootId: string
  /** 仅用于展示，例如 ~/Pictures；不是授权凭据 */
  displayPath: string
  name: string
  /** 根目录本身已不存在（U 盘拔出等），需要用户重新关联 */
  missing?: boolean
}

/** 左侧树的文件夹节点（文件按需加载，不随整棵树下发） */
export interface FolderNode {
  entryId: string
  rootId: string
  name: string
  depth: number
  hasChildren: boolean
  mediaCount: number
}

export interface MediaItem {
  entryId: string
  rootId: string
  parentEntryId: string
  name: string
  kind: MediaKind
  /** 小写扩展名，不带点 */
  ext: string
  size: number
  mtime: number
  /** 缩略图地址（后端回环服务，回环服务启动前为空） */
  thumbUrl?: string
}

export interface MoveResult {
  moved: number
  failed: { name: string; reason: string }[]
}

export interface DeleteResult {
  deleted: number
  failed: { name: string; reason: string }[]
  /** 用户在原生确认框里取消了 */
  cancelled?: boolean
}

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'svg',
  // 相机 RAW：尼康必支持，其余主流厂商兼容
  'nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'dng', 'pef', 'ptx', 'srw',
  'x3f', '3fr', 'ari', 'cap', 'iiq', 'kdc', 'mdc', 'mos', 'mrw', 'erf', 'k25', 'kc2',
])

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv',
])
