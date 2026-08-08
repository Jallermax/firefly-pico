import { matchRecurringOccurrences } from './AnalyticsRecurringUtils.js'

const FLOW_KEYS = ['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt', 'savingsChange', 'debtChange', 'netWorthChange', 'availableCashChange']
const CUMULATIVE_METRICS = new Set(['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt'])
const SAVINGS_KINDS = new Set(['savingsAccessible', 'savingsRestricted'])
const MONEY_KINDS = new Set(['available', 'savingsAccessible', 'savingsRestricted', 'liability'])

const roundRatio = (value, precision = 6) => Number(value.toFixed(precision))
const validDecimalPlaces = (value) => Number.isInteger(value) && value >= 0 && value <= 8
const roundAmount = (value, currencyDecimalPlaces) => Number(value.toFixed(currencyDecimalPlaces))
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]

const dateKey = (value) => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  }
  return String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null
}

const dateParts = (value) => {
  const key = dateKey(value)
  if (!key) return null
  const [year, month, day] = key.split('-').map(Number)
  return { key, year, month, day, date: new Date(year, month - 1, day) }
}

const formatDate = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
const addDays = (value, count) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + count)
const daysInMonth = (year, month) => new Date(year, month, 0).getDate()
const monthIndex = ({ year, month }) => year * 12 + month - 1
const monthKeyAt = (index) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
const monthEnd = (monthKey) => {
  const [year, month] = String(monthKey ?? '')
    .split('-')
    .map(Number)
  return Number.isInteger(year) && Number.isInteger(month) ? `${monthKey}-${String(daysInMonth(year, month)).padStart(2, '0')}` : null
}

const completedMonths = (today, count) => {
  const current = dateParts(today)
  if (!current || !Number.isInteger(count) || count < 1) return []
  const currentIndex = monthIndex(current)
  return Array.from({ length: count }, (_, index) => monthKeyAt(currentIndex - count + index))
}

const datesAfter = (today, endDate) => {
  const start = dateParts(today)
  const end = dateParts(endDate)
  if (!start || !end || start.key >= end.key) return []
  const dates = []
  for (let cursor = addDays(start.date, 1); formatDate(cursor) <= end.key; cursor = addDays(cursor, 1)) dates.push(formatDate(cursor))
  return dates
}

const emptyTotals = (value = 0) => Object.fromEntries(FLOW_KEYS.map((key) => [key, value]))
const emptyIdSets = () => Object.fromEntries(FLOW_KEYS.map((key) => [key, new Set()]))
const isSavings = (kind) => SAVINGS_KINDS.has(kind)
const amountOf = (entry) => (Number.isFinite(entry?.value) ? Math.abs(entry.value) : null)
const accountIncluded = (account, kind) => {
  const included = account?.includeNetWorth ?? account?.include_net_worth ?? account?.includeInNetWorth ?? account?.attributes?.include_net_worth
  return included === true || (included === undefined && ['available', 'savingsAccessible', 'liability'].includes(kind))
}

const endpointId = (value, endpoint) => String(value?.[`${endpoint}Account`]?.id ?? value?.identity?.[`${endpoint}AccountId`] ?? '')

const projectionContext = (value, accountContexts = null, requireAccountContext = false) => {
  const direction = value?.direction ?? (value?.refund?.isRefund ? 'refund' : value?.sourceKind === 'revenue' ? 'income' : value?.destinationKind === 'expense' ? 'expense' : 'transfer')
  const sourceAccountId = endpointId(value, 'source')
  const destinationAccountId = endpointId(value, 'destination')
  const sourceAccountContext = sourceAccountId ? accountContexts?.[sourceAccountId] : null
  const destinationAccountContext = destinationAccountId ? accountContexts?.[destinationAccountId] : null
  const missingAccountIds = requireAccountContext
    ? unique([sourceAccountId && !sourceAccountContext ? sourceAccountId : null, destinationAccountId && !destinationAccountContext ? destinationAccountId : null]).sort()
    : []
  const missingAccountEndpoints = requireAccountContext
    ? [...(!sourceAccountId || !sourceAccountContext ? ['source'] : []), ...(!destinationAccountId || !destinationAccountContext ? ['destination'] : [])]
    : []
  const sourceKind = requireAccountContext
    ? (sourceAccountContext?.kind ?? null)
    : (sourceAccountContext?.kind ?? value?.sourceKind ?? value?.identity?.sourceKind ?? (direction === 'income' ? 'revenue' : direction === 'expense' ? 'available' : null))
  const destinationKind = requireAccountContext
    ? (destinationAccountContext?.kind ?? null)
    : (destinationAccountContext?.kind ?? value?.destinationKind ?? value?.identity?.destinationKind ?? (direction === 'income' ? 'available' : direction === 'expense' ? 'expense' : null))
  const context = {
    direction,
    sourceKind,
    destinationKind,
    sourceAccountId,
    destinationAccountId,
    categoryId: String(value?.categoryId ?? value?.identity?.categoryId ?? ''),
    isRefund: Boolean(value?.refund?.isRefund || direction === 'refund'),
    sourceIncluded: accountIncluded(sourceAccountContext ?? value?.sourceAccount, sourceKind),
    destinationIncluded: accountIncluded(destinationAccountContext ?? value?.destinationAccount, destinationKind),
  }
  return { context, missingAccountIds, missingAccountEndpoints }
}

