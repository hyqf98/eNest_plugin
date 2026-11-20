/**
 * tvbox 数据模型：配置/站点/影片/线路/选集/直播 的跨端统一形态。
 * 归一发生在后端（cms/spider 各适配层 → 这里定义的结构），前端直接消费。
 */

/** 影片卡片（列表/搜索/推荐共用） */
export interface VodItem {
  vod_id: string
  vod_name: string
  vod_pic?: string
  vod_remarks?: string
  type_name?: string
  vod_year?: string
  vod_area?: string
  siteKey: string
}

/** 选集（"第1集$url"） */
export interface Episode { name: string; url: string }

/** 播放线路（vod_play_from 按 $$$ 拆分后与选集按下标配对） */
export interface PlayFlag { flag: string; episodes: Episode[] }

/** 详情 */
export interface VodDetail extends VodItem {
  vod_content?: string
  vod_actor?: string
  vod_director?: string
  vod_lang?: string
  vod_score?: string
  flags: PlayFlag[]
}

/** 分类（class 树，两级） */
export interface TypeItem { type_id: string; type_name: string; parent?: string }

/** 筛选维度（home 返回 filters） */
export interface FilterGroup {
  key: string
  name: string
  init?: string
  value: Array<{ n: string; v: string }>
}

/** 分类页返回 */
export interface CategoryPage {
  list: VodItem[]
  page: number
  pagecount: number
  total?: number
  /** XML 源（type0）分类树随分类响应附带 */
  types?: TypeItem[]
}

/** 站点（sites 数组项归一） */
export interface SiteMeta {
  key: string
  name: string
  type: number          // 0=MacCMS XML / 1=MacCMS JSON / 3=Spider JS / 4=HTTP 扩展
  api: string
  ext?: string
  jar?: string
  searchable: number
  quickSearch: number
  changeable: number
  hide?: number
  timeout?: number
  playUrl?: string
  header?: Record<string, string>
  categories?: string[]
  /** 本地启停（不在配置里，用户偏好） */
  disabled?: boolean
  /** 运行态错误（加载/执行失败原因，界面展示用） */
  error?: string
}

/** 解析器（parses 数组项） */
export interface ParseMeta {
  name: string
  type: number          // 0=WebView(不支持) / 1=Json / 2=Json+ext / 3=Spider
  url: string
  ext?: { flag?: string[]; header?: Record<string, string> }
}

/** 直播分组/频道 */
export interface LiveChannel {
  name: string
  urls: string[]        // 多线路
  number?: number
  logo?: string
  epg?: string
  header?: Record<string, string>
}
export interface LiveGroup { name: string; channels: LiveChannel[] }

/** 播放决策返回 */
export interface PlayResult {
  /** 直接可播的地址（已按需过解析；可能是 m3u8/mp4/其他直链） */
  url: string
  /** 播放需携带的请求头（代理转发时注入） */
  headers?: Record<string, string>
  /** 提示信息（走了哪个解析等） */
  note?: string
  /** 是否大概率是直链视频（决定 hls.js 还是原生 video 尝试） */
  kind?: 'hls' | 'mp4' | 'link'
}
