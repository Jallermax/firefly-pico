import { format, startOfMonth, subMonths } from 'date-fns'

const codeOf = (value) => value?.fireflyCode ?? value ?? null
const unique = (values) => [...new Set(values.filter(Boolean))]

export const ANALYTICS_UNCATEGORIZED_ID = 'uncategorized'

export function getAnalyticsAccountGroups(accounts) {
  const active = accounts.filter((account) => account?.attributes?.active === true)
  const typeOf = (account) => codeOf(account?.attributes?.type)
  const roleOf = (account) => codeOf(account?.attributes?.account_role)
  const balanceHolding = (account) => ['asset', 'cash', 'liabilities'].includes(typeOf(account))

  return {
    netWorth: active.filter((account) => balanceHolding(account) && account?.attributes?.include_net_worth === true),
    savingsIncluded: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset' && account?.attributes?.include_net_worth === true),
    savingsExcluded: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset' && account?.attributes?.include_net_worth !== true),
    debt: active.filter((account) => typeOf(account) === 'liabilities'),
  }
}

export function getAnalyticsCurrentAmount({ account, metric, fallbackAmount }) {
  const currentDebt = account?.attributes?.current_debt
  const rawAmount = metric === 'debt' && currentDebt !== null && currentDebt !== undefined && (typeof currentDebt !== 'string' || currentDebt.trim() !== '') ? currentDebt : fallbackAmount
  if (rawAmount === null || rawAmount === undefined || (typeof rawAmount === 'string' && rawAmount.trim() === '')) return null
  const amount = Number(rawAmount)
  if (!Number.isFinite(amount)) return null
  return metric === 'debt' ? Math.abs(amount) : amount
}

export function combineSavingsBalanceSeries({ includedSeries, excludedSeries, includedIsEmpty, excludedIsEmpty }) {
  const series = [
    { value: includedSeries, isEmpty: includedIsEmpty },
    { value: excludedSeries, isEmpty: excludedIsEmpty },
  ]
  if (series.some(({ value, isEmpty }) => !isEmpty && !value)) return null

  const nonEmptySeries = series.filter(({ isEmpty }) => !isEmpty).map(({ value }) => value)
  const metadata = {
    isEstimated: series.some(({ value }) => value?.isEstimated),
    missingCurrencies: unique(series.flatMap(({ value }) => value?.missingCurrencies ?? [])),
    warnings: unique(series.flatMap(({ value }) => value?.warnings ?? [])),
  }
  if (metadata.missingCurrencies.length > 0) return { points: [], currentPoint: null, ...metadata }

  const dates = unique(nonEmptySeries.flatMap(({ points }) => points?.filter((point) => Number.isFinite(point.value)).map(({ x }) => x) ?? [])).sort()
  const points = dates.flatMap((x) => {
    const constituents = nonEmptySeries.map(({ points }) => points?.filter((point) => point.x <= x && Number.isFinite(point.value)).at(-1))
    if (constituents.some((point) => !point)) return []
    const isEstimated = constituents.some((point) => point.isEstimated)
    return [{ x, value: constituents.reduce((total, point) => total + point.value, 0), ...(isEstimated ? { isEstimated: true } : {}) }]
  })
  const currentPoints = nonEmptySeries.map(({ currentPoint }) => (Number.isFinite(currentPoint?.value) ? currentPoint : null))
  const currentPoint = currentPoints.every((point) => Number.isFinite(point?.value))
    ? {
        x: currentPoints.at(-1)?.x ?? null,
        value: currentPoints.reduce((total, point) => total + point.value, 0),
        ...(currentPoints.some((point) => point.isEstimated) ? { isEstimated: true } : {}),
      }
    : null

  return { points, currentPoint, ...metadata }
}

export function getAnalyticsAccountKind(account) {
  const type = codeOf(account?.attributes?.type)
  const role = codeOf(account?.attributes?.account_role)
  const direction = codeOf(account?.attributes?.liability_direction)
  if (type === 'expense') return 'expense'
  if (type === 'revenue') return 'revenue'
  if (type === 'asset' && role === 'savingAsset') return 'savings'
  if (type === 'liabilities' && direction === 'debit') return 'liabilityDebit'
  if (type === 'liabilities' && direction === 'credit') return 'liabilityCredit'
  if (type === 'liabilities') return 'liabilityUnknown'
  if (['asset', 'cash'].includes(type)) return 'available'
  return 'other'
}

export function convertAnalyticsAmount({ amount, currencyCode, primaryAmount, primaryCurrencyCode, displayCurrencyCode, rates }) {
  const hasAmount = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
  const hasPrimary = hasAmount(primaryAmount) && primaryCurrencyCode
  const sourceAmountValue = hasPrimary ? primaryAmount : amount
  const sourceCurrency = hasPrimary ? primaryCurrencyCode : currencyCode

  if (!hasAmount(sourceAmountValue)) {
    return { value: null, isEstimated: false, missingCurrency: null }
  }

  const sourceAmount = Number(sourceAmountValue)
  if (!Number.isFinite(sourceAmount) || !sourceCurrency || !displayCurrencyCode) {
    return { value: null, isEstimated: false, missingCurrency: sourceCurrency ?? displayCurrencyCode ?? null }
  }
  if (sourceCurrency === displayCurrencyCode) {
    return { value: sourceAmount, isEstimated: false, missingCurrency: null }
  }

  const sourceRate = Number(rates?.[sourceCurrency])
  const destinationRate = Number(rates?.[displayCurrencyCode])
  if (!Number.isFinite(sourceRate) || !Number.isFinite(destinationRate) || sourceRate === 0) {
    return { value: null, isEstimated: false, missingCurrency: !Number.isFinite(sourceRate) ? sourceCurrency : displayCurrencyCode }
  }

  return {
    value: (sourceAmount * destinationRate) / sourceRate,
    isEstimated: true,
    missingCurrency: null,
  }
}

