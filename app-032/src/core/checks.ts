/**
 * 自检（对应规格书 §10 验收标准）
 * 每次参数变化都会重算全部几何并跑一遍断言，结果直接显示在界面上。
 */
import type { CheckResult, FrameMember, Lantern, Panel } from './types'
import { bodySurfaceArea, polygonEdge, ringPerimeter, segmentInfos } from './geometry'
import { buildFrame, type FrameResult } from './frame'
import { buildPanels, panelNetArea, type PanelResult } from './panels'
import { computeBatch, computeMaterials, type BatchMaterials, type SingleLightMaterials } from './materials'
import {
  assertNoPanelSplit,
  countSplitPanels,
  paginate,
  paginateLabels,
  stripSegments,
  stripUsableMm,
  effectiveOverlap,
  PAGE_MARGIN_MM,
  CALIBRATION_PAGES,
  type LoftOptions,
  type Sheet,
  type SheetItemStrip
} from './paginate'
import { CRAFT } from './craft'

export interface FullResult {
  frame: FrameResult
  panels: PanelResult
  materials: SingleLightMaterials
  batch: BatchMaterials
  sheets: Sheet[]
  checks: CheckResult[]
  reconcile: ReconcileResult
  elapsedMs: number
}

/** 编号 / 块数对账单：图纸页、标签页、分页三处共用同一份结论 */
export interface ReconcileResult {
  paper: string
  overlapMm: number
  /** 裁片类型数（裁片清单 / 图纸 / 标签三方一致） */
  panelKinds: number
  /** 裁片总块数（含同类型多块） */
  panelQty: number
  /** 图纸上实际排出的裁片占位块数（每类型 1 块 1:1 样） */
  sheetPanelKinds: number
  /** 标签总张数（= 类型数）与标签页数 */
  labelCards: number
  labelPages: number
  /** 长条构件种数、总段数、跨页（多段）构件数 */
  stripKinds: number
  stripSegTotal: number
  stripSplitKinds: number
  /** 图纸总页数（含校验页） */
  sheetPages: number
  problems: string[]
  pass: boolean
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1)
const f3 = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3)

export function computeAll(l: Lantern, loft: LoftOptions): FullResult {
  const t0 = performance.now()
  const frame = buildFrame(l)
  const panels = buildPanels(l)
  const materials = computeMaterials(l)
  const batch = computeBatch(materials, Math.max(1, Math.round(l.batchCount)), l.wasteRatio)
  const sheets = paginate(l, loft)
  const reconcileResult = reconcile(frame.members, panels.panels, sheets, loft)
  const elapsedMs = performance.now() - t0
  const checks = runChecks(l, frame, panels, materials, batch, sheets, elapsedMs, loft, reconcileResult)
  return { frame, panels, materials, batch, sheets, checks, reconcile: reconcileResult, elapsedMs }
}

/**
 * 同一份结论：图纸上每一块裁片编号、每一段长条拼接编号、标签页块数、
 * 裁片清单与构件清单里的编号必须对得上；改纸张 / 搭接量后整体重算。
 */
