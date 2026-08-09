export const buildCategorySummaryPresentation = ({ summaries, isDesktopLayout, labels }) => ({
  layout: isDesktopLayout ? 'desktop' : 'mobile',
  labels,
  rows: summaries.map((item) => {
    const unavailableLabel = item.status === 'insufficientHistory' ? labels.insufficientHistory : labels.unavailable
    const currentForecastLabel = item.forecastAvailable ? item.forecastLabel : unavailableLabel
    return {
      ...item,
      currentForecastLabel,
      values: [
        { id: 'average', label: labels.average, value: item.averageLabel },
        { id: 'currentActual', label: labels.currentActual, value: item.currentActualLabel },
        { id: 'currentForecast', label: labels.currentForecast, value: currentForecastLabel },
        { id: 'remainingFromToday', label: labels.remainingFromToday, value: item.forecastAvailable ? item.remainingFromTodayLabel : unavailableLabel },
      ],
    }
  }),
})

export const decorateCategoryChartPoint = (point, { kind, fallbackXLabel, currencyCode, formatNumber, secondaryLabel, secondaryValueLabel, isEstimated }) => ({
  ...point,
  xLabel: point.xLabel ?? fallbackXLabel,
  valueLabel: `${formatNumber(point.value)} ${currencyCode}`,
  ...(typeof secondaryLabel === 'string' && typeof secondaryValueLabel === 'string' ? { secondaryLabel, secondaryValueLabel } : {}),
  kind,
  isEstimated,
})

export const buildCategoryForecastDetailsPresentation = ({ point, labels, formatValue, formatSignedValue = formatValue }) => {
  const actual = point.actualToDate ?? point.currentActual
  const final = point.final ?? point.currentForecast
  const rows = [
    { id: 'currentActual', label: labels.currentActual, value: formatValue(actual) },
    { id: 'finalForecast', label: labels.finalForecast, value: formatValue(final) },
    { id: 'remainingFromToday', label: labels.remainingFromToday, value: formatSignedValue(point.remainingFromToday) },
  ]
  if (point.progressState === 'ready' && Number.isFinite(point.progress)) rows.push({ id: 'progress', label: labels.progress, value: `${Math.round(point.progress * 100)}%` })
  else rows.push({ id: 'progressState', value: point.progressState ?? point.status })
  const sources = new Map()
  for (const source of point.projectedSources ?? []) {
    const amount = source.flowAmounts?.expenses
    if (!Number.isFinite(amount) || amount === 0) continue
    const identity = source.candidateId ?? source.sourceId ?? source.sourceLabel ?? source.id
    const id = `source:${source.sourceKind}:${identity}`
    const current = sources.get(id) ?? { ...source, id, amount: 0 }
    current.amount += amount
    sources.set(id, current)
  }
  for (const source of sources.values()) {
    const kindLabel = labels.sourceKinds?.[source.sourceKind] ?? source.sourceKind
    rows.push({
      id: source.id,
      label: source.sourceLabel ? `${kindLabel} — ${source.sourceLabel}` : kindLabel,
      value: formatSignedValue(source.amount),
      sourceKind: source.sourceKind,
      sourceLabel: source.sourceLabel ?? null,
      sourceId: source.sourceId ?? null,
      candidateId: source.candidateId ?? null,
    })
  }
  return rows
}

export const buildCategoryReadyPresentation = ({ usedMonths, requestedMonths, unclassified = { transactionIds: [] } }) => {
  const unavailableTransactionIds = unclassified.transactionIds ?? []
  return {
    isBlocked: unavailableTransactionIds.length > 0,
    unavailableTransactionIds,
    showShortHistory: usedMonths !== requestedMonths,
    showCalculation: true,
  }
}

export const sortMoneyFlowPresentationItems = (items) =>
  [...items].sort((left, right) => {
    const leftIsOther = String(left.id).startsWith('other:') || String(left.kind).startsWith('other') || left.label === 'Other'
    const rightIsOther = String(right.id).startsWith('other:') || String(right.kind).startsWith('other') || right.label === 'Other'
    return Number(leftIsOther) - Number(rightIsOther) || Math.abs(right.value) - Math.abs(left.value) || String(left.refId ?? left.id).localeCompare(String(right.refId ?? right.id))
  })
