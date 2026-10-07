<script setup lang="ts">
/**
 * 1:1 放样图（分页与拼接标记）· 规格书 §4.5 / §4.7 / §8 / §9
 * - SVG 以毫米为绘图单位（viewBox 1 单位 = 1mm），width/height 用 mm，1:1 输出；
 * - 同一块裁片不拆到两页、不缩放（由 paginate 保证，CHK-06 报红可一眼看出）；
 * - 骨架长条跨页按真实搭接量重叠排布，对位十字 + 连续拼接编号（F001-1/3…）；
 * - 附 100mm 校验尺与 Ø100 校验圆；@page 尺寸随所选 A4/A3 动态注入，
 *   并显式提示「请关闭『适应页面』并按 100% 打印」；
 * - 图纸页 / 标签页 / 构件清单页顶部显示同一份「编号对账单」（CHK-09）。
 */
import { computed, onUnmounted, reactive, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChecksPanel from '../components/ChecksPanel.vue'
import { getLantern } from '../core/store'
import { CALIBRATION_CIRCLE_MM, CALIBRATION_RULER_MM, computeAll } from '../core/checks'
import {
  DEFAULT_LOFT_OPTIONS,
  PAPER_DIMS,
  assertNoPanelSplit,
  paginateLabels,
  PANEL_PAD_TOP,
  LABELS_PER_PAGE,
  stripUsableMm,
  effectiveOverlap,
  type LoftOptions,
  type SheetItem,
  type SheetItemPanel,
  type SheetItemStrip
} from '../core/paginate'
import { groupMembers } from '../core/frame'
import { kindName, shapeName } from '../core/exporter'
import { coveringLabel, kindLabel, styleLabel } from '../core/craft'
import { panelCutBounds } from '../core/panels'
import type { Panel } from '../core/types'

type PrintMode = 'loft' | 'frame' | 'labels'

const route = useRoute()
const router = useRouter()

const lantern = computed(() => getLantern(route.params.id as string))
const mode = computed<PrintMode>(() => {
  const v = String(route.query.view || 'loft')
  return v === 'frame' || v === 'labels' ? v : 'loft'
})

const opts = reactive<LoftOptions>({ ...DEFAULT_LOFT_OPTIONS })

watch(
  lantern,
  (l) => {
    if (!l) return
    opts.paper = l.pageSize
    opts.overlapMm = l.overlapMm
  },
  { immediate: true }
)

// 打印设置回写到灯样（纸张 / 搭接量），与其它页面保持一致
watch(
  () => [opts.paper, opts.overlapMm] as const,
  ([paper, overlapMm]) => {
    const l = lantern.value
    if (!l) return
    l.pageSize = paper
    l.overlapMm = overlapMm
  }
)

const full = computed(() => {
  const l = lantern.value
  if (!l) return null
  return computeAll(l, { ...opts })
})

const sheets = computed(() => full.value?.sheets ?? [])
const splitCheck = computed(() => assertNoPanelSplit(sheets.value))
const frameGroups = computed(() => (full.value ? groupMembers(full.value.frame.members) : []))

/** 三种打印模式统一用所选幅面（构件清单 / 标签页也按 A4/A3 出） */
const pageDims = computed(() => PAPER_DIMS[opts.paper])

const coverDims = computed(() => {
  const g = full.value?.frame.geometry
  if (!g) return { topMm: 0, botMm: 0 }
  const s = g.sections
  return { topMm: s[s.length - 1].radiusMm * 2, botMm: s[0].radiusMm * 2 }
})

/** 动态注入 @page 尺寸：换 A4/A3 后必须按新幅面毫米数重算，否则打印机仍按旧纸宽裁掉右边 */
watchEffect(() => {
  const d = pageDims.value
  let el = document.getElementById('loft-page-style') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'loft-page-style'
    document.head.appendChild(el)
  }
  el.textContent = `@page { size: ${d.wMm}mm ${d.hMm}mm; margin: 0; }`
})

onUnmounted(() => {
  document.getElementById('loft-page-style')?.remove()
})

/** 裁片标签：每张裁片类型一张，每 10 张一页，多出来的自动续页，一张都不许漏 */
const allPanels = computed(() => full.value?.panels.panels ?? [])
const labelPages = computed(() => paginateLabels(allPanels.value))

/** 标签网格随纸张幅面放大（A3 更宽更高），始终 2 列 × 5 行 = 每页 10 张 */
const labelGridStyle = computed(() => {
  const d = pageDims.value
  const padMm = d.wMm >= 297 ? 14 : 10
  const colW = (d.wMm - padMm * 2 - 4) / 2
  const rowH = d.hMm >= 400 ? 68 : 50
  return { gridTemplateColumns: `repeat(2, ${colW.toFixed(1)}mm)`, gridAutoRows: `${rowH}mm` }
})

function setMode(m: PrintMode) {
  router.replace({ path: route.path, query: m === 'loft' ? {} : { view: m } })
}

function doPrint() {
  window.print()
}

const asPanel = (it: SheetItem): SheetItemPanel => it as SheetItemPanel
const asStrip = (it: SheetItem): SheetItemStrip => it as SheetItemStrip

function panelBox(it: SheetItemPanel) {
  const p = it.panel
  const b = panelCutBounds(p)
  // 在占位框内水平居中（梯形上下宽不同、多边形顶点外扩时也不会越过占位框被切边）
  return {
    x: it.xMm + (it.wMm - b.w) / 2,
    y: it.yMm + PANEL_PAD_TOP,
    w: b.w,
    h: b.h
  }
}

const isPlainCircle = (p: Panel) => p.shape === 'circle' && !p.polySides