const contextKey = (context) =>
  [
    context.direction,
    context.sourceKind,
    context.sourceAccountId,
    context.destinationKind,
    context.destinationAccountId,
    context.categoryId,
    Number(context.isRefund),
    Number(context.sourceIncluded),
    Number(context.destinationIncluded),
  ].join('|')

const flowAmountsFor = (context, amount, currencyDecimalPlaces) => {
  const values = emptyTotals()
  if (!Number.isFinite(amount) || amount === 0) return values
  const sourceSavings = isSavings(context.sourceKind)
  const destinationSavings = isSavings(context.destinationKind)
  const sourceLiability = context.sourceKind === 'liability'
  const destinationLiability = context.destinationKind === 'liability'

  if (context.isRefund && context.sourceKind === 'expense' && MONEY_KINDS.has(context.destinationKind)) values.refunds += amount
  else if (context.sourceKind === 'revenue' && MONEY_KINDS.has(context.destinationKind)) values.income += amount
  if (MONEY_KINDS.has(context.sourceKind) && context.destinationKind === 'expense') values.expenses += amount

  if (!sourceSavings && destinationSavings) values.savingsDeposits += amount
  if (sourceSavings && !destinationSavings) values.savingsWithdrawals += amount
  if (!sourceLiability && destinationLiability) values.debtRepayments += amount
  if (sourceLiability && !destinationLiability) values.newDebt += amount

  values.savingsChange = (destinationSavings ? amount : 0) - (sourceSavings ? amount : 0)
  values.debtChange = (sourceLiability ? amount : 0) - (destinationLiability ? amount : 0)
  values.netWorthChange = (context.destinationIncluded ? amount : 0) - (context.sourceIncluded ? amount : 0)
  values.availableCashChange = values.income + values.refunds + values.savingsWithdrawals + values.newDebt - values.expenses - values.savingsDeposits - values.debtRepayments
  return Object.fromEntries(FLOW_KEYS.map((key) => [key, roundAmount(values[key], currencyDecimalPlaces)]))
}

const affectedMetricsFor = (context, currencyDecimalPlaces) => FLOW_KEYS.filter((key) => flowAmountsFor(context, 1, currencyDecimalPlaces)[key] !== 0)

const addAmounts = (target, values, currencyDecimalPlaces, transactionId = null, ids = null) => {
  for (const key of FLOW_KEYS) {
    target[key] = roundAmount(target[key] + (values[key] ?? 0), currencyDecimalPlaces)
    if (ids && transactionId && values[key]) ids[key].add(String(transactionId))
  }
}

const averageSamples = (samples, currencyDecimalPlaces) =>
  Object.fromEntries(FLOW_KEYS.map((key) => [key, roundAmount(samples[key].reduce((total, value) => total + value, 0) / samples[key].length, currencyDecimalPlaces)]))

const primaryFlow = (amounts) => ['refunds', 'income', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt'].find((key) => amounts[key] > 0) ?? 'transfer'

const candidateEligible = (candidate) => candidate?.source?.authoritative === true || (candidate?.source?.type === 'inferred' && Number(candidate?.confidence?.score) >= 0.6)

const canonicalSemanticValue = (value) => {
  if (value instanceof Date) return dateKey(value)
  if (Array.isArray(value)) return value.map(canonicalSemanticValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalSemanticValue(value[key])]),
  )
}

