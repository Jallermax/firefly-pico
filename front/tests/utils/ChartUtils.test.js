import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildLineChartGeometry, nearestChartPointIndex, nearestPointIndex, resolveMoneyFlowPresentation } from '../../utils/ChartUtils.js'
import * as ChartUtils from '../../utils/ChartUtils.js'
import { buildFinancialTrendChartSeries } from '../../utils/AnalyticsUtils.js'

test('line geometry shares one x scale and keeps zero in range when needed', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'a',
        points: [
          { x: '2026-01', value: -10, kind: 'actual' },
          { x: '2026-02', value: 10, kind: 'forecast' },
        ],
      },
      {
        id: 'b',
        points: [
          { x: '2026-01', value: 0 },
          { x: '2026-02', value: 5 },
        ],
      },
    ],
  })
  assert.deepEqual(geometry.xValues, ['2026-01', '2026-02'])
  assert.equal(geometry.yMin, -10)
  assert.equal(geometry.yMax, 10)
  assert.deepEqual(
    geometry.series[0].points.map(({ x }) => x),
    [10, 90],
  )
  assert.equal(geometry.series[0].segments[0].dashed, true)
})

test('nearest point clamps pointer and keyboard positions', () => {
  assert.equal(nearestPointIndex({ clientX: 50, left: 0, width: 100, pointCount: 5 }), 2)
  assert.equal(nearestPointIndex({ clientX: -20, left: 0, width: 100, pointCount: 5 }), 0)
  assert.equal(nearestPointIndex({ clientX: 120, left: 0, width: 100, pointCount: 5 }), 4)
  assert.equal(nearestPointIndex({ clientX: 20, left: 0, width: 100, pointCount: 0 }), -1)
})

test('nearest chart point maps the rendered plot bounds instead of the full root', () => {
  assert.equal(nearestChartPointIndex({ clientX: 88, left: 0, width: 1000, viewBoxWidth: 1000, padding: { left: 88, right: 24 }, pointCount: 12 }), 0)
  assert.equal(nearestChartPointIndex({ clientX: 976, left: 0, width: 1000, viewBoxWidth: 1000, padding: { left: 88, right: 24 }, pointCount: 12 }), 11)
})

test('line geometry preserves gaps instead of joining across missing values', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'a',
        points: [
          { x: '2026-01', value: 1 },
          { x: '2026-02', value: null },
          { x: '2026-03', value: 3, kind: 'actual' },
          { x: '2026-04', value: 4, kind: 'forecast' },
        ],
      },
    ],
  })

  assert.equal(geometry.series[0].points[1].y, null)
  assert.deepEqual(geometry.series[0].segments, [{ path: 'M 63.33333333333333 20 L 90 10', dashed: true }])
})

test('forecast segment connects from its own last actual when another series adds the missing current x', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'missing-current',
        points: [
          { x: '2026-07', value: 100, kind: 'actual' },
          { x: '2026-08:forecast', value: 110, kind: 'forecast' },
        ],
      },
      {
        id: 'complete',
        points: [
          { x: '2026-07', value: 20, kind: 'actual' },
          { x: '2026-08', value: 25, kind: 'partial' },
          { x: '2026-08:forecast', value: 30, kind: 'forecast' },
        ],
      },
    ],
  })

  assert.equal(geometry.series[0].segments.length, 1)
  assert.equal(geometry.series[0].segments[0].dashed, true)
  assert.equal(geometry.series[1].segments.filter(({ dashed }) => dashed).length, 1)
})

test('inspection-only points align tooltip values without drawing a line', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: [
      {
        id: 'balance',
        points: [
          { x: '2026-08', value: 10 },
          { x: '2026-08:forecast', value: 10, inspectionOnly: true },
        ],
      },
    ],
  })

  assert.deepEqual(geometry.xValues, ['2026-08', '2026-08:forecast'])
  assert.deepEqual(geometry.series[0].segments, [])
})

test('financial forecast crosshair keeps exact values and dashed segments for every selected metric', () => {
  assert.equal(typeof ChartUtils.decorateLineChartPoint, 'function')
  assert.equal(typeof ChartUtils.lineChartPointsAtX, 'function')
  assert.equal(typeof ChartUtils.persistentLineChartPoints, 'function')
  const forecastKey = '2026-08:forecast'
  const accountSeries = ['netWorth', 'savings', 'debt'].map((id, index) => ({
    id,
    changePoints: [{ x: '2026-08', value: 10 + index, kind: 'partial' }],
    forecastChange: 20 + index,
    remainingFromToday: index === 2 ? -5 : 10 + index,
    forecastAvailable: true,
  }))
  const metrics = ['netWorth', 'savings', 'debt', 'expenses'].map((id) => ({ id }))
  const series = buildFinancialTrendChartSeries({
    view: 'changes',
    metrics,
    selectedIds: metrics.map(({ id }) => id),
    accountSeries,
    expenses: { actualPoints: [], currentActual: 20, currentForecast: 30, remainingFromToday: 10, forecastAvailable: true },
    currentMonthKey: '2026-08',
  }).map((item) => ({
    ...item,
    points: item.points.map((point) => {
      const source = item.id === 'expenses' ? { remainingFromToday: 10 } : accountSeries.find(({ id }) => id === item.id)
      return ChartUtils.decorateLineChartPoint(point, {
        xLabel: 'Aug 2026',
        valueLabel: `${point.value} USD`,
        secondaryLabel: point.kind === 'forecast' ? 'From today' : undefined,
        secondaryValueLabel: point.kind === 'forecast' ? `${source.remainingFromToday > 0 ? '+' : ''}${source.remainingFromToday} USD` : undefined,
        isEstimated: true,
      })
    }),
  }))
  const geometry = buildLineChartGeometry({ width: 100, height: 60, padding: { top: 10, right: 10, bottom: 10, left: 10 }, series })
  const selected = ChartUtils.lineChartPointsAtX(geometry.series, forecastKey)

  assert.equal(selected.length, 4)
  assert.deepEqual(
    selected.map(({ series: item, point }) => [item.id, point.value, point.kind, point.secondaryLabel, point.secondaryValueLabel, point.isEstimated]),
    [
      ['netWorth', 20, 'forecast', 'From today', '+10 USD', true],
      ['savings', 21, 'forecast', 'From today', '+11 USD', true],
      ['debt', 22, 'forecast', 'From today', '-5 USD', true],
      ['expenses', 30, 'forecast', 'From today', '+10 USD', true],
    ],
  )
  assert.equal(
    geometry.series.every((item) => item.segments.some(({ dashed }) => dashed) && ChartUtils.persistentLineChartPoints(item.points).some(({ kind }) => kind === 'forecast')),
    true,
  )
})

