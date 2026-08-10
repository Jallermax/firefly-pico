const MODES = ['spending', 'full']
const SAVINGS_VIEWS = ['combined', 'split']
const DETAIL_LEVELS = [5, 10, 'all']
const MONEY_KINDS = new Set(['available', 'savingsAccessible', 'savingsRestricted', 'liability'])
const SAVINGS_KINDS = new Set(['savingsAccessible', 'savingsRestricted'])
const UNCATEGORIZED_ID = 'uncategorized'
const CATEGORY_PATTERNS = ['solid', 'category-dots', 'category-horizontal', 'category-grid']
const CATEGORY_PATTERN_VARIANTS = ['outline', 'offset', 'inverse', 'dense', 'sparse', 'cross', 'wave', 'dash']

const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== '').map(String))].sort()
const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(8)) : value)
const amountOf = (entry) => (Number.isFinite(entry?.value) ? Math.abs(entry.value) : null)
const transactionIdOf = (entry) => (entry?.transactionId === null || entry?.transactionId === undefined ? null : String(entry.transactionId))
const projectedIdOf = (entry) => String(entry?.id ?? entry?.candidateId ?? entry?.sourceId ?? '')
const monthOfProjected = (entry) => String(entry?.date ?? '').match(/^\d{4}-\d{2}/)?.[0] ?? null
const categoryOf = (entry) => String(entry?.categoryId ?? UNCATEGORIZED_ID)
const normalizedMode = (mode) => (MODES.includes(mode) ? mode : 'spending')
const normalizedSavingsView = (view) => (SAVINGS_VIEWS.includes(view) ? view : 'combined')
const normalizedDetailLevel = (value) => (DETAIL_LEVELS.includes(value) ? value : 5)

const areaPath = ({ segment, xAt, yAt, isolatedWidth }) => {
  if (segment.length === 1) {
    const [{ index, point }] = segment
    const halfWidth = isolatedWidth / 2
    return `M ${xAt(index) - halfWidth} ${yAt(point.top)} L ${xAt(index) + halfWidth} ${yAt(point.top)} L ${xAt(index) + halfWidth} ${yAt(point.bottom)} L ${xAt(index) - halfWidth} ${yAt(point.bottom)} Z`
  }
  const top = segment.map(({ index, point }, offset) => `${offset === 0 ? 'M' : 'L'} ${xAt(index)} ${yAt(point.top)}`).join(' ')
  const bottom = [...segment]
    .reverse()
    .map(({ index, point }) => `L ${xAt(index)} ${yAt(point.bottom)}`)
    .join(' ')
  return `${top} ${bottom} Z`
}

export function buildCombinationAreaGeometry({ points = [], xValues = [], xAt, yAt, predicate = () => true, isolatedWidth = 12 }) {
  const pointByX = new Map(points.map((point) => [point.x, point]))
  const valid = (point) => Boolean(point && predicate(point) && Number.isFinite(point.top) && Number.isFinite(point.bottom))
  const paths = []
  let actualSegment = []
  const flushActual = () => {
    if (actualSegment.length === 0) return
    paths.push({ d: areaPath({ segment: actualSegment, xAt, yAt, isolatedWidth }), forecast: false })
    actualSegment = []
  }

  xValues.forEach((key, index) => {
    const point = pointByX.get(key)
    if (!valid(point) || point.kind === 'forecast') return flushActual()
    actualSegment.push({ index, point })
  })
  flushActual()

  xValues.forEach((key, index) => {
    const point = pointByX.get(key)
    if (!valid(point) || point.kind !== 'forecast') return
    const previous = pointByX.get(xValues[index - 1])
    const segment =
      valid(previous) && previous.kind !== 'forecast'
        ? [
            { index: index - 1, point: previous },
            { index, point },
          ]
        : [{ index, point }]
    paths.push({ d: areaPath({ segment, xAt, yAt, isolatedWidth }), forecast: true })
  })
  return paths
}

export function interpolateCombinationArea({ points = [], xValues = [], position }) {
  if (!Number.isFinite(position) || xValues.length === 0) return null
  const pointByX = new Map(points.map((point) => [point.x, point]))
  const clamped = Math.min(xValues.length - 1, Math.max(0, position))
  const leftIndex = Math.floor(clamped)
  const rightIndex = Math.ceil(clamped)
  const leftPoint = pointByX.get(xValues[leftIndex])
  const rightPoint = pointByX.get(xValues[rightIndex])
  const valid = (point) => Number.isFinite(point?.bottom) && Number.isFinite(point?.top)
  if (!valid(leftPoint) || !valid(rightPoint)) return null
  if (leftIndex === rightIndex) return { bottom: leftPoint.bottom, top: leftPoint.top, point: leftPoint, leftPoint, rightPoint }
  const ratio = clamped - leftIndex
  return {
    bottom: leftPoint.bottom + (rightPoint.bottom - leftPoint.bottom) * ratio,
    top: leftPoint.top + (rightPoint.top - leftPoint.top) * ratio,
    point: null,
    leftPoint,
    rightPoint,
  }
}

export function resolveCombinationChartTarget({ clientPoint, bounds, viewBox, padding, xValues = [], areas = [], yAt, pointerType = 'mouse' }) {
  if (!clientPoint || !bounds?.width || !bounds?.height || !viewBox?.width || !viewBox?.height || xValues.length === 0 || typeof yAt !== 'function') return null
  const svgX = ((clientPoint.x - bounds.left) / bounds.width) * viewBox.width
  const svgY = ((clientPoint.y - bounds.top) / bounds.height) * viewBox.height
  const innerWidth = viewBox.width - padding.left - padding.right
  if (
    !Number.isFinite(svgX) ||
    !Number.isFinite(svgY) ||
    !Number.isFinite(innerWidth) ||
    innerWidth <= 0 ||
    svgX < padding.left ||
    svgX > viewBox.width - padding.right ||
    svgY < 0 ||
    svgY > viewBox.height
  )
    return null
  const position = xValues.length > 1 ? ((svgX - padding.left) / innerWidth) * (xValues.length - 1) : 0
  const guideIndex = Math.min(xValues.length - 1, Math.max(0, Math.round(position)))
  const guideSvgX = padding.left + (guideIndex / Math.max(1, xValues.length - 1)) * innerWidth
  const guideClientX = bounds.left + (guideSvgX / viewBox.width) * bounds.width
  if (Math.abs(clientPoint.x - guideClientX) <= (pointerType === 'touch' ? 22 : 10)) return { mode: 'month', seriesId: null, monthIndex: guideIndex }

  const monthIndex = Math.ceil(Math.min(xValues.length - 1, Math.max(0, position)))
  if (monthIndex <= 0) return null
  for (let areaIndex = areas.length - 1; areaIndex >= 0; areaIndex--) {
    const area = areas[areaIndex]
    const interpolated = interpolateCombinationArea({ points: area.points, xValues, position })
    if (!interpolated) continue
    const y1 = yAt(interpolated.bottom)
    const y2 = yAt(interpolated.top)
    if (svgY >= Math.min(y1, y2) && svgY <= Math.max(y1, y2)) return { mode: 'seriesMonth', seriesId: area.seriesId, monthIndex }
  }
  return null
}

