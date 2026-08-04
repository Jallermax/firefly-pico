const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const SERIES_MARKERS = ['circle', 'square', 'diamond', 'triangle', 'cross', 'hollow']

export function nearestPointIndex({ clientX, left, width, pointCount }) {
  if (pointCount <= 0 || width <= 0) return -1
  const ratio = clamp((clientX - left) / width, 0, 1)
  return Math.round(ratio * (pointCount - 1))
}

export function nearestChartPointIndex({ clientX, left, width, viewBoxWidth, padding, pointCount }) {
  const scale = width / viewBoxWidth
  return nearestPointIndex({
    clientX,
    left: left + padding.left * scale,
    width: width - (padding.left + padding.right) * scale,
    pointCount,
  })
}

export function buildLineChartLayout({ isDesktop, renderedWidth }) {
  const width = Number.isFinite(renderedWidth) && renderedWidth > 0 ? renderedWidth : isDesktop ? 1000 : 360
  const height = isDesktop ? 320 : 240
  const padding = isDesktop ? { top: 16, right: 24, bottom: 38, left: 88 } : { top: 16, right: 12, bottom: 34, left: 64 }

  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    padding,
    gridX1: padding.left,
    gridX2: width - padding.right,
    yAxisLabelX: padding.left - 8,
    xAxisY: height - 10,
    crosshairY1: padding.top,
    crosshairY2: height - padding.bottom,
    axisFontSize: isDesktop ? 11 : 12,
    markerSize: isDesktop ? 4.5 : 5,
    selectedMarkerSize: isDesktop ? 7 : 8,
  }
}

export function buildLineChartGeometry({ series, width, height, padding }) {
  const xValues = [...new Set(series.flatMap((item) => item.points.map((point) => point.x)))].sort()
  const values = series.flatMap((item) => item.points.map((point) => point.value)).filter(Number.isFinite)
  const yMin = Math.min(0, ...values)
  const yMaxCandidate = Math.max(0, ...values)
  const yMax = yMaxCandidate === yMin ? yMin + 1 : yMaxCandidate
  const innerWidth = width - padding.left - padding.right
  const innerHeight = height - padding.top - padding.bottom
  const xAt = (x) => padding.left + (xValues.indexOf(x) / Math.max(1, xValues.length - 1)) * innerWidth
  const yAt = (value) => padding.top + ((yMax - value) / (yMax - yMin)) * innerHeight
  const outputSeries = series.map((item, seriesIndex) => {
    const marker = item.marker ?? SERIES_MARKERS[seriesIndex % SERIES_MARKERS.length]
    const points = item.points.map((point) => ({ ...point, x: xAt(point.x), y: Number.isFinite(point.value) ? yAt(point.value) : null, key: point.x, marker }))
    const segments = points.flatMap((point, index) => {
      const previous =
        point.kind === 'forecast' ? points.slice(0, index).findLast((candidate) => candidate.y !== null && !candidate.inspectionOnly && candidate.kind !== 'forecast') : points[index - 1]
      if (!previous || previous.y === null || point.y === null || previous.inspectionOnly || point.inspectionOnly) return []
      if (point.kind !== 'forecast' && xValues.indexOf(point.key) - xValues.indexOf(previous.key) !== 1) return []
      return [{ path: 'M ' + previous.x + ' ' + previous.y + ' L ' + point.x + ' ' + point.y, dashed: point.kind === 'forecast' }]
    })
    return {
      ...item,
      marker,
      points,
      segments,
    }
  })
  return { xValues, yMin, yMax, series: outputSeries }
}

export function decorateLineChartPoint(point, { xLabel, valueLabel, secondaryLabel, secondaryValueLabel, isEstimated = false }) {
  return {
    ...point,
    xLabel,
    valueLabel,
    ...(typeof secondaryLabel === 'string' && typeof secondaryValueLabel === 'string' ? { secondaryLabel, secondaryValueLabel } : {}),
    isEstimated: Boolean(isEstimated),
  }
}

export function lineChartPointsAtX(series, key) {
  return series.flatMap((item) => {
    const point = item.points.find((candidate) => candidate.key === key && candidate.y !== null)
    return point ? [{ series: item, point }] : []
  })
}

export function persistentLineChartPoints(points, maxPointCount = 12) {
  const visiblePoints = points.filter((point) => point.y !== null && !point.inspectionOnly)
  if (visiblePoints.length <= maxPointCount) return visiblePoints
  const step = Math.ceil(visiblePoints.length / maxPointCount)
  let lastActualIndex = -1
  visiblePoints.forEach((point, index) => {
    if (point.kind !== 'forecast') lastActualIndex = index
  })
  return visiblePoints.filter((point, index) => index % step === 0 || index === visiblePoints.length - 1 || index === lastActualIndex || point.kind === 'forecast')
}