test('financial trend omits unavailable expenses while retaining selected account metrics', () => {
  const series = buildFinancialTrendChartSeries({
    view: 'changes',
    metrics: [{ id: 'netWorth' }, { id: 'expenses' }],
    selectedIds: ['netWorth', 'expenses'],
    accountSeries: [{ id: 'netWorth', changePoints: [{ x: '2026-08', value: 10, kind: 'partial' }], forecastAvailable: false }],
    expenses: null,
    currentMonthKey: '2026-08',
  })

  assert.deepEqual(
    series.map(({ id }) => id),
    ['netWorth'],
  )
})

test('tooltip and live-region qualifiers share partial forecast and estimated labels', () => {
  assert.equal(typeof ChartUtils.lineChartPointQualifierKeys, 'function')
  assert.equal(typeof ChartUtils.buildLineChartLiveDescription, 'function')
  const partial = { kind: 'partial', isEstimated: true, valueLabel: '10 USD' }
  const forecast = { kind: 'forecast', isEstimated: true, valueLabel: '20 USD' }
  const qualifierLabels = { forecast: 'Forecast', partial: 'Partial', estimated_current_rates: 'Estimated at current rates' }

  assert.deepEqual(ChartUtils.lineChartPointQualifierKeys(partial), ['partial', 'estimated_current_rates'])
  assert.deepEqual(ChartUtils.lineChartPointQualifierKeys(forecast), ['forecast', 'estimated_current_rates'])
  assert.equal(
    ChartUtils.buildLineChartLiveDescription({
      xLabel: 'Aug 2026',
      values: [
        { label: 'Net worth', point: partial },
        { label: 'Expenses', point: forecast },
      ],
      qualifierLabels,
    }),
    'Aug 2026. Net worth: 10 USD, Partial, Estimated at current rates. Expenses: 20 USD, Forecast, Estimated at current rates',
  )
})

test('forecast crosshair exposes end-of-month and from-today values together', () => {
  const description = ChartUtils.buildLineChartLiveDescription({
    xLabel: 'Aug 2026 forecast',
    values: [
      {
        label: 'Savings end-of-month forecast',
        point: {
          valueLabel: '2,500 USD',
          kind: 'forecast',
          secondaryLabel: 'From today',
          secondaryValueLabel: '+1,300 USD',
        },
      },
      {
        label: 'Expenses end-of-month forecast',
        point: {
          valueLabel: '2,321 USD',
          kind: 'forecast',
          secondaryLabel: 'From today',
          secondaryValueLabel: '+2,321 USD',
        },
      },
    ],
    qualifierLabels: { forecast: 'Forecast' },
  })

  assert.equal(
    description,
    'Aug 2026 forecast. Savings end-of-month forecast: 2,500 USD, Forecast, From today: +1,300 USD. Expenses end-of-month forecast: 2,321 USD, Forecast, From today: +2,321 USD',
  )
})

test('metric facet filters labels and refuses to remove the final selection', () => {
  assert.equal(typeof ChartUtils.filterChartFacetItems, 'function')
  assert.equal(typeof ChartUtils.toggleRequiredChartFacetSelection, 'function')
  const items = [
    { id: 'netWorth', label: 'Net-worth change' },
    { id: 'expenses', label: 'Total expenses' },
  ]

  assert.deepEqual(ChartUtils.filterChartFacetItems(items, 'ExPeNs'), [items[1]])
  assert.deepEqual(ChartUtils.toggleRequiredChartFacetSelection(['netWorth'], 'netWorth'), ['netWorth'])
  assert.deepEqual(ChartUtils.toggleRequiredChartFacetSelection(['netWorth'], 'expenses'), ['netWorth', 'expenses'])
  assert.deepEqual(ChartUtils.toggleRequiredChartFacetSelection(['netWorth', 'expenses'], 'netWorth'), ['expenses'])
})