const normalizeSelection = (selection = {}) => {
  const { mode, seriesId = null, monthIndex = -1 } = selection ?? {}
  const normalizedMode = ['month', 'series', 'seriesMonth'].includes(mode) ? mode : null
  return {
    mode: normalizedMode,
    seriesId: normalizedMode === 'month' ? null : normalizedMode && seriesId ? String(seriesId) : null,
    monthIndex: normalizedMode === 'series' ? -1 : Number.isInteger(monthIndex) ? monthIndex : -1,
  }
}
const selectionOrNull = (selection) => {
  const normalized = normalizeSelection(selection)
  return normalized.mode ? normalized : null
}
const emptyInteraction = (effect = null) => ({ previewSelection: null, pinnedSelection: null, isDragging: false, pointerStart: null, effect })
const interactionState = (state) => ({
  ...emptyInteraction(),
  ...state,
  previewSelection: selectionOrNull(state?.previewSelection),
  pinnedSelection: selectionOrNull(state?.pinnedSelection),
  effect: null,
})
const clearedInteraction = () => emptyInteraction({ type: 'clear' })
const sameSelection = (left, right) => left?.mode === right?.mode && left?.seriesId === right?.seriesId && left?.monthIndex === right?.monthIndex
const selectionForEvent = (event) => selectionOrNull(event?.target ?? (Number.isInteger(event?.index) ? { mode: 'month', monthIndex: event.index } : null))
const repairSelection = (selection, pointCount) => {
  if (!selection || selection.mode === 'series') return selection
  if (pointCount <= 0) return null
  return { ...selection, monthIndex: Math.min(pointCount - 1, Math.max(0, selection.monthIndex)) }
}
const hasLegacyInteractionFields = (state) => ['selectedIndex', 'mode', 'selectedSeriesId', 'isPinned', 'isKeyboardSelection'].some((key) => Object.hasOwn(state ?? {}, key))

export const displayCombinationSelection = (state) => state?.previewSelection ?? state?.pinnedSelection ?? normalizeSelection()

const withLegacyInteractionFields = (state, legacy, isKeyboardSelection = state.isKeyboardSelection ?? false, legacySelection = displayCombinationSelection(state)) => {
  if (!legacy) return state
  const selected = ['month', 'seriesMonth'].includes(legacySelection.mode)
  return {
    ...state,
    selectedIndex: selected ? legacySelection.monthIndex : -1,
    mode: legacySelection.mode === 'seriesMonth' ? 'area' : legacySelection.mode === 'month' ? 'month' : null,
    selectedSeriesId: legacySelection.mode === 'seriesMonth' || legacySelection.mode === 'series' ? legacySelection.seriesId : null,
    isPinned: Boolean(state.pinnedSelection && sameSelection(legacySelection, state.pinnedSelection)),
    isKeyboardSelection,
  }
}

export function buildCombinationSelectedSegment({ points = [], xValues = [], monthIndex, xAt, yAt }) {
  if (!Number.isInteger(monthIndex) || monthIndex <= 0 || typeof xAt !== 'function' || typeof yAt !== 'function') return null
  const pointByX = new Map(points.map((point) => [point.x, point]))
  const previous = pointByX.get(xValues[monthIndex - 1])
  const current = pointByX.get(xValues[monthIndex])
  if (![previous, current].every((point) => Number.isFinite(point?.top) && Number.isFinite(point?.bottom))) return null
  return {
    d: areaPath({
      segment: [
        { index: monthIndex - 1, point: previous },
        { index: monthIndex, point: current },
      ],
      xAt,
      yAt,
      isolatedWidth: 0,
    }),
    monthIndex,
  }
}

export const buildCombinationMonthBand = ({ monthIndex, xAt }) =>
  monthIndex <= 0 || typeof xAt !== 'function' ? null : { x: xAt(monthIndex - 1), width: xAt(monthIndex) - xAt(monthIndex - 1), monthIndex }

export function reduceCombinationChartInteraction(state, event) {
  const current = interactionState(state)
  const legacy = hasLegacyInteractionFields(state)
  const finish = (next, isKeyboardSelection = next.isKeyboardSelection ?? false, legacySelection) => withLegacyInteractionFields(next, legacy, isKeyboardSelection, legacySelection)
  const hasPointCount = Number.isFinite(Number(event?.pointCount))
  const pointCount = Number(event?.pointCount) || 0
  const target = selectionForEvent(event)
  if (event?.type === 'clear' || event?.type === 'outside' || event?.type === 'pointerCancel') return finish(clearedInteraction(), false)
  if (event?.type === 'pointCountChanged') {
    if (pointCount === 0) return finish(emptyInteraction(), false)
    return finish({ ...current, previewSelection: repairSelection(current.previewSelection, pointCount), pinnedSelection: repairSelection(current.pinnedSelection, pointCount) })
  }
  if (event?.type === 'legendPreview' && event.seriesId) return finish({ ...current, previewSelection: normalizeSelection({ mode: 'series', seriesId: event.seriesId }) }, false)
  if (event?.type === 'legendLeave') return finish({ ...current, previewSelection: null }, false)
  if (event?.type === 'legendToggle' && event.seriesId) {
    const selection = normalizeSelection({ mode: 'series', seriesId: event.seriesId })
    return finish(sameSelection(current.pinnedSelection, selection) ? clearedInteraction() : { ...current, previewSelection: null, pinnedSelection: selection, effect: { type: 'select' } }, false)
  }
  if (event?.type === 'pointerMove') return finish({ ...current, previewSelection: target }, false, legacy && current.pinnedSelection && !current.isDragging ? current.pinnedSelection : undefined)
  if (event?.type === 'pointerLeave') return finish(current.isDragging ? current : { ...current, previewSelection: null }, current.isDragging ? current.isKeyboardSelection : false)
  if (event?.type === 'pointerDown') {
    if (!target) return finish(current, false)
    return finish({ ...current, previewSelection: target, isDragging: true, pointerStart: target }, false)
  }
  if (event?.type === 'pointerUp') {
    if (hasPointCount && pointCount === 0) return finish(emptyInteraction(), false)
    if (!current.isDragging) return finish(current, false)
    const selection = target ?? current.previewSelection ?? current.pointerStart
    if (!selection) return finish({ ...current, isDragging: false, pointerStart: null }, false)
    if (sameSelection(current.pinnedSelection, selection) && sameSelection(current.pointerStart, selection)) return finish(clearedInteraction(), false)
    return finish({ ...current, previewSelection: null, pinnedSelection: selection, isDragging: false, pointerStart: null, effect: { type: 'select' } }, false)
  }
  if (event?.type === 'key') {
    if (event.key === 'Escape') return finish(clearedInteraction(), false)
    if (pointCount === 0) return finish(current)
    if (event.key === 'Enter') {
      const selection = selectionOrNull(displayCombinationSelection(current)) ?? normalizeSelection({ mode: 'month', monthIndex: 0 })
      return finish({ ...current, previewSelection: null, pinnedSelection: repairSelection(selection, pointCount), effect: { type: 'select' } }, true)
    }
    const currentSelection = selectionOrNull(displayCombinationSelection(current))
    const hasMonthSelection = currentSelection?.mode === 'seriesMonth' || currentSelection?.mode === 'month'
    let monthIndex = hasMonthSelection ? currentSelection.monthIndex : 0
    if (event.key === 'ArrowLeft') monthIndex--
    else if (event.key === 'ArrowRight') monthIndex++
    else if (event.key === 'Home') monthIndex = 0
    else if (event.key === 'End') monthIndex = pointCount - 1
    else return finish(current)
    if (!hasMonthSelection && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) monthIndex = 0
    return finish({ ...current, previewSelection: normalizeSelection({ mode: 'month', monthIndex: Math.min(pointCount - 1, Math.max(0, monthIndex)) }), effect: { type: 'select' } }, true)
  }
  if (event?.type === 'rowSelect') return finish({ ...current, effect: { type: 'selectRow', item: event.item, activation: event.activation } })
  return finish(current)
}

