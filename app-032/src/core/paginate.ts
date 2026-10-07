/**
 * 1:1 放样图分页（规格书 §4.5 / §8）
 * 规则（两处取舍已定，见 README / 页面说明）：
 *  - 按真实毫米绘制；**同一块裁片不拆到两页、不缩放**；一块裁片当前页放不下时
 *    另起一页；整页可打印区都放不下时整块单独一页居中放置，并在自检 CHK-06 报红
 *    （取舍：费纸，但拓印尺寸永远正确）；
 *  - 跨页只发生在骨架长条图上：相邻段按 overlapMm **真实重叠** 排布（取舍：多占纸，
 *    但拼缝能接上），段编号按构件一顺接下去（F001-1/3、F001-2/3…），带对位十字。
 * 纸张幅面一切换，页宽 / 页高 / 可打印区 / 分页全部按新幅面的毫米数重算。
 */
import type { FrameMember, Lantern, Panel } from './types'
import { buildFrame } from './frame'
import { buildPanels, panelCutBounds } from './panels'

export type PaperSize = 'A4' | 'A3'

export const PAPER_DIMS: Record<PaperSize, { wMm: number; hMm: number }> = {
  A4: { wMm: 210, hMm: 297 },
  A3: { wMm: 297, hMm: 420 }
}

/** 每页四周保留的安全边（mm）：落在常见打印机非打印区（~5mm）以内，避免触发自动缩放 */
export const PAGE_MARGIN_MM = 8
export const HEADER_MM = 12
/** 裁片占位框四周留白（mm） */
export const PANEL_PAD_X = 6
export const PANEL_PAD_TOP = 9
export const PANEL_PAD_BOTTOM = 14
const ROW_GAP = 5
const STRIP_ROW_H = 17
const STRIP_GUTTER = 9
const EPS = 0.001

/** 每张标签页固定排 10 张（2 列 × 5 行），一张都不许漏 */
export const LABELS_PER_PAGE = 10

/** 校验页数量（图纸最前面的 1:1 自检页，编号对账时计入页码） */
export const CALIBRATION_PAGES = 1

export interface SheetItemCalibration {
  type: 'calibration'
  xMm: number
  yMm: number
  wMm: number
  hMm: number
}

export interface SheetItemPanel {
  type: 'panel'
  panel: Panel
  /** 占位框左上角（mm，页面坐标） */
  xMm: number
  yMm: number
  /** 占位框尺寸（含标注留白，mm） */
  wMm: number
  hMm: number
  /** true = 单块可打印区放不下，整块独占一页居中（未拆分 / 未缩放） */
  oversized: boolean
}

export interface SheetItemStrip {
  type: 'strip'
  member: FrameMember
  xMm: number
  yMm: number
  /** 本段绘制长度（1:1，mm） */
  lengthMm: number
  /** 该构件截取总长（含余量，mm） */
  totalMm: number
  segIndex: number
  segCount: number
  /** 本段起点在整根构件上的位置（mm），用于 1:1 图上标注标尺读数 */
  startMm: number
  /** 拼接编号，如 F001-2/3（同一根构件一顺接下去，跨页也不断） */
  tag: string
  /** 相邻段编号（用于标注搭接方向） */
  prevTag?: string
  nextTag?: string
  /** 相邻段实际重叠量（mm，几何真实搭接，非仅标注） */
  overlapMm: number
  /** 实际采用的搭接量（mm；请求值超过段长时会被夹回） */
  effectiveOverlapMm: number
}

export type SheetItem = SheetItemCalibration | SheetItemPanel | SheetItemStrip

export interface Sheet {
  index: number
  title: string
  paper: PaperSize
  wMm: number
  hMm: number
  headerMm: number
  contentX: number
  contentY: number
  contentWMm: number
  contentHMm: number
  items: SheetItem[]
  warn?: string
}

export interface LoftOptions {
  paper: PaperSize
  includePanels: boolean
  includeStrips: boolean
  includeCalibration: boolean
  overlapMm: number
}

export const DEFAULT_LOFT_OPTIONS: LoftOptions = {
  paper: 'A4',
  includePanels: true,
  includeStrips: true,
  includeCalibration: true,
  overlapMm: 10
}

/** 长条单段可绘制长度（mm） */
export function stripUsableMm(contentWMm: number): number {
  return contentWMm - STRIP_GUTTER * 2
}

/**
 * 骨架长条分段（搭接排布）：
 * start[i] = i * (usable - overlap)；相邻段在几何上真实重叠 overlap mm，
 * 因此最后标尺读数连续、拼缝能对上；段数 = ceil((L - o)/(usable - o))。
 * 段编号按同一根构件一顺接下去。
 */
