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

const moneyFlowBandWidth = (value, total, maxWidth) => Math.max(4, clamp(Math.max(0, Number(value)) / Math.max(1, Number(total)), 0, 1) * maxWidth)
const moneyFlowLabelPosition = (index, count, start, end) => (count <= 1 ? (start + end) / 2 : start + (index / (count - 1)) * (end - start))
const moneyFlowAnchors = (nodes, total, maxWidth, center) => {
  const widths = nodes.map(({ value }) => moneyFlowBandWidth(value, total, maxWidth))
  let offset = center - widths.reduce((sum, width) => sum + width, 0) / 2
  return widths.map((width) => {
    const anchor = offset + width / 2
    offset += width
    return { anchor, width }
  })
}

export function buildMoneyFlowGeometry({ sources, destinations, total, isDesktop }) {
  const bus = isDesktop
    ? { x: 478, y: 40, width: 44, height: 440, labelX: 500, labelY: 260, transform: 'rotate(-90 500 260)' }
    : { x: 24, y: 286, width: 312, height: 48, labelX: 180, labelY: 315, transform: null }
  const geometryFor = (nodes, side) => {
    const anchors = moneyFlowAnchors(nodes, total, isDesktop ? 180 : 48, isDesktop ? 260 : 180)
    return nodes.map((node, index) => {
      const { anchor, width } = anchors[index]
      if (isDesktop) {
        const labelY = moneyFlowLabelPosition(index, nodes.length, 72, 448)
        const isSource = side === 'source'
        return {
          ...node,
          side,
          width,
          path: isSource ? `M 340 ${labelY} C 390 ${labelY}, 430 ${anchor}, 478 ${anchor}` : `M 522 ${anchor} C 570 ${anchor}, 610 ${labelY}, 660 ${labelY}`,
          labelX: isSource ? 225 : 775,
          labelY,
          amountX: isSource ? 225 : 775,
          amountY: labelY + 18,
          textAnchor: isSource ? 'end' : 'start',
        }
      }

      const isLeft = index % 2 === 0
      const isSource = side === 'source'
      const labelY = isSource ? moneyFlowLabelPosition(index, nodes.length, 38, 206) : moneyFlowLabelPosition(index, nodes.length, 410, 578)
      const pathX = isLeft ? 132 : 228
      return {
        ...node,
        side,
        width,
        path: isSource
          ? `M ${pathX} ${labelY + 48} C ${pathX} ${labelY + 70}, ${anchor} 246, ${anchor} ${bus.y}`
          : `M ${anchor} ${bus.y + bus.height} C ${anchor} 374, ${pathX} ${labelY - 48}, ${pathX} ${labelY - 48}`,
        labelX: isLeft ? 16 : 344,
        labelY,
        amountX: isLeft ? 16 : 344,
        amountY: labelY + 17,
        textAnchor: isLeft ? 'start' : 'end',
      }
    })
  }

  return {
    viewBox: isDesktop ? '0 0 1000 520' : '0 0 360 620',
    bus,
    sources: geometryFor(sources, 'source'),
    destinations: geometryFor(destinations, 'destination'),
  }
}

const MONEY_FLOW_GRAPH_PADDING = 16
const MONEY_FLOW_GRAPH_GAP = 28
const MONEY_FLOW_GRAPH_HIT_SIZE = 44
const MONEY_FLOW_GRAPH_NODE_THICKNESS = 12

const moneyFlowGraphWidth = (renderedWidth, isDesktop) => (Number.isFinite(renderedWidth) && renderedWidth > 0 ? renderedWidth : isDesktop ? 1000 : 360)
const moneyFlowGraphLayerGroups = (nodes) => {
  const layers = new Map()
  for (const node of nodes) layers.set(node.layer, [...(layers.get(node.layer) ?? []), node])
  return [...layers.entries()].sort(([left], [right]) => left - right).map(([layer, entries]) => ({ layer, nodes: entries.sort((left, right) => left.id.localeCompare(right.id)) }))
}

