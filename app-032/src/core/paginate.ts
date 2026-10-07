/**
 * 1:1 放样图分页（规格书 §4.5 / §8）
 * 规则（单位全 mm，1 位小数）：
 * - 按真实毫米绘制；**同一块裁片不拆到两页、不缩放**；
 * - 一块裁片按当前幅面排不进可打印区时，整块挪到单独一页居中 1:1 印出（费纸但尺寸正确）；
 *   连单页都放不下（裁片本身大于纸张可打印区）时标记 oversize 并由自检报错，绝不就地切开；
 * - 跨页只发生在骨架长条图上：相邻两段按搭接量重叠，拼的时候能接上；
 *   分段编号以「构件」为序（如 FM002-2/4），跨页也连续；
 * - 纸张换幅面后，图纸宽高、可打印区、长条分段全部按新幅面的毫米数重算。
 */
import type { FrameMember, Lantern, Panel } from './types'
import { buildFrame } from './frame'
import { buildPanels } from './panels'

export type PaperSize = 'A4' | 'A3'

export const PAPER_DIMS: Record<PaperSize, { wMm: number; hMm: number }> = {
  A4: { wMm: 210, hMm: 297 },
  A3: { wMm: 297, hMm: 420 }
}

/** 打印留白：避开大多数打印机的物理不可印区（@page margin 0，留白画在图纸内） */
export const PAGE_MARGIN_MM = 8
export const HEADER_MM = 12

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
  xMm: number
  yMm: number
  wMm: number
  hMm: number
  /** 裁片本体相对占位盒的左留白（普通拼排 vs 独占页不同） */
  padLeft: number
  /** 裁片本体相对占位盒的上留白（图名） */
  padTop: number
  /** 整块独占一页居中（排不进当前页可打印区时的处理，仍 1:1） */
  dedicated: boolean
  /** 裁片本体（含最小安全留白）大于整页可打印区：任何幅面都印不全，必须报错，绝不切开/缩放 */
  oversize: boolean
}

export interface SheetItemStrip {
  type: 'strip'
  member: FrameMember
  xMm: number
  yMm: number
  /** 本段绘制长度（1:1，mm，不含与下一段的搭接） */
  lengthMm: number
  /** 该构件截取总长（含余量，mm） */
  totalMm: number
  segIndex: number
  segCount: number
  /** 本段起点在整根构件上的位置（mm），用于 1:1 图上标注标尺读数 */
  startMm: number
  /** 拼接编号，以构件为序，如 FM002-2/4（跨页也连续） */
  tag: string
  /** 相邻段编号（用于标注搭接方向） */
  prevTag?: string
  nextTag?: string
  overlapMm: number
}

export type SheetItem = SheetItemCalibration | SheetItemPanel | SheetItemStrip

export interface Sheet {
  index: number
  title: string
  wMm: number
  hMm: number
  headerMm: number
  contentX: number
  contentY: number
  contentWMm: number
  contentHMm: number
  items: SheetItem[]
  /** 是否为「超大裁片独占页」：该页上的裁片在任何幅面都印不全 */
  oversize?: boolean
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

/** 普通拼排时裁片四周留给图名/尺寸箭头的空当（mm） */
const PANEL_PAD_X = 6
const PANEL_PAD_TOP = 8
const PANEL_PAD_BOTTOM = 20
/** 独占一页居中时的最小安全留白（仅避开打印机物理不可印区与图名） */
const PANEL_DED_PAD_X = 3
const PANEL_DED_PAD_TOP = 8
const PANEL_DED_PAD_BOTTOM = 14
const ROW_GAP = 5
const STRIP_ROW_H = 17
const EPS = 0.001

export function f1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1)
}