export function propagateCashUseReconciliation({ totals, gap, reconciliation }) {
  const statusByMonth = new Map(reconciliation.map((item) => [item.monthKey, item]))
  const blocked = (x) => ['unavailable', 'mismatch'].includes(statusByMonth.get(x)?.status)
  const nextTotals = {
    ...totals,
    points: totals.points.map((point) => (blocked(point.x) ? { ...point, uses: null, sources: null, gap: null, status: 'unavailable', delta: statusByMonth.get(point.x)?.delta ?? null } : point)),
  }
  const nextGap = {
    ...gap,
    points: gap.points.map((point) => (blocked(point.x) ? { ...point, value: null, bottom: null, top: null, direction: 'unavailable', status: 'unavailable' } : point)),
  }
  const statuses = reconciliation.map(({ status }) => status)
  const auditStatus = statuses.includes('mismatch') ? 'mismatch' : statuses.includes('unavailable') ? 'unavailable' : statuses.includes('partial') ? 'partial' : 'ok'
  return { totals: nextTotals, gap: nextGap, auditStatus }
}

export function buildCashUseVisualStyles({ series, categoryColors, sourceColors, semanticColors }) {
  const styles = {}
  const expenseLayers = series.useLayers.filter(({ kind }) => ['expenseCategory', 'otherExpense'].includes(kind))
  expenseLayers.forEach((layer, index) => {
    const isOther = layer.kind === 'otherExpense'
    const primaryTupleCount = categoryColors.length * CATEGORY_PATTERNS.length
    const patternIndex = Math.floor(index / categoryColors.length)
    const overflowTier = Math.floor(index / primaryTupleCount) - 1
    const color = categoryColors[index % categoryColors.length]
    styles[layer.id] = {
      color: isOther ? semanticColors.transfer : color,
      pattern: isOther ? 'category-dots' : CATEGORY_PATTERNS[patternIndex % CATEGORY_PATTERNS.length],
      ...(isOther ? {} : { patternVariant: overflowTier < 0 ? 'primary' : CATEGORY_PATTERN_VARIANTS[overflowTier % CATEGORY_PATTERN_VARIANTS.length], legendOrdinal: index + 1 }),
      markerKind: 'area',
    }
  })

  for (const layer of series.useLayers.filter(({ kind }) => !['expenseCategory', 'otherExpense'].includes(kind))) {
    const savings = layer.kind.toLowerCase().includes('savings')
    styles[layer.id] = {
      color: savings ? sourceColors[layer.kind.includes('Restricted') ? 1 : 0] : semanticColors.expense,
      pattern: savings ? layer.pattern : 'debt',
      markerKind: 'area',
    }
  }

  for (const [index, band] of series.sourceBands.entries()) {
    styles[band.id] = {
      color: band.kind === 'refunds' || band.kind === 'newDebt' ? semanticColors.expense : sourceColors[index % sourceColors.length],
      pattern: band.pattern,
      markerKind: 'area',
    }
  }

  styles['refund-coverage'] = { color: semanticColors.expense, pattern: 'refund', markerKind: 'area' }
  styles['ordinary-income'] = { color: semanticColors.income, pattern: 'line', markerKind: 'line' }
  styles['gap-positive'] = { color: semanticColors.income, pattern: 'gap-positive', markerKind: 'area' }
  styles['gap-negative'] = { color: semanticColors.expense, pattern: 'gap-negative', markerKind: 'area' }
  styles['total-sources'] = { color: semanticColors.neutral, pattern: 'dotted-line', markerKind: 'line' }
  return styles
}

const emptyBucket = () => ({ value: 0, transactionIds: [], unavailableTransactionIds: [] })
const emptyMonth = () => ({
  categories: new Map(),
  income: emptyBucket(),
  refunds: emptyBucket(),
  savings: { combined: emptyBucket(), accessible: emptyBucket(), restricted: emptyBucket() },
  debtRepaid: emptyBucket(),
  newDebt: emptyBucket(),
})
const ensureCategory = (month, categoryId) => {
  if (!month.categories.has(categoryId))
    month.categories.set(categoryId, { ...emptyBucket(), coverage: { refunded: 0, refundTransactionIds: [], purchaseTransactionIds: [], unavailableTransactionIds: [] } })
  return month.categories.get(categoryId)
}
const addId = (bucket, id, key = 'transactionIds') => {
  if (id) bucket[key] = unique([...bucket[key], id])
}
const addActual = (bucket, entry, signedAmount) => {
  const id = transactionIdOf(entry)
  if (!Number.isFinite(signedAmount)) {
    addId(bucket, id, 'unavailableTransactionIds')
    return
  }
  bucket.value = round(bucket.value + signedAmount)
  if (signedAmount !== 0) addId(bucket, id)
}

const isRefund = (entry) => entry?.refund?.isRefund === true && entry?.sourceKind === 'expense' && MONEY_KINDS.has(entry?.destinationKind)
const isIncome = (entry) => !isRefund(entry) && entry?.sourceKind === 'revenue' && MONEY_KINDS.has(entry?.destinationKind)

