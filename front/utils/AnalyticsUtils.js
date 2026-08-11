import { format, startOfMonth, subMonths } from 'date-fns'
import { sortMoneyFlowPresentationItems } from './AnalyticsCategoryPresentationUtils.js'

const codeOf = (value) => value?.fireflyCode ?? value ?? null
const unique = (values) => [...new Set(values.filter(Boolean))]

export const resolveAnalyticsFxDisclosurePlacements = (disclosure) => (disclosure ? [{ surface: 'page', disclosure }] : [])

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
  if (!Number.isFinite(sourceAmount)) {
    return { value: null, isEstimated: false, missingCurrency: null }
  }
  if (!sourceCurrency || !displayCurrencyCode) {
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

export function buildMonthlyMoneyFlow({ entries = [], monthKey, currencyDecimalPlaces = 2, savingsView }) {
  const nodes = new Map()
  const links = new Map()
  const savingsChanges = new Map()
  const availableSavingsDeposits = []
  const savingsAvailableWithdrawals = []
  const unclassified = { value: 0, transactionIds: new Set() }
  const liabilityReallocations = new Map()
  const pools = {
    available: { incoming: 0, outgoing: 0 },
    savingsAccessible: { incoming: 0, outgoing: 0 },
    savingsRestricted: { incoming: 0, outgoing: 0 },
  }
  const totals = {
    income: 0,
    refunds: 0,
    newDebt: 0,
    expenses: 0,
    debtPaid: 0,
    savingsDeposited: 0,
    excess: 0,
    existingAvailable: 0,
    savingsWithdrawal: 0,
  }
  const coverage = new Map()
  let positiveSavingsMovement = 0
  let negativeSavingsMovement = 0
  const savingsGroup = (kind) => (kind === 'savingsAccessible' ? 'accessible' : 'restricted')
  const savingsPool = (kind) => (['savingsAccessible', 'savingsRestricted'].includes(kind) ? kind : null)
  const accountId = (account, fallback) => String(account?.id ?? fallback)
  const sortedIds = (ids) => [...ids].filter(Boolean).sort()
  const ensureNode = (id, options) => {
    const node = nodes.get(id) ?? { id, ...options, value: 0, transactionIds: new Set() }
    nodes.set(id, node)
    return node
  }
  const addNode = (id, options, value, transactionId) => {
    if (!Number.isFinite(value) || value === 0) return
    const node = ensureNode(id, options)
    node.value += value
    if (transactionId) node.transactionIds.add(transactionId)
  }
  const addLink = (sourceId, targetId, options, value, transactionId) => {
    if (!Number.isFinite(value) || value === 0) return
    const id = `${sourceId}->${targetId}:${options.kind ?? ''}:${options.fundingPool ?? ''}`
    const link = links.get(id) ?? { id, sourceId, targetId, ...options, value: 0, transactionIds: new Set() }
    link.value += value
    if (transactionId) link.transactionIds.add(transactionId)
    links.set(id, link)
  }
  const addPool = (pool, direction, value) => {
    pools[pool][direction] += value
  }
  const addSavingsChange = (kind, account, value, transactionId) => {
    const id = accountId(account, 'unknown-savings')
    const key = `${kind}:${id}`
    const change = savingsChanges.get(key) ?? { id, kind, value: 0, transactionIds: new Set() }
    change.value += value
    if (transactionId) change.transactionIds.add(transactionId)
    savingsChanges.set(key, change)
  }
  const addUnclassified = (value, transactionId) => {
    if (!Number.isFinite(value)) unclassified.value = null
    else if (Number.isFinite(unclassified.value)) unclassified.value += value
    if (transactionId) unclassified.transactionIds.add(transactionId)
  }
  const addSourceToPool = ({ id, options, pool, value, transactionId }) => {
    addNode(id, { layer: 0, ...options }, value, transactionId)
    addNode(
      pool,
      { layer: pool === 'available' ? 2 : 3, kind: pool === 'available' ? 'available' : 'savings', ...(pool === 'available' ? {} : { savingsGroup: savingsGroup(pool) }) },
      value,
      transactionId,
    )
    const groupId = options.kind === 'income' ? 'income' : options.kind === 'refund' ? 'refundIncome' : null
    if (groupId) {
      addNode(groupId, { layer: 1, kind: options.kind }, value, transactionId)
      addLink(id, groupId, { kind: options.kind, fundingPool: pool }, value, transactionId)
      addLink(groupId, pool, { kind: options.kind, fundingPool: pool }, value, transactionId)
    } else addLink(id, pool, { kind: options.kind, fundingPool: pool }, value, transactionId)
    addPool(pool, 'incoming', value)
  }
  const addExistingSavingsSource = ({ account, sourceKind, targetPool, value, transactionId, details = null }) => {
    const refId = accountId(account, 'unknown-savings')
    const sourceId = `savingsWithdrawal:${refId}`
    const group = savingsGroup(sourceKind)
    addNode(sourceId, { layer: 0, kind: 'existingSavings', movementKind: 'savingsWithdrawal', refId, savingsGroup: group }, value, transactionId)
    addNode(
      targetPool,
      { layer: targetPool === 'available' ? 2 : 3, kind: targetPool === 'available' ? 'available' : 'savings', ...(targetPool === 'available' ? {} : { savingsGroup: savingsGroup(targetPool) }) },
      value,
      transactionId,
    )
    addLink(sourceId, targetPool, { kind: details ? 'bridge' : 'existingSavings', fundingPool: targetPool, ...(details ? { details } : {}) }, value, transactionId)
    addPool(targetPool, 'incoming', value)
    negativeSavingsMovement += value
    totals.savingsWithdrawal += value
  }
  const addIncome = (entry, amount, targetKind) => {
    const id = String(entry.categoryId ?? entry.sourceAccount?.id ?? 'uncategorized-income')
    const sourceId = `income:${id}`
    totals.income += amount
    const pool = targetKind === 'available' ? 'available' : savingsPool(targetKind)
    if (pool) {
      addSourceToPool({ id: sourceId, options: { kind: 'income', refId: id }, pool, value: amount, transactionId: entry.transactionId })
      if (pool !== 'available') addSavingsChange(pool, entry.destinationAccount, amount, entry.transactionId)
      return
    }
    if (targetKind === 'liability') addDebtPayment(sourceId, entry.destinationAccount, amount, entry.transactionId, 'income')
  }
  const addRefund = (entry, amount, targetKind) => {
    const category = String(entry.refund?.coverageCategoryId ?? entry.categoryId ?? ANALYTICS_UNCATEGORIZED_ID)
    const sourceId = `refund:${category}`
    totals.refunds += amount
    const pool = targetKind === 'available' ? 'available' : savingsPool(targetKind)
    if (pool) {
      addSourceToPool({ id: sourceId, options: { kind: 'refund', refId: category, receiptSource: true }, pool, value: amount, transactionId: entry.transactionId })
      if (pool !== 'available') addSavingsChange(pool, entry.destinationAccount, amount, entry.transactionId)
      return
    }
    if (targetKind === 'liability') addDebtPayment(sourceId, entry.destinationAccount, amount, entry.transactionId, 'refund')
  }
  const addDebtPayment = (sourceId, account, amount, transactionId, sourceKind = null, fundingPool = null) => {
    const refId = accountId(account, 'unknown-liability')
    if (sourceKind) addNode(sourceId, { layer: 0, kind: sourceKind, refId: sourceId.split(':').slice(1).join(':') }, amount, transactionId)
    addNode('debtPaid', { layer: 4, kind: 'debtPaid' }, amount, transactionId)
    addNode(`debtPaid:${refId}`, { layer: 5, kind: 'debtPaid', refId }, amount, transactionId)
    addLink(sourceId, 'debtPaid', { kind: 'debtPaid', ...(fundingPool ? { fundingPool } : {}) }, amount, transactionId)
    addLink('debtPaid', `debtPaid:${refId}`, { kind: 'debtPaid' }, amount, transactionId)
    totals.debtPaid += amount
  }
  const addExpense = (pool, entry, amount, sourceId = pool) => {
    const category = String(entry.categoryId ?? ANALYTICS_UNCATEGORIZED_ID)
    if (pool) {
      addNode(
        pool,
        { layer: pool === 'available' ? 2 : 3, kind: pool === 'available' ? 'available' : 'savings', ...(pool === 'available' ? {} : { savingsGroup: savingsGroup(pool) }) },
        amount,
        entry.transactionId,
      )
      addPool(pool, 'outgoing', amount)
    }
    addNode('expenses', { layer: 4, kind: 'expenses' }, amount, entry.transactionId)
    addNode(`expense:${category}`, { layer: 5, kind: 'expenseCategory', refId: category }, amount, entry.transactionId)
    addLink(sourceId, 'expenses', { kind: 'expense', ...(pool ? { fundingPool: pool } : {}) }, amount, entry.transactionId)
    addLink('expenses', `expense:${category}`, { kind: 'expense', ...(pool ? { fundingPool: pool } : {}) }, amount, entry.transactionId)
    totals.expenses += amount
  }

  for (const entry of entries) {
    if (entry.refund?.isRefund && entry.refund.coverageMonthKey === monthKey && Number.isFinite(entry.refund.coverageValue)) {
      const category = String(entry.refund.coverageCategoryId ?? entry.categoryId ?? ANALYTICS_UNCATEGORIZED_ID)
      const item = coverage.get(category) ?? { value: 0, transactionIds: new Set() }
      item.value += Math.abs(entry.refund.coverageValue)
      if (entry.transactionId) item.transactionIds.add(entry.transactionId)
      coverage.set(category, item)
    }
    if (entry.monthKey !== monthKey) continue
    if (entry.conversion?.missingCurrency) continue
    if (!Number.isFinite(entry.value)) {
      addUnclassified(null, entry.transactionId)
      continue
    }

    const amount = Math.abs(entry.value)
    const sourceKind = entry.sourceKind
    const destinationKind = entry.destinationKind
    const sourceSavings = savingsPool(sourceKind)
    const destinationSavings = savingsPool(destinationKind)
    if (entry.refund?.isRefund && sourceKind === 'expense' && ['available', 'savingsAccessible', 'savingsRestricted', 'liability'].includes(destinationKind)) {
      addRefund(entry, amount, destinationKind)
      continue
    }
    if (sourceKind === 'revenue' && ['available', 'savingsAccessible', 'savingsRestricted', 'liability'].includes(destinationKind)) {
      addIncome(entry, amount, destinationKind)
      continue
    }
    if ((sourceKind === 'available' || sourceSavings) && destinationKind === 'expense') {
      if (sourceSavings) addExistingSavingsSource({ account: entry.sourceAccount, sourceKind: sourceSavings, targetPool: sourceSavings, value: amount, transactionId: entry.transactionId })
      addExpense(sourceKind === 'available' ? 'available' : sourceSavings, entry, amount)
      continue
    }
    if (sourceKind === 'available' && destinationSavings) {
      availableSavingsDeposits.push({ pool: destinationSavings, account: entry.destinationAccount, value: amount, transactionId: entry.transactionId })
      addSavingsChange(destinationSavings, entry.destinationAccount, amount, entry.transactionId)
      continue
    }
    if (sourceSavings && destinationKind === 'available') {
      savingsAvailableWithdrawals.push({ pool: sourceSavings, account: entry.sourceAccount, value: amount, transactionId: entry.transactionId })
      continue
    }
    if (sourceSavings && destinationSavings) {
      addExistingSavingsSource({ account: entry.sourceAccount, sourceKind: sourceSavings, targetPool: destinationSavings, value: amount, transactionId: entry.transactionId })
      addSavingsChange(destinationSavings, entry.destinationAccount, amount, entry.transactionId)
      continue
    }
    if ((sourceKind === 'available' || sourceSavings) && destinationKind === 'liability') {
      const pool = sourceKind === 'available' ? 'available' : sourceSavings
      if (sourceSavings) addExistingSavingsSource({ account: entry.sourceAccount, sourceKind: sourceSavings, targetPool: sourceSavings, value: amount, transactionId: entry.transactionId })
      addNode(
        pool,
        { layer: pool === 'available' ? 2 : 3, kind: pool === 'available' ? 'available' : 'savings', ...(pool === 'available' ? {} : { savingsGroup: savingsGroup(pool) }) },
        amount,
        entry.transactionId,
      )
      addDebtPayment(pool, entry.destinationAccount, amount, entry.transactionId, null, pool)
      addPool(pool, 'outgoing', amount)
      continue
    }
    if (sourceKind === 'liability' && ['available', 'savingsAccessible', 'savingsRestricted', 'expense'].includes(destinationKind)) {
      const refId = accountId(entry.sourceAccount, 'unknown-liability')
      const sourceId = `newDebt:${refId}`
      totals.newDebt += amount
      if (destinationKind === 'expense') {
        addNode(sourceId, { layer: 0, kind: 'newDebt', refId }, amount, entry.transactionId)
        addExpense(null, entry, amount, sourceId)
      } else {
        const pool = destinationKind === 'available' ? 'available' : destinationSavings
        addSourceToPool({ id: sourceId, options: { kind: 'newDebt', refId }, pool, value: amount, transactionId: entry.transactionId })
        if (destinationSavings) addSavingsChange(destinationSavings, entry.destinationAccount, amount, entry.transactionId)
      }
      continue
    }
    if (sourceKind === 'liability' && destinationKind === 'liability') {
      const sourceId = accountId(entry.sourceAccount, 'unknown-liability')
      const targetId = accountId(entry.destinationAccount, 'unknown-liability')
      const key = `${sourceId}->${targetId}`
      const reallocation = liabilityReallocations.get(key) ?? { sourceId, targetId, value: 0, transactionIds: new Set() }
      reallocation.value += amount
      if (entry.transactionId) reallocation.transactionIds.add(entry.transactionId)
      liabilityReallocations.set(key, reallocation)
      continue
    }
    if (sourceKind === 'available' && destinationKind === 'available') continue
    addUnclassified(amount, entry.transactionId)
  }

  const grossAvailableToSavings = availableSavingsDeposits.reduce((total, item) => total + item.value, 0)
  const grossSavingsToAvailable = savingsAvailableWithdrawals.reduce((total, item) => total + item.value, 0)
  const bridgeDetails = {
    availableToSavings: { value: grossAvailableToSavings, transactionIds: sortedIds(availableSavingsDeposits.map(({ transactionId }) => transactionId)) },
    savingsToAvailable: { value: grossSavingsToAvailable, transactionIds: sortedIds(savingsAvailableWithdrawals.map(({ transactionId }) => transactionId)) },
    net: grossAvailableToSavings - grossSavingsToAvailable,
  }
  const pendingDeposits = availableSavingsDeposits.map((item) => ({ ...item }))
  for (const withdrawal of savingsAvailableWithdrawals) {
    let remaining = withdrawal.value
    for (const deposit of pendingDeposits) {
      if (remaining <= 0) break
      const value = Math.min(remaining, deposit.value)
      if (value <= 0) continue
      addExistingSavingsSource({ account: withdrawal.account, sourceKind: withdrawal.pool, targetPool: deposit.pool, value, transactionId: withdrawal.transactionId })
      remaining -= value
      deposit.value -= value
    }
    if (remaining > 0)
      addExistingSavingsSource({ account: withdrawal.account, sourceKind: withdrawal.pool, targetPool: 'available', value: remaining, transactionId: withdrawal.transactionId, details: bridgeDetails })
  }
  for (const deposit of pendingDeposits) {
    if (deposit.value <= 0) continue
    addNode('available', { layer: 2, kind: 'available' }, deposit.value, deposit.transactionId)
    addNode(deposit.pool, { layer: 3, kind: 'savings', savingsGroup: savingsGroup(deposit.pool) }, deposit.value, deposit.transactionId)
    addLink('available', deposit.pool, { kind: 'bridge', fundingPool: 'available', details: bridgeDetails }, deposit.value, deposit.transactionId)
    addPool('available', 'outgoing', deposit.value)
    addPool(deposit.pool, 'incoming', deposit.value)
  }

  for (const change of savingsChanges.values()) {
    const group = savingsGroup(change.kind)
    if (change.value > 0) {
      const useId = `savingsDeposited:${group}`
      positiveSavingsMovement += change.value
      totals.savingsDeposited += change.value
      addNode(useId, { layer: 4, kind: 'savingsDeposited', savingsGroup: group }, change.value, null)
      addNode(`savingsDeposit:${change.id}`, { layer: 5, kind: 'savingsDeposit', refId: change.id, savingsGroup: group }, change.value, null)
      addLink(change.kind, useId, { kind: 'savingsDeposit', fundingPool: change.kind }, change.value, null)
      addLink(useId, `savingsDeposit:${change.id}`, { kind: 'savingsDeposit', fundingPool: change.kind }, change.value, null)
      addPool(change.kind, 'outgoing', change.value)
      for (const transactionId of change.transactionIds) {
        ensureNode(useId, {}).transactionIds.add(transactionId)
        ensureNode(`savingsDeposit:${change.id}`, {}).transactionIds.add(transactionId)
        links.get(`${change.kind}->${useId}:savingsDeposit:${change.kind}`).transactionIds.add(transactionId)
        links.get(`${useId}->savingsDeposit:${change.id}:savingsDeposit:${change.kind}`).transactionIds.add(transactionId)
      }
    }
  }

  for (const [category, item] of coverage) {
    const node = ensureNode(`expense:${category}`, { layer: 5, kind: 'expenseCategory', refId: category })
    const coverageTransactionIds = sortedIds(item.transactionIds)
    node.refundCoverage = { value: item.value, transactionIds: coverageTransactionIds }
  }

  for (const pool of Object.keys(pools)) {
    const net = pools[pool].incoming - pools[pool].outgoing
    if (pool !== 'available' || net >= 0) continue
    const value = -net
    totals.existingAvailable += value
    addSourceToPool({ id: 'existingAvailable', options: { kind: 'existingAvailable' }, pool, value, transactionId: null })
  }
  const availableNet = pools.available.incoming - pools.available.outgoing
  if (availableNet > 0) {
    totals.excess += availableNet
    addNode('newExcess', { layer: 4, kind: 'newExcess' }, availableNet, null)
    addLink('available', 'newExcess', { kind: 'newExcess', fundingPool: 'available' }, availableNet, null)
    addPool('available', 'outgoing', availableNet)
  }

  for (const pool of Object.keys(pools)) {
    const node = nodes.get(pool)
    if (node) node.value = Math.max(pools[pool].incoming, pools[pool].outgoing)
  }
  const savingsIncoming = pools.savingsAccessible.incoming + pools.savingsRestricted.incoming
  const savingsOutgoing = pools.savingsAccessible.outgoing + pools.savingsRestricted.outgoing

  const audit = {
    pools: {
      available: { ...pools.available, net: pools.available.incoming - pools.available.outgoing },
      savings: { incoming: savingsIncoming, outgoing: savingsOutgoing, net: savingsIncoming - savingsOutgoing },
      savingsAccessible: { ...pools.savingsAccessible, net: pools.savingsAccessible.incoming - pools.savingsAccessible.outgoing },
      savingsRestricted: { ...pools.savingsRestricted, net: pools.savingsRestricted.incoming - pools.savingsRestricted.outgoing },
    },
    totalSources: totals.income + totals.refunds + totals.newDebt + totals.existingAvailable + totals.savingsWithdrawal,
    totalDestinations: totals.expenses + totals.debtPaid + totals.savingsDeposited + totals.excess,
    liabilityIncrease: totals.newDebt,
    liabilityReduction: totals.debtPaid,
    netDebtChange: totals.newDebt - totals.debtPaid,
    positiveSavingsMovement,
    negativeSavingsMovement,
    netSavings: positiveSavingsMovement - negativeSavingsMovement,
    liabilityReallocations: [...liabilityReallocations.values()].map((entry) => ({ ...entry, transactionIds: sortedIds(entry.transactionIds) })),
    unclassified: unclassified.value,
  }
  audit.equationDifference = audit.totalSources - audit.totalDestinations
  const tolerance = 0.5 * 10 ** -currencyDecimalPlaces
  const poolsBalanced = Object.values(pools).every(({ incoming, outgoing }) => Math.abs(incoming - outgoing) <= tolerance)
  const missingCurrencies = unique(entries.filter(({ monthKey: entryMonthKey }) => entryMonthKey === monthKey).map(({ conversion }) => conversion?.missingCurrency))
  const isBalanced =
    poolsBalanced && Math.abs(audit.equationDifference) <= tolerance && Number.isFinite(unclassified.value) && Math.abs(unclassified.value) <= tolerance && missingCurrencies.length === 0

  const orderedGraph = orderMoneyFlowGraph({
    graph: {
      nodes: [...nodes.values()].map((node) => ({ ...node, transactionIds: sortedIds(node.transactionIds) })),
      links: [...links.values()].map((link) => ({ ...link, transactionIds: sortedIds(link.transactionIds) })),
    },
  })

  return {
    nodes: orderedGraph.nodes,
    links: orderedGraph.links,
    pools: audit.pools,
    audit,
    meta: { savingsView },
    isEstimated: entries.some(({ monthKey: entryMonthKey, isEstimated }) => entryMonthKey === monthKey && isEstimated),
    missingCurrencies,
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

const moneyFlowFamilyKind = (kind) => {
  const value = String(kind ?? '')
  return value.startsWith('other') ? value.charAt(5).toLowerCase() + value.slice(6) : value
}

const sourceFamilyRank = (node) => ({ income: 0, refund: 1, existingAvailable: 2, existingSavings: 2, existingPassThrough: 2, newDebt: 3 })[moneyFlowFamilyKind(node.kind)] ?? 4
const destinationFamilyRank = (node) => ({ expenseCategory: 0, debtPaid: 1, savingsDeposit: 2, newExcess: 3 })[moneyFlowFamilyKind(node.kind)] ?? 4
const middleFamilyRank = (node) =>
  ({ income: 0, refund: 1, passThrough: 2, passThroughPool: 2, available: 3, savings: 4, expenses: 5, debtPaid: 6, savingsDeposited: 7, newExcess: 8 })[moneyFlowFamilyKind(node.kind)] ?? 9

export function orderMoneyFlowGraph({ graph, orderMode = 'amount', labelOf = (node) => node.label ?? node.refId ?? node.id }) {
  const layers = [...new Set(graph.nodes.map(({ layer }) => layer))].sort((left, right) => left - right)
  const sourceLayer = layers.at(0)
  const destinationLayer = layers.at(-1)
  const nodes = layers.flatMap((layer) => {
    const familyRank =
      orderMode === 'type'
        ? layer === sourceLayer && layer !== destinationLayer
          ? sourceFamilyRank
          : layer === destinationLayer && layer !== sourceLayer
            ? destinationFamilyRank
            : middleFamilyRank
        : () => 0
    return sortMoneyFlowPresentationItems(
      graph.nodes.filter((node) => node.layer === layer),
      { familyRank, labelOf },
    )
  })
  const nodeOrder = new Map(nodes.map(({ id }, index) => [id, index]))
  const links = [...graph.links].sort(
    (left, right) =>
      (nodeOrder.get(left.sourceId) ?? 0) - (nodeOrder.get(right.sourceId) ?? 0) || (nodeOrder.get(left.targetId) ?? 0) - (nodeOrder.get(right.targetId) ?? 0) || left.id.localeCompare(right.id),
  )

  return { ...graph, nodes, links }
}

export function limitMoneyFlowGraphDetail({ graph, detailLevel, minimumAmount = 0 }) {
  if (detailLevel === 'all') return graph

  const limit = Number(detailLevel)
  const threshold = Number.isFinite(minimumAmount) && minimumAmount >= 0 ? minimumAmount : 0
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
    const hidden = detailLevel === 'threshold' ? ranked.filter(({ value }) => Math.abs(value) < threshold) : ranked.slice(Number.isFinite(limit) && limit >= 0 ? limit : ranked.length)
    if (detailLevel === 'threshold' && hidden.length < 2) continue
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
      ...(hidden.some(({ refundCoverage }) => refundCoverage)
        ? {
            refundCoverage: {
              value: hidden.reduce((total, node) => total + (node.refundCoverage?.value ?? 0), 0),
              transactionIds: unique(hidden.flatMap(({ refundCoverage }) => refundCoverage?.transactionIds ?? [])).sort(),
            },
          }
        : {}),
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

  return orderMoneyFlowGraph({ graph: { ...graph, nodes: [...graph.nodes.filter(({ id }) => !hiddenToOther.has(id)), ...otherNodes], links: [...rewiredLinks.values()] } })
}

export function buildCategoryLedger({ transactions, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const months = {}
  const missingCurrencies = []
  const unclassifiedTransactionIds = new Set()
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
        amount: item.amount,
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
      if (!Number.isFinite(converted.value)) {
        if (transaction.id) unclassifiedTransactionIds.add(transaction.id)
        continue
      }
      const categoryId = item.category_id ?? ANALYTICS_UNCATEGORIZED_ID
      const month = (months[monthKey] ??= { categories: {} })
      const category = (month.categories[categoryId] ??= { amount: 0, byDay: {}, transactionIds: [], transactionIdsByDay: {} })
      const value = direction * Math.abs(converted.value)
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
    unclassified: { value: unclassifiedTransactionIds.size ? null : 0, transactionIds: [...unclassifiedTransactionIds].sort() },
  }
}

export function buildGrossCategoryLedger({ ledger, coverage = null }) {
  const months = {}
  const unavailableTransactionIds = new Set()
  const unavailableByMonth = {}
  const unavailableByMonthCategory = {}
  const unavailableRefundTransactionIds = new Set()
  const missingCurrencies = new Set()
  const kindFor = (entry, side) => {
    const kind = entry?.[`${side}Kind`]
    if (kind && kind !== 'unknown') return kind
    const accountKind = getAnalyticsAccountKind(entry?.[`${side}Account`])
    return accountKind === 'savings'
      ? entry?.[`${side}Account`]?.attributes?.include_net_worth === true
        ? 'savingsAccessible'
        : 'savingsRestricted'
      : accountKind.startsWith('liability')
        ? 'liability'
        : accountKind
  }
  const isExpense = (entry) => kindFor(entry, 'destination') === 'expense' && ['available', 'savingsAccessible', 'savingsRestricted', 'liability'].includes(kindFor(entry, 'source'))
  const isRefund = (entry) => kindFor(entry, 'source') === 'expense' && (entry?.refund?.isRefund === true || (entry?.refund?.coverageMonthKey && entry?.refund?.coverageCategoryId))

  for (const entry of ledger?.entries ?? []) {
    const key = isRefund(entry) ? (entry.refund?.coverageMonthKey ?? entry?.monthKey) : entry?.monthKey
    const day = Number(entry?.day)
    if (!key || !Number.isInteger(day) || day < 1 || day > 31) continue
    if (!isExpense(entry) && !isRefund(entry)) continue
    const categoryId = String((isRefund(entry) ? entry.refund?.coverageCategoryId : entry.categoryId) ?? ANALYTICS_UNCATEGORIZED_ID)
    const month = (months[key] ??= { categories: {} })
    const category = (month.categories[categoryId] ??= {
      amount: 0,
      byDay: {},
      transactionIds: [],
      transactionIdsByDay: {},
      refundedAmount: 0,
      refundedAmountByDay: {},
      refundTransactionIds: [],
      refundTransactionIdsByDay: {},
      unavailableRefundTransactionIds: [],
    })
    if (!Number.isFinite(entry.value)) {
      if (isExpense(entry)) {
        unavailableTransactionIds.add(entry.transactionId)
        unavailableByMonth[key] = unique([...(unavailableByMonth[key] ?? []), entry.transactionId])
        unavailableByMonthCategory[key] ??= {}
        unavailableByMonthCategory[key][categoryId] = unique([...(unavailableByMonthCategory[key][categoryId] ?? []), entry.transactionId])
      }
      if (isRefund(entry)) {
        unavailableRefundTransactionIds.add(entry.transactionId)
        category.unavailableRefundTransactionIds = unique([...category.unavailableRefundTransactionIds, entry.transactionId])
      }
      if (entry.conversion?.missingCurrency) missingCurrencies.add(entry.conversion.missingCurrency)
      continue
    }
    if (isExpense(entry)) {
      const amount = Math.abs(entry.value)
      category.amount += amount
      category.byDay[day] = (category.byDay[day] ?? 0) + amount
      if (entry.transactionId) {
        category.transactionIds = unique([...category.transactionIds, entry.transactionId])
        category.transactionIdsByDay[day] = unique([...(category.transactionIdsByDay[day] ?? []), entry.transactionId])
      }
    }
    if (isRefund(entry)) {
      category.refundedAmount += Math.abs(entry.value)
      category.refundedAmountByDay[day] = (category.refundedAmountByDay[day] ?? 0) + Math.abs(entry.value)
      if (entry.transactionId) {
        category.refundTransactionIds = unique([...category.refundTransactionIds, entry.transactionId])
        category.refundTransactionIdsByDay[day] = unique([...(category.refundTransactionIdsByDay[day] ?? []), entry.transactionId])
      }
    }
  }

  return {
    months,
    ledgerStartMonth: coverage?.startMonth ?? ledger?.coverage?.startMonth ?? null,
    isEstimated: ledger?.fx?.isEstimated === true,
    missingCurrencies: unique([...missingCurrencies, ...(ledger?.fx?.missingCurrencies ?? [])]),
    unclassified: { value: unavailableTransactionIds.size ? null : 0, transactionIds: [...unavailableTransactionIds].filter(Boolean).sort() },
    unclassifiedByMonth: Object.fromEntries(Object.entries(unavailableByMonth).map(([key, ids]) => [key, [...ids].filter(Boolean).sort()])),
    unclassifiedByMonthCategory: unavailableByMonthCategory,
    unavailableRefundTransactionIds: [...unavailableRefundTransactionIds].filter(Boolean).sort(),
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
    const currentActual = Object.entries(current.byDay).reduce((total, [day, value]) => total + (Number(day) <= todayDay ? value : 0), 0)
    const currentTransactionIds = unique(Object.entries(current.transactionIdsByDay ?? {}).flatMap(([day, transactionIds]) => (Number(day) <= todayDay ? transactionIds : [])))
    const average = usedMonths > 0 ? completedTotal / usedMonths : null

    return {
      id: categoryId,
      actualPoints: monthKeys.map((key) => {
        const category = categoryForMonth(ledger, key, categoryId)
        const refunded = category.refundedAmount ?? 0
        const unavailableTransactionIds = category.unavailableRefundTransactionIds ?? []
        return {
          x: key,
          value: category.amount,
          transactionIds: category.transactionIds,
          refundCoverage: {
            gross: category.amount,
            refunded,
            netCost: unavailableTransactionIds.length ? null : category.amount - refunded,
            transactionIds: category.refundTransactionIds ?? [],
            unavailableTransactionIds,
            status: unavailableTransactionIds.length ? 'unavailable' : refunded ? 'ready' : 'none',
          },
        }
      }),
      average,
      currentActual,
      currentTransactionIds,
      refundedAmount: Object.entries(current.refundedAmountByDay ?? {}).reduce((total, [day, value]) => total + (Number(day) <= todayDay ? value : 0), 0),
      refundTransactionIds: unique(Object.entries(current.refundTransactionIdsByDay ?? {}).flatMap(([day, ids]) => (Number(day) <= todayDay ? ids : []))),
      unavailableRefundTransactionIds: current.unavailableRefundTransactionIds ?? [],
      refundCoverage: {
        gross: currentActual,
        refunded: Object.entries(current.refundedAmountByDay ?? {}).reduce((total, [day, value]) => total + (Number(day) <= todayDay ? value : 0), 0),
        netCost: (current.unavailableRefundTransactionIds ?? []).length
          ? null
          : currentActual - Object.entries(current.refundedAmountByDay ?? {}).reduce((total, [day, value]) => total + (Number(day) <= todayDay ? value : 0), 0),
        transactionIds: unique(Object.entries(current.refundTransactionIdsByDay ?? {}).flatMap(([day, ids]) => (Number(day) <= todayDay ? ids : []))),
        unavailableTransactionIds: current.unavailableRefundTransactionIds ?? [],
        status: (current.unavailableRefundTransactionIds ?? []).length ? 'unavailable' : (current.refundedAmount ?? 0) ? 'ready' : 'none',
      },
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
  const refundCoverage = (items) => {
    const gross = items.reduce((total, item) => total + item.gross, 0)
    const refunded = items.reduce((total, item) => total + item.refunded, 0)
    const unavailableTransactionIds = unique(items.flatMap((item) => item.unavailableTransactionIds))
    return {
      gross,
      refunded,
      netCost: unavailableTransactionIds.length ? null : gross - refunded,
      transactionIds: unique(items.flatMap((item) => item.transactionIds)),
      unavailableTransactionIds,
      status: unavailableTransactionIds.length ? 'unavailable' : refunded ? 'ready' : 'none',
    }
  }
  const actualPoints = categorySummary.monthKeys.map((key, index) => ({
    x: key,
    value: categoryForecasts.reduce((total, category) => total + category.actualPoints[index].value, 0),
    kind: 'actual',
    transactionIds: unique(categoryForecasts.flatMap((category) => category.actualPoints[index].transactionIds)),
    refundCoverage: refundCoverage(categoryForecasts.map((category) => category.actualPoints[index].refundCoverage)),
  }))
  const currentActual = categoryForecasts.reduce((total, category) => total + category.currentActual, 0)

  return {
    requestedMonths: averageMonths,
    usedMonths: categorySummary.usedMonths,
    actualPoints,
    average: categorySummary.usedMonths > 0 ? categoryForecasts.reduce((total, category) => total + category.average, 0) : null,
    currentActual,
    categoryIds,
    categoryForecasts,
    currentTransactionIds: unique(categoryForecasts.flatMap((category) => category.currentTransactionIds)),
    refundCoverage: refundCoverage(categoryForecasts.map((category) => category.refundCoverage)),
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
      const pointForKey = (key) => {
        const sourceKey = sourceMonthKeys.filter((sourceMonthKey) => sourceMonthKey <= key).at(-1)
        return sourceKey ? monthlyPoints[sourceKey] : null
      }
      const totalForKey = (key) => pointForKey(key)?.value ?? null
      const movementIdsFor = (key) => {
        const previousKey = monthKey(subMonths(new Date(key + '-01T00:00:00'), 1))
        const previous = new Set(pointForKey(previousKey)?.transactionIds ?? [])
        const current = new Set(pointForKey(key)?.transactionIds ?? [])
        return [...previous].filter((id) => !current.has(id)).sort()
      }
      const completedMonthKeys = monthKeys.filter((key) => key !== currentMonthKey)
      const precedingCompletedTotal = totalForKey(completedMonthKeys.at(-1))
      const totalPoints = [
        ...completedMonthKeys.flatMap((key) => {
          const value = totalForKey(key)
          return value === null ? [] : [{ x: key, value, kind: 'actual', transactionIds: movementIdsFor(key) }]
        }),
        ...(currentTotal === null || precedingCompletedTotal === null
          ? []
          : [{ x: currentMonthKey, value: currentTotal, kind: 'partial', transactionIds: currentPoint?.transactionIds ?? [], ...currentEstimate }]),
      ]
      const changePoints = monthKeys.flatMap((key) => {
        const previousKey = monthKey(subMonths(new Date(key + '-01T00:00:00'), 1))
        const previous = totalForKey(previousKey)
        const isCurrentMonth = key === currentMonthKey
        const current = isCurrentMonth ? currentTotal : totalForKey(key)
        return previous === null || current === null
          ? []
          : [
              {
                x: key,
                value: current - previous,
                kind: isCurrentMonth ? 'partial' : 'actual',
                transactionIds: isCurrentMonth ? (currentPoint?.transactionIds ?? []) : movementIdsFor(key),
                ...(isCurrentMonth ? currentEstimate : {}),
              },
            ]
      })
      const completedChanges = changePoints.filter(({ kind }) => kind === 'actual')
      const averageChange = completedChanges.length > 0 ? completedChanges.reduce((total, point) => total + point.value, 0) / completedChanges.length : null
      const currentChange = changePoints.find(({ kind }) => kind === 'partial')?.value ?? null

      return {
        id,
        totalPoints,
        changePoints,
        currentTotal,
        currentChange,
        averageChange,
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
      if (view !== 'changes' || !expenses) return []
      const actualPoints = expenses.actualPoints ?? []
      const projectedSources = (expenses.projectedSources ?? []).filter((entry) => Number.isFinite(entry.flowAmounts?.expenses) && entry.flowAmounts.expenses !== 0)
      const forecastMetadata = {
        transactionIds: expenses.actualTransactionIds ?? expenses.currentTransactionIds ?? [],
        actualToDate: expenses.actualToDate,
        final: expenses.final,
        remainingFromToday: expenses.remainingFromToday,
        progress: expenses.progress,
        progressState: expenses.progressState,
        status: expenses.status,
        actualTransactionIds: expenses.actualTransactionIds ?? expenses.currentTransactionIds ?? [],
        actualTransactionCount: (expenses.actualTransactionIds ?? expenses.currentTransactionIds ?? []).length,
        projectedSources,
      }
      return [
        {
          ...metric,
          points: [
            ...actualPoints.filter((point) => point.kind !== 'partial'),
            ...(expenses.forecastAvailable && Number.isFinite(expenses.currentForecast)
              ? [{ x: currentMonthKey + ':forecast', value: expenses.currentForecast, kind: 'forecast', ...forecastMetadata }]
              : []),
          ],
        },
      ]
    }

    const series = accountSeriesById[metric.id]
    if (!series) return []
    const isBalances = view === 'balances'
    const forecastValue = isBalances ? series.forecastTotal : series.forecastChange
    const actualPoints = (isBalances ? series.totalPoints : series.changePoints).filter((point) => point.kind === 'actual')
    const partial = isBalances ? series.totalPoints.find((point) => point.kind === 'partial') : series.changePoints.find((point) => point.kind === 'partial')
    const fallback = !isBalances && actualPoints.length === 0 && partial ? [{ ...partial, inspectionOnly: true }] : []
    const flowKey = { netWorth: 'netWorthChange', debt: 'debtChange', savings: 'savingsChange' }[metric.id]
    const projectedSources = (series.projectedSources ?? []).filter((entry) => {
      if (flowKey) return Number.isFinite(entry.flowAmounts?.[flowKey]) && entry.flowAmounts[flowKey] !== 0
      const savingsKind = metric.id === 'savingsIncluded' ? 'savingsAccessible' : metric.id === 'savingsExcluded' ? 'savingsRestricted' : null
      return savingsKind ? (entry.destinationKind === savingsKind ? entry.amount : entry.sourceKind === savingsKind ? -entry.amount : 0) !== 0 : false
    })
    const forecastMetadata = {
      transactionIds: series.actualTransactionIds ?? partial?.transactionIds ?? [],
      actualToDate: series.actualToDate,
      final: series.final,
      remainingFromToday: series.remainingFromToday,
      progress: series.progress,
      progressState: series.progressState,
      status: series.status,
      actualTransactionIds: series.actualTransactionIds ?? partial?.transactionIds ?? [],
      actualTransactionCount: (series.actualTransactionIds ?? partial?.transactionIds ?? []).length,
      projectedSources,
    }
    return [
      {
        ...metric,
        points: [
          ...actualPoints,
          ...(isBalances && partial ? [{ ...partial, ...forecastMetadata }] : fallback.map((point) => ({ ...point, ...forecastMetadata }))),
          ...(series.forecastAvailable && Number.isFinite(forecastValue)
            ? [{ x: currentMonthKey + ':forecast', value: forecastValue, kind: 'forecast', partial: series.forecastIsPartial === true, ...forecastMetadata }]
            : []),
        ],
      },
    ]
  })
}

export function formatFinancialTrendForecastValue({ forecastAvailable, status, value, formatValue, insufficientHistoryLabel, unavailableLabel = insufficientHistoryLabel, partialLabel = null }) {
  if (forecastAvailable) {
    const formatted = formatValue(value)
    return partialLabel && ['partial', 'unavailable'].includes(status) && formatted !== '—' ? `${formatted} · ${partialLabel}` : formatted
  }
  return status === 'insufficientHistory' ? insufficientHistoryLabel : unavailableLabel
}

export function rankCategoryIds({ ledger, averageMonths, today }) {
  const monthKeys = completedMonthKeys({ today, averageMonths, ledgerStartMonth: ledger.ledgerStartMonth })
  const categoryIds = unique(monthKeys.flatMap((key) => Object.keys(ledger.months?.[key]?.categories ?? {})))
  return categoryIds
    .filter((id) => monthKeys.some((key) => categoryForMonth(ledger, key, id).amount > 0))
    .sort((left, right) => {
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
