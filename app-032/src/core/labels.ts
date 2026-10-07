/**
 * 裁片标签（规格书 §4.7）
 * 规则：每一块物理裁片都有一张标签（裁片类型 ×qty → qty 张），逐块编号一块对一块；
 * 每张 A4 排 10 张（2 列 × 5 行），一块不许漏、编号不许重。
 * 编号是图纸 / 标签 / 清单三处对账的唯一来源，改纸张或搭接量不影响块号。
 */
import type { Lantern, Panel } from './types'
import { buildPanels } from './panels'

export const LABELS_PER_PAGE = 10
export const LABEL_PAGE = { wMm: 210, hMm: 297, marginMm: 10 }

export interface LabelEntry {
  /** 裁片类型编号，如 P001 */
  panelId: string
  /** 裁片名称 */
  label: string
  panel: Panel
  /** 该类型内的第几块，从 1 起 */
  piece: number
  /** 该类型总块数 */
  pieceOf: number
  /** 全灯连续块号，从 1 起（跨裁片类型、跨标签页连续） */
  seq: number
  /** 贴在实物上的编号，如 P001-03 */
  code: string
}

export interface LabelPage {
  index: number
  total: number
  items: LabelEntry[]
}

/** 全灯标签清单（逐块），顺序与裁片清单一致 */
export function buildLabels(l: Lantern): LabelEntry[] {
  const out: LabelEntry[] = []
  let seq = 0
  for (const p of buildPanels(l).panels) {
    for (let k = 1; k <= p.qty; k++) {
      seq++
      out.push({
        panelId: p.id,
        label: p.label,
        panel: p,
        piece: k,
        pieceOf: p.qty,
        seq,
        code: `${p.id}-${String(k).padStart(2, '0')}`
      })
    }
  }
  return out
}

/** 按每 10 张一页分页 */
export function paginateLabels(l: Lantern): LabelPage[] {
  const all = buildLabels(l)
  const pages: LabelPage[] = []
  const total = Math.max(1, Math.ceil(all.length / LABELS_PER_PAGE))
  for (let i = 0; i < all.length; i += LABELS_PER_PAGE) {
    pages.push({ index: pages.length + 1, total, items: all.slice(i, i + LABELS_PER_PAGE) })
  }
  return pages
}