const actualMonths = (ledger) => {
  const result = new Map()
  const month = (key) => {
    if (!result.has(key)) result.set(key, emptyMonth())
    return result.get(key)
  }

  for (const entry of ledger?.entries ?? []) {
    const monthKey = entry?.monthKey
    if (!monthKey) continue
    const current = month(monthKey)
    const amount = amountOf(entry)

    if (entry?.destinationKind === 'expense') {
      if (MONEY_KINDS.has(entry?.sourceKind)) addActual(ensureCategory(current, categoryOf(entry)), entry, amount)
      else if (entry?.sourceKind === 'unknown' || !entry?.sourceKind) addActual(ensureCategory(current, categoryOf(entry)), entry, null)
    }
    if (isIncome(entry)) addActual(current.income, entry, amount)
    if (isRefund(entry)) addActual(current.refunds, entry, amount)

    const sourceSavings = SAVINGS_KINDS.has(entry?.sourceKind)
    const destinationSavings = SAVINGS_KINDS.has(entry?.destinationKind)
    if (sourceSavings !== destinationSavings) addActual(current.savings.combined, entry, amount === null ? null : destinationSavings ? amount : -amount)
    for (const [id, kind] of [
      ['accessible', 'savingsAccessible'],
      ['restricted', 'savingsRestricted'],
    ]) {
      const delta = (entry?.destinationKind === kind ? 1 : 0) - (entry?.sourceKind === kind ? 1 : 0)
      if (delta !== 0) addActual(current.savings[id], entry, amount === null ? null : delta * amount)
    }

    const sourceLiability = entry?.sourceKind === 'liability'
    const destinationLiability = entry?.destinationKind === 'liability'
    if (!sourceLiability && destinationLiability) addActual(current.debtRepaid, entry, amount)
    if (sourceLiability && !destinationLiability) addActual(current.newDebt, entry, amount)

    if (entry?.refund?.isRefund === true) {
      const coverageMonthKey = entry.refund.coverageMonthKey ?? monthKey
      const coverageCategoryId = String(entry.refund.coverageCategoryId ?? entry.categoryId ?? UNCATEGORIZED_ID)
      const category = ensureCategory(month(coverageMonthKey), coverageCategoryId)
      const coverageAmount = Number.isFinite(entry.refund.coverageValue) ? Math.abs(entry.refund.coverageValue) : amount
      const refundId = transactionIdOf(entry)
      if (Number.isFinite(coverageAmount)) {
        category.coverage.refunded = round(category.coverage.refunded + coverageAmount)
        addId(category.coverage, refundId, 'refundTransactionIds')
        addId(category.coverage, entry.refund.linkedPurchaseTransactionId, 'purchaseTransactionIds')
      } else addId(category.coverage, refundId, 'unavailableTransactionIds')
    }
  }
  return result
}

const projectedEntries = (remainingActivity, currentMonthKey) => (remainingActivity?.dailyProjectedEntries ?? []).filter((entry) => monthOfProjected(entry) === currentMonthKey && projectedIdOf(entry))

const projectedFlowValue = (entry, key) => {
  const value = entry?.flowAmounts?.[key]
  if (value === null || value === undefined) return 0
  return Number.isFinite(value) ? Math.abs(value) : null
}

const projectedFor = (entries, predicate, key) => {
  const sources = entries.filter((entry) => predicate(entry) && projectedFlowValue(entry, key) !== 0)
  const unavailable = sources.some((entry) => !Number.isFinite(projectedFlowValue(entry, key)))
  return {
    value: unavailable ? null : round(sources.reduce((total, entry) => total + projectedFlowValue(entry, key), 0)),
    sources: sources.map((entry) => structuredClone(entry)),
  }
}

const projectedSavingsFor = (entries, viewId) => {
  const expectedKind = viewId === 'accessible' ? 'savingsAccessible' : viewId === 'restricted' ? 'savingsRestricted' : null
  const relevant = []
  let value = 0
  let unavailable = false
  for (const entry of entries) {
    const deposits = projectedFlowValue(entry, 'savingsDeposits')
    const withdrawals = projectedFlowValue(entry, 'savingsWithdrawals')
    if (deposits === 0 && withdrawals === 0) continue
    if (!Number.isFinite(deposits) || !Number.isFinite(withdrawals)) unavailable = true
    const destinationKind = entry.destinationKind ?? entry.destinationAccountKind ?? entry.context?.destinationKind
    const sourceKind = entry.sourceKindNormalized ?? entry.sourceAccountKind ?? entry.context?.sourceKind
    const includedDeposit = !expectedKind || destinationKind === expectedKind
    const includedWithdrawal = !expectedKind || sourceKind === expectedKind
    if (expectedKind && ((deposits > 0 && !destinationKind) || (withdrawals > 0 && !sourceKind))) unavailable = true
    const delta = (includedDeposit && Number.isFinite(deposits) ? deposits : 0) - (includedWithdrawal && Number.isFinite(withdrawals) ? withdrawals : 0)
    if (delta !== 0 || unavailable) {
      value = round(value + delta)
      relevant.push(structuredClone(entry))
    }
  }
  return { value: unavailable ? null : value, sources: relevant }
}

const categoryRankingItems = ({ months, completedMonthKeys, currentMonthKey, projected }) => {
  const ids = new Set()
  for (const key of completedMonthKeys) for (const id of months.get(key)?.categories.keys() ?? []) ids.add(id)
  for (const id of months.get(currentMonthKey)?.categories.keys() ?? []) ids.add(id)
  for (const entry of projected) if (projectedFlowValue(entry, 'expenses') !== 0) ids.add(categoryOf(entry))
  const amountFor = (id) => {
    const buckets = completedMonthKeys.map((key) => months.get(key)?.categories.get(id)).filter(Boolean)
    if (buckets.some((bucket) => bucket.unavailableTransactionIds.length > 0)) return null
    return completedMonthKeys.reduce((total, key) => {
      const bucket = months.get(key)?.categories.get(id)
      return total + (Number.isFinite(bucket?.value) ? bucket.value : 0)
    }, 0)
  }
  return [...ids]
    .map((id) => ({ id, amount: amountFor(id) }))
    .sort((left, right) => Number.isFinite(right.amount) - Number.isFinite(left.amount) || (Number.isFinite(left.amount) ? right.amount - left.amount : 0) || left.id.localeCompare(right.id))
}

const categoriesForDetail = ({ ranking, detailLevel }) => (detailLevel === 'all' ? ranking : ranking.slice(0, detailLevel))