export function stripSegments(
  totalMm: number,
  usableMm: number,
  overlapMm: number
): { start: number; len: number }[] {
  const usable = usableMm
  if (usable <= 0) return [{ start: 0, len: Math.max(1, totalMm) }]
  // 搭接量不能把整段吃光（每段至少前进 10mm），否则永远走不到头；由调用方提示已夹紧
  const overlap = effectiveOverlap(overlapMm, usable)
  const step = usable - overlap
  if (totalMm <= usable + EPS) return [{ start: 0, len: totalMm }]
  const segCount = Math.max(1, Math.ceil((totalMm - overlap - EPS) / step))
  const segs: { start: number; len: number }[] = []
  for (let i = 0; i < segCount; i++) {
    const start = i * step
    const len = Math.min(usable, totalMm - start)
    segs.push({ start, len: Math.max(1, len) })
  }
  return segs
}

/** 实际采用的搭接量：每段至少要前进 10mm，请求值过大时夹到 usable-10 */
export function effectiveOverlap(overlapMm: number, usableMm: number): number {
  if (usableMm <= 10) return 0
  return Math.max(0, Math.min(overlapMm, usableMm - 10))
}

/** 裁片占位框尺寸（外接矩形 + 标注留白） */
export function panelSlot(p: Panel): { w: number; h: number } {
  const b = panelCutBounds(p)
  return { w: b.w + PANEL_PAD_X * 2, h: b.h + PANEL_PAD_TOP + PANEL_PAD_BOTTOM }
}

export function paginate(l: Lantern, opts: LoftOptions): Sheet[] {
  const dims = PAPER_DIMS[opts.paper]
  const contentX = PAGE_MARGIN_MM
  const contentY = HEADER_MM + 4
  const contentW = dims.wMm - PAGE_MARGIN_MM * 2
  const contentH = dims.hMm - contentY - PAGE_MARGIN_MM
  const right = contentX + contentW
  const bottom = contentY + contentH

  const sheets: Sheet[] = []
  let sheet!: Sheet
  let cx = contentX
  let cy = contentY
  let rowH = 0

  const startSheet = (warn?: string) => {
    sheet = {
      index: sheets.length + 1,
      title: `放样图 ${opts.paper} · 第 ${sheets.length + 1} 页`,
      paper: opts.paper,
      wMm: dims.wMm,
      hMm: dims.hMm,
      headerMm: HEADER_MM,
      contentX,
      contentY,
      contentWMm: contentW,
      contentHMm: contentH,
      items: [],
      warn
    }
    sheets.push(sheet)
    cx = contentX
    cy = contentY
    rowH = 0
    return sheet
  }
  /** 取当前图纸；若尚未开页（例如关闭了校验页）则先开一张 */
  const ensureSheet = () => {
    if (!sheet) startSheet()
    return sheet
  }
  const nextRow = () => {
    cx = contentX
    cy += rowH + ROW_GAP
    rowH = 0
  }
  const fitsRow = (w: number) => cx + w <= right + EPS
  const fitsPage = (h: number) => cy + h <= bottom + EPS

  if (opts.includeCalibration) {
    const s = startSheet()
    s.title = `1:1 校验页 · ${opts.paper}（请按 100% 打印，关闭「适应页面」）`
    s.items.push({ type: 'calibration', xMm: contentX, yMm: contentY, wMm: contentW, hMm: contentH })
    cx = right
    rowH = contentH
  }

  if (opts.includePanels) {
    for (const p of buildPanels(l).panels) {
      const slot = panelSlot(p)
      // 当前行放不下先换行（行内已有其它块时）；当前页放不下另起一页（裁片绝不跨页、绝不缩放）
      if (cx > contentX + EPS && !fitsRow(slot.w)) nextRow()
      if (!fitsPage(slot.h)) startSheet()
      const cur = ensureSheet()

      if (slot.w > contentW + EPS || slot.h > contentH + EPS) {
        // 整块连一页可打印区都放不下：整块独占一页，水平居中、靠页眉放置，
        // 保持 1:1（由 CHK-12 幅面适配提示换纸，绝不切半 / 缩小）
        startSheet()
        // 水平居中：比可打印区宽时左右溢出量相同（纸面上仍居中，报警要求换纸）
        const px = contentX + (contentW - slot.w) / 2
        const py = contentY
        sheet.warn =
          `裁片 ${p.id} ${p.label}（占位 ${f1(slot.w)}×${f1(slot.h)}mm）大于 ${opts.paper} 可打印区` +
          `（${f1(contentW)}×${f1(contentH)}mm）：已整块单独一页居中、仍按 1:1 输出，未拆分未缩放；` +
          (opts.paper === 'A4' ? '请把纸张换成 A3 后重新打印。' : '当前幅面仍放不下，请检查灯体直径 / 缝份参数。')
        sheet.items.push({ type: 'panel', panel: p, xMm: px, yMm: py, wMm: slot.w, hMm: slot.h, oversized: true })
        cx = right
        rowH = contentH
        continue
      }

      cur.items.push({ type: 'panel', panel: p, xMm: cx, yMm: cy, wMm: slot.w, hMm: slot.h, oversized: false })
      cx += slot.w + ROW_GAP
      rowH = Math.max(rowH, slot.h)
    }
  }

  if (opts.includeStrips) {
    const usable = stripUsableMm(contentW)
    const wantOverlap = Math.max(0, opts.overlapMm)
    for (const m of buildFrame(l).members) {
      const total = m.lengthMm
      const segs = stripSegments(total, usable, wantOverlap)
      const segCount = segs.length
      const effOverlap = effectiveOverlap(wantOverlap, usable)
      segs.forEach((seg, i) => {
        if (!fitsRow(contentW)) nextRow()
        if (!fitsPage(STRIP_ROW_H)) startSheet()
        const cur = ensureSheet()
        // 编号按构件一顺接下去：FM001-1/3、FM001-2/3…，与构件清单同一编号，跨页也不断、不重号
        const tag = `${m.id}-${i + 1}/${segCount}`
        cur.items.push({
          type: 'strip',
          member: m,
          xMm: cx + STRIP_GUTTER,
          yMm: cy,
          lengthMm: seg.len,
          totalMm: total,
          segIndex: i,
          segCount,
          startMm: seg.start,
          tag,
          overlapMm: segCount > 1 ? effOverlap : 0,
          effectiveOverlapMm: effOverlap
        })
        cx = right
        rowH = STRIP_ROW_H
      })
    }
  }

  // 回填相邻段编号（拼接方向提示）
  const byMember = new Map<string, SheetItemStrip[]>()
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type !== 'strip') continue
      const arr = byMember.get(it.member.id) || []
      arr.push(it)
      byMember.set(it.member.id, arr)
    }
  }
  for (const arr of byMember.values()) {
    arr.sort((a, b) => a.segIndex - b.segIndex)
    arr.forEach((it, i) => {
      if (arr[i - 1]) it.prevTag = arr[i - 1].tag
      if (arr[i + 1]) it.nextTag = arr[i + 1].tag
    })
  }

  if (sheets.length === 0) startSheet()
  return sheets
}

