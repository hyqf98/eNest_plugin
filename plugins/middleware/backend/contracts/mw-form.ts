/** Schema 描述符契约：驱动声明表单/列表/指标/发送字段，前端统一渲染。
 * 目标：新增中间件 = 写一个驱动文件 + 注册，前端零改动。
 * 描述符经 kinds.list action 透传到渲染层；secret 值永不进描述符或连接对象。 */

export type MwFieldType = 'text' | 'password' | 'select' | 'switch' | 'number'

/** 连接表单字段（kind 专属；连接名称/环境/只读/备注由前端统一附加） */
export interface MwConnectionField {
  key: string
  label: string
  type: MwFieldType
  placeholder?: string
  tip?: string
  required?: boolean
  /** type=select 时的选项 */
  options?: Array<{ value: string; label: string }>
  /** switch/select 初始值 */
  default?: string | number | boolean
  /** 条件显隐：表单字段 field 等于 equals 时显示；not=true 反转（缺省 equals 视为真值） */
  visibleWhen?: { field: string; equals?: string | boolean | number; not?: boolean }
  /** 凭据字段：值经 vault 换 ref，表单不回显明文 */
  vaultSlot?: 'primary' | 'emqx'
  /** 校验规则（前端预检，驱动侧仍各自校验） */
  pattern?: 'https-url' | 'mqtt-url' | 'host-ports' | 'redis-url'
  /** type=number 下限 */
  min?: number
  /** 值在 MwConnectionConfig 里的路径（缺省平铺在顶层）；path 含点号时组装嵌套对象 */
  path?: string
  /** 与下一字段并排半列 */
  half?: boolean
}

/** 列表列（topics/groups/clients 各分段通用；值先取 row 后取 row.extras） */
export interface MwListColumn {
  key: string
  title: string
  format?: 'text' | 'mono' | 'num' | 'compact' | 'bytes' | 'ms' | 'datetime' | 'chip' | 'bool' | 'lag' | 'health' | 'type' | 'entity'
  width?: string
  /** 仅从 row.extras 取值 */
  from?: 'extras'
  /** format=chip/type 的强调样式 */
  chipClass?: 'ok' | 'warn' | 'bad' | 'accent'
  /** 组合列：source→destination（bindings 专用） */
  route?: boolean
}

export interface MwPageColumns {
  page: 'topics' | 'queues' | 'exchanges' | 'bindings' | 'subscriptions' | 'groups' | 'clients'
  columns: MwListColumn[]
}

/** overview/monitor 指标卡：label 与单位一次声明，运行时可在 MwOverview.metricSpecs 覆盖 */
export interface MwMetricSpec {
  key: string
  label: string
  unit?: 'count' | 'bytes' | 'ms' | 'percent' | 'rate' | 'text'
  /** 数值超过阈值时卡片标 warn（堆积类） */
  warnThreshold?: number
}

/** 发消息页字段（映射 MwMessageSendInput 同名字段；topic/payload/headers 由前端统一渲染） */
export interface MwSendField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'switch'
  placeholder?: string
  tip?: string
  options?: Array<{ value: string; label: string }>
  /** 初始值 */
  default?: string | number | boolean
  /** type=number 下限 */
  min?: number
  half?: boolean
}