const aggregateCategories = (month, ids) => {
  const buckets = ids.map((id) => month?.categories.get(id)).filter(Boolean)
  const unavailable = unique(buckets.flatMap((bucket) => bucket.unavailableTransactionIds))
  const refundUnavailable = unique(buckets.flatMap((bucket) => bucket.coverage.unavailableTransactionIds))
  const gross = unavailable.length ? null : round(buckets.reduce((total, bucket) => total + bucket.value, 0))
  const refunded = round(buckets.reduce((total, bucket) => total + bucket.coverage.refunded, 0))
  return {
    value: gross,
    transactionIds: unique(buckets.flatMap((bucket) => bucket.transactionIds)),
    unavailableTransactionIds: unavailable,
    coverage: {
      gross,
      refunded,
      netCost: gross === null || refundUnavailable.length ? null : round(gross - refunded),
      status: refundUnavailable.length ? 'unavailable' : refunded ? 'ready' : 'none',
      refundTransactionIds: unique(buckets.flatMap((bucket) => bucket.coverage.refundTransactionIds)),
      purchaseTransactionIds: unique(buckets.flatMap((bucket) => bucket.coverage.purchaseTransactionIds)),
      unavailableTransactionIds: refundUnavailable,
    },
  }
}

const categoryProjected = (entries, categoryIds) => projectedFor(entries, (entry) => categoryIds.includes(categoryOf(entry)), 'expenses')

const forecastProjection = ({ projection, remainingActivity, metricIds, progressMetric = metricIds[0] }) => {
  const statusByMetric = remainingActivity?.statusByMetric ?? {}
  const hasMetricContract = Object.keys(statusByMetric).length > 0
  const statuses = metricIds.map((metric) => statusByMetric[metric] ?? (hasMetricContract ? 'partial' : (remainingActivity?.status ?? 'ready')))
  const status = statuses.includes('unavailable') ? 'unavailable' : statuses.includes('insufficientHistory') ? 'insufficientHistory' : statuses.includes('partial') ? 'partial' : 'ready'
  const hasEvidence = (projection.sources?.length ?? 0) > 0
  const blocked = status === 'unavailable' || status === 'insufficientHistory' || (status === 'partial' && !hasEvidence)
  return {
    ...projection,
    value: blocked ? null : projection.value,
    status,
    metricIds,
    progress: blocked || !Number.isFinite(remainingActivity?.progress?.[progressMetric]) ? null : remainingActivity.progress[progressMetric],
    progressState:
      status === 'insufficientHistory'
        ? 'insufficientHistory'
        : status === 'unavailable'
          ? 'unavailable'
          : (remainingActivity?.progressState?.[progressMetric] ?? (projection.value === 0 ? 'noExpectedActivity' : 'ready')),
  }
}

const buildLayerPoint = ({ x, kind, actual, projected = { value: 0, sources: [] }, coverage = null }) => {
  const actualValue = actual?.value ?? 0
  const projectedValue = projected.value ?? 0
  const unavailable = actualValue === null || projected.value === null || (actual?.unavailableTransactionIds?.length ?? 0) > 0
  const value = unavailable ? null : round(actualValue + projectedValue)
  const point = {
    x,
    kind,
    value,
    actualValue: actualValue === null ? null : actualValue,
    projectedValue: projected.value === null ? null : projectedValue,
    bottom: null,
    top: null,
    transactionIds: unique(actual?.transactionIds ?? []),
    projectedSources: projected.sources ?? [],
    ...(coverage ? { refundCoverage: coverage } : {}),
  }
  if (kind === 'forecast')
    Object.assign(point, { status: projected.status ?? 'ready', progress: projected.progress ?? null, progressState: projected.progressState ?? 'notApplicable', metricIds: projected.metricIds ?? [] })
  return point
}

const cumulative = (layers, monthKeys, startFor = () => 0) => {
  for (const x of monthKeys) {
    let total = startFor(x)
    for (const layer of layers) {
      const point = layer.points.find((item) => item.x === x)
      if (!point) continue
      if (!Number.isFinite(total) || !Number.isFinite(point.value)) {
        point.bottom = null
        point.top = null
        total = null
      } else {
        point.bottom = total
        point.top = round(total + point.value)
        total = point.top
      }
    }
  }
}

const bucketForSavingsUse = (bucket) => ({ ...bucket, value: Number.isFinite(bucket?.value) ? Math.max(0, bucket.value) : null, transactionIds: bucket?.value > 0 ? bucket.transactionIds : [] })
const bucketForSavingsSource = (bucket) => ({ ...bucket, value: Number.isFinite(bucket?.value) ? Math.max(0, -bucket.value) : null, transactionIds: bucket?.value < 0 ? bucket.transactionIds : [] })
const projectedSavingsUse = (projection) => ({
  ...projection,
  value: Number.isFinite(projection.value) ? Math.max(0, projection.value) : null,
  sources: projection.value > 0 ? projection.sources : [],
})
const projectedSavingsSource = (projection) => ({
  ...projection,
  value: Number.isFinite(projection.value) ? Math.max(0, -projection.value) : null,
  sources: projection.value < 0 ? projection.sources : [],
})