const canonicalizeCandidates = (candidates) => {
  const groups = new Map()
  for (const candidate of candidates) {
    const candidateId = String(candidate?.id ?? '')
    const canonical = canonicalSemanticValue(candidate)
    const fingerprint = JSON.stringify(canonical)
    const group = groups.get(candidateId) ?? { fingerprints: new Map(), count: 0 }
    group.fingerprints.set(fingerprint, canonical)
    group.count += 1
    groups.set(candidateId, group)
  }

  const accepted = []
  const deduplicatedCandidateIds = []
  const conflictingCandidateIds = []
  for (const candidateId of [...groups.keys()].sort()) {
    const group = groups.get(candidateId)
    if (group.fingerprints.size > 1) conflictingCandidateIds.push(candidateId)
    else {
      accepted.push([...group.fingerprints.values()][0])
      if (group.count > 1) deduplicatedCandidateIds.push(candidateId)
    }
  }
  return { candidates: accepted, deduplicatedCandidateIds, conflictingCandidateIds }
}

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
const usableAuthoritativeConversion = (conversion) => {
  if (
    !conversion ||
    !['exact', 'exactPrimary', 'rate'].includes(conversion.mode) ||
    !nonEmptyString(conversion.sourceCurrency) ||
    !nonEmptyString(conversion.displayCurrency) ||
    conversion.missingCurrency
  )
    return false
  return conversion.mode !== 'rate' || (Number.isFinite(conversion.rate) && conversion.rate > 0 && conversion.isEstimated === true)
}

const candidateProjectionInput = ({ candidate, candidateAmounts, accountContexts }) => {
  const authoritative = candidate?.source?.authoritative === true
  const { context, missingAccountIds, missingAccountEndpoints } = projectionContext(candidate, accountContexts, authoritative)
  const amountEvidence = authoritative ? candidateAmounts?.[candidate.id] : (candidateAmounts?.[candidate.id] ?? { value: candidate?.expectedAmount?.value, conversion: null })
  const reasons = []
  const missingCurrencies = unique([amountEvidence?.conversion?.missingCurrency]).sort()
  if (!amountEvidence) reasons.push('missingAmountEvidence')
  else if (
    !Number.isFinite(amountEvidence.value) ||
    amountEvidence.value <= 0 ||
    (authoritative && !usableAuthoritativeConversion(amountEvidence.conversion)) ||
    (!authoritative && (amountEvidence?.conversion?.mode === 'unavailable' || amountEvidence?.conversion?.missingCurrency))
  )
    reasons.push('unavailableAmount')
  if (missingAccountEndpoints.length > 0 || !context.sourceKind || !context.destinationKind) reasons.push('missingAccountContext')
  return {
    context,
    amount: Number(amountEvidence?.value),
    conversion: amountEvidence?.conversion ?? null,
    reasons: unique(reasons),
    missingCurrencies,
    missingAccountIds,
    missingAccountEndpoints,
  }
}

const candidateConversionAudit = ({ candidateId, conversion, resolution }) => ({
  candidateId: String(candidateId),
  resolution,
  mode: conversion?.mode ?? null,
  sourceCurrency: conversion?.sourceCurrency ?? null,
  displayCurrency: conversion?.displayCurrency ?? null,
  ...(Number.isFinite(conversion?.rate) ? { rate: conversion.rate } : {}),
  isEstimated: conversion?.isEstimated === true,
  missingCurrency: conversion?.missingCurrency ?? null,
})

const candidateEvidenceIds = (candidate) =>
  unique(
    [candidate?.source?.id, ...(candidate?.evidence?.entryIds ?? []), ...(candidate?.evidence?.transactionIds ?? [])].map((value) => (value === null || value === undefined ? null : String(value))),
  ).sort()

const recurringHistoryIds = (candidates) => {
  const entryIds = new Set()
  const transactionIds = new Set()
  for (const candidate of candidates) {
    for (const id of candidate?.evidence?.entryIds ?? []) entryIds.add(String(id))
    for (const id of candidate?.evidence?.transactionIds ?? []) transactionIds.add(String(id))
  }
  return { entryIds, transactionIds }
}

const nextOverdueDate = ({ candidate, today, endDate }) => {
  const future = datesAfter(today, endDate)
  if (future.length === 0) return null
  const evidenceDates = unique((candidate?.evidence?.dates ?? []).map(dateKey)).filter(Boolean)
  if (evidenceDates.length < 3) return future[0]

  const weekdayCounts = new Map()
  for (const value of evidenceDates) {
    const weekday = dateParts(value).date.getDay()
    weekdayCounts.set(weekday, (weekdayCounts.get(weekday) ?? 0) + 1)
  }
  const preferred = [...weekdayCounts.entries()].sort(([leftDay, leftCount], [rightDay, rightCount]) => rightCount - leftCount || leftDay - rightDay)[0]
  if (!preferred || preferred[1] < 2) return future[0]
  return future.slice(0, Math.max(1, candidate?.matching?.dateWindowDays ?? 4)).find((value) => dateParts(value).date.getDay() === preferred[0]) ?? future[0]
}

