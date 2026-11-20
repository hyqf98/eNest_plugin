/**
 * registry.mjs — AI 面板实例注册表（轻量解耦）
 * workbench.js 设置页只需要 getAiPanel()?.resetPositions()；直接 import panel.mjs
 * 会把 A2UI 渲染层静态拉进主 chunk。panel 初始化时在这里登记，消费方经注册表取。
 */

let instance = null

export function registerAiPanel(panel) {
  instance = panel || null
}

export function getAiPanel() {
  return instance
}