export function lineChartPointQualifierKeys(point) {
  return [point.kind === 'forecast' ? 'forecast' : null, point.kind === 'partial' ? 'partial' : null, point.isEstimated ? 'estimated_current_rates' : null].filter(Boolean)
}

export function buildLineChartLiveDescription({ xLabel, values, qualifierLabels }) {
  const descriptions = values.map(({ label, point }) => {
    const primary = [point.valueLabel, ...lineChartPointQualifierKeys(point).map((key) => qualifierLabels[key])].filter(Boolean).join(', ')
    const secondary = typeof point.secondaryLabel === 'string' && typeof point.secondaryValueLabel === 'string' ? `${point.secondaryLabel}: ${point.secondaryValueLabel}` : null
    return [`${label}: ${primary}`, secondary].filter(Boolean).join(', ')
  })
  return [xLabel, ...descriptions].filter(Boolean).join('. ')
}

export function filterChartFacetItems(items, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return normalizedQuery ? items.filter((item) => item.label.toLocaleLowerCase().includes(normalizedQuery)) : items
}

export function toggleRequiredChartFacetSelection(selectedIds, id) {
  if (!selectedIds.includes(id)) return [...selectedIds, id]
  return selectedIds.length === 1 ? selectedIds : selectedIds.filter((item) => item !== id)
}

export function resolveFinancialTrendSourceState({ hasAccountSelection, expensesSelected, balanceState, expenseState }) {
  const balanceHasResult = ['ready', 'empty'].includes(balanceState.status) || balanceState.isStale
  const expenseHasResult = ['ready', 'empty'].includes(expenseState.status) || expenseState.isStale
  return {
    balanceBlocking: hasAccountSelection && !expensesSelected && !balanceHasResult && ['loading', 'error'].includes(balanceState.status),
    expenseBlocking: expensesSelected && !hasAccountSelection && !expenseHasResult && ['loading', 'error'].includes(expenseState.status),
    balanceStatusVisible: hasAccountSelection && ['loading', 'error'].includes(balanceState.status),
    expenseStatusVisible: expensesSelected && ['loading', 'error'].includes(expenseState.status),
    selectedSourcesSettled: (!hasAccountSelection || ['ready', 'empty'].includes(balanceState.status)) && (!expensesSelected || ['ready', 'empty'].includes(expenseState.status)),
  }
}

export function projectSelectedBalanceWarnings({ warnings, selectedMetrics }) {
  const metricLabels = new Map(selectedMetrics.map(({ id, label }) => [id, label]))
  return warnings.flatMap((warning) => {
    const metricIds = warning.metricIds.filter((id) => metricLabels.has(id))
    return metricIds.length ? [{ ...warning, metricIds, metricLabels: metricIds.map((id) => metricLabels.get(id)) }] : []
  })
}

const MONEY_FLOW_GRAPH_PADDING = 16
const MONEY_FLOW_GRAPH_GAP = 28
const MONEY_FLOW_GRAPH_HIT_SIZE = 44
const MONEY_FLOW_GRAPH_NODE_THICKNESS = 12
const MONEY_FLOW_GRAPH_DESKTOP_LABEL_GUTTER = 192
const MONEY_FLOW_GRAPH_LABEL_GAP = 8
const MONEY_FLOW_GRAPH_MOBILE_FONT_SIZE = 13.25
const MONEY_FLOW_GRAPH_POINTER_HIT_RADIUS = 22

const moneyFlowGraphWidth = (renderedWidth, isDesktop) => (Number.isFinite(renderedWidth) && renderedWidth > 0 ? renderedWidth : isDesktop ? 1000 : 360)
const moneyFlowGraphLayerGroups = (nodes) => {
  const layers = new Map()
  for (const node of nodes) layers.set(node.layer, [...(layers.get(node.layer) ?? []), node])
  return [...layers.entries()].sort(([left], [right]) => left - right).map(([layer, entries]) => ({ layer, nodes: entries }))
}

const moneyFlowGraphOuterCategory = ({ layer, kind }, firstLayer, lastLayer) =>
  (layer === firstLayer && ['income', 'refund', 'otherIncome', 'otherRefund'].includes(kind)) || (layer === lastLayer && ['expenseCategory', 'otherExpenseCategory'].includes(kind))

