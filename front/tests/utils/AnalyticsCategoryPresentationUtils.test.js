import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildCategoryReadyPresentation, buildCategorySummaryPresentation, decorateCategoryChartPoint } from '../../utils/AnalyticsCategoryPresentationUtils.js'
import * as CategoryPresentation from '../../utils/AnalyticsCategoryPresentationUtils.js'

const summaries = [
  {
    id: 'groceries',
    label: 'Groceries',
    color: '#00a261',
    averageLabel: '120 USD',
    currentActualLabel: '45 USD',
    forecastLabel: '2,500 USD',
    remainingFromTodayLabel: '+2,181 USD',
    forecastAvailable: true,
  },
]

const labels = {
  category: 'Category',
  average: 'Monthly average',
  currentActual: 'Spent so far',
  currentForecast: 'End-of-month forecast',
  remainingFromToday: 'From today',
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
        { id: 'currentForecast', label: 'End-of-month forecast', value: '2,500 USD' },
        { id: 'remainingFromToday', label: 'From today', value: '+2,181 USD' },
      ],
    },
  ])
})

test('category summary presentation selects mobile localized values including remaining from today', () => {
  const presentation = buildCategorySummaryPresentation({ summaries, isDesktopLayout: false, labels })

  assert.equal(presentation.layout, 'mobile')
  assert.equal(presentation.labels.average, 'Monthly average')
  assert.equal(presentation.labels.currentActual, 'Spent so far')
  assert.equal(presentation.labels.currentForecast, 'End-of-month forecast')
  assert.deepEqual(
    presentation.rows[0].values?.map(({ id }) => id),
    ['average', 'currentActual', 'currentForecast', 'remainingFromToday'],
  )
  assert.equal(presentation.rows[0].values?.find(({ id }) => id === 'remainingFromToday')?.value, '+2,181 USD')
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
      secondaryLabel: 'From today',
      secondaryValueLabel: '0.00 USD',
      isEstimated: true,
    },
  )

  assert.deepEqual(point, {
    x: '2026-08:forecast',
    value: 1234.5,
    transactionIds: [],
    xLabel: 'Aug 2026',
    valueLabel: '1234.50 USD',
    secondaryLabel: 'From today',
    secondaryValueLabel: '0.00 USD',
    kind: 'forecast',
    isEstimated: true,
  })
})

test('category forecast details expose every input and both forecast values', () => {
  assert.equal(typeof CategoryPresentation.buildCategoryForecastDetailsPresentation, 'function')
  const presentation = CategoryPresentation.buildCategoryForecastDetailsPresentation({
    point: {
      currentActual: 319,
      average: 2100,
      averageHistoricalRemainder: 1800,
      pacedForecast: 2119,
      currentForecast: 2500,
      remainingFromToday: 2181,
      usedMonths: 6,
    },
    labels: {
      currentActual: 'Current actual',
      average: 'Average',
      historicalRemainder: 'Historical remainder',
      pacedForecast: 'Paced forecast',
      finalForecast: 'Final max result',
      remainingFromToday: 'Remaining from today',
      usedMonths: 'Completed months used',
    },
    formatValue: (value) => `${value} USD`,
    formatSignedValue: (value) => `${value > 0 ? '+' : ''}${value} USD`,
  })

  assert.deepEqual(presentation, [
    { id: 'currentActual', label: 'Current actual', value: '319 USD' },
    { id: 'average', label: 'Average', value: '2100 USD' },
    { id: 'historicalRemainder', label: 'Historical remainder', value: '1800 USD' },
    { id: 'pacedForecast', label: 'Paced forecast', value: '2119 USD' },
    { id: 'finalForecast', label: 'Final max result', value: '2500 USD' },
    { id: 'remainingFromToday', label: 'Remaining from today', value: '+2181 USD' },
    { id: 'usedMonths', label: 'Completed months used', value: 6 },
  ])
})

test('category ready presentation keeps calculation disclosure and missing-rate warnings independently visible', () => {
  const presentation = buildCategoryReadyPresentation({
    usedMonths: 2,
    requestedMonths: 6,
    missingCurrencies: ['EUR'],
    unclassified: { value: null, transactionIds: ['invalid-z', 'invalid-a'] },
  })

  assert.deepEqual(presentation, {
    isBlocked: true,
    unavailableTransactionIds: ['invalid-z', 'invalid-a'],
    showShortHistory: true,
    showCalculation: true,
    showMissingRates: true,
    missingCurrencies: ['EUR'],
  })

  assert.deepEqual(buildCategoryReadyPresentation({ usedMonths: 6, requestedMonths: 6, missingCurrencies: [] }), {
    isBlocked: false,
    unavailableTransactionIds: [],
    showShortHistory: false,
    showCalculation: true,
    showMissingRates: false,
    missingCurrencies: [],
  })
})

test('category card renders estimated FX only as a compact title badge', () => {
  const component = readFileSync(new URL('../../components/analytics/analytics-category-spending.vue', import.meta.url), 'utf8')
  const template = component.slice(0, component.indexOf('<script setup>'))

  assert.match(template, /v-if="summary\.isEstimated" class="analytics-fx-badge"[\s\S]*analytics\.common\.fx_current_rates/)
  assert.doesNotMatch(template, /analytics\.common\.estimated_current_rates/)
  assert.equal(template.match(/analytics\.common\.missing_rates/g)?.length, 2)
})

test('category card renders unavailable amounts as a blocking warning before empty results', () => {
  const component = readFileSync(new URL('../../components/analytics/analytics-category-spending.vue', import.meta.url), 'utf8')
  const template = component.slice(0, component.indexOf('<script setup>'))

  assert.ok(template.indexOf('v-else-if="readyPresentation.isBlocked"') < template.indexOf("analyticsStore.categoryState.status === 'empty'"))
  assert.match(template, /analytics\.common\.unavailable_amounts/)
  assert.match(template, /readyPresentation\.unavailableTransactionIds\.join\(', '\)/)
})
