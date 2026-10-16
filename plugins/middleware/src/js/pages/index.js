/** 页面注册表：tabs.js 路由唯一依据。kinds=null 表示全部类型可见（页面内部按能力再降级）。 */
export const PAGES = [
  { id: 'overview', title: '概览', kinds: null, page: () => import('./overview.js') },
  { id: 'topics', title: 'Topic · 队列', kinds: null, page: () => import('./topics.js') },
  { id: 'messages', title: '消息', kinds: null, page: () => import('./messages.js') },
  { id: 'groups', title: '消费组 · 订阅', kinds: null, page: () => import('./groups.js') },
  { id: 'monitor', title: '监控', kinds: null, page: () => import('./monitor.js') },
  { id: 'trace', title: '轨迹', kinds: ['rocketmq'], page: () => import('./trace.js') },
  { id: 'publish', title: '发消息', kinds: null, page: () => import('./publish.js') }
]