const moneyFlowGraphVisibleNodes = (nodes, mode) => {
  if (mode !== 'condensed') return nodes
  const layers = [...new Set(nodes.map(({ layer }) => layer))].sort((left, right) => left - right)
  return nodes.filter((node) => !moneyFlowGraphOuterCategory(node, layers[0], layers.at(-1)))
}

const moneyFlowGraphGraphemes = (value) => {
  const text = String(value ?? '')
  if (!text) return []
  if (typeof Intl.Segmenter !== 'function') return Array.from(text)
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(({ segment }) => segment)
}
const moneyFlowGraphGraphemeWidth = (value, fontSize) => {
  if (/\s/u.test(value)) return fontSize * 0.4
  if (/[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return fontSize
  if (/[MW@#%&]/u.test(value)) return fontSize * 0.9
  if (/\p{Punctuation}/u.test(value)) return fontSize * 0.5
  return fontSize * 0.72
}
const moneyFlowGraphTextWidth = (value, fontSize) => {
  const graphemes = moneyFlowGraphGraphemes(value)
  return graphemes.length ? graphemes.reduce((total, grapheme) => total + moneyFlowGraphGraphemeWidth(grapheme, fontSize), 8) : 0
}
const truncateMoneyFlowGraphText = (value, maximumWidth, fontSize) => {
  const text = String(value ?? '')
  if (moneyFlowGraphTextWidth(text, fontSize) <= maximumWidth) return { text, truncated: false }
  const ellipsis = '…'
  const available = Math.max(0, maximumWidth - 8 - moneyFlowGraphGraphemeWidth(ellipsis, fontSize))
  const retained = []
  let width = 0
  for (const grapheme of moneyFlowGraphGraphemes(text)) {
    const graphemeWidth = moneyFlowGraphGraphemeWidth(grapheme, fontSize)
    if (width + graphemeWidth > available) break
    retained.push(grapheme)
    width += graphemeWidth
  }
  return { text: retained.join('') + ellipsis, truncated: true }
}

export function resolveMoneyFlowGraphFit({ nodes, isDesktop, renderedWidth, mode = 'full', allowTruncation = false }) {
  const width = moneyFlowGraphWidth(renderedWidth, isDesktop)
  const visibleNodes = moneyFlowGraphVisibleNodes(nodes, mode)
  const layers = moneyFlowGraphLayerGroups(visibleNodes).map(({ layer, nodes: entries }) => {
    const availableWidth = width - MONEY_FLOW_GRAPH_PADDING * 2 - Math.max(0, entries.length - 1) * MONEY_FLOW_GRAPH_LABEL_GAP
    const slotWidth = entries.length ? availableWidth / entries.length : 0
    const measuredNodes = entries.map((node) => {
      const label = String(node.label ?? node.refId ?? node.id)
      const valueLabel = String(node.valueLabel ?? node.value ?? '')
      const renderedLabel = allowTruncation ? truncateMoneyFlowGraphText(label, slotWidth, MONEY_FLOW_GRAPH_MOBILE_FONT_SIZE) : { text: label, truncated: false }
      const renderedValue = allowTruncation ? truncateMoneyFlowGraphText(valueLabel, slotWidth, MONEY_FLOW_GRAPH_MOBILE_FONT_SIZE) : { text: valueLabel, truncated: false }
      const labelWidth = moneyFlowGraphTextWidth(renderedLabel.text, MONEY_FLOW_GRAPH_MOBILE_FONT_SIZE)
      const valueWidth = moneyFlowGraphTextWidth(renderedValue.text, MONEY_FLOW_GRAPH_MOBILE_FONT_SIZE)
      return {
        id: node.id,
        labelWidth,
        valueWidth,
        targetWidth: Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, labelWidth, valueWidth),
        displayLabel: renderedLabel.text,
        displayValueLabel: renderedValue.text,
        truncated: renderedLabel.truncated || renderedValue.truncated,
      }
    })
    return {
      layer,
      requiredWidth: MONEY_FLOW_GRAPH_PADDING * 2 + measuredNodes.reduce((total, node) => total + node.targetWidth, 0) + Math.max(0, measuredNodes.length - 1) * MONEY_FLOW_GRAPH_LABEL_GAP,
      nodes: measuredNodes,
    }
  })
  const requiredWidth = Math.max(0, ...layers.map((layer) => layer.requiredWidth))
  const overflowingNodeIds = [
    ...new Set(layers.flatMap((layer) => layer.nodes.filter(({ targetWidth }) => targetWidth + MONEY_FLOW_GRAPH_PADDING * 2 > width || layer.requiredWidth > width).map(({ id }) => id))),
  ]
  return {
    mode,
    fits: requiredWidth <= width,
    renderedWidth: width,
    requiredWidth,
    overflowingNodeIds,
    truncatedNodeIds: layers.flatMap(({ nodes: entries }) => entries.filter(({ truncated }) => truncated).map(({ id }) => id)),
    layers,
  }
}

export function resolveMoneyFlowGraphMode({ nodes, isDesktop, renderedWidth }) {
  if (isDesktop) return 'full'
  if (resolveMoneyFlowGraphFit({ nodes, isDesktop, renderedWidth, mode: 'full' }).fits) return 'full'
  const groups = moneyFlowGraphLayerGroups(nodes)
  const firstLayer = groups[0]?.layer
  const lastLayer = groups.at(-1)?.layer
  return nodes.some((node) => moneyFlowGraphOuterCategory(node, firstLayer, lastLayer)) ? 'condensed' : 'full'
}

const moneyFlowGraphHitBox = ({ x, y, width, height }) => {
  const hitWidth = Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, width)
  const hitHeight = Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, height)
  return { x: x - (hitWidth - width) / 2, y: y - (hitHeight - height) / 2, width: hitWidth, height: hitHeight }
}

const resolveMoneyFlowGraphOrientation = ({ isDesktop, width, layerCount }) => {
  const horizontalLayerStart = MONEY_FLOW_GRAPH_DESKTOP_LABEL_GUTTER + MONEY_FLOW_GRAPH_NODE_THICKNESS / 2
  const requiredWidth = horizontalLayerStart * 2 + Math.max(0, layerCount - 1) * MONEY_FLOW_GRAPH_HIT_SIZE
  return isDesktop && width >= requiredWidth ? 'horizontal' : 'vertical'
}

const moneyFlowGraphRibbonPath = ({ source, target, sourceOffset, targetOffset, width, orientation }) => {
  if (orientation === 'horizontal') {
    const sourceX = source.x + source.width
    const targetX = target.x
    const sourceStart = source.y + sourceOffset
    const sourceEnd = sourceStart + width
    const targetStart = target.y + targetOffset
    const targetEnd = targetStart + width
    const middleX = (sourceX + targetX) / 2
    const sourceCenter = sourceStart + width / 2
    const targetCenter = targetStart + width / 2
    const start = { x: sourceX, y: sourceCenter }
    const control1 = { x: middleX, y: sourceCenter }
    const control2 = { x: middleX, y: targetCenter }
    const end = { x: targetX, y: targetCenter }
    return {
      path: `M ${sourceX} ${sourceStart} C ${middleX} ${sourceStart}, ${middleX} ${targetStart}, ${targetX} ${targetStart} L ${targetX} ${targetEnd} C ${middleX} ${targetEnd}, ${middleX} ${sourceEnd}, ${sourceX} ${sourceEnd} Z`,
      corridor: {
        path: `M ${sourceX} ${sourceCenter} C ${middleX} ${sourceCenter}, ${middleX} ${targetCenter}, ${targetX} ${targetCenter}`,
        hitWidth: Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, width),
        start,
        control1,
        control2,
        end,
      },
    }
  }

  const sourceY = source.y + source.height
  const targetY = target.y
  const sourceStart = source.x + sourceOffset
  const sourceEnd = sourceStart + width
  const targetStart = target.x + targetOffset
  const targetEnd = targetStart + width
  const middleY = (sourceY + targetY) / 2
  const sourceCenter = sourceStart + width / 2
  const targetCenter = targetStart + width / 2
  const start = { x: sourceCenter, y: sourceY }
  const control1 = { x: sourceCenter, y: middleY }
  const control2 = { x: targetCenter, y: middleY }
  const end = { x: targetCenter, y: targetY }
  return {
    path: `M ${sourceStart} ${sourceY} C ${sourceStart} ${middleY}, ${targetStart} ${middleY}, ${targetStart} ${targetY} L ${targetEnd} ${targetY} C ${targetEnd} ${middleY}, ${sourceEnd} ${middleY}, ${sourceEnd} ${sourceY} Z`,
    corridor: {
      path: `M ${sourceCenter} ${sourceY} C ${sourceCenter} ${middleY}, ${targetCenter} ${middleY}, ${targetCenter} ${targetY}`,
      hitWidth: Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, width),
      start,
      control1,
      control2,
      end,
    },
  }
}

