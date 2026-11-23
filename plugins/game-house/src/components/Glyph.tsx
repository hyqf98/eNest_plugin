import { Desktop, GameController, GearSix, Heart, DownloadSimple, MagnifyingGlass, Package, PuzzlePiece, Wrench } from '@phosphor-icons/react'
import type { ComponentType } from 'react'

/** Phosphor 的每个图标都是一个这样的组件 */
export type GlyphComponent = ComponentType<{ weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'; size?: number | string; color?: string; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>

/** 统一线宽风格 */
export const ICON_WEIGHT = 'regular' as const

export function Glyph({ icon: Component, size = 16, className }: { icon: GlyphComponent; size?: number; className?: string }) {
  return <Component weight={ICON_WEIGHT} size={size} className={className} aria-hidden="true" />
}

/** 栏目图标表 */
export const NAV_ICONS: Record<string, GlyphComponent> = {
  pc: Desktop,
  console: GameController,
  software: Package,
  trainer: Wrench,
  mod: PuzzlePiece,
  pansou: MagnifyingGlass,
  my: Heart,
  downloads: DownloadSimple,
  settings: GearSix,
}