function panelSize(p: Panel) {
  return { w: Math.max(p.widthTopMm, p.widthBottomMm), h: p.heightMm }
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

  const startSheet = (titleSuffix?: string) => {
    const idx = sheets.length + 1
    sheet = {
      index: idx,
      title: titleSuffix
        ? `放样图 ${opts.paper} · 第 ${idx} 页 · ${titleSuffix}`
        : `放样图 ${opts.paper} · 第 ${idx} 页`,
      wMm: dims.wMm,
      hMm: dims.hMm,
      headerMm: HEADER_MM,
      contentX,
      contentY,
      contentWMm: contentW,
      contentHMm: contentH,
      items: []
    }
    sheets.push(sheet)
    cx = contentX
    cy = contentY
    rowH = 0
    return sheet
  }
  /** 若尚未开页先开一张（例如关闭了校验页） */
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
    const s = startSheet('1:1 校验页')
    s.title = `1:1 校验页 · ${opts.paper}（请按 100% 打印，关闭「适应页面」）`
    s.items.push({ type: 'calibration', xMm: contentX, yMm: contentY, wMm: contentW, hMm: contentH })
    cx = right
    rowH = contentH
  }

  // 校验页独占一张纸：后续内容另开新页
  if (opts.includeCalibration && (opts.includePanels || opts.includeStrips)) {
    startSheet()
  }

  // ---------- 裁片：不跨页、不缩放；排不进就整块独占一页居中 ----------
  if (opts.includePanels) {
    const all = buildPanels(l).panels
    for (const p of all) {
      const { w: pw, h: ph } = panelSize(p)

      // ① 裁片本体连「最小安全留白 + 图名」都放不下：任何幅面都印不全。
      //    整块独占一页并标红报错，绝不切开或缩放（切开/缩放都会让拓印尺寸错误、已裁料作废）。
      const dedW = pw + PANEL_DED_PAD_X * 2
      const dedH = ph + PANEL_DED_PAD_TOP + PANEL_DED_PAD_BOTTOM
      if (dedW > contentW + EPS || dedH > contentH + EPS) {
        const s = startSheet(`超大裁片 ${p.id}（${p.label}）`)
        s.oversize = true
        s.warn =
          `裁片 ${p.id}（${p.label}）裁切尺寸 ${f1(pw)}×${f1(ph)}mm，即使整块独占一页也大于 ` +
          `${opts.paper} 可打印区 ${f1(contentW)}×${f1(contentH)}mm，1:1 印不全。` +
          `不允许切开或缩放（否则拓印尺寸错误、已裁料作废），请换更大幅面后重排。`
        // 仍按 1:1 把裁片左上角放进安全区，便于直观看到超出多少
        s.items.push({
          type: 'panel',
          panel: p,
          xMm: contentX,
          yMm: contentY,
          wMm: dedW,
          hMm: dedH,
          padLeft: PANEL_DED_PAD_X,
          padTop: PANEL_DED_PAD_TOP,
          dedicated: true,
          oversize: true
        })
        cx = right
        cy = bottom
        rowH = 0
        continue
      }

      // ② 普通拼排：按带完整标注空当的占位盒在当前页流式排版
      const boxW = pw + PANEL_PAD_X * 2
      const boxH = ph + PANEL_PAD_TOP + PANEL_PAD_BOTTOM
      if (cx > contentX + EPS && !fitsRow(boxW)) nextRow()

      if (boxW <= contentW + EPS && fitsPage(boxH)) {
        const cur = ensureSheet()
        cur.items.push({
          type: 'panel',
          panel: p,
          xMm: cx,
          yMm: cy,
          wMm: boxW,
          hMm: boxH,
          padLeft: PANEL_PAD_X,
          padTop: PANEL_PAD_TOP,
          dedicated: false,
          oversize: false
        })
        cx += boxW + ROW_GAP
        rowH = Math.max(rowH, boxH)
        continue
      }

      // ③ 当前页剩余位置放不下（会被切边）：整块挪到单独一页、水平垂直居中，仍 1:1
      const s = startSheet(`裁片 ${p.id}（${p.label}）独占页`)
      const x = contentX + Math.max(0, (contentW - dedW) / 2)
      const y = contentY + Math.max(0, (contentH - dedH) / 2)
      s.items.push({
        type: 'panel',
        panel: p,
        xMm: x,
        yMm: y,
        wMm: dedW,
        hMm: dedH,
        padLeft: PANEL_DED_PAD_X,
        padTop: PANEL_DED_PAD_TOP,
        dedicated: true,
        oversize: false
      })
      // 独占页之后另开新页继续排后续裁片
      startSheet()
    }
  }

  // ---------- 骨架长条：按搭接量一顺接下去，编号以构件为序 ----------
  if (opts.includeStrips) {
    // 长条行从新页顺序排，避免裁片页右侧剩余空位造成误判
    if (sheet && sheet.items.length > 0) startSheet()
    const usable = contentW
    const overlap = clampOverlap(Math.max(0, opts.overlapMm), usable)
    /** 每段在构件方向上推进的步长（相邻段起点间隔） */
    const advance = usable - overlap
    for (const m of buildFrame(l).members) {
      const total = m.lengthMm
      const segCount = total <= usable + EPS ? 1 : Math.ceil((total - overlap) / (usable - overlap))
      for (let i = 0; i < segCount; i++) {
        const start = i * advance
        // 本段与下段重叠 overlap；末段收在构件末端，绝不越过构件全长
        const len = Math.min(usable, total - start)
        if (!fitsPage(STRIP_ROW_H)) startSheet()
        const cur = ensureSheet()
        const tag = `${m.id}-${i + 1}/${segCount}`
        cur.items.push({
          type: 'strip',
          member: m,
          xMm: contentX,
          yMm: cy,
          lengthMm: len,
          totalMm: total,
          segIndex: i,
          segCount,
          startMm: start,
          tag,
          overlapMm: segCount > 1 ? overlap : 0
        })
        cy += STRIP_ROW_H
        rowH = STRIP_ROW_H
      }
    }
  }

  // 回填相邻段编号（拼接方向提示；跨页也能找到）
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

  // 清掉独占页后多开、最终没用上的空白页，并把页码/标题重排
  for (let i = sheets.length - 1; i >= 0; i--) {
    if (sheets[i].items.length === 0) sheets.splice(i, 1)
  }
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i]
    s.index = i + 1
    if (!s.oversize && !/独占页|校验页/.test(s.title)) {
      s.title = s.title.replace(/第 \d+ 页/, `第 ${i + 1} 页`)
    }
    // 独占页标题不带页码，统一在页脚显示；这里补上正确页码
    if (/独占页/.test(s.title) && !s.oversize) {
      s.title = `放样图 ${opts.paper} · 第 ${i + 1} 页 · 裁片独占页（整块居中 1:1）`
    }
    if (s.oversize) {
      s.title = `放样图 ${opts.paper} · 第 ${i + 1} 页 · 超大裁片（印不全，禁止切开/缩放）`
    }
  }

  if (sheets.length === 0) startSheet()
  return sheets
}