test('selected balance warning projection keeps one group with both selected labels', () => {
  assert.equal(typeof ChartUtils.projectSelectedBalanceWarnings, 'function')

  const warnings = ChartUtils.projectSelectedBalanceWarnings({
    warnings: [{ type: 'current-balance-unverified', sampleDate: '2026-08-03', metricIds: ['netWorth', 'savings'] }],
    selectedMetrics: [
      { id: 'netWorth', label: 'Net worth' },
      { id: 'savings', label: 'Savings' },
    ],
  })

  assert.deepEqual(warnings, [
    {
      type: 'current-balance-unverified',
      sampleDate: '2026-08-03',
      metricIds: ['netWorth', 'savings'],
      metricLabels: ['Net worth', 'Savings'],
    },
  ])
})

test('selected balance warning projection removes an unselected metric label', () => {
  assert.equal(typeof ChartUtils.projectSelectedBalanceWarnings, 'function')

  const warnings = ChartUtils.projectSelectedBalanceWarnings({
    warnings: [{ type: 'current-balance-unverified', sampleDate: '2026-08-03', metricIds: ['netWorth', 'savings'] }],
    selectedMetrics: [{ id: 'netWorth', label: 'Net worth' }],
  })

  assert.deepEqual(warnings, [
    {
      type: 'current-balance-unverified',
      sampleDate: '2026-08-03',
      metricIds: ['netWorth'],
      metricLabels: ['Net worth'],
    },
  ])
})

test('selected balance warning projection omits balance warnings for expenses-only selection', () => {
  assert.equal(typeof ChartUtils.projectSelectedBalanceWarnings, 'function')

  const warnings = ChartUtils.projectSelectedBalanceWarnings({
    warnings: [{ type: 'current-balance-unverified', sampleDate: '2026-08-03', metricIds: ['netWorth', 'savings'] }],
    selectedMetrics: [],
  })

  assert.deepEqual(warnings, [])
})

test('financial trend source states keep account and transaction failures independent', () => {
  assert.equal(typeof ChartUtils.resolveFinancialTrendSourceState, 'function')

  assert.deepEqual(
    ChartUtils.resolveFinancialTrendSourceState({
      hasAccountSelection: true,
      expensesSelected: true,
      balanceState: { status: 'error', isStale: false },
      expenseState: { status: 'ready', isStale: false },
    }),
    {
      balanceBlocking: false,
      expenseBlocking: false,
      balanceStatusVisible: true,
      expenseStatusVisible: false,
      selectedSourcesSettled: false,
    },
  )
  assert.deepEqual(
    ChartUtils.resolveFinancialTrendSourceState({
      hasAccountSelection: false,
      expensesSelected: true,
      balanceState: { status: 'error', isStale: false },
      expenseState: { status: 'error', isStale: false },
    }),
    {
      balanceBlocking: false,
      expenseBlocking: true,
      balanceStatusVisible: false,
      expenseStatusVisible: true,
      selectedSourcesSettled: false,
    },
  )
  assert.deepEqual(
    ChartUtils.resolveFinancialTrendSourceState({
      hasAccountSelection: true,
      expensesSelected: false,
      balanceState: { status: 'loading', isStale: true },
      expenseState: { status: 'idle', isStale: false },
    }),
    {
      balanceBlocking: false,
      expenseBlocking: false,
      balanceStatusVisible: true,
      expenseStatusVisible: false,
      selectedSourcesSettled: false,
    },
  )
})

test('financial trend card warns about unavailable expenses without hiding account results', () => {
  const component = readFileSync(new URL('../../components/analytics/analytics-balance-trends.vue', import.meta.url), 'utf8')

  assert.match(component, /const hasUnavailableExpenses = computed/)
  assert.match(component, /series\.id === 'expenses' \? hasExpenseResult\.value && !hasUnavailableExpenses\.value : hasBalanceResult\.value/)
  assert.match(component, /expensesSelected && hasUnavailableExpenses[\s\S]*analytics\.common\.unavailable_amounts/)
  assert.match(component, /const expenseSummary = computed\(\(\) => \{[\s\S]*hasUnavailableExpenses\.value[\s\S]*return null/)
})

test('line geometry assigns six persistent non-color marker treatments to every finite point', () => {
  const geometry = buildLineChartGeometry({
    width: 100,
    height: 60,
    padding: { top: 10, right: 10, bottom: 10, left: 10 },
    series: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      id,
      points: [
        { x: '2026-01', value: 1, kind: 'actual' },
        { x: '2026-02', value: 2, kind: id === 'a' ? 'forecast' : 'actual' },
      ],
    })),
  })

  assert.deepEqual(
    geometry.series.map(({ marker }) => marker),
    ['circle', 'square', 'diamond', 'triangle', 'cross', 'hollow'],
  )
  assert.equal(
    geometry.series.every((series) => series.points.every((point) => point.marker === series.marker)),
    true,
  )
  assert.equal(geometry.series[0].segments[0].dashed, true)
})