export function resolveMoneyFlowGraphMode({ nodes, isDesktop, renderedWidth }) {
  if (isDesktop) return 'full'
  const width = moneyFlowGraphWidth(renderedWidth, false)
  const requiredWidth = Math.max(
    0,
    ...moneyFlowGraphLayerGroups(nodes).map(({ nodes: entries }) => entries.length * MONEY_FLOW_GRAPH_HIT_SIZE + Math.max(0, entries.length - 1) * MONEY_FLOW_GRAPH_GAP + MONEY_FLOW_GRAPH_PADDING * 2),
  )
  return requiredWidth <= width ? 'full' : 'condensed'
}

const moneyFlowGraphHitBox = ({ x, y, width, height }) => {
  const hitWidth = Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, width)
  const hitHeight = Math.max(MONEY_FLOW_GRAPH_HIT_SIZE, height)
  return { x: x - (hitWidth - width) / 2, y: y - (hitHeight - height) / 2, width: hitWidth, height: hitHeight }
}

const moneyFlowGraphRibbonPath = ({ source, target, sourceOffset, targetOffset, width, isDesktop }) => {
  if (isDesktop) {
    const sourceX = source.x + source.width
    const targetX = target.x
    const sourceStart = source.y + sourceOffset
    const sourceEnd = sourceStart + width
    const targetStart = target.y + targetOffset
    const targetEnd = targetStart + width
    const middleX = (sourceX + targetX) / 2
    return {
      path: `M ${sourceX} ${sourceStart} C ${middleX} ${sourceStart}, ${middleX} ${targetStart}, ${targetX} ${targetStart} L ${targetX} ${targetEnd} C ${middleX} ${targetEnd}, ${middleX} ${sourceEnd}, ${sourceX} ${sourceEnd} Z`,
      bounds: { x: Math.min(sourceX, targetX), y: Math.min(sourceStart, targetStart), width: Math.abs(targetX - sourceX), height: Math.max(sourceEnd, targetEnd) - Math.min(sourceStart, targetStart) },
    }
  }

  const sourceY = source.y + source.height
  const targetY = target.y
  const sourceStart = source.x + sourceOffset
  const sourceEnd = sourceStart + width
  const targetStart = target.x + targetOffset
  const targetEnd = targetStart + width
  const middleY = (sourceY + targetY) / 2
  return {
    path: `M ${sourceStart} ${sourceY} C ${sourceStart} ${middleY}, ${targetStart} ${middleY}, ${targetStart} ${targetY} L ${targetEnd} ${targetY} C ${targetEnd} ${middleY}, ${sourceEnd} ${middleY}, ${sourceEnd} ${sourceY} Z`,
    bounds: { x: Math.min(sourceStart, targetStart), y: Math.min(sourceY, targetY), width: Math.max(sourceEnd, targetEnd) - Math.min(sourceStart, targetStart), height: Math.abs(targetY - sourceY) },
  }
}

