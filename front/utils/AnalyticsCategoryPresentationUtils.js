export const buildCategorySummaryPresentation = ({ summaries, isDesktopLayout, labels }) => ({
  layout: isDesktopLayout ? 'desktop' : 'mobile',
  labels,
  rows: summaries.map((item) => {
    const currentForecastLabel = item.forecastAvailable ? item.forecastLabel : labels.insufficientHistory
    return {
      ...item,
      currentForecastLabel,
      values: [
        { id: 'average', label: labels.average, value: item.averageLabel },
        { id: 'currentActual', label: labels.currentActual, value: item.currentActualLabel },
        { id: 'currentForecast', label: labels.currentForecast, value: currentForecastLabel },
        { id: 'remainingFromToday', label: labels.remainingFromToday, value: item.forecastAvailable ? item.remainingFromTodayLabel : labels.insufficientHistory },
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

export const buildCategoryForecastDetailsPresentation = ({ point, labels, formatValue, formatSignedValue = formatValue }) => [
  { id: 'currentActual', label: labels.currentActual, value: formatValue(point.currentActual) },
  { id: 'average', label: labels.average, value: formatValue(point.average) },
  { id: 'historicalRemainder', label: labels.historicalRemainder, value: formatValue(point.averageHistoricalRemainder) },
  { id: 'pacedForecast', label: labels.pacedForecast, value: formatValue(point.pacedForecast) },
  { id: 'finalForecast', label: labels.finalForecast, value: formatValue(point.currentForecast) },
  { id: 'remainingFromToday', label: labels.remainingFromToday, value: formatSignedValue(point.remainingFromToday) },
  { id: 'usedMonths', label: labels.usedMonths, value: point.usedMonths },
]

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