test('responsive line chart layout keeps axis labels and persistent markers readable', () => {
  assert.equal(typeof ChartUtils.buildLineChartLayout, 'function')

  const cases = [
    { isDesktop: false, renderedWidth: 358 },
    { isDesktop: true, renderedWidth: 500 },
    { isDesktop: false, renderedWidth: 700 },
    { isDesktop: false, renderedWidth: 800 },
    { isDesktop: true, renderedWidth: 1168 },
  ].map(({ isDesktop, renderedWidth }) => ({ isDesktop, renderedWidth, layout: ChartUtils.buildLineChartLayout({ isDesktop, renderedWidth }) }))

  for (const { layout, renderedWidth } of cases) {
    const renderedScale = renderedWidth / layout.width
    const renderedFontSize = layout.axisFontSize * renderedScale
    const renderedMarkerDiameter = layout.markerSize * 2 * renderedScale

    assert.ok(renderedFontSize >= 11 && renderedFontSize <= 13, `${renderedWidth}px renders ${renderedFontSize}px axis text`)
    assert.ok(renderedMarkerDiameter >= 9, `${renderedWidth}px renders ${renderedMarkerDiameter}px persistent markers`)
    assert.equal(layout.viewBox, `0 0 ${layout.width} ${layout.height}`)
    assert.equal(layout.gridX1, layout.padding.left)
    assert.equal(layout.gridX2, layout.width - layout.padding.right)
    assert.equal(layout.crosshairY1, layout.padding.top)
    assert.equal(layout.crosshairY2, layout.height - layout.padding.bottom)
    assert.ok(layout.xAxisY > layout.crosshairY2 && layout.xAxisY <= layout.height)
  }

  for (const { isDesktop, layout, renderedWidth } of cases.filter(({ isDesktop }) => !isDesktop)) {
    const mobileRenderedHeight = layout.height * (renderedWidth / layout.width)
    assert.equal(isDesktop, false)
    assert.ok(mobileRenderedHeight >= 235 && mobileRenderedHeight <= 245, `${renderedWidth}px mobile chart renders ${mobileRenderedHeight}px tall`)
  }
})

test('money flow presentation withholds unclassified activity and keeps its audit', () => {
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: false, hasNodes: true, hasUnclassified: true }), {
    showGraph: false,
    showEmpty: false,
    showAudit: true,
    reason: 'unclassified',
  })
})

test('money flow presentation distinguishes empty, full, condensed, stale, missing-rate, and unbalanced states', () => {
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: true, hasNodes: false }), {
    showGraph: false,
    showEmpty: true,
    showAudit: false,
    reason: 'empty',
  })
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: true, hasNodes: true }), {
    showGraph: true,
    showEmpty: false,
    showAudit: false,
    reason: null,
  })
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: true, hasNodes: true, isCondensed: true }), {
    showGraph: true,
    showEmpty: false,
    showAudit: false,
    reason: 'condensed',
  })
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: true, hasNodes: true, isStale: true }), {
    showGraph: true,
    showEmpty: false,
    showAudit: false,
    reason: 'stale',
  })
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: false, hasNodes: true, hasMissingRates: true }), {
    showGraph: false,
    showEmpty: false,
    showAudit: true,
    reason: 'missing_rates',
  })
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: false, hasNodes: true }), {
    showGraph: false,
    showEmpty: false,
    showAudit: true,
    reason: 'unbalanced',
  })
})

test('mobile money flow typography remains readable inside an inset card', () => {
  const whiteCss = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')
  const darkCss = readFileSync(new URL('../../assets/styles/theme-dark.css', import.meta.url), 'utf8')
  const ruleBody = (css, selector) => {
    const start = css.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `missing ${selector}`)
    return css.slice(start, css.indexOf('}', start) + 1)
  }
  const mobileRule = ruleBody(whiteCss, '.analytics-flow-mobile')
  const horizontalPadding = Number(mobileRule.match(/padding-inline:\s*([\d.]+)/)?.[1])
  const mobileFontSize = Number(whiteCss.match(/\.analytics-flow-mobile \.analytics-flow-node-label,[\s\S]*?font-size:\s*([\d.]+)px/)?.[1])

  for (const viewportWidth of [360, 390]) {
    const renderedFontSize = mobileFontSize * ((viewportWidth - 32 - horizontalPadding * 2) / 360)
    assert.ok(renderedFontSize >= 12, `${viewportWidth}px renders ${renderedFontSize}px flow text`)
  }
  assert.match(ruleBody(whiteCss, '.analytics-flow-node-amount'), /fill:\s*var\(--van-text-color\)/)
  assert.match(ruleBody(darkCss, '.van-theme-dark .analytics-flow-node-amount'), /fill:\s*var\(--van-text-color\)/)
})