const accountType = (account) => codeOf(account?.attributes?.type)

const splitDirection = (item) => {
  const sourceType = accountType(item?.accountSource)
  const destinationType = accountType(item?.accountDestination)
  if (destinationType === 'expense') return 1
  if (sourceType === 'expense') return -1
  return 0
}

const splitMonthKey = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  if (Number.isNaN(date.getTime())) return null
  return format(date, 'yyyy-MM')
}

const splitDay = (item) => {
  const date = item?.date instanceof Date ? item.date : new Date(item?.date)
  return Number.isNaN(date.getTime()) ? null : date.getDate()
}

export function buildMonthlyMoneyFlow({ transactions, monthKey, displayCurrencyCode, primaryCurrencyCode, rates, currencyDecimalPlaces = 2, savingsView }) {
  const nodes = new Map()
  const links = new Map()
  const pairs = new Map()
  const savingsChanges = new Map()
  const missingCurrencies = new Set()
  const unclassified = { value: 0, transactionIds: new Set() }
  const liabilityReallocations = new Map()
  const pools = {
    available: { incoming: 0, outgoing: 0 },
    savings: { incoming: 0, outgoing: 0 },
  }
  const totals = {
    income: 0,
    refunds: 0,
    newDebt: 0,
    liabilityCollected: 0,
    expenses: 0,
    debtPaid: 0,
    liabilityExtended: 0,
  }
  const bridge = { availableToSavings: 0, savingsToAvailable: 0, transactionIds: new Set() }
  let isEstimated = false

  const accountId = (account, fallback) => String(account?.id ?? account?.attributes?.name ?? fallback)
  const categoryId = (item, fallback = ANALYTICS_UNCATEGORIZED_ID) => String(item?.category_id ?? fallback)
  const sortedIds = (ids) => [...ids].filter(Boolean).sort()
  const addNode = (id, options, value, transactionId) => {
    if (!Number.isFinite(value) || value === 0) return
    const node = nodes.get(id) ?? { id, ...options, value: 0, transactionIds: new Set() }
    node.value += value
    if (transactionId) node.transactionIds.add(transactionId)
    nodes.set(id, node)
  }
  const addLink = (sourceId, targetId, options, value, transactionId) => {
    if (!Number.isFinite(value) || value === 0) return
    const id = `${sourceId}->${targetId}:${options.kind ?? ''}:${options.fundingPool ?? ''}`
    const link = links.get(id) ?? { id, sourceId, targetId, ...options, value: 0, transactionIds: new Set() }
    link.value += value
    if (transactionId) link.transactionIds.add(transactionId)
    links.set(id, link)
  }
  const addNodeFromIds = (id, options, value, transactionIds) => {
    const ids = sortedIds(transactionIds)
    if (ids.length === 0) return addNode(id, options, value, null)
    for (const transactionId of ids) addNode(id, options, value / ids.length, transactionId)
  }
  const addLinkFromIds = (sourceId, targetId, options, value, transactionIds) => {
    const ids = sortedIds(transactionIds)
    if (ids.length === 0) return addLink(sourceId, targetId, options, value, null)
    for (const transactionId of ids) addLink(sourceId, targetId, options, value / ids.length, transactionId)
  }
  const addPool = (pool, direction, value) => {
    pools[pool][direction] += value
  }
  const addSavingsChange = (account, value, transactionId) => {
    const id = accountId(account, 'unknown-savings')
    const change = savingsChanges.get(id) ?? { value: 0, transactionIds: new Set(), savingsGroup: account?.attributes?.include_net_worth === true ? 'included' : 'excluded' }
    change.value += value
    if (transactionId) change.transactionIds.add(transactionId)
    savingsChanges.set(id, change)
  }
  const addUnclassified = (value, transactionId) => {
    unclassified.value += value
    if (transactionId) unclassified.transactionIds.add(transactionId)
  }
  const addPair = (pool, category, direction, value, transactionId) => {
    const key = `${pool}:${category}`
    const pair = pairs.get(key) ?? { pool, category, purchases: 0, refunds: 0, transactionIds: new Set() }
    pair[direction] += value
    if (transactionId) pair.transactionIds.add(transactionId)
    pairs.set(key, pair)
  }
  const addIncome = (item, amount, transactionId, target) => {
    const revenueAccount = item.accountSource
    const id = String(item.category_id ?? revenueAccount?.id ?? 'uncategorized-income')
    const label = String(item.category_name ?? revenueAccount?.attributes?.name ?? revenueAccount?.id ?? 'uncategorized-income')
    addNode(`income:${id}`, { layer: 0, kind: 'income', refId: id, label }, amount, transactionId)
    addNode('income', { layer: 1, kind: 'income' }, amount, transactionId)
    addLink(`income:${id}`, 'income', { kind: 'income' }, amount, transactionId)
    totals.income += amount
    if (target === 'available' || target === 'savings') {
      addNode(target, { layer: 2, kind: target }, amount, transactionId)
      addLink('income', target, { kind: 'income', fundingPool: target }, amount, transactionId)
      addPool(target, 'incoming', amount)
      if (target === 'savings') addSavingsChange(item.accountDestination, amount, transactionId)
      return
    }
    addLiabilityDestination('income', target, item.accountDestination, amount, transactionId)
  }
  const addRefund = (item, amount, transactionId, target) => {
    const category = categoryId(item)
    const id = `refund:${category}`
    addNode(id, { layer: 0, kind: 'refund', refId: category }, amount, transactionId)
    totals.refunds += amount
    if (target === 'available' || target === 'savings') {
      addNode(target, { layer: 2, kind: target }, amount, transactionId)
      addLink(id, target, { kind: 'refund', fundingPool: target }, amount, transactionId)
      addPool(target, 'incoming', amount)
      if (target === 'savings') addSavingsChange(item.accountDestination, amount, transactionId)
      return
    }
    addLiabilityDestination(id, target, item.accountDestination, amount, transactionId)
  }
  const addLiabilitySource = (sourceKind, account, amount, transactionId, target, item) => {
    const refId = accountId(account, 'unknown-liability')
    const isDebit = sourceKind === 'liabilityDebit'
    const id = `${isDebit ? 'newDebt' : 'liabilityCollected'}:${refId}`
    const kind = isDebit ? 'newDebt' : 'liabilityCollected'
    addNode(id, { layer: 0, kind, refId }, amount, transactionId)
    totals[kind] += amount
    if (target === 'available' || target === 'savings') {
      addNode(target, { layer: 2, kind: target }, amount, transactionId)
      addLink(id, target, { kind, fundingPool: target }, amount, transactionId)
      addPool(target, 'incoming', amount)
      if (target === 'savings') addSavingsChange(item.accountDestination, amount, transactionId)
      return
    }
    if (target === 'expense') {
      const category = categoryId(item)
      addNode('expenses', { layer: 3, kind: 'expenses' }, amount, transactionId)
      addNode(`expense:${category}`, { layer: 4, kind: 'expenseCategory', refId: category }, amount, transactionId)
      addLink(id, 'expenses', { kind }, amount, transactionId)
      addLink('expenses', `expense:${category}`, { kind: 'expense' }, amount, transactionId)
      totals.expenses += amount
    }
  }
  const addLiabilityDestination = (sourceId, destinationKind, account, amount, transactionId, fundingPool = null) => {
    const refId = accountId(account, 'unknown-liability')
    const isDebit = destinationKind === 'liabilityDebit'
    const commonId = isDebit ? 'debtPaid' : 'liabilityExtended'
    const id = `${commonId}:${refId}`
    addNode(commonId, { layer: 3, kind: commonId }, amount, transactionId)
    addNode(id, { layer: 4, kind: commonId, refId }, amount, transactionId)
    addLink(sourceId, commonId, { kind: commonId, ...(fundingPool ? { fundingPool } : {}) }, amount, transactionId)
    addLink(commonId, id, { kind: commonId }, amount, transactionId)
    totals[commonId] += amount
  }

  for (const transaction of transactions) {
    for (const item of transaction?.attributes?.transactions ?? []) {
      if (splitMonthKey(item) !== monthKey) continue
      const converted = convertAnalyticsAmount({
        amount: Math.abs(Number(item.amount)),
        currencyCode: item.currency_code,
        primaryAmount: item.primary_amount,
        primaryCurrencyCode,
        displayCurrencyCode,
        rates,
      })
      if (converted.missingCurrency) {
        missingCurrencies.add(converted.missingCurrency)
        continue
      }
      if (!Number.isFinite(converted.value)) {
        addUnclassified(0, transaction.id)
        continue
      }

      const amount = Math.abs(converted.value)
      const sourceKind = getAnalyticsAccountKind(item.accountSource)
      const destinationKind = getAnalyticsAccountKind(item.accountDestination)
      isEstimated ||= converted.isEstimated

      if (sourceKind === 'revenue' && ['available', 'savings', 'liabilityDebit', 'liabilityCredit'].includes(destinationKind)) {
        addIncome(item, amount, transaction.id, destinationKind)
        continue
      }
      if (sourceKind === 'expense' && ['available', 'savings'].includes(destinationKind)) {
        addPair(destinationKind, categoryId(item), 'refunds', amount, transaction.id)
        if (destinationKind === 'savings') addSavingsChange(item.accountDestination, amount, transaction.id)
        continue
      }
      if (sourceKind === 'expense' && ['liabilityDebit', 'liabilityCredit'].includes(destinationKind)) {
        addRefund(item, amount, transaction.id, destinationKind)
        continue
      }
      if ((sourceKind === 'available' || sourceKind === 'savings') && destinationKind === 'expense') {
        addPair(sourceKind, categoryId(item), 'purchases', amount, transaction.id)
        if (sourceKind === 'savings') addSavingsChange(item.accountSource, -amount, transaction.id)
        continue
      }
      if (sourceKind === 'available' && destinationKind === 'savings') {
        bridge.availableToSavings += amount
        bridge.transactionIds.add(transaction.id)
        addSavingsChange(item.accountDestination, amount, transaction.id)
        continue
      }
      if (sourceKind === 'savings' && destinationKind === 'available') {
        bridge.savingsToAvailable += amount
        bridge.transactionIds.add(transaction.id)
        addSavingsChange(item.accountSource, -amount, transaction.id)
        continue
      }
      if (sourceKind === 'savings' && destinationKind === 'savings') {
        addSavingsChange(item.accountSource, -amount, transaction.id)
        addSavingsChange(item.accountDestination, amount, transaction.id)
        continue
      }
      if (sourceKind === 'available' && destinationKind === 'available') continue
      if ((sourceKind === 'available' || sourceKind === 'savings') && ['liabilityDebit', 'liabilityCredit'].includes(destinationKind)) {
        addNode(sourceKind, { layer: 2, kind: sourceKind }, amount, transaction.id)
        addLiabilityDestination(sourceKind, destinationKind, item.accountDestination, amount, transaction.id, sourceKind)
        addPool(sourceKind, 'outgoing', amount)
        if (sourceKind === 'savings') addSavingsChange(item.accountSource, -amount, transaction.id)
        continue
      }
      if (['liabilityDebit', 'liabilityCredit'].includes(sourceKind) && ['available', 'savings', 'expense'].includes(destinationKind)) {
        addLiabilitySource(sourceKind, item.accountSource, amount, transaction.id, destinationKind, item)
        continue
      }
      if (['liabilityDebit', 'liabilityCredit'].includes(sourceKind) && ['liabilityDebit', 'liabilityCredit'].includes(destinationKind)) {
        const sourceId = accountId(item.accountSource, 'unknown-liability')
        const targetId = accountId(item.accountDestination, 'unknown-liability')
        const key = `${sourceId}->${targetId}`
        const reallocation = liabilityReallocations.get(key) ?? { sourceId, targetId, value: 0, transactionIds: new Set() }
        reallocation.value += amount
        reallocation.transactionIds.add(transaction.id)
        liabilityReallocations.set(key, reallocation)
        continue
      }

      addUnclassified(amount, transaction.id)
    }
  }

  for (const { pool, category, purchases, refunds, transactionIds } of pairs.values()) {
    const net = purchases - refunds
    const ids = sortedIds(transactionIds)
    if (net > 0) {
      addNodeFromIds(pool, { layer: 2, kind: pool }, net, ids)
      addNodeFromIds('expenses', { layer: 3, kind: 'expenses' }, net, ids)
      addNodeFromIds(`expense:${category}`, { layer: 4, kind: 'expenseCategory', refId: category }, net, ids)
      addLinkFromIds(pool, 'expenses', { kind: 'expense', fundingPool: pool }, net, ids)
      addLinkFromIds('expenses', `expense:${category}`, { kind: 'expense', fundingPool: pool }, net, ids)
      addPool(pool, 'outgoing', net)
      totals.expenses += net
    }
    if (net < 0) {
      const value = -net
      const id = `refund:${category}`
      addNodeFromIds(id, { layer: 0, kind: 'refund', refId: category }, value, ids)
      addNodeFromIds(pool, { layer: 2, kind: pool }, value, ids)
      addLinkFromIds(id, pool, { kind: 'refund', fundingPool: pool }, value, ids)
      addPool(pool, 'incoming', value)
      totals.refunds += value
    }
  }

  const netBridge = bridge.availableToSavings - bridge.savingsToAvailable
  for (const transactionId of sortedIds(bridge.transactionIds)) {
    if (netBridge > 0) addLink('available', 'savings', { kind: 'bridge', fundingPool: 'available' }, netBridge / bridge.transactionIds.size, transactionId)
    if (netBridge < 0) addLink('savings', 'available', { kind: 'bridge', fundingPool: 'savings' }, -netBridge / bridge.transactionIds.size, transactionId)
  }
  if (netBridge > 0) {
    addNode('available', { layer: 2, kind: 'available' }, netBridge, null)
    addNode('savings', { layer: 2, kind: 'savings' }, netBridge, null)
    addPool('available', 'outgoing', netBridge)
    addPool('savings', 'incoming', netBridge)
  }
  if (netBridge < 0) {
    addNode('savings', { layer: 2, kind: 'savings' }, -netBridge, null)
    addNode('available', { layer: 2, kind: 'available' }, -netBridge, null)
    addPool('savings', 'outgoing', -netBridge)
    addPool('available', 'incoming', -netBridge)
  }

  let positiveSavingsMovement = 0
  let negativeSavingsMovement = 0
  for (const [id, change] of savingsChanges) {
    if (change.value > 0) {
      positiveSavingsMovement += change.value
      addNodeFromIds('savingsDeposited', { layer: 3, kind: 'savingsDeposited' }, change.value, change.transactionIds)
      addNodeFromIds(`savingsDeposit:${id}`, { layer: 4, kind: 'savingsDeposit', refId: id, savingsGroup: change.savingsGroup }, change.value, change.transactionIds)
      addLinkFromIds('savings', 'savingsDeposited', { kind: 'savingsDeposit' }, change.value, change.transactionIds)
      addLinkFromIds('savingsDeposited', `savingsDeposit:${id}`, { kind: 'savingsDeposit' }, change.value, change.transactionIds)
    }
    if (change.value < 0) {
      const value = -change.value
      negativeSavingsMovement += value
      addNodeFromIds(`existingSavings:${id}`, { layer: 0, kind: 'existingSavings', refId: id, savingsGroup: change.savingsGroup }, value, change.transactionIds)
      addLinkFromIds(`existingSavings:${id}`, 'savings', { kind: 'existingSavings' }, value, change.transactionIds)
    }
  }

  const availableNet = pools.available.incoming - pools.available.outgoing
  const savingsNet = pools.savings.incoming - pools.savings.outgoing
  const newExcess = Math.max(availableNet, 0)
  const existingAvailableFundsUsed = Math.max(-availableNet, 0)
  if (newExcess > 0) {
    addNode('newExcess', { layer: 3, kind: 'newExcess' }, newExcess, null)
    addLink('available', 'newExcess', { kind: 'newExcess' }, newExcess, null)
  }
  if (existingAvailableFundsUsed > 0) {
    addNode('existingAvailable', { layer: 0, kind: 'existingAvailable' }, existingAvailableFundsUsed, null)
    addLink('existingAvailable', 'available', { kind: 'existingAvailable' }, existingAvailableFundsUsed, null)
  }

  for (const pool of ['available', 'savings']) {
    const node = nodes.get(pool)
    if (!node) continue
    node.value = [...links.values()].filter((link) => link.targetId === pool).reduce((total, link) => total + link.value, 0)
  }

  const audit = {
    pools: {
      available: { ...pools.available, net: availableNet },
      savings: { ...pools.savings, net: savingsNet },
    },
    totalSources: totals.income + totals.refunds + totals.newDebt + totals.liabilityCollected + existingAvailableFundsUsed + negativeSavingsMovement,
    totalDestinations: totals.expenses + totals.debtPaid + totals.liabilityExtended + positiveSavingsMovement + newExcess,
    liabilityIncrease: totals.newDebt + totals.liabilityExtended,
    liabilityReduction: totals.debtPaid + totals.liabilityCollected,
    netDebtChange: totals.newDebt + totals.liabilityExtended - totals.debtPaid - totals.liabilityCollected,
    positiveSavingsMovement,
    negativeSavingsMovement,
    netSavings: positiveSavingsMovement - negativeSavingsMovement,
    liabilityReallocations: [...liabilityReallocations.values()].map((entry) => ({ ...entry, transactionIds: sortedIds(entry.transactionIds) })),
    unclassified: unclassified.value,
  }
  audit.equationDifference = audit.totalSources - audit.totalDestinations
  const tolerance = 0.5 * 10 ** -currencyDecimalPlaces
  const availableDifference = pools.available.incoming + existingAvailableFundsUsed - pools.available.outgoing - newExcess
  const savingsDifference = pools.savings.incoming + negativeSavingsMovement - pools.savings.outgoing - positiveSavingsMovement
  const isBalanced =
    Math.abs(availableDifference) <= tolerance &&
    Math.abs(savingsDifference) <= tolerance &&
    Math.abs(audit.equationDifference) <= tolerance &&
    Math.abs(unclassified.value) <= tolerance &&
    missingCurrencies.size === 0

  return {
    nodes: [...nodes.values()].map((node) => ({ ...node, transactionIds: sortedIds(node.transactionIds) })).sort((left, right) => left.id.localeCompare(right.id)),
    links: [...links.values()].map((link) => ({ ...link, transactionIds: sortedIds(link.transactionIds) })).sort((left, right) => left.id.localeCompare(right.id)),
    pools: audit.pools,
    audit,
    meta: { savingsView },
    isEstimated,
    missingCurrencies: [...missingCurrencies].sort(),
    unclassified: { value: unclassified.value, transactionIds: sortedIds(unclassified.transactionIds) },
    isBalanced,
  }
}