const uniqueProjectedSources = (sources) => {
  const seen = new Set()
  return sources.filter((source) => {
    const id = projectedIdOf(source)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

const aggregateForecastStatus = (points) => {
  const statuses = points.map(({ status }) => status).filter(Boolean)
  if (statuses.includes('unavailable')) return 'unavailable'
  if (statuses.includes('insufficientHistory')) return 'insufficientHistory'
  if (statuses.includes('partial')) return 'partial'
  return 'ready'
}

const aggregateForecastProgress = ({ actualValue, projectedValue, value, status }) => {
  if (status === 'unavailable' || status === 'insufficientHistory') return { progress: null, progressState: status }
  if (![actualValue, projectedValue, value].every(Number.isFinite)) return { progress: null, progressState: status === 'partial' ? 'partial' : 'unavailable' }
  if (actualValue === 0 && projectedValue === 0) return { progress: null, progressState: 'noExpectedActivity' }
  if ((actualValue < 0 && value > 0) || (actualValue > 0 && value < 0) || (actualValue !== 0 && value === 0)) return { progress: null, progressState: 'oppositeDirection' }
  return { progress: value === 0 ? null : round(Math.min(1, Math.abs(actualValue / value))), progressState: 'ready' }
}

const aggregateSummaryPoint = ({ x, kind, components }) => {
  const points = components.map(({ point }) => point).filter(Boolean)
  const status = kind === 'forecast' ? aggregateForecastStatus(points) : 'ok'
  const totalFor = (key) => {
    if (components.some(({ point }) => !Number.isFinite(point?.[key]))) return null
    return round(components.reduce((total, { point, factor = 1 }) => total + point[key] * factor, 0))
  }
  const actualValue = totalFor('actualValue')
  const projectedValue = totalFor('projectedValue')
  const value = totalFor('value')
  const transactionIds = unique(points.flatMap((point) => point.transactionIds ?? []))
  const projectedSources = uniqueProjectedSources(points.flatMap((point) => point.projectedSources ?? []))
  const metricIds = unique(points.flatMap((point) => point.metricIds ?? []))
  return {
    x,
    kind,
    value,
    actualValue,
    projectedValue,
    transactionIds,
    projectedSources,
    ...(kind === 'forecast' ? { status, ...aggregateForecastProgress({ actualValue, projectedValue, value, status }), metricIds } : {}),
  }
}

export function buildCashUseSeries({ ledger, remainingActivity = {}, months = [], mode, savingsView, detailLevel = 5 }) {
  const selectedMode = normalizedMode(mode)
  const selectedSavingsView = normalizedSavingsView(savingsView)
  const selectedDetailLevel = normalizedDetailLevel(detailLevel)
  const completedMonthKeys = unique(months).sort()
  const currentMonthKey =
    remainingActivity.currentMonthKey ??
    (remainingActivity.dailyProjectedEntries ?? []).map(monthOfProjected).filter(Boolean).sort().at(-1) ??
    (ledger?.entries ?? [])
      .map(({ monthKey }) => monthKey)
      .filter(Boolean)
      .sort()
      .at(-1)
  const forecastX = currentMonthKey ? `${currentMonthKey}:forecast` : null
  const monthKeys = [...completedMonthKeys, ...(forecastX ? [forecastX] : [])]
  const actual = actualMonths(ledger)
  const future = currentMonthKey ? projectedEntries(remainingActivity, currentMonthKey) : []
  const auditUnavailableForecastMetrics = new Set(remainingActivity?.audit?.unavailable?.affectedMetricIds ?? [])
  const authoritativeRemainingActivity = {
    ...remainingActivity,
    statusByMetric: {
      ...(remainingActivity?.statusByMetric ?? {}),
      ...Object.fromEntries([...auditUnavailableForecastMetrics].map((metric) => [metric, 'unavailable'])),
    },
  }
  const projectedWithStatus = (projection, metricIds, progressMetric = metricIds[0]) => forecastProjection({ projection, remainingActivity: authoritativeRemainingActivity, metricIds, progressMetric })
  const rankingItems = categoryRankingItems({ months: actual, completedMonthKeys, currentMonthKey, projected: future })
  const ranking = rankingItems.map(({ id }) => id)
  const visibleCategoryIds = categoriesForDetail({ ranking, detailLevel: selectedDetailLevel })
  const hiddenCategoryIds = ranking.filter((id) => !visibleCategoryIds.includes(id))

  const categoryGroups = visibleCategoryIds.map((id) => ({ id: `category:${id}`, kind: 'expenseCategory', categoryIds: [id], categoryId: id, pattern: 'solid' }))
  if (hiddenCategoryIds.length > 0) categoryGroups.push({ id: 'category:other', kind: 'otherExpense', categoryIds: hiddenCategoryIds, labelKey: 'analytics.flow.other', pattern: 'solid' })

  const useLayers = categoryGroups.map((group) => ({
    ...group,
    points: monthKeys.map((x) => {
      const isForecast = x === forecastX
      const key = isForecast ? currentMonthKey : x
      const actualCategory = aggregateCategories(actual.get(key), group.categoryIds)
      const expenseProjection = isForecast ? projectedWithStatus(categoryProjected(future, group.categoryIds), ['expenses']) : undefined
      const refundProjection = isForecast
        ? projectedWithStatus(
            projectedFor(future, (entry) => group.categoryIds.includes(categoryOf(entry)), 'refunds'),
            ['refunds'],
          )
        : null
      const coverage = isForecast
        ? {
            ...actualCategory.coverage,
            projectedValue: refundProjection.value,
            projectedStatus: refundProjection.status,
            projectedSources: refundProjection.sources,
            totalRefunded: Number.isFinite(refundProjection.value) ? round(actualCategory.coverage.refunded + refundProjection.value) : null,
          }
        : actualCategory.coverage
      return buildLayerPoint({
        x,
        kind: isForecast ? 'forecast' : 'actual',
        actual: actualCategory,
        projected: expenseProjection,
        coverage,
      })
    }),
  }))

  const savingsGroups = selectedSavingsView === 'split' ? ['accessible', 'restricted'] : ['combined']
  if (selectedMode === 'full') {
    useLayers.push({
      id: 'debt:repaid',
      kind: 'debtRepaid',
      labelKey: 'analytics.cash_use.debt_repaid',
      pattern: 'debt',
      points: monthKeys.map((x) => {
        const isForecast = x === forecastX
        const key = isForecast ? currentMonthKey : x
        return buildLayerPoint({
          x,
          kind: isForecast ? 'forecast' : 'actual',
          actual: actual.get(key)?.debtRepaid ?? emptyBucket(),
          projected: isForecast
            ? projectedWithStatus(
                projectedFor(future, () => true, 'debtRepayments'),
                ['debtRepayments'],
              )
            : undefined,
        })
      }),
    })
    for (const id of savingsGroups) {
      const savingsProjection = projectedSavingsFor(future, id)
      const projection = projectedWithStatus(savingsProjection, ['savingsDeposits', 'savingsWithdrawals'], savingsProjection.value < 0 ? 'savingsWithdrawals' : 'savingsDeposits')
      useLayers.push({
        id: `savings:${id}`,
        kind: id === 'combined' ? 'savingsDeposit' : id === 'accessible' ? 'savingsAccessibleDeposit' : 'savingsRestrictedDeposit',
        labelKey: `analytics.cash_use.savings_${id}`,
        pattern: id === 'restricted' ? 'restricted-savings' : 'accessible-savings',
        points: monthKeys.map((x) => {
          const isForecast = x === forecastX
          const key = isForecast ? currentMonthKey : x
          return buildLayerPoint({
            x,
            kind: isForecast ? 'forecast' : 'actual',
            actual: bucketForSavingsUse(actual.get(key)?.savings[id] ?? emptyBucket()),
            projected: isForecast ? projectedSavingsUse(projection) : undefined,
          })
        }),
      })
    }
  }

  const ordinaryIncome = {
    id: 'ordinary-income',
    kind: 'ordinaryIncome',
    labelKey: 'analytics.cash_use.ordinary_income',
    pattern: 'solid-line',
    points: monthKeys.map((x) => {
      const isForecast = x === forecastX
      const key = isForecast ? currentMonthKey : x
      const actualIncome = actual.get(key)?.income ?? emptyBucket()
      const projection = isForecast
        ? projectedWithStatus(
            projectedFor(future, () => true, 'income'),
            ['income'],
          )
        : undefined
      return buildLayerPoint({ x, kind: isForecast ? 'forecast' : 'actual', actual: actualIncome, projected: projection })
    }),
  }

  const sourceBands = [
    {
      id: 'refunds',
      kind: 'refunds',
      labelKey: 'analytics.cash_use.refunds',
      pattern: 'refund',
      actualBucket: (month) => month?.refunds ?? emptyBucket(),
      projected: () =>
        projectedWithStatus(
          projectedFor(future, () => true, 'refunds'),
          ['refunds'],
        ),
    },
  ]
  if (selectedMode === 'full') {
    for (const id of savingsGroups) {
      const savingsProjection = projectedSavingsFor(future, id)
      const projection = projectedWithStatus(savingsProjection, ['savingsDeposits', 'savingsWithdrawals'], savingsProjection.value < 0 ? 'savingsWithdrawals' : 'savingsDeposits')
      sourceBands.push({
        id: `savings-withdrawn:${id}`,
        kind: id === 'combined' ? 'savingsWithdrawn' : id === 'accessible' ? 'savingsAccessibleWithdrawn' : 'savingsRestrictedWithdrawn',
        labelKey: `analytics.cash_use.savings_withdrawn_${id}`,
        pattern: id === 'restricted' ? 'restricted-savings' : 'accessible-savings',
        actualBucket: (month) => bucketForSavingsSource(month?.savings[id] ?? emptyBucket()),
        projected: () => projectedSavingsSource(projection),
      })
    }
    sourceBands.push({
      id: 'new-debt',
      kind: 'newDebt',
      labelKey: 'analytics.cash_use.new_debt',
      pattern: 'debt',
      actualBucket: (month) => month?.newDebt ?? emptyBucket(),
      projected: () =>
        projectedWithStatus(
          projectedFor(future, () => true, 'newDebt'),
          ['newDebt'],
        ),
    })
  }
  const projectedSourceBands = sourceBands.map(({ actualBucket, projected, ...band }) => ({
    ...band,
    points: monthKeys.map((x) => {
      const isForecast = x === forecastX
      const key = isForecast ? currentMonthKey : x
      return buildLayerPoint({ x, kind: isForecast ? 'forecast' : 'actual', actual: actualBucket(actual.get(key)), projected: isForecast ? projected() : undefined })
    }),
  }))

  cumulative(useLayers, monthKeys)
  cumulative(projectedSourceBands, monthKeys, (x) => pointForX(ordinaryIncome.points, x)?.value ?? null)

  const expenseSummaryPoints = monthKeys.map((x) => {
    const isForecast = x === forecastX
    const key = isForecast ? currentMonthKey : x
    return buildLayerPoint({
      x,
      kind: isForecast ? 'forecast' : 'actual',
      actual: aggregateCategories(actual.get(key), ranking),
      projected: isForecast
        ? projectedWithStatus(
            projectedFor(future, () => true, 'expenses'),
            ['expenses'],
          )
        : undefined,
    })
  })
  const nonExpenseUseLayers = useLayers.filter(({ kind }) => !['expenseCategory', 'otherExpense'].includes(kind))
  const totalUses = {
    id: 'total-uses',
    kind: 'totalUses',
    labelKey: 'analytics.cash_use.total_uses',
    points: monthKeys.map((x) =>
      aggregateSummaryPoint({
        x,
        kind: x === forecastX ? 'forecast' : 'actual',
        components: [{ point: pointForX(expenseSummaryPoints, x) }, ...nonExpenseUseLayers.map((layer) => ({ point: pointForX(layer.points, x) }))],
      }),
    ),
  }
  const totalSources = {
    id: 'total-sources',
    kind: 'totalSources',
    labelKey: 'analytics.cash_use.total_sources',
    pattern: 'boundary-line',
    points: monthKeys.map((x) =>
      aggregateSummaryPoint({
        x,
        kind: x === forecastX ? 'forecast' : 'actual',
        components: [{ point: pointForX(ordinaryIncome.points, x) }, ...projectedSourceBands.map((layer) => ({ point: pointForX(layer.points, x) }))],
      }),
    ),
  }
  let totals = {
    id: 'totals',
    points: monthKeys.map((x) => {
      const usePoint = pointForX(totalUses.points, x)
      const sourcePoint = pointForX(totalSources.points, x)
      const unavailable = !Number.isFinite(usePoint?.value) || !Number.isFinite(sourcePoint?.value)
      const partial = [usePoint, sourcePoint].some((point) => point?.status === 'partial')
      const uses = unavailable ? null : usePoint.value
      const sources = unavailable ? null : sourcePoint.value
      return {
        x,
        kind: x === forecastX ? 'forecast' : 'actual',
        uses,
        sources,
        gap: unavailable ? null : round(sources - uses),
        status: unavailable ? 'unavailable' : partial ? 'partial' : 'ok',
        delta: unavailable ? null : 0,
      }
    }),
  }

  let gap = {
    id: 'gap',
    kind: 'gap',
    points: monthKeys.map((x) => {
      const total = pointForX(totals.points, x)
      const usePoint = pointForX(totalUses.points, x)
      const sourcePoint = pointForX(totalSources.points, x)
      const summary = aggregateSummaryPoint({
        x,
        kind: total.kind,
        components: [
          { point: sourcePoint, factor: 1 },
          { point: usePoint, factor: -1 },
        ],
      })
      const direction = total.gap === null ? 'unavailable' : total.gap >= 0 ? 'positive' : 'negative'
      const labelKey =
        selectedMode === 'spending' ? 'analytics.cash_use.after_spending' : direction === 'negative' ? 'analytics.cash_use.existing_available_funds_required' : 'analytics.cash_use.new_excess'
      return {
        x,
        kind: total.kind,
        value: total.gap,
        bottom: total.gap === null ? null : Math.min(total.uses, total.sources),
        top: total.gap === null ? null : Math.max(total.uses, total.sources),
        direction,
        labelKey,
        pattern: direction === 'negative' ? 'gap-negative' : direction === 'positive' ? 'gap-positive' : 'unavailable',
        transactionIds: unique([...(usePoint?.transactionIds ?? []), ...(sourcePoint?.transactionIds ?? [])]),
        projectedSources: uniqueProjectedSources([...(usePoint?.projectedSources ?? []), ...(sourcePoint?.projectedSources ?? [])]),
        ...(total.kind === 'forecast'
          ? {
              actualValue: summary.actualValue,
              projectedValue: summary.projectedValue,
              progress: summary.progress,
              progressState: summary.progressState,
              status: Number.isFinite(summary.value) ? summary.status : 'unavailable',
              metricIds: summary.metricIds,
            }
          : {}),
      }
    }),
  }

  const reconciliation = totals.points.map((point) => {
    const key = point.x === forecastX ? currentMonthKey : point.x
    const actualGross = aggregateCategories(actual.get(key), ranking).value
    const projectedGross =
      point.x === forecastX
        ? projectedWithStatus(
            projectedFor(future, () => true, 'expenses'),
            ['expenses'],
          ).value
        : 0
    const grossExpense = Number.isFinite(actualGross) && Number.isFinite(projectedGross) ? round(actualGross + projectedGross) : null
    const categoryTotal = Number.isFinite(point.uses)
      ? round(
          categoryGroups.reduce((total, group) => {
            const value = pointForX(useLayers.find(({ id }) => id === group.id).points, point.x)?.value
            return total + (Number.isFinite(value) ? value : 0)
          }, 0),
        )
      : null
    const usePoints = useLayers.map((layer) => pointForX(layer.points, point.x))
    const sourcePoints = [pointForX(ordinaryIncome.points, point.x), ...projectedSourceBands.map((layer) => pointForX(layer.points, point.x))]
    const useLayerTotal = usePoints.every((item) => Number.isFinite(item?.value)) ? round(usePoints.reduce((total, item) => total + item.value, 0)) : null
    const sourceComponentTotal = sourcePoints.every((item) => Number.isFinite(item?.value)) ? round(sourcePoints.reduce((total, item) => total + item.value, 0)) : null
    const gapPoint = pointForX(gap.points, point.x)
    const available = [grossExpense, categoryTotal, point.uses, useLayerTotal, point.sources, sourceComponentTotal, point.gap, gapPoint?.value].every(Number.isFinite)
    const categoryDelta = available ? round(categoryTotal - grossExpense) : null
    const useDelta = available ? round(useLayerTotal - point.uses) : null
    const sourceDelta = available ? round(sourceComponentTotal - point.sources) : null
    const gapDelta = available ? round(gapPoint.value - (point.sources - point.uses)) : null
    const delta = available ? round(categoryDelta + useDelta + sourceDelta + gapDelta) : null
    return {
      monthKey: point.x,
      status: !available ? 'unavailable' : point.status === 'partial' ? 'partial' : delta === 0 ? 'ok' : 'mismatch',
      grossExpense,
      categoryTotal,
      categoryDelta,
      totalUses: point.uses,
      useLayerTotal,
      useDelta,
      totalSources: point.sources,
      sourceComponentTotal,
      sourceDelta,
      gap: point.gap,
      gapDelta,
      delta,
    }
  })
  const propagated = propagateCashUseReconciliation({ totals, gap, reconciliation })
  totals = propagated.totals
  gap = propagated.gap
  const unavailable = completedMonthKeys.flatMap((monthKey) => {
    const ids = unique([
      ...[...(actual.get(monthKey)?.categories.values() ?? [])].flatMap((bucket) => bucket.unavailableTransactionIds),
      ...(actual.get(monthKey)?.income.unavailableTransactionIds ?? []),
      ...(actual.get(monthKey)?.refunds.unavailableTransactionIds ?? []),
      ...(selectedMode === 'full'
        ? [
            ...savingsGroups.flatMap((id) => actual.get(monthKey)?.savings[id].unavailableTransactionIds ?? []),
            ...(actual.get(monthKey)?.debtRepaid.unavailableTransactionIds ?? []),
            ...(actual.get(monthKey)?.newDebt.unavailableTransactionIds ?? []),
          ]
        : []),
    ])
    return ids.length ? [{ monthKey, transactionIds: ids }] : []
  })
  if (forecastX && pointForX(totals.points, forecastX)?.status === 'unavailable') {
    const current = actual.get(currentMonthKey)
    const transactionIds = unique([
      ...[...(current?.categories.values() ?? [])].flatMap((bucket) => bucket.unavailableTransactionIds),
      ...(current?.income.unavailableTransactionIds ?? []),
      ...(current?.refunds.unavailableTransactionIds ?? []),
      ...(selectedMode === 'full'
        ? [
            ...savingsGroups.flatMap((id) => current?.savings[id].unavailableTransactionIds ?? []),
            ...(current?.debtRepaid.unavailableTransactionIds ?? []),
            ...(current?.newDebt.unavailableTransactionIds ?? []),
          ]
        : []),
    ])
    const forecastPoints = [
      pointForX(expenseSummaryPoints, forecastX),
      ...nonExpenseUseLayers.map(({ points }) => pointForX(points, forecastX)),
      pointForX(ordinaryIncome.points, forecastX),
      ...projectedSourceBands.map(({ points }) => pointForX(points, forecastX)),
    ]
    const blockedForecastPoints = forecastPoints.filter((point) => !Number.isFinite(point?.value))
    const metricIds = unique(blockedForecastPoints.flatMap((point) => point?.metricIds ?? []))
    const projectedSources = blockedForecastPoints.flatMap((point) => point?.projectedSources ?? [])
    const unresolvedCandidates = authoritativeRemainingActivity?.audit?.recurring?.unresolvedCandidates ?? []
    const unavailableCandidateIds = authoritativeRemainingActivity?.audit?.unavailable?.candidateIds ?? []
    const relevantUnresolvedCandidates = unresolvedCandidates.filter(({ affectedMetricIds = [] }) => affectedMetricIds.some((metricId) => metricIds.includes(metricId)))
    const unresolvedCandidateIds = new Set(unresolvedCandidates.map(({ candidateId }) => String(candidateId)))
    const orphanCandidateIds = unavailableCandidateIds.filter((candidateId) => !unresolvedCandidateIds.has(String(candidateId)))
    unavailable.push({
      monthKey: forecastX,
      transactionIds,
      projected: {
        metricIds,
        sourceIds: unique([...projectedSources.map(({ sourceId }) => sourceId), ...relevantUnresolvedCandidates.map(({ sourceId }) => sourceId)]),
        candidateIds: unique([...projectedSources.map(({ candidateId }) => candidateId), ...relevantUnresolvedCandidates.map(({ candidateId }) => candidateId), ...orphanCandidateIds]),
        evidenceIds: unique(projectedSources.flatMap(({ evidenceIds }) => evidenceIds ?? [])),
        statuses: metricIds.map((metricId) => ({ metricId, status: authoritativeRemainingActivity.statusByMetric?.[metricId] ?? 'unavailable' })),
      },
    })
  }

  const hasPartialForecast = forecastX && [totalUses, totalSources].some(({ points }) => pointForX(points, forecastX)?.status === 'partial')
  const auditStatus =
    propagated.auditStatus === 'mismatch'
      ? 'mismatch'
      : unavailable.length || propagated.auditStatus === 'unavailable'
        ? 'unavailable'
        : hasPartialForecast || propagated.auditStatus === 'partial'
          ? 'partial'
          : 'ok'

  return {
    mode: selectedMode,
    savingsView: selectedSavingsView,
    detailLevel: selectedDetailLevel,
    completedMonthKeys,
    currentMonthKey,
    monthKeys,
    ranking,
    rankingItems,
    visibleCategoryIds,
    hiddenCategoryIds,
    useLayers,
    totalUses,
    ordinaryIncome,
    sourceBands: projectedSourceBands,
    totalSources,
    totals,
    gap,
    audit: { status: auditStatus, unavailable, reconciliation },
  }
}

function pointForX(points, x) {
  return points.find((point) => point.x === x)
}