const layeredGeometryGraph = {
  nodes: [
    { id: 'income:salary', layer: 0, kind: 'income', refId: 'salary', value: 100, transactionIds: ['income'] },
    { id: 'refund:food', layer: 0, kind: 'refund', refId: 'food', value: 20, transactionIds: ['refund'] },
    { id: 'income', layer: 1, kind: 'income', value: 100, transactionIds: ['income'] },
    { id: 'refundIncome', layer: 1, kind: 'refund', value: 20, transactionIds: ['refund'] },
    { id: 'available', layer: 2, kind: 'available', value: 120, transactionIds: ['expense-available', 'income', 'refund'] },
    { id: 'savingsAccessible', layer: 3, kind: 'savings', savingsGroup: 'accessible', value: 40, transactionIds: ['deposit'] },
    { id: 'expenses', layer: 4, kind: 'expenses', value: 80, transactionIds: ['expense-available', 'expense-savings'] },
    { id: 'savingsDeposited:accessible', layer: 4, kind: 'savingsDeposited', savingsGroup: 'accessible', value: 40, transactionIds: ['deposit'] },
    { id: 'expense:food', layer: 5, kind: 'expenseCategory', refId: 'food', value: 60, transactionIds: ['expense-available'], refundCoverage: { value: 20, transactionIds: ['refund'] } },
    { id: 'expense:home', layer: 5, kind: 'expenseCategory', refId: 'home', value: 20, transactionIds: ['expense-savings'] },
    { id: 'savingsDeposit:hysa', layer: 5, kind: 'savingsDeposit', savingsGroup: 'accessible', refId: 'hysa', value: 40, transactionIds: ['deposit'] },
  ],
  links: [
    { id: 'salary-income', sourceId: 'income:salary', targetId: 'income', kind: 'income', value: 100, transactionIds: ['income'] },
    { id: 'refund-food-income', sourceId: 'refund:food', targetId: 'refundIncome', kind: 'refund', value: 20, transactionIds: ['refund'] },
    { id: 'income-available', sourceId: 'income', targetId: 'available', kind: 'income', fundingPool: 'available', value: 100, transactionIds: ['income'] },
    { id: 'refund-available', sourceId: 'refundIncome', targetId: 'available', kind: 'refund', fundingPool: 'available', value: 20, transactionIds: ['refund'] },
    {
      id: 'available-savings',
      sourceId: 'available',
      targetId: 'savingsAccessible',
      kind: 'bridge',
      fundingPool: 'available',
      value: 40,
      transactionIds: ['deposit'],
      details: { availableToSavings: { value: 50, transactionIds: ['deposit'] }, savingsToAvailable: { value: 10, transactionIds: ['withdraw'] }, net: 40 },
    },
    { id: 'available-expenses', sourceId: 'available', targetId: 'expenses', kind: 'expense', fundingPool: 'available', value: 80, transactionIds: ['expense-available'] },
    {
      id: 'savings-deposited',
      sourceId: 'savingsAccessible',
      targetId: 'savingsDeposited:accessible',
      kind: 'savingsDeposit',
      fundingPool: 'savingsAccessible',
      value: 40,
      transactionIds: ['deposit'],
    },
    { id: 'expenses-food', sourceId: 'expenses', targetId: 'expense:food', kind: 'expense', fundingPool: 'available', value: 60, transactionIds: ['expense-available'] },
    { id: 'expenses-home', sourceId: 'expenses', targetId: 'expense:home', kind: 'expense', fundingPool: 'available', value: 20, transactionIds: ['expense-savings'] },
    {
      id: 'deposited-hysa',
      sourceId: 'savingsDeposited:accessible',
      targetId: 'savingsDeposit:hysa',
      kind: 'savingsDeposit',
      fundingPool: 'savingsAccessible',
      value: 40,
      transactionIds: ['deposit'],
    },
  ],
}

test('packed ribbons close at square node edges and never overfill a pool', () => {
  assert.equal(typeof ChartUtils.buildMoneyFlowGraphGeometry, 'function')

  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...layeredGeometryGraph, isDesktop: true, renderedWidth: 900, mode: 'full' })

  assert.equal(
    geometry.ribbons.every(({ path }) => path.startsWith('M ') && path.endsWith(' Z')),
    true,
  )
  assert.equal(
    geometry.ribbons.every(({ strokeWidth }) => strokeWidth === undefined),
    true,
  )
  assert.equal(
    geometry.ribbons.every(({ width, value }) => width === Math.abs(value) * geometry.scale),
    true,
  )
  assert.equal(
    geometry.pools.every(({ incomingWidth, outgoingWidth, span }) => incomingWidth <= span && outgoingWidth <= span),
    true,
  )
})

test('money flow layout preserves stable aggregation order while packing ribbons toward counterparts', () => {
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({
    nodes: [
      { id: 'available', layer: 0, kind: 'available', value: 10, transactionIds: [] },
      { id: 'savings', layer: 0, kind: 'savings', value: 10, transactionIds: [] },
      { id: 'destination:a', layer: 1, kind: 'expenseCategory', value: 10, transactionIds: [] },
      { id: 'destination:z', layer: 1, kind: 'expenseCategory', value: 10, transactionIds: [] },
    ],
    links: [
      { id: '01-savings-a', sourceId: 'savings', targetId: 'destination:a', kind: 'expense', value: 7, transactionIds: [] },
      { id: '02-available-a', sourceId: 'available', targetId: 'destination:a', kind: 'expense', value: 3, transactionIds: [] },
      { id: '03-savings-z', sourceId: 'savings', targetId: 'destination:z', kind: 'expense', value: 3, transactionIds: [] },
      { id: '04-available-z', sourceId: 'available', targetId: 'destination:z', kind: 'expense', value: 7, transactionIds: [] },
    ],
    isDesktop: true,
    renderedWidth: 900,
    mode: 'full',
  })
  const nodePosition = new Map(geometry.nodes.map((node) => [node.id, node.y + node.height / 2]))
  const layerOrder = (layer) =>
    geometry.nodes
      .filter((node) => node.layer === layer)
      .sort((left, right) => left.y - right.y)
      .map(({ id }) => id)
  const endpoints = (ribbon) => {
    const values = ribbon.path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number)
    return { source: (values[1] + values[15]) / 2, target: (values[7] + values[9]) / 2 }
  }

  assert.deepEqual(layerOrder(0), ['available', 'savings'])
  assert.deepEqual(layerOrder(1), ['destination:a', 'destination:z'])
  for (const sourceId of layerOrder(0)) {
    const ribbons = geometry.ribbons.filter((ribbon) => ribbon.sourceId === sourceId).sort((left, right) => endpoints(left).source - endpoints(right).source)
    assert.deepEqual(
      ribbons.map(({ targetId }) => targetId),
      ribbons.map(({ targetId }) => targetId).sort((left, right) => nodePosition.get(left) - nodePosition.get(right)),
    )
  }
  for (const targetId of layerOrder(1)) {
    const ribbons = geometry.ribbons.filter((ribbon) => ribbon.targetId === targetId).sort((left, right) => endpoints(left).target - endpoints(right).target)
    assert.deepEqual(
      ribbons.map(({ sourceId }) => sourceId),
      ribbons.map(({ sourceId }) => sourceId).sort((left, right) => nodePosition.get(left) - nodePosition.get(right)),
    )
  }
})