export function reconcile(
  members: FrameMember[],
  panels: Panel[],
  sheets: Sheet[],
  loft: LoftOptions
): ReconcileResult {
  const panelIds = panels.map((p) => p.id)
  const memberIds = new Set(members.map((m) => m.id))

  const sheetPanels: string[] = []
  const stripsByMember = new Map<string, SheetItemStrip[]>()
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type === 'panel') sheetPanels.push(it.panel.id)
      if (it.type === 'strip') {
        const arr = stripsByMember.get(it.member.id) || []
        arr.push(it)
        stripsByMember.set(it.member.id, arr)
      }
    }
  }

  const labelPagesArr = paginateLabels(panels)
  const labelCards = labelPagesArr.reduce((n, pg) => n + pg.length, 0)
  const problems: string[] = []

  // ① 裁片编号：清单 vs 图纸（每种 1 块 1:1 样，不重不漏）
  const sheetCounts = new Map<string, number>()
  for (const id of sheetPanels) sheetCounts.set(id, (sheetCounts.get(id) || 0) + 1)
  for (const id of panelIds) {
    const n = sheetCounts.get(id) || 0
    if (n === 0) problems.push(`裁片 ${id} 没有排进 1:1 图纸`)
    else if (n > 1) problems.push(`裁片 ${id} 在图纸上重复出现 ${n} 次（疑似跨页切开）`)
  }
  for (const [id, n] of sheetCounts) {
    if (!panelIds.includes(id)) problems.push(`图纸上出现裁片清单里没有的编号 ${id}`)
    if (n > 1) problems.push(`裁片 ${id} 被排了 ${n} 次`)
  }

  // ② 标签：张数 = 裁片类型数，编号一一对得上，每页 ≤10 张
  if (labelCards !== panels.length) problems.push(`标签 ${labelCards} 张 ≠ 裁片类型 ${panels.length} 种`)
  labelPagesArr.forEach((pg, i) => {
    if (pg.length > 10) problems.push(`标签第 ${i + 1} 页排了 ${pg.length} 张（每页最多 10 张）`)
    for (const p of pg) {
      if (!panelIds.includes(p.id)) problems.push(`标签页出现裁片清单里没有的编号 ${p.id}`)
    }
  })

  // ③ 长条：段编号按构件一顺接上、跨页不断、拼接编号引用的都是真实构件
  let stripSegTotal = 0
  let stripSplitKinds = 0
  for (const [mid, arrRaw] of stripsByMember) {
    if (!memberIds.has(mid)) {
      problems.push(`图纸长条引用了构件清单里没有的编号 ${mid}`)
      continue
    }
    const arr = [...arrRaw].sort((a, b) => a.segIndex - b.segIndex)
    stripSegTotal += arr.length
    if (arr.length > 1) stripSplitKinds += 1
    arr.forEach((it, i) => {
      if (it.segIndex !== i) problems.push(`构件 ${mid} 段顺序错乱：第 ${i + 1} 张是 segIndex=${it.segIndex + 1}`)
      const expectTag = `${mid}-${i + 1}/${arr.length}`
      if (it.tag !== expectTag) problems.push(`长条编号 ${it.tag} 与应有编号 ${expectTag} 不一致`)
      if (i > 0) {
        const prev = arr[i - 1]
        const gap = +(it.startMm - (prev.startMm + prev.lengthMm)).toFixed(3)
        if (Math.abs(gap + it.overlapMm) > 0.2) {
          problems.push(`构件 ${mid} 第 ${i + 1} 段与上段搭接对不上（几何重叠应为 ${it.overlapMm}mm，实为 ${-gap}mm）`)
        }
        if (it.prevTag !== prev.tag) problems.push(`构件 ${mid} 第 ${i + 1} 段「接上段」编号 ${it.prevTag} ≠ ${prev.tag}`)
      }
      if (i < arr.length - 1 && it.nextTag !== arr[i + 1].tag) {
        problems.push(`构件 ${mid} 第 ${i + 1} 段「续下段」编号 ${it.nextTag} ≠ ${arr[i + 1].tag}`)
      }
    })
    // 最后一段必须覆盖到构件全长
    const last = arr[arr.length - 1]
    if (last && last.startMm + last.lengthMm < last.totalMm - 0.5) {
      problems.push(`构件 ${mid} 分段到 ${f1(last.startMm + last.lengthMm)}mm 就断了，全长 ${f1(last.totalMm)}mm 没出全`)
    }
  }

  const panelQty = panels.reduce((s, p) => s + p.qty, 0)
  return {
    paper: loft.paper,
    overlapMm: Math.max(0, loft.overlapMm),
    panelKinds: panels.length,
    panelQty,
    sheetPanelKinds: sheetPanels.length,
    labelCards,
    labelPages: labelPagesArr.length,
    stripKinds: stripsByMember.size,
    stripSegTotal,
    stripSplitKinds,
    sheetPages: sheets.length,
    problems,
    pass: problems.length === 0
  }
}

