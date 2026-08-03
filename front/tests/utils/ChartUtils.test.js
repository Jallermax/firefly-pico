import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildLineChartGeometry, buildMoneyFlowGeometry, nearestChartPointIndex, nearestPointIndex, resolveMoneyFlowPresentation } from '../../utils/ChartUtils.js'
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

test('money flow uses compact top-to-bottom mobile geometry', () => {
  const geometry = buildMoneyFlowGeometry({
    sources: [
      { id: 'income', value: 75 },
      { id: 'newDebt', value: 25 },
    ],
    destinations: [{ id: 'expenses', value: 100 }],
    total: 100,
    isDesktop: false,
  })

  assert.equal(geometry.viewBox, '0 0 360 620')
  assert.ok(geometry.sources.every((node) => node.labelY < geometry.bus.y && node.path && node.width <= 48))
  assert.ok(geometry.destinations.every((node) => node.labelY > geometry.bus.y + geometry.bus.height && node.path && node.width <= 48))
  assert.equal(geometry.sources[0].textAnchor, 'start')
  assert.equal(geometry.sources[1].textAnchor, 'end')
  const sourceStartY = Number(geometry.sources[0].path.match(/^M \S+ (\S+)/)?.[1])
  const destinationEndY = Number(geometry.destinations[0].path.match(/ (\S+)$/)?.[1])
  assert.ok(sourceStartY - geometry.sources[0].amountY >= 30)
  assert.ok(geometry.destinations[0].labelY - destinationEndY >= 48)
})

test('money flow retains left-to-right desktop geometry', () => {
  const geometry = buildMoneyFlowGeometry({
    sources: [{ id: 'income', value: 100 }],
    destinations: [{ id: 'expenses', value: 100 }],
    total: 100,
    isDesktop: true,
  })

  assert.equal(geometry.viewBox, '0 0 1000 520')
  assert.ok(geometry.sources[0].labelX < geometry.bus.x)
  assert.ok(geometry.destinations[0].labelX > geometry.bus.x + geometry.bus.width)
  assert.equal(geometry.sources[0].width, 180)
  assert.equal(geometry.destinations[0].width, 180)
  const sourceStartX = Number(geometry.sources[0].path.match(/^M (\S+)/)?.[1])
  const destinationEndX = Number(geometry.destinations[0].path.match(/ (\S+) \S+$/)?.[1])
  assert.ok(sourceStartX - geometry.sources[0].labelX >= geometry.sources[0].width / 2 + 20)
  assert.ok(geometry.destinations[0].labelX - destinationEndX >= geometry.destinations[0].width / 2 + 20)
})

test('money flow presentation suppresses an unbalanced diagram without hiding its audit', () => {
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: false, hasNodes: true }), {
    showChart: false,
    showEmpty: false,
    showUnbalancedAudit: true,
  })
  assert.deepEqual(resolveMoneyFlowPresentation({ isBalanced: true, hasNodes: false }), {
    showChart: false,
    showEmpty: true,
    showUnbalancedAudit: false,
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
    { id: 'income', layer: 1, kind: 'income', value: 100, transactionIds: ['income'] },
    { id: 'available', layer: 2, kind: 'available', value: 60, transactionIds: ['expense-available', 'income'] },
    { id: 'savings', layer: 2, kind: 'savings', value: 40, transactionIds: ['expense-savings', 'income'] },
    { id: 'expenses', layer: 3, kind: 'expenses', value: 100, transactionIds: ['expense-available', 'expense-savings'] },
    { id: 'expense:food', layer: 4, kind: 'expenseCategory', refId: 'food', value: 60, transactionIds: ['expense-available'] },
    { id: 'expense:home', layer: 4, kind: 'expenseCategory', refId: 'home', value: 40, transactionIds: ['expense-savings'] },
  ],
  links: [
    { id: 'salary-income', sourceId: 'income:salary', targetId: 'income', kind: 'income', value: 100, transactionIds: ['income'] },
    { id: 'income-available', sourceId: 'income', targetId: 'available', kind: 'income', fundingPool: 'available', value: 60, transactionIds: ['income'] },
    { id: 'income-savings', sourceId: 'income', targetId: 'savings', kind: 'income', fundingPool: 'savings', value: 40, transactionIds: ['income'] },
    { id: 'available-expenses', sourceId: 'available', targetId: 'expenses', kind: 'expense', fundingPool: 'available', value: 60, transactionIds: ['expense-available'] },
    { id: 'savings-expenses', sourceId: 'savings', targetId: 'expenses', kind: 'expense', fundingPool: 'savings', value: 40, transactionIds: ['expense-savings'] },
    { id: 'expenses-food', sourceId: 'expenses', targetId: 'expense:food', kind: 'expense', fundingPool: 'available', value: 60, transactionIds: ['expense-available'] },
    { id: 'expenses-home', sourceId: 'expenses', targetId: 'expense:home', kind: 'expense', fundingPool: 'savings', value: 40, transactionIds: ['expense-savings'] },
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
})

test('crowded 390px flow condenses outer details without discarding their selection metadata', () => {
  const detailNodes = Array.from({ length: 7 }, (_, index) => ({
    id: `expense:${index + 1}`,
    layer: 4,
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
    nodes: [...layeredGeometryGraph.nodes.filter(({ layer }) => layer !== 4), ...detailNodes],
    links: [...layeredGeometryGraph.links.filter(({ targetId }) => !targetId.startsWith('expense:')), ...detailLinks],
  }

  assert.equal(ChartUtils.resolveMoneyFlowGraphMode({ nodes: graph.nodes, isDesktop: false, renderedWidth: 390 }), 'condensed')
  const geometry = ChartUtils.buildMoneyFlowGraphGeometry({ ...graph, isDesktop: false, renderedWidth: 390, mode: 'condensed' })
  const hiddenNodes = graph.nodes.filter(({ layer }) => layer === 0 || layer === 4)
  const hiddenNodeIds = new Set(hiddenNodes.map(({ id }) => id))
  const hiddenLinks = graph.links.filter(({ sourceId, targetId }) => hiddenNodeIds.has(sourceId) || hiddenNodeIds.has(targetId))

  assert.equal(
    geometry.nodes.every(({ layer }) => layer > 0 && layer < 4),
    true,
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

test('layered flow renderer uses filled ribbons and emits exact selected graph objects', () => {
  const component = readFileSync(new URL('../../components/charts/layered-money-flow-chart.vue', import.meta.url), 'utf8')

  assert.match(component, /<path :d="ribbon\.path" :fill="linkColor\(ribbon\)"/)
  assert.doesNotMatch(component, /stroke-linecap|strokeWidth/)
  assert.match(component, /defineEmits\(\['select-node', 'select-link'\]\)/)
  assert.match(component, /emit\('select-node', node\)/)
  assert.match(component, /emit\('select-link', link\)/)
  assert.match(component, /linkAriaLabel[\s\S]*analytics\.flow\.source[\s\S]*analytics\.flow\.destination/)
})