const moneyFlowCubicPoint = ({ start, control1, control2, end }, amount) => {
  const inverse = 1 - amount
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * amount * control1.x + 3 * inverse * amount ** 2 * control2.x + amount ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * amount * control1.y + 3 * inverse * amount ** 2 * control2.y + amount ** 3 * end.y,
  }
}
const moneyFlowPointSegmentDistance = (point, start, end) => {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const lengthSquared = deltaX ** 2 + deltaY ** 2
  const amount = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared)) : 0
  return Math.hypot(point.x - (start.x + amount * deltaX), point.y - (start.y + amount * deltaY))
}

export function resolveNearestMoneyFlowRibbon({ ribbons, point }) {
  const candidates = ribbons
    .map((ribbon) => {
      let distance = Infinity
      let previous = ribbon.corridor.start
      for (let index = 1; index <= 32; index++) {
        const current = moneyFlowCubicPoint(ribbon.corridor, index / 32)
        distance = Math.min(distance, moneyFlowPointSegmentDistance(point, previous, current))
        previous = current
      }
      return { ribbon, distance, hitRadius: Math.max(MONEY_FLOW_GRAPH_POINTER_HIT_RADIUS, Math.abs(Number(ribbon.width) || 0) / 2) }
    })
    .filter(({ distance, hitRadius }) => distance <= hitRadius)
  candidates.sort((left, right) => left.distance - right.distance || left.ribbon.id.localeCompare(right.ribbon.id))
  return candidates[0]?.ribbon ?? null
}