function clampOverlap(overlap: number, usable: number): number {
  // 搭接量必须小于可打印宽，否则步长 ≤ 0 分段不收敛
  if (usable <= 0) return 0
  return Math.min(overlap, Math.max(0, usable - 10))
}

/** 裁片占位盒（与 paginate 的留白常量保持一致），PrintView 按此 1:1 落图 */
export const PANEL_BOX = { padX: PANEL_PAD_X, padTop: PANEL_PAD_TOP, padBottom: PANEL_PAD_BOTTOM }

/**
 * 断言：任一裁片不跨页（每块裁片在整份图纸中只出现一次且完整落在可打印区内）。
 * oversize（裁片本身大于整页可打印区）单独计数——这是必须处理的错误，不算跨页。
 */
export function assertNoPanelSplit(sheets: Sheet[]): {
  pass: boolean
  detail: string
  overflow: number
  oversize: number
  totalKinds: number
} {
  const seen = new Map<string, number>()
  let overflow = 0
  let oversize = 0
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type !== 'panel') continue
      seen.set(it.panel.id, (seen.get(it.panel.id) || 0) + 1)
      if (it.oversize) {
        oversize++
        continue
      }
      const fitsX = it.xMm >= s.contentX - EPS && it.xMm + it.wMm <= s.contentX + s.contentWMm + EPS
      const fitsY = it.yMm >= s.contentY - EPS && it.yMm + it.hMm <= s.contentY + s.contentHMm + EPS
      if (!fitsX || !fitsY) overflow++
    }
  }
  const split = [...seen.entries()].filter(([, n]) => n > 1)
  const pass = split.length === 0 && overflow === 0 && oversize === 0
  return {
    pass,
    overflow,
    oversize,
    totalKinds: seen.size,
    detail: pass
      ? `共 ${seen.size} 种裁片，每块只出现在一页且完整落在 ${sheets[0]?.wMm ?? 0}×${sheets[0]?.hMm ?? 0}mm 图纸的可打印区内（不跨页、不缩放）`
      : [
          split.length ? `存在跨页裁片：${split.map(([id, n]) => `${id}×${n}`).join('、')}` : '',
          overflow ? `越出可打印区 ${overflow} 块` : '',
          oversize ? `超大裁片（整块独占页仍印不全）${oversize} 块，请换更大幅面` : ''
        ]
          .filter(Boolean)
          .join('；')
  }
}

