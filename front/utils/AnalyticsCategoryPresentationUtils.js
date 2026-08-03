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
