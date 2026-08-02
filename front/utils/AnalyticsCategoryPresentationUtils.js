export const buildCategorySummaryPresentation = ({ summaries, isDesktopLayout, labels }) => ({
  layout: isDesktopLayout ? 'desktop' : 'mobile',
  labels,
  rows: summaries.map((item) => ({
    ...item,
    currentForecastLabel: item.forecastAvailable ? item.forecastLabel : labels.insufficientHistory,
  })),
})

export const decorateCategoryChartPoint = (point, { kind, fallbackXLabel, currencyCode, formatNumber, isEstimated }) => ({
  ...point,
  xLabel: point.xLabel ?? fallbackXLabel,
  valueLabel: `${formatNumber(point.value)} ${currencyCode}`,
  kind,
  isEstimated,
})

export const buildCategoryReadyPresentation = ({ usedMonths, requestedMonths, isEstimated, missingCurrencies }) => ({
  showShortHistory: usedMonths !== requestedMonths,
  showCalculation: true,
  showEstimatedRates: isEstimated,
  showMissingRates: missingCurrencies.length > 0,
  missingCurrencies,
})