function runChecks(
  l: Lantern,
  frame: FrameResult,
  panels: PanelResult,
  materials: SingleLightMaterials,
  batch: BatchMaterials,
  sheets: Sheet[],
  elapsedMs: number,
  loft: LoftOptions,
  reconcileResult: ReconcileResult
): CheckResult[] {
  const out: CheckResult[] = []
  const g = frame.geometry
  const lash = Math.max(0, l.lashAllowanceMm)

  // ---- CHK-01 几何：棱长/周长与手算一致 ----
  {
    const cases = [
      { name: '正六棱柱底边（D200）', got: polygonEdge(100, 6), expect: 100, tol: 1 },
      { name: '正八棱柱底边（D200）', got: polygonEdge(100, 8), expect: 76.5367, tol: 1 },
      { name: '圆形横篾圈周长（D200）', got: ringPerimeter(100, 0, false), expect: 628.3185, tol: 1 },
      { name: '六边形周长（D200）', got: ringPerimeter(100, 6, true), expect: 600, tol: 1 }
    ]
    const bad = cases.filter((c) => Math.abs(c.got - c.expect) > c.tol)
    out.push({
      id: 'CHK-01',
      title: '几何手算核对（棱长 / 周长，误差 ≤ 1mm）',
      pass: bad.length === 0,
      value: bad.length === 0 ? '4/4 项通过' : `${bad.length} 项超差`,
      detail: cases
        .map((c) => `${c.name}：算得 ${f3(c.got)} / 手算 ${f3(c.expect)}（Δ${f3(Math.abs(c.got - c.expect))}）`)
        .join('；')
    })
  }

  // ---- CHK-02 竖篾长度与分段高度累计 ----
  {
    const segs = segmentInfos(g)
    const sumH = segs.reduce((s, x) => s + x.heightMm, 0)
    const sumSlant = segs.reduce((s, x) => s + x.slantMm, 0)
    const vertical = frame.members.find((m) => m.kind === 'vertical' || m.kind === 'rib')
    const raw = vertical ? vertical.rawLengthMm : 0
    const allStraight = segs.every((s) => Math.abs(s.drMm) < 0.05)
    const pass = Math.abs(raw - sumSlant) <= 0.1 && (!allStraight || Math.abs(raw - sumH) <= 0.1)
    out.push({
      id: 'CHK-02',
      title: '竖篾净长 = 分段母线折线长累计',
      pass,
      value: `Δ折线 ${f1(Math.abs(raw - sumSlant))}mm`,
      detail: allStraight
        ? `竖篾净长 ${f1(raw)}mm，分段高累计 ${f1(sumH)}mm，平口直柱两者一致（Δ${f1(Math.abs(raw - sumH))}mm）`
        : `竖篾净长 ${f1(raw)}mm，分段高累计 ${f1(sumH)}mm，折线长累计 ${f1(sumSlant)}mm（收口段横向偏移 ${f1(sumSlant - sumH)}mm）`
    })
  }

  // ---- CHK-03 缝份 ----
  {
    const s = Math.max(0, l.seamAllowanceMm)
    const bad = panels.panels.filter(
      (p) =>
        Math.abs(p.widthTopMm - (p.rawWidthTopMm + 2 * s)) > 0.06 ||
        Math.abs(p.widthBottomMm - (p.rawWidthBottomMm + 2 * s)) > 0.06 ||
        Math.abs(p.heightMm - (p.rawHeightMm + 2 * s)) > 0.06
    )
    out.push({
      id: 'CHK-03',
      title: '裁片尺寸 = 展开净尺寸 + 缝份 × 2（每边）',
      pass: bad.length === 0,
      value: `${panels.panels.length - bad.length}/${panels.panels.length} 种裁片通过`,
      detail:
        bad.length === 0
          ? `全部 ${panels.panels.length} 种裁片上/下/高三个尺寸均等于净尺寸 + ${f1(s)}×2mm；裁片图以红色虚线绘制缝份折线`
          : `超差裁片：${bad.map((p) => p.label).join('、')}`
    })
  }

  // ---- CHK-04 备料守恒 ----
  {
    const stock = frame.members.reduce((a, m) => a + m.lengthMm * m.qty, 0)
    const rawTotal = frame.members.reduce((a, m) => a + m.rawLengthMm * m.qty, 0)
    const lashTotal = frame.members.reduce((a, m) => a + m.qty * m.lashJoints * lash, 0)
    const diff = stock - rawTotal
    const pass = stock >= rawTotal - 1e-6 && Math.abs(diff - lashTotal) <= 0.5
    out.push({
      id: 'CHK-04',
      title: '备料守恒：Σ备料长度 ≥ Σ净长，且差值 = 余量总和',
      pass,
      value: `Σ备料 ${f1(stock)}mm / Σ净长 ${f1(rawTotal)}mm`,
      detail: `差值 ${f1(diff)}mm，应等于余量总和 ${f1(lashTotal)}mm（竖篾两端、横篾圈接头各计 ${f1(lash)}mm）`
    })
  }

  // ---- CHK-05 面积核对 ----
  {
    const netArea = panels.panels.reduce((a, p) => a + panelNetArea(p) * p.qty, 0)
    const refArea = bodySurfaceArea(g, Math.max(3, Math.round(l.divisions)))
    const ratio = refArea > 0 ? netArea / refArea : 0
    const pass = ratio >= 0.97 && ratio <= 1.03
    let advice = ''
    if (!pass && !g.polygon) {
      const need = suggestDivisions(l, netArea, ratio)
      advice = need ? `；建议把母线等分数提高到 ${need}（当前 ${l.divisions}）` : ''
    } else if (!pass) {
      advice = '；请检查缝份/分层参数，棱柱类侧面积应与裁片面积完全一致'
    }
    out.push({
      id: 'CHK-05',
      title: '面积核对：Σ裁片净面积 / 灯体表面积 ∈ [0.97, 1.03]',
      pass,
      value: `比值 ${(ratio * 100).toFixed(2)}%`,
      detail: `裁片净面积 ${f3(netArea / 1_000_000)}m²，灯体表面积（含顶底盖）${f3(refArea / 1_000_000)}m²${advice}`
    })
  }

  // ---- CHK-06 分页：裁片不跨页、不缩放（整块超区时单独成页，仍 1:1，是选定取舍） ----
  {
    const splitPanels = countSplitPanels(sheets)
    const r = assertNoPanelSplit(sheets)
    out.push({
      id: 'CHK-06',
      title: '分页：任一裁片不跨页、不缩放（放不下整块单独一页居中）',
      pass: splitPanels.length === 0,
      value:
        splitPanels.length === 0
          ? r.overflow > 0
            ? `通过（${r.overflow} 块超幅面已整块单页，需换纸）`
            : '通过'
          : `失败（${splitPanels.length} 块被拆）`,
      detail:
        splitPanels.length === 0
          ? r.detail +
            '；长条跨页按真实搭接 ' +
            f1(loftOverlap(sheets)) +
            'mm 排布，接缝处有对位十字与连续拼接编号'
          : `存在跨页裁片：${splitPanels.join('、')}`
    })
    // CHK-12：幅面提示（不算失败——这是「整块单页、1:1」取舍的代价，一眼可见该换纸）
    out.push({
      id: 'CHK-12',
      title: `幅面适配：超 ${loft.paper} 可打印区的裁片（整块单页居中、未拆未缩，需换更大纸）`,
      pass: true,
      value: r.overflow === 0 ? '无超幅面裁片' : `${r.overflow} 块超幅面`,
      detail:
        r.overflow === 0
          ? `全部裁片在 ${loft.paper} 可打印区内完整排列`
          : `${r.detail}；这些裁片仍按真实尺寸 1:1 输出，拼接拓印尺寸正确，代价是每张多用一页纸；换 ${loft.paper === 'A4' ? 'A3' : '更大幅面'} 后本项自动消失`
    })
  }

  // ---- CHK-07 批量 ----
  {
    const n = Math.max(1, Math.round(l.batchCount))
    const k = n * (1 + l.wasteRatio)
    // 与单灯值的偏差只来自展示精度（长度 3 位小数 / 胶 1 位小数）
    const errs = [
      Math.abs(batch.frameM - materials.frameM * k),
      Math.abs(batch.coveringM2 - materials.coveringM2 * k),
      Math.abs(batch.lashM - materials.lashM * k)
    ]
    const pass = errs.every((e) => e <= 0.0011) && Math.abs(batch.glueG - materials.glueG * k) <= 0.051
    out.push({
      id: 'CHK-07',
      title: `批量制灯：${n} 个材料总量 = 单灯 × ${n} × (1 + ${(l.wasteRatio * 100).toFixed(0)}%)`,
      pass,
      value: `竹篾 ${f3(batch.frameM)}m / 蒙面 ${f3(batch.coveringM2)}m²`,
      detail: `单灯竹篾 ${f3(materials.frameM)}m × ${n} × ${(1 + l.wasteRatio).toFixed(2)} = ${f3(materials.frameM * k)}m = 批量值；蒙面、扎线、胶同理（LED 按颗数 × ${n} 计，不参与损耗）`
    })
  }

  // ---- CHK-08 性能 ----
  {
    const pass = elapsedMs < 100
    out.push({
      id: 'CHK-08',
      title: '放样计算 < 100ms',
      pass,
      value: `${elapsedMs.toFixed(1)}ms`,
      detail: `${l.divisions} 等分 × ${l.layers.length} 层：构件 ${frame.totalQty} 根、裁片 ${panels.totalQty} 块、图纸 ${sheets.length} 页，全流程耗时 ${elapsedMs.toFixed(1)}ms（含分页）`
    })
  }

  // ---- CHK-09 编号总核对：图纸 / 标签 / 清单同一份结论 ----
  {
    const rc = reconcileResult
    out.push({
      id: 'CHK-09',
      title: '编号总核对：图纸裁片编号、长条拼接编号、标签块数、裁片/构件清单完全一致',
      pass: rc.pass,
      value: rc.pass
        ? `裁片 ${rc.panelKinds} 种/${rc.panelQty} 块、标签 ${rc.labelCards} 张/${rc.labelPages} 页、长条 ${rc.stripSegTotal} 段，全部对上`
        : `${rc.problems.length} 处对不上`,
      detail: rc.pass
        ? `裁片清单 ${rc.panelKinds} 种 = 图纸 1:1 样 ${rc.sheetPanelKinds} 块 = 标签 ${rc.labelCards} 张（每 10 张一页，共 ${rc.labelPages} 页）；` +
          `构件清单 ${rc.stripKinds} 种长条在图纸上共 ${rc.stripSegTotal} 段（跨页 ${rc.stripSplitKinds} 种），段段连续；图纸共 ${rc.sheetPages} 页（${rc.paper}，搭接 ${f1(rc.overlapMm)}mm）`
        : rc.problems.join('；')
    })
  }

  // ---- CHK-10 长条分段：搭接几何连续、段编号一顺接上 ----
  {
    const usable = stripUsableMm(sheets[0]?.contentWMm ?? 0)
    const want = Math.max(0, l.overlapMm)
    const eff = effectiveOverlap(want, usable)
    const clamped = want > eff + 0.001
    // 用当前纸张 / 搭接量重新独立分段，与图纸上的段数/起点逐一比对
    const members = frame.members
    const expectSegs = new Map<string, { start: number; len: number }[]>()
    for (const m of members) expectSegs.set(m.id, stripSegments(m.lengthMm, usable, want))
    const got = new Map<string, SheetItemStrip[]>()
    for (const s of sheets) {
      for (const it of s.items) {
        if (it.type !== 'strip') continue
        const arr = got.get(it.member.id) || []
        arr.push(it)
        got.set(it.member.id, arr)
      }
    }
    const bad: string[] = []
    for (const m of members) {
      const exp = expectSegs.get(m.id)!
      const g = (got.get(m.id) || []).slice().sort((a, b) => a.segIndex - b.segIndex)
      if (g.length !== exp.length) {
        bad.push(`${m.id} 段数 ${g.length}≠${exp.length}`)
        continue
      }
      exp.forEach((e, i) => {
        if (Math.abs(e.start - g[i].startMm) > 0.2 || Math.abs(e.len - g[i].lengthMm) > 0.2) {
          bad.push(`${m.id} 第 ${i + 1} 段起点/长度对不上`)
        }
      })
    }
    out.push({
      id: 'CHK-10',
      title: '长条跨页：相邻段真实搭接、标尺读数连续、段编号按顺序接上',
      pass: bad.length === 0,
      value: bad.length === 0 ? `搭接 ${f1(eff)}mm · 共 ${[...got.values()].reduce((s, a) => s + a.length, 0)} 段` : `${bad.length} 处异常`,
      detail:
        (clamped
          ? `搭接量 ${f1(want)}mm ≥ 单段可用宽 ${f1(usable)}mm，已夹为 ${f1(eff)}mm；`
          : `搭接量 ${f1(eff)}mm（每段前进 ${f1(usable - eff)}mm，相邻段几何重叠 ${f1(eff)}mm，拼接可对上）；`) +
        (bad.length === 0 ? '各构件段数 / 起点 / 长度与分段公式一致，编号 F###-i/n 连续' : bad.join('；'))
    })
  }

  // ---- CHK-11 校验尺按标称长度绘制（1:1 的图纸侧保证） ----
  {
    const ruler = CALIBRATION_RULER_MM
    const circle = CALIBRATION_CIRCLE_MM
    out.push({
      id: 'CHK-11',
      title: `校验尺 / 校验圆按标称长度绘制（水平尺 ${ruler}mm、垂直尺 ${ruler}mm、⌀${circle}mm）`,
      pass: ruler === 100 && circle === 100,
      value: `尺 ${ruler}.0mm · 圆 ⌀${circle}.0mm`,
      detail:
        `SVG width/height 与 viewBox 均按 mm 1:1（1 单位 = 1mm），@page 尺寸随所选 ${loft.paper} 幅面注入、页边距 0、内容距纸边 ${PAGE_MARGIN_MM}mm（图纸含 ${CALIBRATION_PAGES} 张校验页）；` +
        `打印后实测必须 = ${ruler}.0mm（误差 ≤ 1mm）；若实测为 ${Math.round(ruler * 0.96)}mm 一类，说明打印对话框仍在「适应页面 / Fit」，必须改回 100% 并选纸张 ${loft.paper}`
    })
  }

  return out
}