const distributeAmount = ({ total, futureDates, observedDates, currencyDecimalPlaces }) => {
  const unitScale = 10 ** currencyDecimalPlaces
  const targetUnits = Math.round(Math.abs(total) * unitScale)
  if (targetUnits === 0 || futureDates.length === 0) return { amounts: [], profile: 'none' }
  const observations = observedDates.map(dateParts).filter(Boolean)
  const coveredMonths = new Set(observations.map(({ key }) => key.slice(0, 7))).size
  let supported = observations.length >= 3 && coveredMonths >= 3
  const dayCounts = new Map()
  const weekdayCounts = new Map()
  for (const { day, date } of observations) {
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
    weekdayCounts.set(date.getDay(), (weekdayCounts.get(date.getDay()) ?? 0) + 1)
  }
  let weights = futureDates.map((value) => {
    if (!supported) return 1
    const parts = dateParts(value)
    return ((dayCounts.get(parts.day) ?? 0) * 0.7 + (weekdayCounts.get(parts.date.getDay()) ?? 0) * 0.3) / observations.length
  })
  if (weights.every((value) => value === 0)) {
    weights = futureDates.map(() => 1)
    supported = false
  }
  const totalWeight = weights.reduce((totalValue, value) => totalValue + value, 0)
  const shares = weights.map((weight, index) => {
    const exact = (targetUnits * weight) / totalWeight
    return { index, units: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  let residual = targetUnits - shares.reduce((sum, { units }) => sum + units, 0)
  for (const share of [...shares].sort((left, right) => right.fraction - left.fraction || left.index - right.index)) {
    if (residual === 0) break
    share.units += 1
    residual -= 1
  }
  return {
    amounts: shares.filter(({ units }) => units > 0).map(({ index, units }) => ({ date: futureDates[index], amount: units / unitScale })),
    profile: supported ? 'observedDayAndWeekday' : 'even',
  }
}

const projectedEntry = ({
  id,
  date,
  amount,
  context,
  sourceKind,
  currencyDecimalPlaces,
  candidate = null,
  expectedId = null,
  overdue = false,
  confidence,
  reasons,
  profile = null,
  conversion = null,
}) => {
  const roundedAmount = roundAmount(amount, currencyDecimalPlaces)
  const flowAmounts = flowAmountsFor(context, roundedAmount, currencyDecimalPlaces)
  return {
    id,
    date,
    amount: roundedAmount,
    direction: context.direction,
    metric: primaryFlow(flowAmounts),
    flowFamily: primaryFlow(flowAmounts),
    categoryId: context.categoryId || null,
    sourceAccountId: context.sourceAccountId || null,
    destinationAccountId: context.destinationAccountId || null,
    sourceKind,
    sourceId: String(candidate?.source?.id ?? id),
    candidateId: candidate?.id ?? null,
    expectedId,
    evidenceIds: candidate ? candidateEvidenceIds(candidate) : [],
    flowAmounts,
    confidence,
    reasons,
    overdue,
    ...(conversion ? { conversion: structuredClone(conversion) } : {}),
    ...(profile ? { profile } : {}),
  }
}

export function projectMetricForecast({ metric, actual, historicalAverage, remainingActivity, currentTotal, currencyDecimalPlaces }) {
  const hasCurrentTotal = currentTotal !== null && currentTotal !== undefined
  const actualValue = hasCurrentTotal ? Number(currentTotal) : Number(actual)
  const remainingValue = Number(remainingActivity)
  const historicalValue = historicalAverage === null || historicalAverage === undefined ? null : Number(historicalAverage)
  if (!validDecimalPlaces(currencyDecimalPlaces) || !Number.isFinite(actualValue) || !Number.isFinite(remainingValue) || (historicalValue !== null && !Number.isFinite(historicalValue))) {
    return { metric, actualToDate: null, historicalBaseline: historicalValue, final: null, remainingFromToday: null, progress: null, progressState: 'notApplicable', status: 'unavailable' }
  }

  if (hasCurrentTotal) {
    return {
      metric,
      actualToDate: roundAmount(actualValue, currencyDecimalPlaces),
      historicalBaseline: historicalValue === null ? null : roundAmount(historicalValue, currencyDecimalPlaces),
      final: roundAmount(actualValue + remainingValue, currencyDecimalPlaces),
      remainingFromToday: roundAmount(remainingValue, currencyDecimalPlaces),
      progress: null,
      progressState: 'notApplicable',
      status: historicalValue === null ? 'partial' : 'ready',
    }
  }

  const cumulative = CUMULATIVE_METRICS.has(metric) || metric?.startsWith('category:')
  const roundedActual = roundAmount(actualValue, currencyDecimalPlaces)
  const roundedHistorical = historicalValue === null ? null : roundAmount(historicalValue, currencyDecimalPlaces)
  const remaining = roundAmount(cumulative ? Math.max(0, remainingValue) : remainingValue, currencyDecimalPlaces)
  const final = roundAmount(roundedActual + remaining, currencyDecimalPlaces)
  let progress = null
  let progressState = 'notApplicable'
  if (roundedActual === 0 && final === 0) progressState = 'noExpectedActivity'
  else if (cumulative && roundedHistorical !== null && roundedActual > roundedHistorical) {
    progress = 1
    progressState = 'aboveHistoricalAverage'
  } else if (cumulative && final > 0) {
    progress = roundRatio(Math.min(1, Math.max(0, roundedActual / final)))
    progressState = 'ready'
  } else if (!cumulative && roundedActual !== 0 && final !== 0 && Math.sign(roundedActual) === Math.sign(final)) {
    progress = roundRatio(Math.min(1, Math.max(0, Math.abs(roundedActual / final))))
    progressState = 'ready'
  } else if (!cumulative && roundedActual !== 0 && final !== 0) progressState = 'oppositeDirection'

  return {
    metric,
    actualToDate: roundedActual,
    historicalBaseline: roundedHistorical,
    final,
    remainingFromToday: remaining,
    progress,
    progressState,
    status: historicalValue === null ? 'partial' : 'ready',
  }
}

export function buildRemainingActivityForecast({ ledger, candidates = [], candidateAmounts = {}, accountContexts = {}, fetchCoverage = null, currencyDecimalPlaces, historyMonths, today, endDate }) {
  const todayKey = dateKey(today)
  const endKey = dateKey(endDate)
  const months = completedMonths(todayKey, Number(historyMonths))
  const invalidInput = !todayKey || !endKey || endKey < todayKey || !validDecimalPlaces(currencyDecimalPlaces)
  const entries = [...(ledger?.entries ?? [])]
    .map((entry) => ({ ...entry, date: dateKey(entry?.date), monthKey: dateKey(entry?.date)?.slice(0, 7) ?? entry?.monthKey ?? null }))
    .sort((left, right) => String(left.date ?? '').localeCompare(String(right.date ?? '')) || String(left.id ?? '').localeCompare(String(right.id ?? '')))
  const currentMonthKey = todayKey?.slice(0, 7)
  const relevantEntries = entries.filter((entry) => months.includes(entry.monthKey) || (entry.monthKey === currentMonthKey && entry.date <= todayKey))
  const unavailableEntries = relevantEntries.filter((entry) => !Number.isFinite(entry.value))
  if (invalidInput) {
    const values = emptyTotals(null)
    return {
      actualToDate: values,
      historicalBaseline: { ...values },
      final: { ...values },
      remainingFromToday: { ...values },
      progress: { ...values },
      progressState: Object.fromEntries(FLOW_KEYS.map((key) => [key, 'notApplicable'])),
      confidence: { level: 'unavailable', reasons: ['Missing or unavailable forecast input'] },
      status: 'unavailable',
      statusByMetric: Object.fromEntries(FLOW_KEYS.map((key) => [key, 'unavailable'])),
      dailyProjectedEntries: [],
      actualTransactionIds: Object.fromEntries(FLOW_KEYS.map((key) => [key, []])),
      audit: {
        history: { months, coverage: 'unavailable', samples: null, variableRemainderSamples: null },
        recurring: {
          fulfilledExpectedIds: [],
          remainingExpectedIds: [],
          removedHistoryEntryIds: [],
          suppressedCandidateIds: [],
          unresolvedCandidates: [],
          candidateConversions: [],
          deduplicatedCandidateIds: [],
          conflictingCandidateIds: [],
        },
        unavailable: { affectedMetricIds: [...FLOW_KEYS], missingCurrencies: [], entryIds: [], candidateIds: [] },
        missingCurrencies: [],
        unavailableEntryIds: [],
      },
    }
  }

  const historyFirst = months[0] ?? null
  const historyEnd = monthEnd(months.at(-1))
  const coverageStart = fetchCoverage?.startMonth ?? null
  const coverageEnd = dateKey(fetchCoverage?.endDate)
  const historyReady = Boolean(historyFirst && historyEnd && coverageStart && coverageEnd && coverageStart <= historyFirst && coverageEnd >= historyEnd)
  const canonicalCandidates = canonicalizeCandidates(candidates)
  const eligibleCandidates = canonicalCandidates.candidates.filter(candidateEligible).sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const suppressedCandidateIds = canonicalCandidates.candidates
    .filter((candidate) => !candidateEligible(candidate))
    .map(({ id }) => String(id))
    .sort()
  const currentEntries = entries.filter(({ date }) => date?.startsWith(todayKey.slice(0, 7)) && date <= todayKey)
  const recurring = matchRecurringOccurrences({ candidates: eligibleCandidates, actualEntries: currentEntries, today: todayKey })
  const candidateById = new Map(eligibleCandidates.map((candidate) => [candidate.id, candidate]))
  const recurringIds = recurringHistoryIds(eligibleCandidates)
  const removedHistoryEntryIds = entries
    .filter((entry) => months.includes(entry.monthKey) && (recurringIds.entryIds.has(String(entry.id)) || recurringIds.transactionIds.has(String(entry.transactionId))))
    .map(({ id }) => String(id))
    .sort()
  const removedHistorySet = new Set(removedHistoryEntryIds)

  const affectedMetricIds = new Set()
  const actualUnavailableMetricIds = new Set()
  const historyUnavailableMetricIds = new Set()
  const forecastUnavailableMetricIds = new Set()
  const unavailableEntryIds = []
  const unavailableCandidateIds = new Set()
  const missingCurrencies = new Set()
  const unresolvedCandidates = []
  const candidateConversions = new Map()
  for (const candidateId of canonicalCandidates.conflictingCandidateIds) {
    for (const key of FLOW_KEYS) {
      affectedMetricIds.add(key)
      forecastUnavailableMetricIds.add(key)
    }
    unavailableCandidateIds.add(candidateId)
    const conversion = candidateAmounts?.[candidateId]?.conversion ?? null
    if (conversion?.missingCurrency) missingCurrencies.add(String(conversion.missingCurrency))
    candidateConversions.set(candidateId, candidateConversionAudit({ candidateId, conversion, resolution: 'unresolved' }))
    unresolvedCandidates.push({
      candidateId,
      sourceId: null,
      reasons: ['duplicateCandidateId'],
      affectedMetricIds: [...FLOW_KEYS],
      missingCurrencies: unique([conversion?.missingCurrency]).sort(),
      missingAccountIds: [],
      missingAccountEndpoints: [],
    })
  }
  for (const entry of unavailableEntries) {
    const { context } = projectionContext(entry)
    for (const key of affectedMetricsFor(context, currencyDecimalPlaces)) {
      affectedMetricIds.add(key)
      if (entry.monthKey === todayKey.slice(0, 7)) actualUnavailableMetricIds.add(key)
      if (months.includes(entry.monthKey)) historyUnavailableMetricIds.add(key)
    }
    unavailableEntryIds.push(String(entry.id))
    if (entry?.conversion?.missingCurrency) missingCurrencies.add(String(entry.conversion.missingCurrency))
  }

  const actualToDate = emptyTotals()
  const actualIds = emptyIdSets()
  for (const entry of currentEntries.filter((item) => Number.isFinite(item.value))) {
    const { context } = projectionContext(entry)
    addAmounts(actualToDate, flowAmountsFor(context, amountOf(entry), currencyDecimalPlaces), currencyDecimalPlaces, entry.transactionId, actualIds)
  }

  const historySamples = Object.fromEntries(FLOW_KEYS.map((key) => [key, []]))
  for (const month of months) {
    const totals = emptyTotals()
    for (const entry of entries.filter(({ monthKey, value }) => monthKey === month && Number.isFinite(value))) {
      const { context } = projectionContext(entry)
      addAmounts(totals, flowAmountsFor(context, amountOf(entry), currencyDecimalPlaces), currencyDecimalPlaces)
    }
    for (const key of FLOW_KEYS) historySamples[key].push(totals[key])
  }
  const historicalBaseline = historyReady ? averageSamples(historySamples, currencyDecimalPlaces) : emptyTotals(null)

  const todayDay = dateParts(todayKey).day
  const variableGroups = new Map()
  if (historyReady) {
    for (const entry of entries.filter(({ monthKey, value }) => months.includes(monthKey) && Number.isFinite(value))) {
      if (removedHistorySet.has(String(entry.id))) continue
      const parts = dateParts(entry.date)
      if (!parts || parts.day <= Math.min(todayDay, daysInMonth(parts.year, parts.month))) continue
      const { context } = projectionContext(entry)
      const key = contextKey(context)
      const group = variableGroups.get(key) ?? { key, context, monthly: Object.fromEntries(months.map((month) => [month, 0])), dates: [], evidenceIds: new Set() }
      group.monthly[entry.monthKey] = roundAmount(group.monthly[entry.monthKey] + amountOf(entry), currencyDecimalPlaces)
      group.dates.push(entry.date)
      if (entry.id) group.evidenceIds.add(String(entry.id))
      if (entry.transactionId) group.evidenceIds.add(String(entry.transactionId))
      variableGroups.set(key, group)
    }
  }

  const projected = []
  for (const occurrence of recurring.remaining.sort((left, right) => left.expectedDate.localeCompare(right.expectedDate) || left.expectedId.localeCompare(right.expectedId))) {
    const candidate = candidateById.get(occurrence.candidateId)
    if (!candidate) continue
    const input = candidateProjectionInput({ candidate, candidateAmounts, accountContexts })
    if (input.reasons.length > 0) {
      candidateConversions.set(String(candidate.id), candidateConversionAudit({ candidateId: candidate.id, conversion: input.conversion, resolution: 'unresolved' }))
      const candidateAffectedMetrics = input.reasons.includes('missingAccountContext') ? [...FLOW_KEYS] : affectedMetricsFor(input.context, currencyDecimalPlaces)
      for (const key of candidateAffectedMetrics) {
        affectedMetricIds.add(key)
        forecastUnavailableMetricIds.add(key)
      }
      unavailableCandidateIds.add(String(candidate.id))
      for (const currency of input.missingCurrencies) missingCurrencies.add(currency)
      if (!unresolvedCandidates.some(({ candidateId }) => candidateId === String(candidate.id))) {
        unresolvedCandidates.push({
          candidateId: String(candidate.id),
          sourceId: String(candidate.source.id),
          reasons: input.reasons,
          affectedMetricIds: candidateAffectedMetrics,
          missingCurrencies: input.missingCurrencies,
          missingAccountIds: input.missingAccountIds,
          missingAccountEndpoints: input.missingAccountEndpoints,
        })
      }
      continue
    }
    const expectedDate = occurrence.expectedDate > todayKey ? occurrence.expectedDate : nextOverdueDate({ candidate, today: todayKey, endDate: endKey })
    if (!expectedDate || expectedDate <= todayKey || expectedDate > endKey) continue
    const sourceKind = candidate.source.authoritative ? 'defined' : 'inferred'
    candidateConversions.set(String(candidate.id), candidateConversionAudit({ candidateId: candidate.id, conversion: input.conversion, resolution: 'projected' }))
    projected.push(
      projectedEntry({
        id: `projected:${sourceKind}:${occurrence.expectedId}:${expectedDate}`,
        date: expectedDate,
        amount: input.amount,
        context: input.context,
        sourceKind,
        currencyDecimalPlaces,
        candidate,
        expectedId: occurrence.expectedId,
        overdue: occurrence.expectedDate <= todayKey,
        confidence: structuredClone(candidate.confidence),
        reasons: occurrence.expectedDate <= todayKey ? ['Expected occurrence is overdue and was moved to a future date'] : [...(candidate.confidence?.reasons ?? [])],
        conversion: input.conversion,
      }),
    )
  }

  const futureDates = datesAfter(todayKey, endKey)
  for (const group of [...variableGroups.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const total = roundAmount(months.reduce((sum, month) => sum + group.monthly[month], 0) / months.length, currencyDecimalPlaces)
    const distribution = distributeAmount({ total, futureDates, observedDates: group.dates, currencyDecimalPlaces })
    for (const item of distribution.amounts) {
      const entry = projectedEntry({
        id: `projected:variable:${group.key}:${item.date}`,
        date: item.date,
        amount: item.amount,
        context: group.context,
        sourceKind: 'variable',
        currencyDecimalPlaces,
        confidence: { score: distribution.profile === 'observedDayAndWeekday' ? 0.7 : 0.4, level: distribution.profile === 'observedDayAndWeekday' ? 'medium' : 'low' },
        reasons: [distribution.profile === 'observedDayAndWeekday' ? 'Observed day-of-month and weekday profile' : 'Even fallback because the timing profile is insufficient'],
        profile: distribution.profile,
      })
      entry.evidenceIds = [...group.evidenceIds].sort()
      projected.push(entry)
    }
  }

  projected.sort((left, right) => left.date.localeCompare(right.date) || left.sourceKind.localeCompare(right.sourceKind) || left.id.localeCompare(right.id))
  const remainingFromToday = emptyTotals()
  for (const entry of projected) addAmounts(remainingFromToday, entry.flowAmounts, currencyDecimalPlaces)
  const hasProjectedSource = projected.some(({ sourceKind }) => sourceKind !== 'variable')
  const sourceStatus = historyReady ? 'ready' : hasProjectedSource || recurring.fulfilled.length > 0 ? 'partial' : 'insufficientHistory'
  const orderedAffectedMetricIds = FLOW_KEYS.filter((key) => affectedMetricIds.has(key))
  const status =
    canonicalCandidates.conflictingCandidateIds.length > 0
      ? 'partial'
      : orderedAffectedMetricIds.length === FLOW_KEYS.length
        ? 'unavailable'
        : orderedAffectedMetricIds.length > 0
          ? 'partial'
          : sourceStatus
  const final = emptyTotals(null)
  const progress = emptyTotals(null)
  const progressState = Object.fromEntries(FLOW_KEYS.map((key) => [key, sourceStatus === 'insufficientHistory' ? 'insufficientHistory' : 'notApplicable']))
  const statusByMetric = Object.fromEntries(FLOW_KEYS.map((key) => [key, affectedMetricIds.has(key) ? 'unavailable' : sourceStatus === 'ready' ? 'ready' : sourceStatus]))
  for (const key of FLOW_KEYS) {
    if (actualUnavailableMetricIds.has(key)) actualToDate[key] = null
    if (historyUnavailableMetricIds.has(key)) historicalBaseline[key] = null
    if (forecastUnavailableMetricIds.has(key)) remainingFromToday[key] = null
    if (affectedMetricIds.has(key) || sourceStatus === 'insufficientHistory') continue
    const metric = projectMetricForecast({
      metric: key,
      actual: actualToDate[key],
      historicalAverage: historicalBaseline[key],
      remainingActivity: remainingFromToday[key],
      currencyDecimalPlaces,
    })
    final[key] = metric.final
    progress[key] = metric.progress
    progressState[key] = metric.progressState
  }

  const variableProfiles = unique(projected.filter(({ sourceKind }) => sourceKind === 'variable').map(({ profile }) => profile))
  const confidence = {
    level:
      sourceStatus === 'insufficientHistory'
        ? 'insufficient'
        : status === 'partial' || status === 'unavailable' || variableProfiles.includes('even')
          ? 'low'
          : projected.some(({ sourceKind }) => sourceKind === 'variable')
            ? 'medium'
            : 'high',
    reasons: unique([
      ...(historyReady ? [`Uses ${months.length} completed months`] : ['Selected completed-month history is incomplete']),
      ...(variableProfiles.includes('even') ? ['Some variable activity uses an even daily fallback'] : []),
      ...(sourceStatus === 'partial' ? ['Only defined or recurring evidence is available'] : []),
      ...(orderedAffectedMetricIds.length > 0 ? ['Some forecast inputs are unavailable'] : []),
    ]),
  }

  return {
    actualToDate,
    historicalBaseline,
    final,
    remainingFromToday,
    progress,
    progressState,
    confidence,
    status,
    statusByMetric,
    dailyProjectedEntries: projected,
    actualTransactionIds: Object.fromEntries(FLOW_KEYS.map((key) => [key, [...actualIds[key]].sort()])),
    audit: {
      history: {
        months,
        coverage: historyReady ? 'complete' : coverageStart ? 'partial' : 'unavailable',
        samples: historyReady ? historySamples : null,
        variableRemainderSamples: historyReady
          ? Object.fromEntries([...variableGroups.values()].sort((left, right) => left.key.localeCompare(right.key)).map((group) => [group.key, months.map((month) => group.monthly[month])]))
          : null,
      },
      recurring: {
        fulfilledExpectedIds: recurring.fulfilled.map(({ expectedId }) => expectedId).sort(),
        remainingExpectedIds: recurring.remaining.map(({ expectedId }) => expectedId).sort(),
        removedHistoryEntryIds,
        suppressedCandidateIds,
        unresolvedCandidates: unresolvedCandidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        candidateConversions: [...candidateConversions.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        deduplicatedCandidateIds: canonicalCandidates.deduplicatedCandidateIds,
        conflictingCandidateIds: canonicalCandidates.conflictingCandidateIds,
      },
      unavailable: {
        affectedMetricIds: orderedAffectedMetricIds,
        missingCurrencies: [...missingCurrencies].sort(),
        entryIds: unavailableEntryIds.sort(),
        candidateIds: [...unavailableCandidateIds].sort(),
      },
      missingCurrencies: [...missingCurrencies].sort(),
      unavailableEntryIds: unavailableEntryIds.sort(),
    },
  }
}
