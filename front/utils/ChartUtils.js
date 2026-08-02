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
    const segments = points.slice(1).flatMap((point, index) => {
      const previous = points[index]
      if (previous.y === null || point.y === null || previous.inspectionOnly || point.inspectionOnly || xValues.indexOf(point.key) - xValues.indexOf(previous.key) !== 1) return []
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