export function buildMoneyFlowGraphGeometry({ nodes, links, isDesktop, renderedWidth, mode }) {
  const width = moneyFlowGraphWidth(renderedWidth, isDesktop)
  const resolvedMode = mode ?? resolveMoneyFlowGraphMode({ nodes, isDesktop, renderedWidth: width })
  const hiddenNodes = resolvedMode === 'condensed' ? nodes.filter(({ layer }) => layer === 0 || layer === 4) : []
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
  const crossExtent = isDesktop ? 280 : Math.max(1, width - MONEY_FLOW_GRAPH_PADDING * 2)
  const scaleCandidates = layerGroups.flatMap(({ nodes: entries }) => {
    const total = entries.reduce((sum, node) => sum + spanValues.get(node.id), 0)
    const available = crossExtent - Math.max(0, entries.length - 1) * MONEY_FLOW_GRAPH_GAP
    return total > 0 ? [Math.max(0, available) / total] : []
  })
  const scale = scaleCandidates.length ? Math.min(...scaleCandidates) : 1
  const layerCrossExtents = layerGroups.map(({ nodes: entries }) => entries.reduce((sum, node) => sum + spanValues.get(node.id) * scale, 0) + Math.max(0, entries.length - 1) * MONEY_FLOW_GRAPH_GAP)
  const height = isDesktop ? Math.max(360, Math.max(0, ...layerCrossExtents) + MONEY_FLOW_GRAPH_PADDING * 2) : Math.max(280, layerGroups.length * 104 + MONEY_FLOW_GRAPH_PADDING * 2)
  const directionExtent = isDesktop ? width : height
  const layerStart = isDesktop ? 48 : 44
  const layerEnd = directionExtent - layerStart
  const layerPosition = (index) => (layerGroups.length <= 1 ? directionExtent / 2 : layerStart + (index / (layerGroups.length - 1)) * (layerEnd - layerStart))
  const graphNodes = []

  layerGroups.forEach(({ nodes: entries }, layerIndex) => {
    const totalExtent = entries.reduce((sum, node) => sum + spanValues.get(node.id) * scale, 0) + Math.max(0, entries.length - 1) * MONEY_FLOW_GRAPH_GAP
    let cursor = ((isDesktop ? height : width) - totalExtent) / 2
    for (const node of entries) {
      const span = spanValues.get(node.id) * scale
      const geometry = isDesktop
        ? { x: layerPosition(layerIndex) - MONEY_FLOW_GRAPH_NODE_THICKNESS / 2, y: cursor, width: MONEY_FLOW_GRAPH_NODE_THICKNESS, height: span }
        : { x: cursor, y: layerPosition(layerIndex) - MONEY_FLOW_GRAPH_NODE_THICKNESS / 2, width: span, height: MONEY_FLOW_GRAPH_NODE_THICKNESS }
      graphNodes.push({
        ...node,
        node,
        ...geometry,
        span,
        incomingWidth: incoming.get(node.id) * scale,
        outgoingWidth: outgoing.get(node.id) * scale,
        hitBox: moneyFlowGraphHitBox(geometry),
      })
      cursor += span + MONEY_FLOW_GRAPH_GAP
    }
  })

  const nodeGeometry = new Map(graphNodes.map((node) => [node.id, node]))
  const sourceOffsets = new Map(graphNodes.map(({ id }) => [id, 0]))
  const targetOffsets = new Map(graphNodes.map(({ id }) => [id, 0]))
  const ribbons = [...visibleLinks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((link) => {
      const source = nodeGeometry.get(link.sourceId)
      const target = nodeGeometry.get(link.targetId)
      const ribbonWidth = Math.abs(link.value) * scale
      const sourceOffset = sourceOffsets.get(link.sourceId)
      const targetOffset = targetOffsets.get(link.targetId)
      sourceOffsets.set(link.sourceId, sourceOffset + ribbonWidth)
      targetOffsets.set(link.targetId, targetOffset + ribbonWidth)
      const { path, bounds } = moneyFlowGraphRibbonPath({ source, target, sourceOffset, targetOffset, width: ribbonWidth, isDesktop })
      return { ...link, link, width: ribbonWidth, path, source, target, hitBox: moneyFlowGraphHitBox(bounds) }
    })

  const baselines = layerGroups.flatMap(({ nodes: entries }) => {
    const positioned = entries.map(({ id }) => nodeGeometry.get(id)).sort((left, right) => (isDesktop ? left.y - right.y : left.x - right.x))
    return positioned.slice(1).map((node, index) => {
      const previous = positioned[index]
      return isDesktop ? node.y + node.height / 2 - previous.y - previous.height / 2 : node.x + node.width / 2 - previous.x - previous.width / 2
    })
  })
  const baselineSpacing = baselines.length ? Math.min(...baselines) : MONEY_FLOW_GRAPH_GAP

  return {
    mode: resolvedMode,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    scale,
    baselineSpacing,
    nodes: graphNodes,
    ribbons,
    pools: graphNodes.filter(({ kind }) => ['available', 'savings'].includes(kind)),
    details: resolvedMode === 'condensed' ? { nodes: hiddenNodes, links: hiddenLinks } : null,
  }
}

export function resolveMoneyFlowPresentation({ isBalanced, hasNodes }) {
  return {
    showChart: isBalanced && hasNodes,
    showEmpty: isBalanced && !hasNodes,
    showUnbalancedAudit: !isBalanced,
  }
}