test('money flow layout keeps amount order and Other last without geometry re-sorting', () => {
  const nodes = [
    { id: 'income:z', layer: 0, kind: 'income', value: 70, transactionIds: [] },
    { id: 'income:a', layer: 0, kind: 'income', value: 30, transactionIds: [] },
    { id: 'other:income', layer: 0, kind: 'otherIncome', value: 10, transactionIds: [] },
    { id: 'income', layer: 1, kind: 'income', value: 110, transactionIds: [] },
  ]
  const links = nodes.slice(0, 3).map((node) => ({ id: `${node.id}->income`, sourceId: node.id, targetId: 'income', kind: 'income', value: node.value, transactionIds: [] }))
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ nodes, links, isDesktop: true, renderedWidth: 900, mode: 'full' })

  assert.deepEqual(
    geometry.nodes
      .filter(({ layer }) => layer === 0)
      .sort((left, right) => left.y - right.y)
      .map(({ id }) => id),
    ['income:z', 'income:a', 'other:income'],
  )
})

test('six-stage geometry gives the Available-to-Savings bridge a measurable transfer span', () => {
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...layeredGeometryGraph, isDesktop: true, renderedWidth: 1200, mode: 'full' })
  const bridge = geometry.ribbons.find(({ kind }) => kind === 'bridge')

  assert.equal(new Set(geometry.nodes.map(({ layer }) => layer).sort()).size, 6)
  assert.equal(bridge.source.layer, 2)
  assert.equal(bridge.target.layer, 3)
  assert.ok(bridge.transferSpan >= 44)
  assert.equal(
    geometry.ribbons.every(({ source, target }) => source.layer < target.layer),
    true,
  )
})

test('ribbon endpoints both preserve direct amount proportionality', () => {
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...layeredGeometryGraph, isDesktop: true, renderedWidth: 1200, mode: 'full' })

  for (const ribbon of geometry.ribbons) {
    assert.equal(ribbon.sourceWidth, Math.abs(ribbon.value) * geometry.scale)
    assert.equal(ribbon.targetWidth, Math.abs(ribbon.value) * geometry.scale)
  }
})

test('money flow item details expose independent source, destination, bridge, and refund evidence', () => {
  assert.equal(typeof ChartUtils.resolveMoneyFlowItemDetails, 'function')
  const bridge = layeredGeometryGraph.links.find(({ kind }) => kind === 'bridge')
  const bridgeDetails = ChartUtils.resolveMoneyFlowItemDetails({ item: bridge, nodes: layeredGeometryGraph.nodes })
  const coveredExpense = layeredGeometryGraph.nodes.find(({ id }) => id === 'expense:food')
  const expenseDetails = ChartUtils.resolveMoneyFlowItemDetails({ item: coveredExpense, nodes: layeredGeometryGraph.nodes })

  assert.deepEqual(bridgeDetails, {
    value: 40,
    sourcePercent: 40 / 120,
    destinationPercent: 1,
    refundCoverage: null,
    bridge: bridge.details,
    transactionIds: ['deposit'],
  })
  assert.deepEqual(expenseDetails, {
    value: 60,
    sourcePercent: null,
    destinationPercent: null,
    refundCoverage: { value: 20, transactionIds: ['refund'] },
    bridge: null,
    transactionIds: ['expense-available', 'refund'],
  })
})

test('reduced Other nodes retain their semantic colors', () => {
  const component = readFileSync(new URL('../../components/analytics/analytics-money-flow.vue', import.meta.url), 'utf8')

  assert.equal(typeof ChartUtils.resolveMoneyFlowSemanticColor, 'function')
  assert.equal(ChartUtils.resolveMoneyFlowSemanticColor({ kind: 'otherExpenseCategory' }), 'var(--expense2)')
  assert.equal(ChartUtils.resolveMoneyFlowSemanticColor({ kind: 'otherSavingsDeposit' }), 'var(--income2)')
  assert.equal(ChartUtils.resolveMoneyFlowSemanticColor({ kind: 'otherDebtPaid' }), 'var(--van-warning-color)')
  assert.equal(ChartUtils.resolveMoneyFlowSemanticColor({ kind: 'otherIncome' }), 'var(--transfer2)')
  assert.match(component, /color: resolveMoneyFlowSemanticColor\(node\)/)
  assert.match(component, /color: resolveMoneyFlowSemanticColor\(link\)/)
})

