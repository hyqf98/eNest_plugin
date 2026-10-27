/**
 * RunningState — 连线运行态上下文。
 * App 在节点状态变化时计算：源节点 running → 其出边进入 running 集合。
 * 以 context 下发避免逐边写 data（React Flow edge 更新昂贵且易竞态）。
 */
import { createContext } from 'react'

export const RunningEdgesContext = createContext({ edges: new Set(), roughness: 1.2 })
