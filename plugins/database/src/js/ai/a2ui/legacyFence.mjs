/**
 * legacyFence.mjs — 旧会话回放的围栏降级渲染
 * 旧格式 assistant 消息里模型可能输出 ```mermaid / ```echarts 围栏；
 * markdown-it 渲染成 language-xxx 代码块后，由 PanelBody 扫描替换为懒渲染容器。
 * 新会话模型走 A2UI surface（EChart/Mermaid 组件），不再产围栏。
 */

export { chartKindOf as chartKindOfLegacy, mountHolder as mountChartHolder } from './holder.mjs'