export function buildMoneyFlowGraphGeometry({ nodes, links, isDesktop, renderedWidth, mode }) {
  const viewportWidth = moneyFlowGraphWidth(renderedWidth, isDesktop)
  const resolvedMode = mode ?? resolveMoneyFlowGraphMode({ nodes, isDesktop, renderedWidth: viewportWidth })
  const fullFit = resolveMoneyFlowGraphFit({ nodes, isDesktop, renderedWidth: viewportWidth, mode: 'full' })
  const layers = [...new Set(nodes.map(({ layer }) => layer))].sort((left, right) => left - right)
  const orientation = resolveMoneyFlowGraphOrientation({ isDesktop, width: viewportWidth, layerCount: layers.length })
  const isHorizontal = orientation === 'horizontal'
  const naturalSelectedFit = resolvedMode === 'full' ? fullFit : resolveMoneyFlowGraphFit({ nodes, isDesktop, renderedWidth: viewportWidth, mode: resolvedMode })
  let selectedFit =
    !isDesktop && !naturalSelectedFit.fits ? resolveMoneyFlowGraphFit({ nodes, isDesktop, renderedWidth: viewportWidth, mode: resolvedMode, allowTruncation: true }) : naturalSelectedFit
  const width = isDesktop && !isHorizontal ? Math.max(viewportWidth, selectedFit.requiredWidth) : viewportWidth
  if (isHorizontal) selectedFit = { ...selectedFit, fits: true, overflowingNodeIds: [] }
  else if (isDesktop && width > viewportWidth) selectedFit = resolveMoneyFlowGraphFit({ nodes, isDesktop, renderedWidth: width, mode: resolvedMode })
  const firstLayer = layers[0]
  const lastLayer = layers.at(-1)
  const hiddenNodes = resolvedMode === 'condensed' ? nodes.filter((node) => moneyFlowGraphOuterCategory(node, firstLayer, lastLayer)) : []
  const hiddenNodeIds = new Set(hiddenNodes.map(({ id }) => id))
  const visibleNodes = nodes.filter(({ id }) => !hiddenNodeIds.has(id))
  const visibleNodeIds = new Set(visibleNodes.map(({ id }) => id))
  const visibleLinks = links.filter(({ sourceId, targetId, value }) => visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId) && Number.isFinite(value) && value !== 0)
  const hiddenLinks = resolvedMode === 'condensed' ? links.filter(({ sourceId, targetId }) => hiddenNodeIds.has(sourceId) || hiddenNodeIds.has(targetId)) : []
  const layerGroups = moneyFlowGraphLayerGroups(visibleNodes)
  const incoming = new Map(visibleNodes.map(({ id }) => [id, 0]))
  const outgoing = new Map(visibleNodes.map(({ id }) => [id, 0]))
  for (const link of visibleLinks) {
    outgoing.set(link.sourceId, outgoing.get(link.sourceId) + Math.abs(link.value))
    incoming.set(link.targetId, incoming.get(link.targetId) + Math.abs(link.value))
  }
  const spanValues = new Map(visibleNodes.map((node) => [node.id, Math.max(Math.abs(Number(node.value) || 0), incoming.get(node.id), outgoing.get(node.id))]))
  const targetWidths = new Map(selectedFit.layers.flatMap(({ nodes: entries }) => entries.map(({ id, targetWidth }) => [id, targetWidth])))
  const presentationByNode = new Map(selectedFit.layers.flatMap(({ nodes: entries }) => entries.map((entry) => [entry.id, entry])))
  const crossExtent = isHorizontal ? 280 : Math.max(1, width - MONEY_FLOW_GRAPH_PADDING * 2)
  const scaleCandidates = layerGroups.flatMap(({ nodes: entries }) => {
    const total = entries.reduce((sum, node) => sum + spanValues.get(node.id), 0)
    return total > 0 ? [crossExtent / total] : []
  })
  const maximumScale = scaleCandidates.length ? Math.min(...scaleCandidates) : 1
  const nodeFootprint = (node, candidateScale) =>
    Math.max(spanValues.get(node.id) * candidateScale, isHorizontal ? MONEY_FLOW_GRAPH_HIT_SIZE : (targetWidths.get(node.id) ?? MONEY_FLOW_GRAPH_HIT_SIZE))
  const groupExtent = (entries, candidateScale) => entries.reduce((sum, node) => sum + nodeFootprint(node, candidateScale), 0) + Math.max(0, entries.length - 1) * MONEY_FLOW_GRAPH_LABEL_GAP
  let scale = maximumScale
  if (!isHorizontal && layerGroups.some(({ nodes: entries }) => groupExtent(entries, scale) > crossExtent)) {
    let lower = 0
    let upper = maximumScale
    for (let index = 0; index < 40; index++) {
      const candidate = (lower + upper) / 2
      if (layerGroups.every(({ nodes: entries }) => groupExtent(entries, candidate) <= crossExtent)) lower = candidate
      else upper = candidate
    }
    scale = lower
  }
  const layerCrossExtents = layerGroups.map(({ nodes: entries }) => groupExtent(entries, scale))
  const height = isHorizontal ? Math.max(360, Math.max(0, ...layerCrossExtents) + MONEY_FLOW_GRAPH_PADDING * 2) : Math.max(280, layerGroups.length * 104 + MONEY_FLOW_GRAPH_PADDING * 2)
  const directionExtent = isHorizontal ? width : height
  const layerStart = isHorizontal ? MONEY_FLOW_GRAPH_DESKTOP_LABEL_GUTTER + MONEY_FLOW_GRAPH_NODE_THICKNESS / 2 : 44
  const layerEnd = directionExtent - layerStart
  const layerPosition = (index) => (layerGroups.length <= 1 ? directionExtent / 2 : layerStart + (index / (layerGroups.length - 1)) * (layerEnd - layerStart))
  const graphNodes = []

  layerGroups.forEach(({ nodes: entries }, layerIndex) => {
    const totalExtent = groupExtent(entries, scale)
    let cursor = ((isHorizontal ? height : width) - totalExtent) / 2
    for (const node of entries) {
      const span = spanValues.get(node.id) * scale
      const footprint = nodeFootprint(node, scale)
      const crossStart = cursor + (footprint - span) / 2
      const geometry = isHorizontal
        ? { x: layerPosition(layerIndex) - MONEY_FLOW_GRAPH_NODE_THICKNESS / 2, y: crossStart, width: MONEY_FLOW_GRAPH_NODE_THICKNESS, height: span }
        : { x: crossStart, y: layerPosition(layerIndex) - MONEY_FLOW_GRAPH_NODE_THICKNESS / 2, width: span, height: MONEY_FLOW_GRAPH_NODE_THICKNESS }
      const presentation = presentationByNode.get(node.id)
      graphNodes.push({
        ...node,
        node,
        ...geometry,
        displayLabel: presentation?.displayLabel ?? String(node.label ?? node.refId ?? node.id),
        displayValueLabel: presentation?.displayValueLabel ?? String(node.valueLabel ?? node.value ?? ''),
        span,
        incomingWidth: incoming.get(node.id) * scale,
        outgoingWidth: outgoing.get(node.id) * scale,
        hitBox: moneyFlowGraphHitBox(geometry),
        contentBox: isHorizontal
          ? {
              x: geometry.x - MONEY_FLOW_GRAPH_DESKTOP_LABEL_GUTTER,
              y: geometry.y + geometry.height / 2 - (presentation?.targetWidth ?? MONEY_FLOW_GRAPH_HIT_SIZE) / 2,
              width: MONEY_FLOW_GRAPH_DESKTOP_LABEL_GUTTER,
              height: presentation?.targetWidth ?? MONEY_FLOW_GRAPH_HIT_SIZE,
            }
          : { x: cursor, y: geometry.y - 24, width: footprint, height: MONEY_FLOW_GRAPH_HIT_SIZE + 28 },
      })
      cursor += footprint + MONEY_FLOW_GRAPH_LABEL_GAP
    }
  })

  const nodeGeometry = new Map(graphNodes.map((node) => [node.id, node]))
  const crossPosition = (node) => (isHorizontal ? node.y + node.height / 2 : node.x + node.width / 2)
  const allocateOffsets = (nodeIdKey, counterpartIdKey) => {
    const offsets = new Map()
    for (const { id } of graphNodes) {
      let offset = 0
      const connected = visibleLinks
        .filter((link) => link[nodeIdKey] === id)
        .sort((left, right) => crossPosition(nodeGeometry.get(left[counterpartIdKey])) - crossPosition(nodeGeometry.get(right[counterpartIdKey])) || left.id.localeCompare(right.id))
      for (const link of connected) {
        offsets.set(link, offset)
        offset += Math.abs(link.value) * scale
      }
    }
    return offsets
  }
  const sourceOffsets = allocateOffsets('sourceId', 'targetId')
  const targetOffsets = allocateOffsets('targetId', 'sourceId')
  const ribbons = [...visibleLinks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((link) => {
      const source = nodeGeometry.get(link.sourceId)
      const target = nodeGeometry.get(link.targetId)
      const ribbonWidth = Math.abs(link.value) * scale
      const sourceOffset = sourceOffsets.get(link)
      const targetOffset = targetOffsets.get(link)
      const { path, corridor } = moneyFlowGraphRibbonPath({ source, target, sourceOffset, targetOffset, width: ribbonWidth, orientation })
      const transferSpan = isHorizontal ? target.x - (source.x + source.width) : target.y - (source.y + source.height)
      return { ...link, link, width: ribbonWidth, sourceWidth: ribbonWidth, targetWidth: ribbonWidth, transferSpan, path, corridor, source, target }
    })

  const baselines = layerGroups.flatMap(({ nodes: entries }) => {
    const positioned = entries.map(({ id }) => nodeGeometry.get(id)).sort((left, right) => (isHorizontal ? left.y - right.y : left.x - right.x))
    return positioned.slice(1).map((node, index) => {
      const previous = positioned[index]
      return isHorizontal ? node.y + node.height / 2 - previous.y - previous.height / 2 : node.x + node.width / 2 - previous.x - previous.width / 2
    })
  })
  const baselineSpacing = baselines.length ? Math.min(...baselines) : MONEY_FLOW_GRAPH_GAP

  return {
    mode: resolvedMode,
    orientation,
    viewportWidth,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    scale,
    baselineSpacing,
    responsive: { full: fullFit, selected: selectedFit },
    nodes: graphNodes,
    ribbons,
    pools: graphNodes.filter(({ kind }) => ['available', 'savings'].includes(kind)),
    details: resolvedMode === 'condensed' ? { nodes: hiddenNodes, links: hiddenLinks } : null,
  }
}

