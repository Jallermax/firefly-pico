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
  unavailable: 'Forecast input unavailable',
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

test('category summary presentation distinguishes insufficient history from unavailable forecast input', () => {
  const presentation = buildCategorySummaryPresentation({
    summaries: [{ ...summaries[0], status: 'unavailable', forecastLabel: null, remainingFromTodayLabel: null, forecastAvailable: false }],
    isDesktopLayout: false,
    labels,
  })

  assert.equal(presentation.rows[0].currentForecastLabel, 'Forecast input unavailable')
  assert.equal(presentation.rows[0].values?.find(({ id }) => id === 'currentForecast')?.value, 'Forecast input unavailable')
  assert.equal(presentation.rows[0].values?.find(({ id }) => id === 'remainingFromToday')?.value, 'Forecast input unavailable')

  const insufficient = buildCategorySummaryPresentation({
    summaries: [{ ...summaries[0], status: 'insufficientHistory', forecastLabel: null, remainingFromTodayLabel: null, forecastAvailable: false }],
    isDesktopLayout: false,
    labels,
  })
  assert.equal(insufficient.rows[0].currentForecastLabel, 'Not enough history')
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

test('category forecast details use Task 8 values and only show ready progress', () => {
  assert.equal(typeof CategoryPresentation.buildCategoryForecastDetailsPresentation, 'function')
  const presentation = CategoryPresentation.buildCategoryForecastDetailsPresentation({
    point: {
      currentActual: 319,
      actualToDate: 319,
      final: 2500,
      remainingFromToday: 2181,
      progress: 0.1276,
      progressState: 'ready',
      status: 'ready',
    },
    labels: {
      currentActual: 'Current actual',
      finalForecast: 'Final max result',
      remainingFromToday: 'Remaining from today',
      progress: 'Progress',
    },
    formatValue: (value) => `${value} USD`,
    formatSignedValue: (value) => `${value > 0 ? '+' : ''}${value} USD`,
  })

  assert.deepEqual(presentation, [
    { id: 'currentActual', label: 'Current actual', value: '319 USD' },
    { id: 'finalForecast', label: 'Final max result', value: '2500 USD' },
    { id: 'remainingFromToday', label: 'Remaining from today', value: '+2181 USD' },
    { id: 'progress', label: 'Progress', value: '13%' },
  ])
  assert.deepEqual(
    CategoryPresentation.buildCategoryForecastDetailsPresentation({
      point: { actualToDate: 4, final: 8, remainingFromToday: 4, progress: null, progressState: 'partial', status: 'partial' },
      labels: { currentActual: 'Actual', finalForecast: 'Final', remainingFromToday: 'Remaining', progress: 'Progress' },
      formatValue: String,
      formatSignedValue: String,
    }),
    [
      { id: 'currentActual', label: 'Actual', value: '4' },
      { id: 'finalForecast', label: 'Final', value: '8' },
      { id: 'remainingFromToday', label: 'Remaining', value: '4' },
      { id: 'progressState', value: 'partial' },
    ],
  )
})

test('category forecast details aggregate projected activity by readable source without losing audit identity', () => {
  const presentation = CategoryPresentation.buildCategoryForecastDetailsPresentation({
    point: {
      actualToDate: 2321,
      final: 3121,
      remainingFromToday: 800,
      progress: 2321 / 3121,
      progressState: 'ready',
      projectedSources: [
        { sourceKind: 'defined', sourceLabel: 'Rent adjustment', sourceId: 'subscription-42', candidateId: 'defined:subscription:subscription-42', flowAmounts: { expenses: 500 } },
        { sourceKind: 'defined', sourceLabel: 'Rent adjustment', sourceId: 'subscription-42', candidateId: 'defined:subscription:subscription-42', flowAmounts: { expenses: 300 } },
        { sourceKind: 'variable', sourceId: 'projected:variable:1', flowAmounts: { expenses: 0 } },
      ],
    },
    labels: {
      currentActual: 'Current actual',
      finalForecast: 'Final forecast',
      remainingFromToday: 'Remaining',
      progress: 'Progress',
      sourceKinds: { defined: 'Recurring', variable: 'Variable' },
    },
    formatValue: (value) => `${value} USD`,
    formatSignedValue: (value) => `${value > 0 ? '+' : ''}${value} USD`,
  })

  assert.deepEqual(presentation.at(-1), {
    id: 'source:defined:defined:subscription:subscription-42',
    label: 'Recurring — Rent adjustment',
    value: '+800 USD',
    sourceKind: 'defined',
    sourceLabel: 'Rent adjustment',
    sourceId: 'subscription-42',
    candidateId: 'defined:subscription:subscription-42',
  })
})

test('category forecast details collapse daily variable remainder into one readable source row', () => {
  const projectedSources = Array.from({ length: 20 }, (_, index) => ({
    id: `projected:variable:${index + 1}`,
    sourceKind: 'variable',
    sourceId: `projected:variable:${index + 1}`,
    evidenceIds: [`history-${index + 1}`],
    flowAmounts: { expenses: 25 },
  }))
  projectedSources.push({
    id: 'projected:defined:rent:1',
    sourceKind: 'defined',
    sourceLabel: 'Rent',
    sourceId: 'rent',
    candidateId: 'defined:recurring:rent',
    evidenceIds: ['rent-definition'],
    flowAmounts: { expenses: 500 },
  })

  const presentation = CategoryPresentation.buildCategoryForecastDetailsPresentation({
    point: {
      actualToDate: 0,
      final: 1000,
      remainingFromToday: 1000,
      progress: 0,
      progressState: 'ready',
      projectedSources,
    },
    labels: {
      currentActual: 'Current actual',
      finalForecast: 'Final forecast',
      remainingFromToday: 'Remaining',
      progress: 'Progress',
      sourceKinds: { defined: 'Recurring', variable: 'Historical average' },
    },
    formatValue: (value) => `${value} USD`,
    formatSignedValue: (value) => `${value > 0 ? '+' : ''}${value} USD`,
  })
  const sourceRows = presentation.filter(({ sourceKind }) => sourceKind)

  assert.deepEqual(
    sourceRows.map(({ id, label, value }) => ({ id, label, value })),
    [
      { id: 'source:defined:defined:recurring:rent', label: 'Recurring — Rent', value: '+500 USD' },
      { id: 'source:variable:variable', label: 'Historical average', value: '+500 USD' },
    ],
  )
  assert.deepEqual(sourceRows[1].evidenceIds, ['history-1', 'history-10', 'history-11', 'history-12', 'history-13', 'history-14', 'history-15', 'history-16'])
  assert.equal(sourceRows[1].evidenceOmittedCount, 12)
})

test('category detail retains non-ready Task 8 progress state without legacy averages or pacing', () => {
  const presentation = CategoryPresentation.buildCategoryForecastDetailsPresentation({
    point: { actualToDate: -10, final: -8, remainingFromToday: 2, progress: null, progressState: 'opposite', status: 'partial' },
    labels: { currentActual: 'Actual', finalForecast: 'Final', remainingFromToday: 'Remaining', progress: 'Progress' },
    formatValue: String,
    formatSignedValue: String,
  })
  assert.deepEqual(presentation, [
    { id: 'currentActual', label: 'Actual', value: '-10' },
    { id: 'finalForecast', label: 'Final', value: '-8' },
    { id: 'remainingFromToday', label: 'Remaining', value: '2' },
    { id: 'progressState', value: 'opposite' },
  ])
  assert.equal(
    presentation.some(({ id }) => ['average', 'pacedForecast', 'historicalRemainder'].includes(id)),
    false,
  )
})

test('category ready presentation keeps unavailable amounts blocking without owning FX disclosure', () => {
  const presentation = buildCategoryReadyPresentation({
    usedMonths: 2,
    requestedMonths: 6,
    unclassified: { value: null, transactionIds: ['invalid-z', 'invalid-a'] },
  })

  assert.deepEqual(presentation, {
    isBlocked: true,
    unavailableTransactionIds: ['invalid-z', 'invalid-a'],
    showShortHistory: true,
    showCalculation: true,
  })

  assert.deepEqual(buildCategoryReadyPresentation({ usedMonths: 6, requestedMonths: 6 }), {
    isBlocked: false,
    unavailableTransactionIds: [],
    showShortHistory: false,
    showCalculation: true,
  })
})

test('category card renders unavailable amounts as a blocking warning before empty results', () => {
  const component = readFileSync(new URL('../../components/analytics/analytics-category-spending.vue', import.meta.url), 'utf8')
  const template = component.slice(0, component.indexOf('<script setup>'))

  assert.ok(template.indexOf('v-else-if="readyPresentation.isBlocked"') < template.indexOf("analyticsStore.categoryState.status === 'empty'"))
  assert.match(template, /analytics\.common\.unavailable_amounts/)
  assert.match(template, /readyPresentation\.unavailableTransactionIds\.join\(', '\)/)
})

test('category forecast explanation describes recurring and historical remaining activity instead of retired pacing', () => {
  const message = JSON.parse(readFileSync(new URL('../../i18n/locales/en.json', import.meta.url), 'utf8')).analytics.category.final_forecast_rule
  assert.match(message, /recurring activity/i)
  assert.match(message, /historical remainder/i)
  assert.doesNotMatch(message, /paced|maximum of actual/i)
})

test('money-flow presentation order is amount descending, stable by ID, with Other last', () => {
  assert.equal(typeof CategoryPresentation.sortMoneyFlowPresentationItems, 'function')
  const items = [
    { id: 'other:expenses', label: 'Other', value: 200 },
    { id: 'expense:z', value: 40 },
    { id: 'expense:largest', value: 90 },
    { id: 'expense:a', value: -40 },
  ]

  assert.deepEqual(
    CategoryPresentation.sortMoneyFlowPresentationItems(items).map(({ id }) => id),
    ['expense:largest', 'expense:a', 'expense:z', 'other:expenses'],
  )
})

test('money flow type ordering groups the right side by family before amount', () => {
  const items = [
    { id: 'excess', kind: 'newExcess', value: 500, label: 'Excess' },
    { id: 'saving', kind: 'savingsDeposit', value: 400, label: 'Saving' },
    { id: 'debt', kind: 'debtPaid', value: 300, label: 'Debt' },
    { id: 'expense-a', kind: 'expenseCategory', value: 20, label: 'Beta' },
    { id: 'expense-b', kind: 'expenseCategory', value: 20, label: 'Alpha' },
  ]

  assert.deepEqual(
    CategoryPresentation.sortMoneyFlowPresentationItems(items, {
      familyRank: (item) => ({ expenseCategory: 0, debtPaid: 1, savingsDeposit: 2, newExcess: 3 })[item.kind],
      labelOf: (item) => item.label,
    }).map(({ id }) => id),
    ['expense-b', 'expense-a', 'debt', 'saving', 'excess'],
  )
})