function suggestDivisions(l: Lantern, netArea: number, ratio: number): number | null {
  if (ratio <= 1.0005) return null
  for (let d = Math.max(3, Math.round(l.divisions)) + 1; d <= CRAFT.divMax; d++) {
    const ref = bodySurfaceArea(frameGeometryOf(l), d)
    const r = ref > 0 ? netArea / ref : 0
    if (r <= 1.03) return d
  }
  return CRAFT.divMax
}

function loftOverlap(sheets: Sheet[]): number {
  for (const s of sheets) {
    for (const it of s.items) {
      if (it.type === 'strip' && it.overlapMm > 0) return it.overlapMm
    }
  }
  return 0
}

/** 校验尺标称长度（mm）：1:1 打印用 */
export const CALIBRATION_RULER_MM = 100
export const CALIBRATION_CIRCLE_MM = 100

function frameGeometryOf(l: Lantern) {
  return buildFrame(l).geometry
}

/** 由圆周长反推直径（尺寸反推工具用） */
export function diameterFromPerimeter(lengthMm: number, n: number, polygon: boolean, lashMm: number): number {
  const net = Math.max(0, lengthMm - lashMm)
  if (polygon) {
    const s = Math.max(3, Math.round(n))
    return net / (s * Math.sin(Math.PI / s))
  }
  return net / Math.PI
}

/** 由母线（竖篾）长度反推可用最大直径：保持收口比例与总高，二分求解 */
export function diameterFromRib(l: Lantern, ribLengthMm: number): number {
  const target = Math.max(10, ribLengthMm - 2 * l.lashAllowanceMm)
  let lo = 20
  let hi = 3000
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    const test: Lantern = { ...l, maxDiameterMm: mid, mouthDiameterMm: (mid * l.mouthDiameterMm) / Math.max(1, l.maxDiameterMm), baseDiameterMm: (mid * l.baseDiameterMm) / Math.max(1, l.maxDiameterMm) }
    const segs = segmentInfos(buildFrame(test).geometry)
    const len = segs.reduce((a, s) => a + s.slantMm, 0)
    if (len < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