export function resolveMoneyFlowItemDetails({ item, nodes }) {
  const nodeDictionary = new Map(nodes.map((node) => [node.id, node]))
  const value = Math.abs(Number(item.value) || 0)
  const sourceValue = Math.abs(Number(nodeDictionary.get(item.sourceId)?.value) || 0)
  const destinationValue = Math.abs(Number(nodeDictionary.get(item.targetId)?.value) || 0)
  const refundCoverage = item.refundCoverage ?? null
  return {
    value: Number(item.value) || 0,
    sourcePercent: item.sourceId && sourceValue ? value / sourceValue : null,
    destinationPercent: item.targetId && destinationValue ? value / destinationValue : null,
    refundCoverage,
    bridge: item.details?.availableToSavings && item.details?.savingsToAvailable ? item.details : null,
    transactionIds: [...new Set([...(item.transactionIds ?? []), ...(refundCoverage?.transactionIds ?? [])])].sort(),
  }
}

export function resolveMoneyFlowInteraction({ state = {}, action, targets = [] }) {
  let preview = state.preview ?? null
  let pinned = state.pinned ?? null
  let selection = null
  let focusTarget = null

  if (['activate', 'pointer-enter', 'focus'].includes(action.type)) preview = action.target
  if (['deactivate', 'pointer-leave', 'blur'].includes(action.type)) preview = null
  if (action.type === 'select') {
    pinned = action.target
    selection = { ...action.target, contextNodes: action.contextNodes ?? [] }
  }
  if (['dismiss', 'outside', 'escape'].includes(action.type)) {
    preview = null
    pinned = null
  }
  if (action.type === 'move' && targets.length) {
    const currentIndex = targets.findIndex(({ type, id }) => type === action.target?.type && id === action.target?.id)
    const startIndex = currentIndex < 0 ? 0 : currentIndex
    focusTarget = targets[(startIndex + action.amount + targets.length) % targets.length]
  }

  return { preview, pinned, active: preview ?? pinned, selection, focusTarget }
}