const moneyFlowOtherGroups = {
  expenseCategory: 'expenses',
  refund: 'refunds',
  savingsDeposit: 'savingsDeposited',
}

const moneyFlowOtherKind = (kind) => `other${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
const sortedTransactionIds = (items) => unique(items.flatMap(({ transactionIds }) => transactionIds ?? [])).sort()

export function limitMoneyFlowGraphDetail({ graph, detailLevel }) {
  if (detailLevel === 'all') return graph

  const limit = Number(detailLevel)
  const linksByNode = new Map()
  for (const link of graph.links) {
    for (const [side, id] of [
      ['source', link.sourceId],
      ['destination', link.targetId],
    ]) {
      const entries = linksByNode.get(id) ?? []
      entries.push({ side, link })
      linksByNode.set(id, entries)
    }
  }

  const groups = new Map()
  for (const node of graph.nodes.filter(({ refId }) => refId !== undefined && refId !== null)) {
    const connections = linksByNode.get(node.id) ?? []
    const outgoing = connections.filter(({ side }) => side === 'source')
    const incoming = connections.filter(({ side }) => side === 'destination')
    const side = outgoing.length && !incoming.length ? 'source' : 'destination'
    const connectedLinks = side === 'source' ? outgoing : incoming
    const parentIds = unique(connectedLinks.map(({ link }) => (side === 'source' ? link.targetId : link.sourceId))).sort()
    const fundingPools = unique(connectedLinks.map(({ link }) => link.fundingPool)).sort()
    const fundingPool = fundingPools[0] ?? (['savingsDeposit', 'existingSavings'].includes(node.kind) ? 'savings' : 'none')
    const sign = side === 'source' || node.value < 0 ? 'negative' : 'positive'
    const groupName = moneyFlowOtherGroups[node.kind] ?? node.kind
    const key = [side, groupName, parentIds.join(','), fundingPools.join(','), fundingPool, sign, node.savingsGroup ?? ''].join(':')
    const group = groups.get(key) ?? { nodes: [], side, groupName, parentIds, fundingPools, fundingPool, sign, savingsGroup: node.savingsGroup }
    group.nodes.push(node)
    groups.set(key, group)
  }

  const hiddenToOther = new Map()
  const otherNodes = []
  const reducedGroups = []
  for (const group of groups.values()) {
    const ranked = [...group.nodes].sort((left, right) => Math.abs(right.value) - Math.abs(left.value) || String(left.refId ?? left.id).localeCompare(String(right.refId ?? right.id)))
    const hidden = ranked.slice(Number.isFinite(limit) && limit >= 0 ? limit : ranked.length)
    if (!hidden.length) continue

    const suffix = group.savingsGroup ? `:${group.savingsGroup}` : ''
    reducedGroups.push({ group, hidden, baseId: `other:${group.groupName}:${group.fundingPool}:${group.sign}${suffix}` })
  }

  const baseIdCounts = new Map()
  for (const { baseId } of reducedGroups) baseIdCounts.set(baseId, (baseIdCounts.get(baseId) ?? 0) + 1)
  for (const { group, hidden, baseId } of reducedGroups) {
    const parentIdentity = group.parentIds.map(encodeURIComponent).join('+')
    const poolIdentity = group.fundingPools.length ? group.fundingPools.map(encodeURIComponent).join('+') : encodeURIComponent(group.fundingPool)
    const compatibilitySuffix = [encodeURIComponent(group.side), parentIdentity, poolIdentity].join(':')
    const id = baseIdCounts.get(baseId) > 1 ? `${baseId}:${compatibilitySuffix}` : baseId
    for (const node of hidden) hiddenToOther.set(node.id, id)
    otherNodes.push({
      id,
      layer: hidden[0].layer,
      kind: moneyFlowOtherKind(hidden[0].kind),
      label: 'Other',
      value: hidden.reduce((total, node) => total + node.value, 0),
      transactionIds: sortedTransactionIds(hidden),
      ...(group.savingsGroup ? { savingsGroup: group.savingsGroup } : {}),
      details: { nodes: hidden },
    })
  }

  if (!hiddenToOther.size) return graph

  const rewiredLinks = new Map()
  for (const link of graph.links) {
    const sourceId = hiddenToOther.get(link.sourceId) ?? link.sourceId
    const targetId = hiddenToOther.get(link.targetId) ?? link.targetId
    if (sourceId === link.sourceId && targetId === link.targetId) {
      rewiredLinks.set(`original:${link.id}`, link)
      continue
    }
    const key = [sourceId, targetId, link.kind ?? '', link.fundingPool ?? ''].join(':')
    const existing = rewiredLinks.get(key)
    if (!existing) {
      rewiredLinks.set(key, { ...link, id: `${sourceId}->${targetId}:${link.kind ?? ''}:${link.fundingPool ?? ''}`, sourceId, targetId, transactionIds: sortedTransactionIds([link]) })
      continue
    }
    existing.value += link.value
    existing.transactionIds = sortedTransactionIds([existing, link])
  }

  const nodes = [...graph.nodes.filter(({ id }) => !hiddenToOther.has(id)), ...otherNodes].sort((left, right) => left.id.localeCompare(right.id))
  const links = [...rewiredLinks.values()].sort((left, right) => left.id.localeCompare(right.id))
  return { ...graph, nodes, links }
}

export function buildCategoryLedger({ transactions, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const months = {}
  const missingCurrencies = []
  let isEstimated = false
  let ledgerStartMonth = null

  for (const transaction of transactions) {
    for (const item of transaction?.attributes?.transactions ?? []) {
      const direction = splitDirection(item)
      const monthKey = splitMonthKey(item)
      const day = splitDay(item)
      if (monthKey && (!ledgerStartMonth || monthKey < ledgerStartMonth)) ledgerStartMonth = monthKey
      if (direction === 0 || !monthKey || !day) continue

      const converted = convertAnalyticsAmount({
        amount: Math.abs(Number(item.amount)),
        currencyCode: item.currency_code,
        primaryAmount: item.primary_amount,
        primaryCurrencyCode,
        displayCurrencyCode,
        rates,
      })
      if (converted.missingCurrency) {
        missingCurrencies.push(converted.missingCurrency)
        continue
      }

      const categoryId = item.category_id ?? ANALYTICS_UNCATEGORIZED_ID
      const month = (months[monthKey] ??= { categories: {} })
      const category = (month.categories[categoryId] ??= { amount: 0, byDay: {}, transactionIds: [], transactionIdsByDay: {} })
      const value = direction * converted.value
      category.amount += value
      category.byDay[day] = (category.byDay[day] ?? 0) + value
      category.transactionIds.push(transaction.id)
      category.transactionIds = unique(category.transactionIds)
      const transactionIdsByDay = (category.transactionIdsByDay[day] ??= [])
      transactionIdsByDay.push(transaction.id)
      category.transactionIdsByDay[day] = unique(transactionIdsByDay)
      isEstimated ||= converted.isEstimated
    }
  }

  return {
    months,
    ledgerStartMonth,
    isEstimated,
    missingCurrencies: unique(missingCurrencies),
  }
}

const monthKey = (date) => format(date, 'yyyy-MM')

const completedMonthKeys = ({ today, averageMonths, ledgerStartMonth }) => {
  const current = startOfMonth(today)
  const requested = Array.from({ length: averageMonths }, (_, index) => monthKey(subMonths(current, averageMonths - index)))
  return ledgerStartMonth ? requested.filter((key) => key >= ledgerStartMonth) : []
}

const categoryForMonth = (ledger, key, categoryId) => ledger.months?.[key]?.categories?.[categoryId] ?? { amount: 0, byDay: {}, transactionIds: [], transactionIdsByDay: {} }

export function summarizeCategoryWindow({ ledger, categoryIds, averageMonths, today }) {
  const monthKeys = completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth })
  const usedMonths = monthKeys.length
  const currentMonthKey = monthKey(today)
  const todayDay = today.getDate()
  const series = categoryIds.map((categoryId) => {
    const current = categoryForMonth(ledger, currentMonthKey, categoryId)
    const completed = monthKeys.map((key) => categoryForMonth(ledger, key, categoryId))
    const completedTotal = completed.reduce((total, category) => total + category.amount, 0)
    const remainderTotal = completed.reduce((total, category) => total + Object.entries(category.byDay).reduce((monthTotal, [day, value]) => monthTotal + (Number(day) > todayDay ? value : 0), 0), 0)
    const averageHistoricalRemainder = usedMonths > 0 ? remainderTotal / usedMonths : 0
    const currentActual = Object.entries(current.byDay).reduce((total, [day, value]) => total + (Number(day) <= todayDay ? value : 0), 0)
    const currentTransactionIds = unique(Object.entries(current.transactionIdsByDay ?? {}).flatMap(([day, transactionIds]) => (Number(day) <= todayDay ? transactionIds : [])))
    const average = usedMonths > 0 ? completedTotal / usedMonths : null
    const forecastAvailable = usedMonths >= 2
    const pacedForecast = forecastAvailable ? currentActual + averageHistoricalRemainder : null
    const currentForecast = forecastAvailable ? Math.max(currentActual, average, pacedForecast) : null
    const remainingFromToday = forecastAvailable ? currentForecast - currentActual : null

    return {
      id: categoryId,
      actualPoints: monthKeys.map((key) => ({
        x: key,
        value: categoryForMonth(ledger, key, categoryId).amount,
        transactionIds: categoryForMonth(ledger, key, categoryId).transactionIds,
      })),
      average,
      currentActual,
      currentTransactionIds,
      pacedForecast,
      currentForecast,
      remainingFromToday,
      forecastAvailable,
    }
  })

  return { requestedMonths: averageMonths, usedMonths, monthKeys, series }
}

export function getForecastCategoryIds({ ledger, averageMonths, today }) {
  const monthKeys = [...completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth }), monthKey(today)]
  return unique(monthKeys.flatMap((key) => Object.keys(ledger.months?.[key]?.categories ?? {}))).sort((left, right) => left.localeCompare(right))
}

export function summarizeTotalExpenseWindow({ ledger, averageMonths, today }) {
  const categoryIds = getForecastCategoryIds({ ledger, averageMonths, today })
  const categorySummary = summarizeCategoryWindow({ ledger, categoryIds, averageMonths, today })
  const categoryForecasts = categorySummary.series
  const actualPoints = categorySummary.monthKeys.map((key, index) => ({ x: key, value: categoryForecasts.reduce((total, category) => total + category.actualPoints[index].value, 0), kind: 'actual' }))
  const currentActual = categoryForecasts.reduce((total, category) => total + category.currentActual, 0)
  const forecastAvailable = categorySummary.usedMonths >= 2
  const currentForecast = forecastAvailable ? categoryForecasts.reduce((total, category) => total + category.currentForecast, 0) : null

  return {
    requestedMonths: averageMonths,
    usedMonths: categorySummary.usedMonths,
    actualPoints,
    average: categorySummary.usedMonths > 0 ? categoryForecasts.reduce((total, category) => total + category.average, 0) : null,
    currentActual,
    currentForecast,
    remainingFromToday: forecastAvailable ? currentForecast - currentActual : null,
    forecastAvailable,
    categoryIds,
    categoryForecasts,
  }
}

const lastMonthlyPoints = (points) =>
  points
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.x) && Number.isFinite(point.value))
    .sort((left, right) => left.x.localeCompare(right.x))
    .reduce((months, point) => ({ ...months, [point.x.slice(0, 7)]: point }), {})

export function summarizeBalanceMovements({ balanceSeries, months, today }) {
  const currentMonth = startOfMonth(today)
  const monthKeys = Array.from({ length: months + 1 }, (_, index) => monthKey(subMonths(currentMonth, months - index)))
  const currentMonthKey = monthKey(today)

  return {
    monthKeys,
    series: balanceSeries.map(({ id, points, currentPoint }) => {
      const monthlyPoints = lastMonthlyPoints(points)
      const currentTotal = Number.isFinite(currentPoint?.value) ? currentPoint.value : null
      const currentEstimate = currentPoint?.isEstimated ? { isEstimated: true } : {}
      const sourceMonthKeys = Object.keys(monthlyPoints).sort()
      const totalForKey = (key) => {
        const sourceKey = sourceMonthKeys.filter((sourceMonthKey) => sourceMonthKey <= key).at(-1)
        return sourceKey ? monthlyPoints[sourceKey].value : null
      }
      const completedMonthKeys = monthKeys.filter((key) => key !== currentMonthKey)
      const precedingCompletedTotal = totalForKey(completedMonthKeys.at(-1))
      const totalPoints = [
        ...completedMonthKeys.flatMap((key) => {
          const value = totalForKey(key)
          return value === null ? [] : [{ x: key, value, kind: 'actual' }]
        }),
        ...(currentTotal === null || precedingCompletedTotal === null ? [] : [{ x: currentMonthKey, value: currentTotal, kind: 'partial', ...currentEstimate }]),
      ]
      const changePoints = monthKeys.flatMap((key) => {
        const previousKey = monthKey(subMonths(new Date(key + '-01T00:00:00'), 1))
        const previous = totalForKey(previousKey)
        const isCurrentMonth = key === currentMonthKey
        const current = isCurrentMonth ? currentTotal : totalForKey(key)
        return previous === null || current === null ? [] : [{ x: key, value: current - previous, kind: isCurrentMonth ? 'partial' : 'actual', ...(isCurrentMonth ? currentEstimate : {}) }]
      })
      const completedChanges = changePoints.filter(({ kind }) => kind === 'actual')
      const averageChange = completedChanges.length > 0 ? completedChanges.reduce((total, point) => total + point.value, 0) / completedChanges.length : null
      const forecastAvailable = completedChanges.length >= 2
      const currentChange = changePoints.find(({ kind }) => kind === 'partial')?.value ?? null
      const forecastChange = forecastAvailable ? averageChange : null
      const forecastTotal = forecastAvailable && precedingCompletedTotal !== null ? precedingCompletedTotal + averageChange : null

      return {
        id,
        totalPoints,
        changePoints,
        currentTotal,
        currentChange,
        averageChange,
        forecastChange,
        forecastTotal,
        remainingFromToday: forecastTotal !== null && currentTotal !== null ? forecastTotal - currentTotal : null,
        forecastAvailable,
      }
    }),
  }
}

export function buildFinancialTrendChartSeries({ view, metrics, selectedIds, accountSeries, expenses, currentMonthKey }) {
  const selected = new Set(selectedIds)
  const accountSeriesById = Object.fromEntries(accountSeries.map((series) => [series.id, series]))

  return metrics.flatMap((metric) => {
    if (!selected.has(metric.id)) return []
    if (metric.id === 'expenses') {
      if (view !== 'changes') return []
      return [
        {
          ...metric,
          points: [
            ...expenses.actualPoints,
            { x: currentMonthKey, value: expenses.currentActual, kind: 'partial' },
            ...(expenses.forecastAvailable && Number.isFinite(expenses.currentForecast) ? [{ x: currentMonthKey + ':forecast', value: expenses.currentForecast, kind: 'forecast' }] : []),
          ],
        },
      ]
    }

    const series = accountSeriesById[metric.id]
    if (!series) return []
    const isBalances = view === 'balances'
    const forecastValue = isBalances ? series.forecastTotal : series.forecastChange
    return [
      {
        ...metric,
        points: [
          ...(isBalances ? series.totalPoints : series.changePoints),
          ...(series.forecastAvailable && Number.isFinite(forecastValue) ? [{ x: currentMonthKey + ':forecast', value: forecastValue, kind: 'forecast' }] : []),
        ],
      },
    ]
  })
}

export function formatFinancialTrendForecastValue({ forecastAvailable, value, formatValue, insufficientHistoryLabel }) {
  return forecastAvailable ? formatValue(value) : insufficientHistoryLabel
}

export function rankCategoryIds({ ledger, averageMonths, today }) {
  const monthKeys = completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth })
  const categoryIds = unique(monthKeys.flatMap((key) => Object.keys(ledger.months?.[key]?.categories ?? {})))
  return categoryIds.sort((left, right) => {
    const leftTotal = monthKeys.reduce((total, key) => total + categoryForMonth(ledger, key, left).amount, 0)
    const rightTotal = monthKeys.reduce((total, key) => total + categoryForMonth(ledger, key, right).amount, 0)
    return rightTotal - leftTotal || left.localeCompare(right)
  })
}

const entriesForLine = ({ line, primaryCurrencyCode }) => {
  if (line?.pc_entries && Object.keys(line.pc_entries).length > 0) {
    return {
      entries: line.pc_entries,
      currencyCode: line.primary_currency_code ?? line.pc_currency_code ?? primaryCurrencyCode,
      isPrimary: true,
    }
  }
  return {
    entries: line?.entries ?? {},
    currencyCode: line?.currency_code,
    isPrimary: false,
  }
}

const normalizeChartDateKey = (value) => {
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)
  return match?.[1] ?? null
}

export function normalizeBalanceSeries({ chartLines, metric, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const normalizedLines = chartLines.map((line) => {
    const source = entriesForLine({ line, primaryCurrencyCode })
    const points = Object.entries(source.entries)
      .map(([x, amount]) => ({ x: normalizeChartDateKey(x), amount }))
      .filter(({ x }) => x)
      .sort((left, right) => left.x.localeCompare(right.x))
      .map(({ x, amount }) => {
        const converted = convertAnalyticsAmount({
          amount,
          currencyCode: source.currencyCode,
          primaryAmount: source.isPrimary ? amount : null,
          primaryCurrencyCode: source.isPrimary ? source.currencyCode : primaryCurrencyCode,
          displayCurrencyCode,
          rates,
        })
        return { x, ...converted }
      })
    return { points }
  })

  const xValues = unique(normalizedLines.flatMap((line) => line.points.map(({ x }) => x))).sort()
  const missingCurrencies = unique(normalizedLines.flatMap((line) => line.points.map(({ missingCurrency }) => missingCurrency)))
  const isEstimated = normalizedLines.some((line) => line.points.some((point) => point.isEstimated))

  const points = xValues
    .map((x) => {
      let value = 0
      let hasValue = false
      let isPointEstimated = false
      for (const line of normalizedLines) {
        const available = line.points.filter((point) => point.x <= x && point.value !== null)
        const point = available.at(-1)
        if (!point) continue
        hasValue = true
        isPointEstimated ||= point.isEstimated
        value += metric === 'debt' ? Math.abs(point.value) : point.value
      }
      return hasValue ? { x, value, ...(isPointEstimated ? { isEstimated: true } : {}) } : null
    })
    .filter(Boolean)

  return { points, isEstimated, missingCurrencies }
}
