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
    forecastLabel: '2,500 USD',
    remainingFromTodayLabel: '2,181 USD',
    forecastAvailable: true,
  },
]

const labels = {
  category: 'Category',
  average: 'Monthly average',
  currentActual: 'Spent so far',
  currentForecast: 'Projected',
  remainingFromToday: 'Remaining from today',
  insufficientHistory: 'Not enough history',
}

test('category summary presentation selects the desktop table branch', () => {
  const presentation = buildCategorySummaryPresentation({ summaries, isDesktopLayout: true, labels })

  assert.equal(presentation.layout, 'desktop')
  assert.deepEqual(presentation.labels, labels)
  assert.deepEqual(presentation.rows, [
    {
      ...summaries[0],
      currentForecastLabel: '2,500 USD',
      values: [
        { id: 'average', label: 'Monthly average', value: '120 USD' },
        { id: 'currentActual', label: 'Spent so far', value: '45 USD' },
        { id: 'currentForecast', label: 'Projected', value: '2,500 USD' },
        { id: 'remainingFromToday', label: 'Remaining from today', value: '2,181 USD' },
      ],
    },
  ])
})

test('category summary presentation selects mobile localized values including remaining from today', () => {
  const presentation = buildCategorySummaryPresentation({ summaries, isDesktopLayout: false, labels })

  assert.equal(presentation.layout, 'mobile')
  assert.equal(presentation.labels.average, 'Monthly average')
  assert.equal(presentation.labels.currentActual, 'Spent so far')
  assert.equal(presentation.labels.currentForecast, 'Projected')
  assert.deepEqual(
    presentation.rows[0].values?.map(({ id }) => id),
    ['average', 'currentActual', 'currentForecast', 'remainingFromToday'],
  )
  assert.equal(presentation.rows[0].values?.find(({ id }) => id === 'remainingFromToday')?.value, '2,181 USD')
})

test('category summary presentation uses insufficient history for unavailable forecast values', () => {
  const presentation = buildCategorySummaryPresentation({
    summaries: [{ ...summaries[0], forecastLabel: null, remainingFromTodayLabel: null, forecastAvailable: false }],
    isDesktopLayout: false,
    labels,
  })

  assert.equal(presentation.rows[0].currentForecastLabel, 'Not enough history')
  assert.equal(presentation.rows[0].values?.find(({ id }) => id === 'currentForecast')?.value, 'Not enough history')
  assert.equal(presentation.rows[0].values?.find(({ id }) => id === 'remainingFromToday')?.value, 'Not enough history')
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