function polygonPoints(n: number, circR: number, cx: number, cy: number): string {
  return Array.from({ length: n }, (_, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n
    return `${(cx + circR * Math.cos(a)).toFixed(2)},${(cy + circR * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

/** 裁切线（原点在裁片外接框左上角，y 向下，单位 mm，1:1） */
function cutPoints(p: Panel, w: number, h: number): string {
  if (p.shape === 'circle' && p.polySides) {
    return polygonPoints(p.polySides, w / 2 / Math.cos(Math.PI / p.polySides), w / 2, h / 2)
  }
  if (p.shape === 'triangle') return `0,${h} ${w},${h} ${w / 2},0`
  const { widthTopMm: wt, widthBottomMm: wb } = p
  return `${(w - wb) / 2},${h} ${(w + wb) / 2},${h} ${(w + wt) / 2},0 ${(w - wt) / 2},0`
}

/** 缝份折线（净样），相对裁切线向内缩 seamAllowanceMm */
function netPoints(p: Panel, w: number, h: number): string {
  const s = p.seamAllowanceMm
  if (p.shape === 'circle' && p.polySides) {
    const raw = p.rawWidthTopMm
    return polygonPoints(p.polySides, raw / 2 / Math.cos(Math.PI / p.polySides), w / 2, h / 2)
  }
  if (p.shape === 'triangle') {
    const rw = p.rawWidthBottomMm
    const rh = p.rawHeightMm
    return `${(w - rw) / 2},${h - s} ${(w + rw) / 2},${h - s} ${w / 2},${h - s - rh}`
  }
  const yb = h - s
  const yt = h - s - p.rawHeightMm
  return `${(w - p.rawWidthBottomMm) / 2},${yb} ${(w + p.rawWidthBottomMm) / 2},${yb} ${
    (w + p.rawWidthTopMm) / 2
  },${yt} ${(w - p.rawWidthTopMm) / 2},${yt}`
}

function markList(it: SheetItemPanel) {
  const b = panelBox(it)
  const p = it.panel
  // 正多边形盖片：标记按对边距建立坐标，而绘制外接框更宽，需补居中偏移
  const off = p.shape === 'circle' && p.polySides ? (b.w - p.widthTopMm) / 2 : 0
  return (p.marksMm || []).map((m, i) => ({
    n: i + 1,
    label: m.label,
    cx: b.x + off + m.x,
    cy: b.y + (b.h - m.y) - off
  }))
}

/** 长条标尺刻度：沿构件全长每 10mm 一格，每 50mm 标数 */
function stripTicks(it: SheetItemStrip) {
  const out: { x: number; major: boolean; label?: string }[] = []
  for (let d = 0; d <= it.lengthMm + 0.001; d += 10) {
    const mm = it.startMm + d
    const major = Math.round(mm) % 50 === 0
    out.push({ x: it.xMm + d, major, label: major ? String(Math.round(mm)) : undefined })
  }
  return out
}

function stripText(it: SheetItemStrip): string {
  const m = it.member
  const kind = kindName(m.kind)
  const name = m.label.includes(kind) ? m.label : `${m.label}（${kind}）`
  const parts = [
    `[${it.tag}] ${m.id} ${name}`,
    `全长 ${f1(it.totalMm)}mm`,
    `本段 ${f1(it.lengthMm)}mm（整根标尺 ${f1(it.startMm)}–${f1(it.startMm + it.lengthMm)}mm，第 ${it.segIndex + 1}/${it.segCount} 段）`
  ]
  if (it.overlapMm > 0) {
    const mates = [it.prevTag, it.nextTag].filter(Boolean).join(' / ')
    parts.push(`与相邻段 ${mates} 真实搭接 ${f1(it.overlapMm)}mm（两端标尺读数连续，按对位十字粘接）`)
  }
  return parts.join(' · ')
}

/** 构件 → 长条分段数（构件清单里展示其图纸拼接编号范围） */
const memberSegCount = computed(() => {
  const map = new Map<string, number>()
  for (const s of sheets.value) {
    for (const it of s.items) {
      if (it.type === 'strip') map.set(it.member.id, it.segCount)
    }
  }
  return map
})

/** 当前纸张下单段可用宽与建议搭接（搭接量必须小于段宽） */
const stripGeom = computed(() => {
  const s0 = sheets.value[0]
  const usable = s0 ? stripUsableMm(s0.contentWMm) : 0
  const want = Math.max(0, opts.overlapMm)
  const eff = effectiveOverlap(want, usable)
  return { usable, eff, clamped: usable > 0 && want > eff + 0.001 }
})

function sheetFoot(s: { index: number }) {
  return `第 ${s.index}/${sheets.value.length} 页 · 请按 100% 打印（关闭「适应页面」）· 校验尺见第 1 页`
}

function f1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1)
}

function today(): string {
  return new Date().toLocaleDateString('zh-CN')
}
</script>

<template>
  <div v-if="!lantern || !full" class="missing">找不到该灯样。<router-link to="/">返回</router-link></div>
  <div v-else class="print-view">
    <!-- 屏显控制区（打印时隐藏） -->
    <section class="controls no-print">
      <div class="ctl-head">
        <div>
          <h2>1:1 放样图 · {{ lantern.name }}</h2>
          <p class="sub">
            单位全 mm（1 位小数）· 图纸按真实毫米绘制，<b>打印时必须 100% 缩放</b>。
            1:1 依赖用户关闭缩放，本页已附 {{ CALIBRATION_RULER_MM }}mm 校验尺与 Ø{{ CALIBRATION_CIRCLE_MM }}mm 校验圆。
          </p>
        </div>
        <div class="ops">
          <button class="primary" @click="doPrint">打印 / 另存为 PDF</button>
          <button @click="router.push(`/panels/${lantern.id}`)">返回裁片页</button>
        </div>
      </div>

      <div class="tabs">
        <button :class="{ on: mode === 'loft' }" @click="setMode('loft')">1:1 放样图</button>
        <button :class="{ on: mode === 'frame' }" @click="setMode('frame')">构件清单（可打印）</button>
        <button :class="{ on: mode === 'labels' }" @click="setMode('labels')">裁片标签</button>
      </div>

      <div v-if="mode === 'loft'" class="fields">
        <label>
          纸张
          <select v-model="opts.paper">
            <option value="A4">A4（210×297mm）</option>
            <option value="A3">A3（297×420mm）</option>
          </select>
        </label>
        <label>
          长条搭接量 (mm)
          <input v-model.number="opts.overlapMm" type="number" min="0" max="60" step="1" />
        </label>
        <label class="chk"><input v-model="opts.includeCalibration" type="checkbox" /> 校验页（100mm 校验尺）</label>
        <label class="chk"><input v-model="opts.includePanels" type="checkbox" /> 蒙面裁片 1:1</label>
        <label class="chk"><input v-model="opts.includeStrips" type="checkbox" /> 骨架长条 1:1</label>
      </div>

      <p v-if="mode === 'loft'" class="warn">
        ⚠ 请在打印对话框里把缩放设为 <b>100%</b>（关闭「适应页面 / Fit to page」），纸张选
        <b>{{ opts.paper }}（{{ pageDims.wMm }}×{{ pageDims.hMm }}mm）</b>，页边距选「无」；
        换纸张后图纸宽高、可打印区、分页已按新幅面毫米数全部重算。打印后先用第 1 页的 100mm 校验尺核对，
        <b>实测必须 = 100.0mm</b>（若量出 96mm 一类，说明仍是「适应页面」缩放）。
      </p>

      <!-- 编号对账单：图纸页 / 标签页 / 构件清单同一份结论 -->
      <section class="reconcile" :class="{ bad: !full.reconcile.pass }">
        <header>
          <h3>编号对账单（图纸 · 标签 · 裁片清单 · 构件清单 同一份结论）</h3>
          <span class="pill" :class="full.reconcile.pass ? 'ok' : 'bad'">
            {{ full.reconcile.pass ? '全部对得上' : `${full.reconcile.problems.length} 处对不上` }}
          </span>
        </header>
        <div class="rec-grid">
          <div><span>纸张幅面</span><b>{{ full.reconcile.paper }}（{{ pageDims.wMm }}×{{ pageDims.hMm }}mm）</b></div>
          <div><span>长条搭接量</span><b>{{ f1(full.reconcile.overlapMm) }}mm{{ stripGeom.clamped ? `（超过段宽，已夹为 ${f1(stripGeom.eff)}mm）` : '' }}</b></div>
          <div><span>裁片清单</span><b>{{ full.reconcile.panelKinds }} 种 / {{ full.reconcile.panelQty }} 块</b></div>
          <div><span>1:1 图纸裁片</span><b :class="{ bad: full.reconcile.sheetPanelKinds !== full.reconcile.panelKinds }">{{ full.reconcile.sheetPanelKinds }} 块（每种 1 块 1:1 样）</b></div>
          <div><span>裁片标签</span><b :class="{ bad: full.reconcile.labelCards !== full.reconcile.panelKinds }">{{ full.reconcile.labelCards }} 张 / {{ full.reconcile.labelPages }} 页（每 {{ LABELS_PER_PAGE }} 张一页）</b></div>
          <div><span>构件清单长条</span><b>{{ full.reconcile.stripKinds }} 种 → 图纸 {{ full.reconcile.stripSegTotal }} 段（跨页 {{ full.reconcile.stripSplitKinds }} 种）</b></div>
          <div><span>图纸总页数</span><b>{{ full.reconcile.sheetPages }} 页（含 1 张校验页）</b></div>
        </div>
        <ul v-if="!full.reconcile.pass" class="rec-problems">
          <li v-for="(p, i) in full.reconcile.problems" :key="i">✗ {{ p }}</li>
        </ul>
        <p v-else class="rec-ok">
          ✓ 裁片编号在裁片清单 / 1:1 图纸 / 标签页三处一一对得上；长条拼接编号（FM###-i/n）与构件清单同号、按构件一顺接下去；
          改纸张幅面或搭接量后本单随图纸整体刷新。
        </p>
      </section>

      <section v-if="mode === 'loft'" class="summary">
        <div class="stat"><span>图纸页数</span><b>{{ sheets.length }} 页</b></div>
        <div class="stat"><span>裁片类型</span><b>{{ full.panels.panels.length }} 种 / {{ full.panels.totalQty }} 块</b></div>
        <div class="stat"><span>裁片不跨页断言</span><b :class="splitCheck.pass ? 'ok' : 'bad'">{{ splitCheck.pass ? '通过' : '失败' }}</b></div>
        <div class="stat"><span>整块超区（未拆未缩）</span><b :class="splitCheck.overflow ? 'bad' : ''">{{ splitCheck.overflow }} 块</b></div>
        <div class="stat"><span>单段可用宽 / 搭接</span><b>{{ f1(stripGeom.usable) }} / {{ f1(stripGeom.eff) }} mm</b></div>
        <div class="stat"><span>底盖净直径</span><b>{{ f1(coverDims.botMm) }} mm</b></div>
      </section>
      <p v-if="mode === 'loft'" class="sub detail">{{ splitCheck.detail }}</p>

      <p v-if="mode === 'labels'" class="sub detail">
        共 {{ allPanels.length }} 张标签，每 {{ LABELS_PER_PAGE }} 张一页，共 {{ labelPages.length }} 页；
        编号与裁片清单、1:1 图纸逐张一致。打印纸张随上方「纸张」选择（当前 {{ opts.paper }}）。
      </p>
      <p v-if="mode === 'frame'" class="sub detail">
        构件编号 FM### 与 1:1 图纸长条拼接编号 F### 同源（F### 即构件号）；跨页构件在「图纸段数」列标明 i/n。
        打印纸张随上方「纸张」选择（当前 {{ opts.paper }}）。
      </p>
    </section>

    <!-- ============ 1:1 放样图纸 ============ -->
    <div v-if="mode === 'loft'" class="sheets">
      <section
        v-for="s in sheets"
        :key="s.index"
        class="sheet"
        :style="{ width: s.wMm + 'mm', height: s.hMm + 'mm' }"
      >
        <svg
          :width="s.wMm + 'mm'"
          :height="s.hMm + 'mm'"
          :viewBox="`0 0 ${s.wMm} ${s.hMm}`"
          xmlns="http://www.w3.org/2000/svg"
        >
          <!-- 页眉 -->
          <text class="hdr" :x="s.contentX" y="5.6">{{ s.title }}</text>
          <text class="hdr-sub" :x="s.contentX + s.contentWMm" y="5.6" text-anchor="end">
            {{ lantern.name }} · {{ kindLabel(lantern.kind) }} · 最大直径 {{ lantern.maxDiameterMm }}mm · 总高
            {{ lantern.totalHeightMm }}mm · {{ lantern.layers.length }} 层
          </text>
          <text class="hdr-sub" :x="s.contentX" y="10.4">
            蒙面 {{ coveringLabel(lantern.covering) }} · 缝份四边各 {{ lantern.seamAllowanceMm }}mm（已计入裁片尺寸）·
            {{ styleLabel(lantern.mouthStyle) }}/{{ styleLabel(lantern.bottomStyle) }} · 单位 mm
          </text>
          <text class="hdr-sub" :x="s.contentX + s.contentWMm" y="10.4" text-anchor="end">
            {{ sheetFoot(s) }}
          </text>
          <line class="hair" :x1="s.contentX" :x2="s.contentX + s.contentWMm" y1="12.4" y2="12.4" />

          <text v-if="s.warn" class="warn-text" :x="s.contentX" :y="s.contentY + 4">{{ s.warn }}</text>

          <g v-for="(it, idx) in s.items" :key="idx">
            <!-- 100mm 校验页 -->
            <g v-if="it.type === 'calibration'">
              <text class="cal-title" :x="it.xMm" :y="it.yMm + 7">
                打印自检：请把打印缩放设为 100%（关闭「适应页面 / Fit to page」），纸张 {{ opts.paper }}，页边距「无」。
              </text>

              <text class="cal-note" :x="it.xMm" :y="it.yMm + 18">
                ① 水平校验尺 标称 {{ CALIBRATION_RULER_MM }}.0mm —— 打印后用钢尺实测此段，误差应 ≤ 1mm
              </text>
              <rect
                :x="it.xMm + 6"
                :y="it.yMm + 22"
                :width="CALIBRATION_RULER_MM"
                :height="8"
                class="cal-bar"
              />
              <g v-for="d in 11" :key="'h' + d">
                <line
                  class="cal-tick"
                  :x1="it.xMm + 6 + (d - 1) * 10"
                  :x2="it.xMm + 6 + (d - 1) * 10"
                  :y1="it.yMm + 22"
                  :y2="it.yMm + 22 + (d % 5 === 1 ? 8 : 4)"
                />
                <text
                  class="cal-label"
                  :x="it.xMm + 6 + (d - 1) * 10"
                  :y="it.yMm + 33.5"
                  text-anchor="middle"
                >
                  {{ (d - 1) * 10 }}
                </text>
              </g>

              <text class="cal-note" :x="it.xMm + 118" :y="it.yMm + 40">
                ② 垂直校验尺 标称 100.0mm
              </text>
              <rect :x="it.xMm + 6" :y="it.yMm + 44" width="8" :height="CALIBRATION_RULER_MM" class="cal-bar" />
              <g v-for="d in 11" :key="'v' + d">
                <line
                  class="cal-tick"
                  :x1="it.xMm + 6"
                  :x2="it.xMm + 6 + (d % 5 === 1 ? 8 : 4)"
                  :y1="it.yMm + 44 + (d - 1) * 10"
                  :y2="it.yMm + 44 + (d - 1) * 10"
                />
              </g>
              <text class="cal-label" :x="it.xMm + 18" :y="it.yMm + 96">100.0mm</text>

              <text class="cal-note" :x="it.xMm + 118" :y="it.yMm + 56">
                ③ Ø{{ CALIBRATION_CIRCLE_MM }}.0mm 校验圆（可对照底盖裁片实测）
              </text>
              <circle
                :cx="it.xMm + 118"
                :cy="it.yMm + 116"
                :r="CALIBRATION_CIRCLE_MM / 2"
                class="cal-circle"
              />
              <line
                class="cal-tick"
                :x1="it.xMm + 118 - 58"
                :x2="it.xMm + 118 + 58"
                :y1="it.yMm + 116"
                :y2="it.yMm + 116"
              />
              <line
                class="cal-tick"
                :x1="it.xMm + 118"
                :x2="it.xMm + 118"
                :y1="it.yMm + 116 - 58"
                :y2="it.yMm + 116 + 58"
              />
              <text class="cal-label" :x="it.xMm + 118" :y="it.yMm + 116 + 2" text-anchor="middle">
                Ø{{ CALIBRATION_CIRCLE_MM }}
              </text>
              <text class="cal-note" :x="it.xMm + 118" :y="it.yMm + 172" text-anchor="middle">
                打印后实测本圆直径，误差应 ≤ 1mm
              </text>

              <text class="cal-note" :x="it.xMm" :y="it.yMm + 200">
                ④ 本灯实际口径：底盖净直径 {{ f1(coverDims.botMm) }}mm、顶盖净直径 {{ f1(coverDims.topMm) }}mm ——
                在「蒙面裁片 1:1」页按同一比例绘制，可实测对照（误差 ≤ 1mm）。
              </text>
              <text class="cal-note" :x="it.xMm" :y="it.yMm + 210">
                ⑤ 同一块裁片不拆页、不缩放（放不下整块单独一页居中，宁可费纸）；骨架长条相邻段按
                {{ f1(opts.overlapMm) }}mm 真实重叠排布（宁可多占纸），段段标尺读数连续、编号 FM###-i/n 相接，请按对位十字粘接。
              </text>
              <text class="cal-note" :x="it.xMm" :y="it.yMm + 220">
                ⑥ 本页 @page 已按 {{ opts.paper }}（{{ s.wMm }}×{{ s.hMm }}mm）设置；
                若切换纸张，图纸宽高 / 可打印区 / 分页 / 长条分段全部按新幅面重算。导出 PDF 选「另存为 PDF」即可。
              </text>
              <text class="cal-note" :x="it.xMm" :y="it.yMm + 230">
                ⑦ 打印后逐项核对：水平尺 = 垂直尺 = 100.0mm、圆直径 = 100.0mm；若量得 96mm 等数值，
                说明打印对话框仍是「适应页面 / Fit」或纸张选错（当前应为 {{ opts.paper }}），请改正后重打。
              </text>
              <text class="cal-foot" :x="it.xMm" :y="it.yMm + it.hMm - 2">
                {{ lantern.name }} · 1:1 校验页 · {{ today() }}
              </text>
            </g>

            <!-- 裁片 1:1 -->
            <g v-else-if="it.type === 'panel'">
              <g>
                <text class="panel-cap" :x="asPanel(it).xMm" :y="asPanel(it).yMm + 4">
                  {{ asPanel(it).panel.label }} ×{{ asPanel(it).panel.qty }} 块 ·
                  净 {{ f1(asPanel(it).panel.rawWidthTopMm) }}/{{ f1(asPanel(it).panel.rawWidthBottomMm) }}×{{
                    f1(asPanel(it).panel.rawHeightMm)
                  }}mm + 缝份 {{ asPanel(it).panel.seamAllowanceMm }}×2 · 实线=裁切线 虚线=净样 十字=对位
                </text>

                <circle
                  v-if="isPlainCircle(asPanel(it).panel)"
                  :cx="panelBox(asPanel(it)).x + panelBox(asPanel(it)).w / 2"
                  :cy="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h / 2"
                  :r="panelBox(asPanel(it)).w / 2"
                  class="cut-area"
                />
                <polygon
                  v-else
                  :points="cutPoints(asPanel(it).panel, panelBox(asPanel(it)).w, panelBox(asPanel(it)).h)"
                  :transform="`translate(${panelBox(asPanel(it)).x} ${panelBox(asPanel(it)).y})`"
                  class="cut-area"
                />

                <circle
                  v-if="isPlainCircle(asPanel(it).panel)"
                  :cx="panelBox(asPanel(it)).x + panelBox(asPanel(it)).w / 2"
                  :cy="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h / 2"
                  :r="asPanel(it).panel.rawWidthTopMm / 2"
                  class="net-line"
                />
                <polygon
                  v-else
                  :points="netPoints(asPanel(it).panel, panelBox(asPanel(it)).w, panelBox(asPanel(it)).h)"
                  :transform="`translate(${panelBox(asPanel(it)).x} ${panelBox(asPanel(it)).y})`"
                  class="net-line"
                />

                <!-- 对位标记 -->
                <g v-for="m in markList(asPanel(it))" :key="m.n" class="mark">
                  <line :x1="m.cx - 3.5" :x2="m.cx + 3.5" :y1="m.cy" :y2="m.cy" />
                  <line :x1="m.cx" :x2="m.cx" :y1="m.cy - 3.5" :y2="m.cy + 3.5" />
                  <circle :cx="m.cx" :cy="m.cy" r="2" />
                  <text :x="m.cx + 4.6" :y="m.cy - 3.4">{{ m.n }}</text>
                </g>

                <!-- 尺寸标注 -->
                <g class="dim">
                  <line
                    :x1="panelBox(asPanel(it)).x + (panelBox(asPanel(it)).w - asPanel(it).panel.widthTopMm) / 2"
                    :x2="panelBox(asPanel(it)).x + (panelBox(asPanel(it)).w + asPanel(it).panel.widthTopMm) / 2"
                    :y1="panelBox(asPanel(it)).y - 3.6"
                    :y2="panelBox(asPanel(it)).y - 3.6"
                  />
                  <text
                    :x="panelBox(asPanel(it)).x + panelBox(asPanel(it)).w / 2"
                    :y="panelBox(asPanel(it)).y - 5"
                    text-anchor="middle"
                  >
                    上宽 {{ f1(asPanel(it).panel.widthTopMm) }}
                  </text>
                  <line
                    :x1="panelBox(asPanel(it)).x + (panelBox(asPanel(it)).w - asPanel(it).panel.widthBottomMm) / 2"
                    :x2="panelBox(asPanel(it)).x + (panelBox(asPanel(it)).w + asPanel(it).panel.widthBottomMm) / 2"
                    :y1="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h + 3"
                    :y2="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h + 3"
                  />
                  <text
                    :x="panelBox(asPanel(it)).x + panelBox(asPanel(it)).w / 2"
                    :y="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h + 6.4"
                    text-anchor="middle"
                  >
                    下宽 {{ f1(asPanel(it).panel.widthBottomMm) }}（含缝份）
                  </text>
                  <line
                    :x1="panelBox(asPanel(it)).x - 2.6"
                    :x2="panelBox(asPanel(it)).x - 2.6"
                    :y1="panelBox(asPanel(it)).y"
                    :y2="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h"
                  />
                  <text
                    :x="panelBox(asPanel(it)).x - 4.4"
                    :y="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h / 2"
                    text-anchor="middle"
                    :transform="`rotate(-90 ${panelBox(asPanel(it)).x - 4.4} ${
                      panelBox(asPanel(it)).y + panelBox(asPanel(it)).h / 2
                    })`"
                  >
                    高 {{ f1(asPanel(it).panel.heightMm) }}
                  </text>
                  <text
                    :x="panelBox(asPanel(it)).x + panelBox(asPanel(it)).w / 2"
                    :y="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h / 2 + 1"
                    text-anchor="middle"
                    class="net-label"
                  >
                    净 {{ f1(asPanel(it).panel.rawWidthTopMm) }}×{{ f1(asPanel(it).panel.rawHeightMm) }} + 缝份
                    {{ asPanel(it).panel.seamAllowanceMm }}×2 = 裁切 {{ f1(asPanel(it).panel.widthTopMm) }}×{{
                      f1(asPanel(it).panel.heightMm)
                    }}
                  </text>
                  <text
                    :x="panelBox(asPanel(it)).x + panelBox(asPanel(it)).w / 2"
                    :y="panelBox(asPanel(it)).y + panelBox(asPanel(it)).h + 10.6"
                    text-anchor="middle"
                    class="panel-cap"
                  >
                    {{ asPanel(it).panel.note }}
                  </text>
                </g>
              </g>
            </g>

            <!-- 骨架长条 1:1（跨页带对位十字与真实搭接） -->
            <g v-else>
              <text class="strip-cap" :x="asStrip(it).xMm" :y="asStrip(it).yMm + 3.6">
                {{ stripText(asStrip(it)) }}
              </text>
              <rect
                class="strip-bar"
                :x="asStrip(it).xMm"
                :y="asStrip(it).yMm + 5"
                :width="asStrip(it).lengthMm"
                height="4"
              />
              <!-- 与上段的真实重叠区（阴影）：此区间与上一段末尾同一标尺读数，粘接时对准 -->
              <rect
                v-if="asStrip(it).segIndex > 0"
                class="strip-overlap"
                :x="asStrip(it).xMm"
                :y="asStrip(it).yMm + 5"
                :width="Math.min(asStrip(it).overlapMm, asStrip(it).lengthMm)"
                height="4"
              />
              <g v-for="t in stripTicks(asStrip(it))" :key="'t' + t.x">
                <line class="strip-tick" :x1="t.x" :x2="t.x" :y1="asStrip(it).yMm + 9" :y2="asStrip(it).yMm + (t.major ? 11.8 : 10.8)" />
                <text v-if="t.label" class="strip-tick-label" :x="t.x" :y="asStrip(it).yMm + 15" text-anchor="middle">
                  {{ t.label }}
                </text>
              </g>
              <!-- 段首对位十字：与上一段段尾同标尺读数（startMm） -->
              <g class="join" v-if="asStrip(it).segIndex > 0">
                <line :x1="asStrip(it).xMm - 4" :x2="asStrip(it).xMm + 4" :y1="asStrip(it).yMm + 7" :y2="asStrip(it).yMm + 7" />
                <line :x1="asStrip(it).xMm" :x2="asStrip(it).xMm" :y1="asStrip(it).yMm + 3" :y2="asStrip(it).yMm + 11" />
                <text class="join-text" :x="asStrip(it).xMm" :y="asStrip(it).yMm + 2.6" text-anchor="middle">
                  ↑ 接 {{ asStrip(it).prevTag }}：对准读数 {{ f1(asStrip(it).startMm) }}，搭接 {{ f1(asStrip(it).overlapMm) }}mm
                </text>
              </g>
              <!-- 段尾对位十字：下一段将从读数 (start+len-overlap) 接上 -->
              <g class="join" v-if="asStrip(it).nextTag">
                <line
                  :x1="asStrip(it).xMm + asStrip(it).lengthMm - 4"
                  :x2="asStrip(it).xMm + asStrip(it).lengthMm + 4"
                  :y1="asStrip(it).yMm + 7"
                  :y2="asStrip(it).yMm + 7"
                />
                <line
                  :x1="asStrip(it).xMm + asStrip(it).lengthMm"
                  :x2="asStrip(it).xMm + asStrip(it).lengthMm"
                  :y1="asStrip(it).yMm + 3"
                  :y2="asStrip(it).yMm + 11"
                />
                <text
                  class="join-text"
                  :x="asStrip(it).xMm + asStrip(it).lengthMm"
                  :y="asStrip(it).yMm + 2.6"
                  text-anchor="middle"
                >
                  续 {{ asStrip(it).nextTag }} ↓
                </text>
              </g>
            </g>
          </g>

          <text class="sheet-foot" :x="s.contentX" :y="s.hMm - 3.4">
            {{ lantern.name }} · {{ sheetFoot(s) }} · 单位 mm · 1:1（100% 打印）
          </text>
        </svg>
      </section>
    </div>

    <!-- ============ 构件清单（可打印） ============ -->
    <section
      v-else-if="mode === 'frame'"
      class="doc"
      :style="{ width: pageDims.wMm + 'mm', minHeight: pageDims.hMm + 'mm' }"
    >
      <h1>骨架构件清单</h1>
      <p class="doc-meta">
        灯样：{{ lantern.name }}（{{ kindLabel(lantern.kind) }}）· 最大直径 {{ lantern.maxDiameterMm }}mm · 总高
        {{ lantern.totalHeightMm }}mm · {{ lantern.layers.length }} 层 · {{ lantern.sides }} 棱 ·
        收口 {{ styleLabel(lantern.mouthStyle) }}/{{ styleLabel(lantern.bottomStyle) }} ·
        每端绑扎余量 {{ lantern.lashAllowanceMm }}mm · 蒙面 {{ coveringLabel(lantern.covering) }} ·
        纸张 {{ opts.paper }}（{{ pageDims.wMm }}×{{ pageDims.hMm }}mm）· 打印日期 {{ today() }}
      </p>
      <table class="doc-table">
        <thead>
          <tr>
            <th>构件编号</th>
            <th>构件名称</th>
            <th>类别</th>
            <th>分组</th>
            <th class="num">净长 (mm)</th>
            <th class="num">截取长度 (mm，含余量)</th>
            <th class="num">余量处数</th>
            <th class="num">数量</th>
            <th class="num">总截取长 (mm)</th>
            <th>弯曲半径 / 折角</th>
            <th class="num">图纸长条段数</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="grp in frameGroups" :key="grp.group">
            <tr class="doc-group">
              <td colspan="11">{{ grp.group }}</td>
            </tr>
            <tr v-for="m in grp.items" :key="m.id">
              <td class="mono strong">{{ m.id }}</td>
              <td>{{ m.label }}</td>
              <td>{{ kindName(m.kind) }}</td>
              <td>{{ m.group }}</td>
              <td class="num mono">{{ f1(m.rawLengthMm) }}</td>
              <td class="num mono strong">{{ f1(m.lengthMm) }}</td>
              <td class="num mono">×{{ m.lashJoints }}</td>
              <td class="num mono">{{ m.qty }}</td>
              <td class="num mono">{{ f1(m.lengthMm * m.qty) }}</td>
              <td class="mono">{{ m.bendRadiusMm ? `R${f1(m.bendRadiusMm)}mm` : m.bendAngleDeg ? `${f1(m.bendAngleDeg)}°` : '—' }}</td>
              <td class="num mono">
                <template v-if="memberSegCount.get(m.id) && memberSegCount.get(m.id)! > 1">
                  {{ memberSegCount.get(m.id) }} 段（{{ m.id }}-1/{{ memberSegCount.get(m.id) }}…）
                </template>
                <template v-else>1</template>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <p class="doc-foot">
        合计：构件 {{ full.frame.totalQty }} 根 · 备料（含余量）{{ (full.frame.stockLengthMm / 1000).toFixed(3) }}m ·
        净长 {{ (full.frame.rawLengthMm / 1000).toFixed(3) }}m · 绑扎余量合计
        {{ f1(full.frame.lashExtraMm) }}mm ｜ 图纸长条共 {{ full.reconcile.stripSegTotal }} 段，
        拼接编号与本清单构件编号同号（{{ opts.paper }}，搭接 {{ f1(opts.overlapMm) }}mm）
      </p>
    </section>

    <!-- ============ 裁片标签（每 10 张一页，一张不漏） ============ -->
    <section
      v-if="mode === 'labels'"
      v-for="(page, pi) in labelPages"
      :key="'lp' + pi"
      class="label-page"
      :style="{ width: pageDims.wMm + 'mm', minHeight: pageDims.hMm + 'mm' }"
    >
      <header class="lp-head">
        <h1>蒙面裁片标签 · {{ lantern.name }}</h1>
        <span>第 {{ pi + 1 }} / {{ labelPages.length }} 页 · 本页 {{ page.length }} 张 · 全单 {{ allPanels.length }} 张 · {{ opts.paper }}</span>
      </header>
      <div class="label-grid" :style="labelGridStyle">
        <div v-for="p in page" :key="p.id" class="label">
          <div class="lb-head">
            <span class="lb-code">{{ p.id }}</span>
            <span class="lb-name">{{ p.label }}</span>
            <span class="lb-qty">× {{ p.qty }} 块</span>
          </div>
          <div class="lb-rows">
            <div><span>形状</span><b>{{ shapeName(p.shape) }}{{ p.polySides ? `（正 ${p.polySides} 边形）` : '' }}</b></div>
            <div><span>净尺寸</span><b>上 {{ f1(p.rawWidthTopMm) }} / 下 {{ f1(p.rawWidthBottomMm) }} × 高 {{ f1(p.rawHeightMm) }} mm</b></div>
            <div><span>裁切尺寸</span><b>上 {{ f1(p.widthTopMm) }} / 下 {{ f1(p.widthBottomMm) }} × 高 {{ f1(p.heightMm) }} mm</b></div>
            <div><span>缝份</span><b>四边各 {{ p.seamAllowanceMm }}mm（已计入裁切尺寸）</b></div>
            <div>
              <span>位置 / 配色</span><b>{{ p.layerIndex >= 0 ? `第 ${p.layerIndex + 1} 层` : '顶/底盖' }} · {{ p.color }}</b>
            </div>
            <div><span>对位标记</span><b>{{ p.marksMm.length }} 处（见 1:1 图十字编号）</b></div>
          </div>
          <div class="lb-tags">
            逐块编号：
            <span v-for="k in p.qty" :key="k" class="lb-tag">{{ p.id }}-{{ String(k).padStart(2, '0') }}</span>
          </div>
          <div class="lb-foot">
            {{ lantern.name }} · 蒙面 {{ coveringLabel(lantern.covering) }} · 标签号 {{ p.id }} 与裁片清单 / 1:1 图纸一致
          </div>
        </div>
      </div>
    </section>

    <ChecksPanel
      v-if="full && mode === 'loft'"
      class="no-print"
      :checks="full.checks.filter((c) => ['CHK-06', 'CHK-08', 'CHK-09', 'CHK-10', 'CHK-11', 'CHK-12'].includes(c.id))"
      :elapsed-ms="full.elapsedMs"
      title="放样、分页与编号自检"
    />
  </div>
</template>

<style scoped>
.print-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.controls {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow);
}

.ctl-head {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
}

h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: #8f1c19;
  border-left: 4px solid var(--red);
  padding-left: 10px;
}

.sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink-soft);
  max-width: 900px;
}

.detail {
  font-size: 12px;
}

.ops {
  display: flex;
  gap: 8px;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  padding: 6px 12px;
  font-size: 12.5px;
}

button:hover {
  border-color: var(--red);
  color: var(--red);
}

button.primary {
  background: var(--red);
  border-color: var(--red);
  color: #fff;
  font-weight: 600;
}

button.primary:hover {
  background: #9c1f1b;
  color: #fff;
}

.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tabs button.on {
  background: #f6e3ba;
  border-color: var(--gold);
  color: #8f1c19;
  font-weight: 600;
}

.fields {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 12.5px;
}

.fields label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink-soft);
}

.fields select,
.fields input[type='number'] {
  font: inherit;
  font-size: 12.5px;
  padding: 4px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink);
}

.fields input[type='number'] {
  width: 68px;
}

.chk {
  cursor: pointer;
}

.warn {
  margin: 0;
  font-size: 12.5px;
  color: #8f1c19;
  background: #fbeae6;
  border: 1px solid #e7c3bb;
  border-radius: 8px;
  padding: 8px 12px;
}

.summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}

.stat {
  background: var(--surface);
  padding: 9px 14px;
  display: flex;
  flex-direction: column;
}

.stat span {
  font-size: 11px;
  color: var(--ink-soft);
}

.stat b {
  font-family: var(--mono);
  font-size: 15px;
}

.ok {
  color: var(--jade);
}

.bad {
  color: var(--red);
}

/* ---------- 编号对账单 ---------- */
.reconcile {
  background: var(--surface);
  border: 1px solid var(--jade);
  border-radius: 10px;
  padding: 10px 14px;
}

.reconcile.bad {
  border-color: var(--red);
  background: #fdf3f1;
}

.reconcile header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.reconcile h3 {
  margin: 0;
  font-size: 13.5px;
  color: #8f1c19;
}

.pill {
  font-size: 11.5px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 10px;
}

.pill.ok {
  background: #e2f0ea;
  color: var(--jade);
}

.pill.bad {
  background: #fbe0dc;
  color: var(--red);
}

.rec-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 5px 18px;
  font-size: 12px;
}

.rec-grid div {
  display: flex;
  gap: 8px;
}

.rec-grid span {
  color: var(--ink-soft);
  flex: 0 0 92px;
}

.rec-grid b {
  font-family: var(--mono);
  font-weight: 600;
}

.rec-grid b.bad {
  color: var(--red);
}

.rec-problems {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--red);
  font-size: 12px;
}

.rec-ok {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--jade);
}

/* ---------- 图纸 ---------- */
.sheets {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  overflow-x: auto;
}

.sheet {
  background: #fff;
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
  flex: 0 0 auto;
}

.sheet svg {
  display: block;
}

.sheet text {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.hdr {
  font-size: 4.2px;
  font-weight: 700;
  fill: #8f1c19;
}

.hdr-sub {
  font-size: 2.7px;
  fill: #6a5c52;
}

.hair {
  stroke: #c6b49b;
  stroke-width: 0.3;
}

.warn-text {
  font-size: 2.9px;
  fill: #b3241f;
}

.cut-area {
  fill: rgba(179, 36, 31, 0.06);
  stroke: #b3241f;
  stroke-width: 0.5;
}

.net-line {
  fill: none;
  stroke: #2f7a63;
  stroke-width: 0.35;
  stroke-dasharray: 3 1.6;
}

.mark line {
  stroke: #2f5f8a;
  stroke-width: 0.3;
}

.mark circle {
  fill: none;
  stroke: #2f5f8a;
  stroke-width: 0.3;
}

.mark text {
  fill: #2f5f8a;
  font-size: 2.4px;
}

.dim line {
  stroke: #2f5f8a;
  stroke-width: 0.3;
}

.dim text {
  fill: #2f5f8a;
  font-size: 2.6px;
}

.dim text.net-label {
  fill: rgba(60, 30, 20, 0.5);
  font-size: 2.6px;
}

.panel-cap {
  font-size: 2.5px;
  fill: #6a5c52;
}

.strip-cap {
  font-size: 2.4px;
  fill: #2b2320;
}

.strip-bar {
  fill: rgba(184, 137, 31, 0.14);
  stroke: #b3241f;
  stroke-width: 0.3;
}

.strip-overlap {
  fill: rgba(47, 122, 99, 0.32);
}

.strip-tick {
  stroke: #2f5f8a;
  stroke-width: 0.25;
}

.strip-tick-label {
  font-size: 2.1px;
  fill: #2f5f8a;
}

.join line {
  stroke: #b3241f;
  stroke-width: 0.4;
}

.join-text {
  font-size: 2.1px;
  fill: #b3241f;
}

.cal-title {
  font-size: 4px;
  font-weight: 700;
  fill: #8f1c19;
}

.cal-note {
  font-size: 3px;
  fill: #2b2320;
}

.cal-foot {
  font-size: 2.6px;
  fill: #6a5c52;
}

.cal-bar {
  fill: rgba(184, 137, 31, 0.16);
  stroke: #2b2320;
  stroke-width: 0.3;
}

.cal-tick {
  stroke: #2b2320;
  stroke-width: 0.3;
}

.cal-label {
  font-size: 2.6px;
  fill: #2b2320;
}

.cal-circle {
  fill: none;
  stroke: #b3241f;
  stroke-width: 0.5;
}

.sheet-foot {
  font-size: 2.5px;
  fill: #6a5c52;
}

/* ---------- 构件清单 ---------- */
.doc {
  padding: 14mm 12mm;
  background: #fff;
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
  margin: 0 auto;
  box-sizing: border-box;
}

.doc h1 {
  margin: 0 0 6px;
  font-size: 18px;
  color: #8f1c19;
}

.doc-meta {
  margin: 0 0 10px;
  font-size: 11.5px;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--line);
  padding-bottom: 8px;
}

.doc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.doc-table th {
  text-align: left;
  border-bottom: 1px solid var(--line-strong);
  padding: 4px 5px;
  font-size: 10.5px;
  color: var(--ink-soft);
  font-weight: 500;
}

.doc-table td {
  padding: 3.4px 5px;
  border-bottom: 1px dashed var(--line);
  vertical-align: top;
}

.doc-group td {
  background: var(--surface-2);
  font-weight: 700;
  color: #8f1c19;
}

.doc-foot {
  margin-top: 10px;
  font-size: 11px;
  color: var(--ink-soft);
}

.num {
  text-align: right;
}

.mono {
  font-family: var(--mono);
}

.strong {
  font-weight: 700;
  color: #8f1c19;
}

/* ---------- 裁片标签 ---------- */
.label-page {
  padding: 10mm;
  background: #fff;
  border: 1px solid var(--line-strong);
  box-shadow: var(--shadow);
  margin: 0 auto;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4mm;
}

.lp-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  border-bottom: 0.3mm solid var(--line-strong);
  padding-bottom: 2mm;
}

.lp-head h1 {
  margin: 0;
  font-size: 5mm;
  color: #8f1c19;
}

.lp-head span {
  font-size: 3mm;
  color: var(--ink-soft);
}

.label-grid {
  display: grid;
  gap: 4mm;
}

.label {
  border: 0.4mm dashed #8a7a68;
  border-radius: 2mm;
  padding: 2.4mm 3mm;
  display: flex;
  flex-direction: column;
  gap: 1mm;
  overflow: hidden;
  background: #fff;
}

.lb-head {
  display: flex;
  align-items: baseline;
  gap: 2mm;
  border-bottom: 0.2mm solid #ddd0bd;
  padding-bottom: 1mm;
}

.lb-code {
  font-family: var(--mono);
  font-size: 3.6mm;
  font-weight: 700;
  color: #8f1c19;
}

.lb-name {
  font-size: 3.3mm;
  font-weight: 600;
  flex: 1;
}

.lb-qty {
  font-family: var(--mono);
  font-size: 3mm;
  color: #b3241f;
}

.lb-rows {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6mm 2mm;
  font-size: 2.6mm;
}

.lb-rows div {
  display: flex;
  gap: 1.4mm;
  align-items: baseline;
}

.lb-rows span {
  color: #6a5c52;
  flex: 0 0 11mm;
}

.lb-rows b {
  font-family: var(--mono);
  font-weight: 500;
}

.lb-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 1mm 2mm;
  align-items: center;
  font-size: 2.4mm;
  color: var(--ink-soft);
}

.lb-tag {
  font-family: var(--mono);
  font-size: 2.5mm;
  background: var(--surface-2);
  border: 0.2mm solid var(--line-strong);
  border-radius: 1mm;
  padding: 0.2mm 1.4mm;
  color: #8f1c19;
}

.lb-foot {
  margin-top: auto;
  font-size: 2.4mm;
  color: #6a5c52;
  border-top: 0.2mm solid #ddd0bd;
  padding-top: 0.8mm;
}

.missing {
  padding: 40px;
  text-align: center;
}

/* ---------- 打印 ---------- */
@media print {
  /* @page 尺寸由 JS 按所选 A4/A3 动态注入；这里再锁根节点尺寸，避免任何缩放 */
  html,
  body {
    width: auto;
    height: auto;
  }

  .print-view {
    gap: 0;
    display: block;
  }

  .controls {
    display: none !important;
  }

  .sheets {
    gap: 0;
    overflow: visible;
    display: block;
  }

  .sheet,
  .doc,
  .label-page {
    border: none;
    box-shadow: none;
    margin: 0;
  }

  .sheet {
    break-after: page;
    page-break-after: always;
  }

  .doc,
  .label-page {
    break-after: page;
    page-break-after: always;
  }

  .sheet:last-child,
  .doc:last-child,
  .label-page:last-child {
    break-after: auto;
    page-break-after: auto;
  }

  .doc-table {
    font-size: 10.5px;
  }
}
</style>
