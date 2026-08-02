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

export function decorateLineChartPoint(point, { xLabel, valueLabel, isEstimated = false }) {
  return { ...point, xLabel, valueLabel, isEstimated: Boolean(isEstimated) }
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
  const descriptions = values.map(({ label, point }) => [label, point.valueLabel, ...lineChartPointQualifierKeys(point).map((key) => qualifierLabels[key])].filter(Boolean).join(', '))
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

export function resolveMoneyFlowPresentation({ isBalanced, hasNodes }) {
  return {
    showChart: isBalanced && hasNodes,
    showEmpty: isBalanced && !hasNodes,
    showUnbalancedAudit: !isBalanced,
  }
}