export function projectMoneyFlowTransactionSelection({ item = {}, rows = [], nodes = [], toUrl }) {
  const evidence = [item, ...rows]
  const nodeDictionary = new Map(nodes.map((node) => [node.id, node]))
  const refundEvidence = [...evidence.flatMap((entry) => [entry.refundCoverage, nodeDictionary.get(entry.sourceId)?.refundCoverage, nodeDictionary.get(entry.targetId)?.refundCoverage])].filter(
    Boolean,
  )
  const uniqueRefundEvidence = [...new Map(refundEvidence.map((coverage) => [`${Number(coverage.value) || 0}:${[...new Set(coverage.transactionIds ?? [])].sort().join(',')}`, coverage])).values()]
  const refundCoverage = uniqueRefundEvidence.length
    ? {
        value: uniqueRefundEvidence.reduce((total, coverage) => total + (Number(coverage.value) || 0), 0),
        transactionIds: [...new Set(uniqueRefundEvidence.flatMap((coverage) => coverage.transactionIds ?? []))].sort(),
      }
    : null
  const transactionIds = [
    ...new Set(
      evidence.flatMap((entry) => [
        ...(entry.transactionIds ?? []),
        ...(entry.refundCoverage?.transactionIds ?? []),
        ...(entry.details?.availableToSavings?.transactionIds ?? []),
        ...(entry.details?.savingsToAvailable?.transactionIds ?? []),
      ]),
    ),
    ...(refundCoverage?.transactionIds ?? []),
  ].sort()
  const uniqueTransactionIds = [...new Set(transactionIds)]
  const queryValue = uniqueTransactionIds.join(',')
  return { refundCoverage, transactionIds: uniqueTransactionIds, queryValue, ...(toUrl ? { query: toUrl(queryValue) } : {}) }
}