/**
 * 断言：长条分段连续可拼——每段起点按（可打印宽 − 搭接量）一顺接下去，
 * 相邻段编号连续、搭接量标注一致、末段收在构件末端。
 */
export function assertStripsContinuous(
  l: Lantern,
  opts: LoftOptions,
  sheets: Sheet[]
): { pass: boolean; detail: string; memberCount: number; segCount: number } {
  const usable = PAPER_DIMS[opts.paper].wMm - PAGE_MARGIN_MM * 2
  const overlap = clampOverlap(Math.max(0, opts.overlapMm), usable)
  const advance = usable - overlap

  const expect = new Map<string, number>()
  let memberCount = 0
  for (const m of buildFrame(l).members) {
    memberCount++
    const n = m.lengthMm <= usable + EPS ? 1 : Math.ceil((m.lengthMm - overlap) / (usable - overlap))
    expect.set(m.id, n)
  }

  const got = new Map<string, SheetItemStrip[]>()
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type !== 'strip') continue
      const arr = got.get(it.member.id) || []
      arr.push(it)
      got.set(it.member.id, arr)
    }
  }

  let segCount = 0
  const problems: string[] = []
  for (const [id, n] of expect) {
    const arr = got.get(id)
    if (!arr) {
      problems.push(`${id} 缺图`)
      continue
    }
    segCount += arr.length
    if (arr.length !== n) problems.push(`${id} 段数 ${arr.length}≠应 ${n}`)
    const sorted = [...arr].sort((a, b) => a.segIndex - b.segIndex)
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i]
      if (it.segIndex !== i) problems.push(`${id} 段序乱（第 ${i + 1} 段）`)
      if (Math.abs(it.startMm - i * advance) > 0.06) {
        problems.push(`${id} 第 ${i + 1} 段起点 ${f1(it.startMm)}≠应 ${f1(i * advance)}`)
      }
      if (it.tag !== `${id}-${i + 1}/${n}`) problems.push(`${id} 编号 ${it.tag}≠应 ${id}-${i + 1}/${n}`)
      if (n > 1 && it.overlapMm !== overlap) problems.push(`${id} 搭接量 ${f1(it.overlapMm)}≠${f1(overlap)}`)
      const wantLen = i === n - 1 ? it.totalMm - it.startMm : advance + overlap
      if (Math.abs(it.lengthMm - wantLen) > 0.06) {
        problems.push(`${id} 第 ${i + 1} 段长 ${f1(it.lengthMm)}≠应 ${f1(wantLen)}`)
      }
      if (i > 0 && it.prevTag !== `${id}-${i}/${n}`) problems.push(`${id} 与上段编号接不上`)
    }
    const last = sorted[n - 1]
    if (last && Math.abs(last.startMm + last.lengthMm - last.totalMm) > 0.06) {
      problems.push(`${id} 末段未收到末端`)
    }
  }

  return {
    pass: problems.length === 0,
    memberCount,
    segCount,
    detail:
      problems.length === 0
        ? `${memberCount} 根构件共 ${segCount} 段，按可打印宽 ${f1(usable)}mm、搭接 ${f1(overlap)}mm 一顺接下去；` +
          `段编号连续（FMxxx-i/n，跨页不断），末段收在构件末端，拼缝对得上`
        : problems.slice(0, 5).join('；') + (problems.length > 5 ? ` 等 ${problems.length} 处` : '')
  }
}
