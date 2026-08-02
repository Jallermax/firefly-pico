import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCategoryReadyPresentation, buildCategorySummaryPresentation, decorateCategoryChartPoint } from '../../utils/AnalyticsCategoryPresentationUtils.js'

const summaries = [
  {
    id: 'groceries',
    label: 'Groceries',
    color: '#00a261',
    averageLabel: '120 USD',
    currentActualLabel: '45 USD',
    forecastLabel: null,
    forecastAvailable: false,
  },
]

const labels = {
  category: 'Category',
  average: 'Monthly average',
  currentActual: 'Spent so far',
  currentForecast: 'Projected',
  insufficientHistory: 'Not enough history',
}

test('category summary presentation selects the desktop table branch', () => {
  const presentation = buildCategorySummaryPresentation({ summaries, isDesktopLayout: true, labels })

  assert.equal(presentation.layout, 'desktop')
  assert.deepEqual(presentation.labels, labels)
  assert.deepEqual(presentation.rows, [
    {
      ...summaries[0],
      currentForecastLabel: 'Not enough history',
    },
  ])
})

test('category summary presentation selects mobile localized rows with an unavailable forecast', () => {
  const presentation = buildCategorySummaryPresentation({ summaries, isDesktopLayout: false, labels })

  assert.equal(presentation.layout, 'mobile')
  assert.equal(presentation.labels.average, 'Monthly average')
  assert.equal(presentation.labels.currentActual, 'Spent so far')
  assert.equal(presentation.labels.currentForecast, 'Projected')
  assert.equal(presentation.rows[0].currentForecastLabel, 'Not enough history')
  assert.equal(presentation.rows[0].forecastAvailable, false)
})

test('category chart point decoration includes currency and forecast metadata', () => {
  const point = decorateCategoryChartPoint(
    { x: '2026-08:forecast', value: 1234.5, transactionIds: [] },
    {
      kind: 'forecast',
      fallbackXLabel: 'Aug 2026',
      currencyCode: 'USD',
      formatNumber: (value) => value.toFixed(2),
      isEstimated: true,
    },
  )

  assert.deepEqual(point, {
    x: '2026-08:forecast',
    value: 1234.5,
    transactionIds: [],
    xLabel: 'Aug 2026',
    valueLabel: '1234.50 USD',
    kind: 'forecast',
    isEstimated: true,
  })
})

test('category ready presentation keeps calculation disclosure and warnings independently visible', () => {
  const presentation = buildCategoryReadyPresentation({
    usedMonths: 2,
    requestedMonths: 6,
    isEstimated: true,
    missingCurrencies: ['EUR'],
  })

  assert.deepEqual(presentation, {
    showShortHistory: true,
    showCalculation: true,
    showEstimatedRates: true,
    showMissingRates: true,
    missingCurrencies: ['EUR'],
  })

  assert.deepEqual(buildCategoryReadyPresentation({ usedMonths: 6, requestedMonths: 6, isEstimated: false, missingCurrencies: [] }), {
    showShortHistory: false,
    showCalculation: true,
    showEstimatedRates: false,
    showMissingRates: false,
    missingCurrencies: [],
  })
})