function f1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1)
}

/** 裁片标签分页：每张裁片类型一张标签，每 10 张一页，一张都不许漏 */
export function paginateLabels(panels: Panel[]): Panel[][] {
  const pages: Panel[][] = []
  for (let i = 0; i < panels.length; i += LABELS_PER_PAGE) {
    pages.push(panels.slice(i, i + LABELS_PER_PAGE))
  }
  if (pages.length === 0) pages.push([])
  return pages
}

/** 真正的跨页（同一裁片出现 >1 次）才是失败；整块超区单页不算跨页 */
export function countSplitPanels(sheets: Sheet[]): string[] {
  const seen = new Map<string, number>()
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type === 'panel') seen.set(it.panel.id, (seen.get(it.panel.id) || 0) + 1)
    }
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)
}

/**
 * 断言：任一裁片不跨页（每块裁片在整份图纸中只出现一次且完整）。
 * overflow = 超过当前幅面可打印区、需换更大纸或调参数的裁片块数（这些块也未被拆分 / 缩放）。
 */
export function assertNoPanelSplit(sheets: Sheet[]): { pass: boolean; detail: string; overflow: number } {
  const seen = new Map<string, number>()
  let overflow = 0
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type !== 'panel') continue
      seen.set(it.panel.id, (seen.get(it.panel.id) || 0) + 1)
      if (it.oversized) overflow++
    }
  }
  const split = countSplitPanels(sheets)
  const pass = split.length === 0
  return {
    pass,
    overflow,
    detail:
      split.length === 0 && overflow === 0
        ? `共 ${seen.size} 种裁片，每块只出现在一页且完整落在可打印区内（超区整块输出 ${overflow} 块）`
        : split.length > 0
          ? `存在跨页裁片：${split.map((id) => `${id}×${seen.get(id)}`).join('、')}`
          : `有 ${overflow} 种裁片整块超出 ${sheets[0]?.paper ?? ''} 可打印区（已整块单页居中、未拆分未缩放），请换 A3 或调小直径 / 缝份`
  }
}