export function formatMoneyFlowValue({ value, language, currencyCode, showAccountAmounts = true, showDecimal = true }) {
  if (!Number.isFinite(value)) return ''
  const formatted = showAccountAmounts ? new Intl.NumberFormat(language, { minimumFractionDigits: showDecimal ? 2 : 0, maximumFractionDigits: showDecimal ? 2 : 0 }).format(value) : '******'
  return [formatted, currencyCode].filter(Boolean).join(' ')
}

export function formatMoneyFlowPercent({ value, language }) {
  return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(value)
}

export function resolveMoneyFlowSemanticColor(item) {
  const kind = String(item.kind ?? '')
  const semanticKind = kind.startsWith('other') && kind.length > 5 ? kind.charAt(5).toLowerCase() + kind.slice(6) : kind
  if (item.fundingPool === 'savings' || ['savings', 'savingsDeposited', 'savingsDeposit', 'existingSavings'].includes(semanticKind)) return 'var(--income2)'
  if (['expenses', 'expense', 'expenseCategory'].includes(semanticKind)) return 'var(--expense2)'
  if (['newDebt', 'debtPaid', 'liabilityExtended', 'liabilityCollected'].includes(semanticKind)) return 'var(--van-warning-color)'
  return 'var(--transfer2)'
}

export function resolveMoneyFlowPresentation({ isBalanced, hasNodes, hasUnclassified = false, hasMissingRates = false, isCondensed = false, isStale = false }) {
  const canPresent = isBalanced && !hasUnclassified && !hasMissingRates
  return {
    showGraph: canPresent && hasNodes,
    showEmpty: canPresent && !hasNodes,
    showAudit: !canPresent,
    reason: hasMissingRates ? 'missing_rates' : hasUnclassified ? 'unclassified' : !isBalanced ? 'unbalanced' : !hasNodes ? 'empty' : isCondensed ? 'condensed' : isStale ? 'stale' : null,
  }
}