test('desktop money flow reserves outer label gutters without collapsing internal layers', () => {
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...layeredGeometryGraph, isDesktop: true, renderedWidth: 1000, mode: 'full' })
  const layerPositions = [...new Set(geometry.nodes.map(({ layer, x }) => `${layer}:${x}`))].map((entry) => Number(entry.split(':')[1]))
  const firstLayerNodes = geometry.nodes.filter(({ layer }) => layer === 0)
  const lastLayerNodes = geometry.nodes.filter(({ layer }) => layer === 5)

  assert.ok(firstLayerNodes.every(({ x }) => x >= 192))
  assert.ok(lastLayerNodes.every(({ x, width }) => x + width <= geometry.width - 192))
  assert.equal(layerPositions.length, 6)
  assert.equal(
    layerPositions.slice(1).every((position, index) => position - layerPositions[index] > 0),
    true,
  )
  assert.ok(geometry.scale > 0)
  assert.equal(
    geometry.ribbons.every(({ width }) => width > 0),
    true,
  )
})

test('desktop full geometry grows before scaling eleven packed peers', () => {
  const sourceNodes = Array.from({ length: 11 }, (_, index) => ({ id: `income:${index + 1}`, layer: 0, kind: 'income', refId: String(index + 1), value: 10, transactionIds: [`income-${index + 1}`] }))
  const sourceLinks = sourceNodes.map((node) => ({
    id: `${node.id}->income`,
    sourceId: node.id,
    targetId: 'income',
    kind: 'income',
    value: 10,
    transactionIds: node.transactionIds,
  }))
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({
    nodes: [...sourceNodes, { id: 'income', layer: 1, kind: 'income', value: 110, transactionIds: [] }, { id: 'available', layer: 2, kind: 'available', value: 110, transactionIds: [] }],
    links: [...sourceLinks, { id: 'income->available', sourceId: 'income', targetId: 'available', kind: 'income', fundingPool: 'available', value: 110, transactionIds: [] }],
    isDesktop: true,
    renderedWidth: 900,
    mode: 'full',
  })
  const available = geometry.pools.find(({ id }) => id === 'available')

  assert.ok(geometry.scale > 0)
  assert.equal(
    geometry.ribbons.every(({ width }) => width > 0),
    true,
  )
  assert.ok(geometry.height > 360)
  assert.ok(available.span > 0)
  assert.ok(available.incomingWidth <= available.span && available.outgoingWidth <= available.span)
})

test('full mobile flow preserves baseline spacing and separate 44px interaction targets', () => {
  assert.equal(typeof ChartUtils.resolveMoneyFlowGraphMode, 'function')
  assert.equal(ChartUtils.resolveMoneyFlowGraphMode({ nodes: layeredGeometryGraph.nodes, isDesktop: false, renderedWidth: 390 }), 'full')

  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...layeredGeometryGraph, isDesktop: false, renderedWidth: 390, mode: 'full' })

  assert.ok(geometry.baselineSpacing >= 28)
  assert.equal(
    geometry.nodes.every(({ hitBox }) => hitBox.width >= 44 && hitBox.height >= 44),
    true,
  )
  assert.equal(
    geometry.ribbons.every(({ hitBox }) => hitBox.width >= 44 && hitBox.height >= 44),
    true,
  )
  assert.equal(geometry.width, 390)
  assert.equal(
    geometry.nodes.every(({ hitBox }) => hitBox.x >= 0 && hitBox.x + hitBox.width <= geometry.width),
    true,
  )
})

test('crowded 390px flow condenses outer details without discarding their selection metadata', () => {
  const detailNodes = Array.from({ length: 7 }, (_, index) => ({
    id: `expense:${index + 1}`,
    layer: 5,
    kind: 'expenseCategory',
    refId: String(index + 1),
    value: 10,
    transactionIds: [`expense-${index + 1}`],
  }))
  const detailLinks = detailNodes.map((node) => ({
    id: `expenses-${node.refId}`,
    sourceId: 'expenses',
    targetId: node.id,
    kind: 'expense',
    fundingPool: 'available',
    value: 10,
    transactionIds: node.transactionIds,
  }))
  const graph = {
    nodes: [...layeredGeometryGraph.nodes.filter(({ kind }) => kind !== 'expenseCategory'), ...detailNodes],
    links: [...layeredGeometryGraph.links.filter(({ targetId }) => !targetId.startsWith('expense:')), ...detailLinks],
  }

  assert.equal(ChartUtils.resolveMoneyFlowGraphMode({ nodes: graph.nodes, isDesktop: false, renderedWidth: 390 }), 'condensed')
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...graph, isDesktop: false, renderedWidth: 390, mode: 'condensed' })
  const hiddenNodes = graph.nodes.filter(({ layer, kind }) => (layer === 0 && ['income', 'refund'].includes(kind)) || (layer === 5 && kind === 'expenseCategory'))
  const hiddenNodeIds = new Set(hiddenNodes.map(({ id }) => id))
  const hiddenLinks = graph.links.filter(({ sourceId, targetId }) => hiddenNodeIds.has(sourceId) || hiddenNodeIds.has(targetId))

  assert.deepEqual(
    geometry.nodes.map(({ id }) => id),
    graph.nodes.filter(({ id }) => !hiddenNodeIds.has(id)).map(({ id }) => id),
  )
  assert.deepEqual(
    geometry.nodes.filter(({ kind }) => ['available', 'savings', 'expenses', 'savingsDeposited', 'savingsDeposit'].includes(kind)).map(({ id }) => id),
    ['available', 'savingsAccessible', 'expenses', 'savingsDeposited:accessible', 'savingsDeposit:hysa'],
  )
  assert.deepEqual(
    geometry.details.nodes.map(({ id }) => id),
    hiddenNodes.map(({ id }) => id),
  )
  assert.deepEqual(
    geometry.details.links.map(({ id }) => id),
    hiddenLinks.map(({ id }) => id),
  )
  assert.deepEqual(
    geometry.details.nodes.flatMap(({ transactionIds }) => transactionIds),
    hiddenNodes.flatMap(({ transactionIds }) => transactionIds),
  )
})

test('layered flow renderer uses accessible patterns and emits exact selected graph objects', () => {
  const component = readFileSync(new URL('../../components/charts/layered-money-flow-chart.vue', import.meta.url), 'utf8')

  assert.match(component, /<path[^>]*:d="ribbon\.path" :fill="linkColor\(ribbon\)"/)
  assert.doesNotMatch(component, /stroke-linecap|strokeWidth/)
  assert.match(component, /id="analytics-flow-refund-pattern"/)
  assert.match(component, /id="analytics-flow-savings-accessible-pattern"/)
  assert.match(component, /id="analytics-flow-savings-restricted-pattern"/)
  assert.match(component, /defineEmits\(\['select-node', 'select-link', 'mode-change'\]\)/)
  assert.match(component, /emit\('select-node', node\)/)
  assert.match(component, /emit\('select-link', link\)/)
  assert.match(component, /emit\('mode-change', value\)/)
  assert.match(component, /linkAriaLabel[\s\S]*analytics\.flow\.source[\s\S]*analytics\.flow\.destination/)
  assert.doesNotMatch(component, /<details[\s\S]*analytics-flow-values/)
})

test('money flow hover, focus, tap, outside-dismiss, and keyboard behavior share pinned details', () => {
  const component = readFileSync(new URL('../../components/charts/layered-money-flow-chart.vue', import.meta.url), 'utf8')
  const whiteCss = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')

  assert.match(component, /resolveMoneyFlowItemDetails/)
  assert.match(component, /const pinned = ref\(null\)/)
  assert.match(component, /onClickOutside\(root, clearPinned\)/)
  assert.match(component, /@keydown\.esc\.stop="clearPinned"/)
  assert.match(component, /@keydown\.(?:left|up)\.prevent="focusRelative\(\$event, -1\)"/)
  assert.match(component, /@keydown\.(?:right|down)\.prevent="focusRelative\(\$event, 1\)"/)
  assert.match(component, /class="analytics-flow-hover-details"/)
  assert.match(component, /profileStore\.showAnimations/)
  assert.doesNotMatch(whiteCss, /(?:^|\n)\.analytics-flow-ribbon-shape\s*\{[^}]*transition:/s)
  assert.match(whiteCss, /\.analytics-flow-animated \.analytics-flow-ribbon-shape\s*\{[^}]*transition:/s)
})

test('money flow card uses the layered graph, persisted detail control, and one exact-details popup', () => {
  const component = readFileSync(new URL('../../components/analytics/analytics-money-flow.vue', import.meta.url), 'utf8')

  assert.match(component, /<layered-money-flow-chart/)
  assert.doesNotMatch(component, /<money-flow-chart/)
  assert.match(component, /v-model="analyticsStore\.graphDetail"/)
  assert.match(component, /@select-node="openDetails"/)
  assert.match(component, /@select-link="openDetails"/)
  assert.match(component, /<details class="analytics-flow-exact-values"/)
  assert.match(component, /v-for="link in fullLinks"/)
  assert.equal(component.match(/<app-popup/g)?.length, 1)
  assert.match(component, /resolveMoneyFlowItemDetails/)
  assert.match(component, /selectedItemDetails\.sourcePercent/)
  assert.match(component, /selectedItemDetails\.destinationPercent/)
  assert.match(component, /TransactionFilterUtils\.filters\.id\.toUrl/)
  assert.match(component, /selectedItem\.value\?\.refundCoverage\?\.transactionIds/)
  assert.doesNotMatch(component, /analytics-flow-fx|flow\.meta\.displayCurrencyCode/)
})

test('money flow detail popup keeps long drilldowns inside a bounded scroll region', () => {
  const whiteCss = readFileSync(new URL('../../assets/styles/theme-white.css', import.meta.url), 'utf8')
  const ruleBody = (selector) => {
    const start = whiteCss.indexOf(`${selector} {`)
    assert.notEqual(start, -1, `missing ${selector}`)
    return whiteCss.slice(start, whiteCss.indexOf('}', start) + 1)
  }
  const detailsRule = ruleBody('.analytics-flow-details')
  const listRule = ruleBody('.analytics-flow-details-list')

  assert.match(detailsRule, /height:\s*100%/)
  assert.match(detailsRule, /min-height:\s*0/)
  assert.match(detailsRule, /max-height:\s*100%/)
  assert.match(listRule, /flex:\s*1/)
  assert.match(listRule, /min-height:\s*0/)
  assert.match(listRule, /overflow-y:\s*auto/)
})
