import { matchRecurringOccurrences } from './AnalyticsRecurringUtils.js'
import { ANALYTICS_UNCATEGORIZED_ID } from './AnalyticsUtils.js'

const FLOW_KEYS = ['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt', 'savingsChange', 'debtChange', 'netWorthChange', 'availableCashChange']
const CUMULATIVE_METRICS = new Set(['income', 'refunds', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt'])
const SAVINGS_KINDS = new Set(['savingsAccessible', 'savingsRestricted'])
const MONEY_KINDS = new Set(['available', 'savingsAccessible', 'savingsRestricted', 'liability'])

const roundRatio = (value, precision = 6) => Number(value.toFixed(precision))
const validDecimalPlaces = (value) => Number.isInteger(value) && value >= 0 && value <= 8
const roundAmount = (value, currencyDecimalPlaces) => Number(value.toFixed(currencyDecimalPlaces))
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]

const stableHash = (value) => {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

const canonicalizeLedgerEntries = (entries) => {
  const byId = new Map()
  const anonymous = []
  for (const entry of entries) {
    if (entry.id === null || entry.id === undefined || entry.id === '') {
      anonymous.push(entry)
      continue
    }
    const id = String(entry.id)
    const variants = byId.get(id) ?? new Map()
    variants.set(JSON.stringify(stableValue(entry)), entry)
    byId.set(id, variants)
  }
  const canonical = [...anonymous]
  const conflicts = []
  for (const [id, variants] of [...byId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (variants.size === 1) canonical.push([...variants.values()][0])
    else conflicts.push({ id, entries: [...variants.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry) })
  }
  return { entries: canonical, conflicts }
}

const usableLedgerValue = (entry) => Number.isFinite(entry?.value) && entry?.conversion?.mode !== 'unavailable' && !entry?.conversion?.missingCurrency

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const recencyWeightedMedian = (samples) => {
  const weighted = samples
    .filter(({ value }) => Number.isFinite(value))
    .map((sample, index) => ({ ...sample, weight: index + 1 }))
    .sort((left, right) => left.value - right.value || left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
  const midpoint = weighted.reduce((total, { weight }) => total + weight, 0) / 2
  let cumulative = 0
  for (const sample of weighted) {
    cumulative += sample.weight
    if (cumulative >= midpoint) return sample.value
  }
  return null
}

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
const calendarDayDistance = (left, right) => Math.abs(Math.round((dateParts(left).date - dateParts(right).date) / 86400000))
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
    : (sourceAccountContext?.kind ??
      value?.sourceAccountKind ??
      value?.identity?.sourceKind ??
      value?.sourceKind ??
      (direction === 'income' ? 'revenue' : direction === 'expense' ? 'available' : null))
  const destinationKind = requireAccountContext
    ? (destinationAccountContext?.kind ?? null)
    : (destinationAccountContext?.kind ??
      value?.destinationAccountKind ??
      value?.identity?.destinationKind ??
      value?.destinationKind ??
      (direction === 'income' ? 'available' : direction === 'expense' ? 'expense' : null))
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

const conflictingRecurringTransactionIds = (entries) => {
  const groups = new Map()
  for (const entry of entries) {
    if (!entry.transactionId || !entry.date || !usableLedgerValue(entry)) continue
    const transactionId = String(entry.transactionId)
    const dates = groups.get(transactionId) ?? new Map()
    dates.set(entry.date, [...(dates.get(entry.date) ?? []), entry])
    groups.set(transactionId, dates)
  }
  return [...groups.entries()]
    .filter(([, dates]) => dates.size > 1 || [...dates.values()].some((dateEntries) => recurringBundleComponents(dateEntries).ambiguousKeys.length > 0))
    .map(([transactionId]) => transactionId)
    .sort()
}

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

const possibleEndpointKinds = (direction, endpoint) => {
  if (direction === 'expense') return endpoint === 'source' ? [...MONEY_KINDS] : ['expense']
  if (direction === 'income') return endpoint === 'source' ? ['revenue'] : [...MONEY_KINDS]
  if (direction === 'refund') return endpoint === 'source' ? ['expense'] : [...MONEY_KINDS]
  if (direction === 'transfer') return [...MONEY_KINDS]
  return []
}

const possibleContextsForMissingAccountContext = (context) => {
  const sourceKinds = context.sourceKind ? [context.sourceKind] : possibleEndpointKinds(context.direction, 'source')
  const destinationKinds = context.destinationKind ? [context.destinationKind] : possibleEndpointKinds(context.direction, 'destination')
  if (sourceKinds.length === 0 || destinationKinds.length === 0) return []

  const contexts = []
  for (const sourceKind of sourceKinds) {
    for (const destinationKind of destinationKinds) {
      contexts.push({
        ...context,
        sourceKind,
        destinationKind,
        sourceIncluded: context.sourceKind ? context.sourceIncluded : accountIncluded(null, sourceKind),
        destinationIncluded: context.destinationKind ? context.destinationIncluded : accountIncluded(null, destinationKind),
      })
    }
  }
  return contexts
}

const potentiallyAffectedMetricsForMissingAccountContext = (context, currencyDecimalPlaces) => {
  const affected = new Set(possibleContextsForMissingAccountContext(context).flatMap((possibleContext) => affectedMetricsFor(possibleContext, currencyDecimalPlaces)))
  return affected.size ? FLOW_KEYS.filter((key) => affected.has(key)) : [...FLOW_KEYS]
}

const partialFlowAmountsForMissingAccountContext = (context, amount, currencyDecimalPlaces) => {
  const possibilities = possibleContextsForMissingAccountContext(context).map((possibleContext) => flowAmountsFor(possibleContext, amount, currencyDecimalPlaces))
  if (possibilities.length === 0) return { flowAmounts: emptyTotals(null), affectedMetricIds: [...FLOW_KEYS] }
  const flowAmounts = {}
  const affectedMetricIds = []
  for (const key of FLOW_KEYS) {
    const values = unique(possibilities.map((valuesByMetric) => valuesByMetric[key]))
    flowAmounts[key] = values.length === 1 ? values[0] : null
    if (values.length !== 1) affectedMetricIds.push(key)
  }
  return { flowAmounts, affectedMetricIds }
}

export function classifyForecastFlowAmounts({ entry, accountContexts = null, currencyDecimalPlaces }) {
  const { context } = projectionContext(entry, accountContexts)
  const amount = amountOf(entry)
  const affectedMetricIds = affectedMetricsFor(context, currencyDecimalPlaces)
  const flowAmounts = Number.isFinite(amount) ? flowAmountsFor(context, amount, currencyDecimalPlaces) : Object.fromEntries(FLOW_KEYS.map((key) => [key, affectedMetricIds.includes(key) ? null : 0]))
  return { status: Number.isFinite(amount) ? 'ready' : 'unavailable', amount, ...context, affectedMetricIds, flowAmounts }
}

const addAmounts = (target, values, currencyDecimalPlaces, transactionId = null, ids = null) => {
  for (const key of FLOW_KEYS) {
    target[key] = roundAmount(target[key] + (values[key] ?? 0), currencyDecimalPlaces)
    if (ids && transactionId && values[key]) ids[key].add(String(transactionId))
  }
}

const medianSamples = (samples, currencyDecimalPlaces) => Object.fromEntries(FLOW_KEYS.map((key) => [key, roundAmount(median(samples[key]), currencyDecimalPlaces)]))

const projectionDimensionInputs = ({ entries, currentEntries, months, projectedEntries, historyReady, currencyDecimalPlaces }) => {
  const dimensions = new Set(projectedEntries.map(projectionDimension).filter(Boolean))
  const actualByDimension = Object.fromEntries([...dimensions].map((dimension) => [dimension, 0]))
  const monthlyByDimension = Object.fromEntries([...dimensions].map((dimension) => [dimension, Object.fromEntries(months.map((month) => [month, 0]))]))
  const classify = (entry) => {
    const { context } = projectionContext(entry)
    const flowAmounts = flowAmountsFor(context, amountOf(entry), currencyDecimalPlaces)
    const dimension = projectionDimension({ categoryId: context.categoryId, flowAmounts })
    return { dimension, amount: dimension?.startsWith('category:') ? flowAmounts.expenses : flowAmounts[dimension] }
  }
  for (const entry of currentEntries.filter(({ value }) => Number.isFinite(value))) {
    const { dimension, amount } = classify(entry)
    if (!dimensions.has(dimension) || !Number.isFinite(amount)) continue
    actualByDimension[dimension] = roundAmount(actualByDimension[dimension] + amount, currencyDecimalPlaces)
  }
  for (const entry of entries.filter(({ monthKey, value }) => months.includes(monthKey) && Number.isFinite(value))) {
    const { dimension, amount } = classify(entry)
    if (!dimensions.has(dimension) || !Number.isFinite(amount)) continue
    monthlyByDimension[dimension][entry.monthKey] = roundAmount(monthlyByDimension[dimension][entry.monthKey] + amount, currencyDecimalPlaces)
  }
  const historicalByDimension = Object.fromEntries(
    [...dimensions].map((dimension) => [
      dimension,
      historyReady ? roundAmount(months.reduce((total, month) => total + monthlyByDimension[dimension][month], 0) / months.length, currencyDecimalPlaces) : null,
    ]),
  )
  return { actualByDimension, historicalByDimension }
}

const primaryFlow = (amounts) => ['refunds', 'income', 'expenses', 'savingsDeposits', 'savingsWithdrawals', 'debtRepayments', 'newDebt'].find((key) => amounts[key] > 0) ?? 'transfer'

const projectionDimension = (entry) => {
  if (Number(entry?.flowAmounts?.expenses) > 0) return `category:${String(entry.categoryId || ANALYTICS_UNCATEGORIZED_ID)}`
  const flow = primaryFlow(entry?.flowAmounts ?? {})
  return flow === 'transfer' ? null : flow
}

const scaleProjectedEntry = (entry, amount, currencyDecimalPlaces) => {
  const roundedAmount = roundAmount(amount, currencyDecimalPlaces)
  const ratio = roundedAmount / entry.amount
  const flowAmounts = Object.fromEntries(
    FLOW_KEYS.map((key) => [key, Number.isFinite(entry.flowAmounts?.[key]) ? roundAmount(entry.flowAmounts[key] * ratio, currencyDecimalPlaces) : (entry.flowAmounts?.[key] ?? null)]),
  )
  if (FLOW_KEYS.includes(entry.metric)) flowAmounts[entry.metric] = roundedAmount
  return { ...structuredClone(entry), amount: roundedAmount, flowAmounts }
}

export function reconcileProjectedActivity({ actualByDimension = {}, historicalByDimension = {}, entries = [], currencyDecimalPlaces }) {
  const scale = 10 ** currencyDecimalPlaces
  const sourceOrder = { defined: 0, inferred: 1, variable: 2 }
  const groups = new Map()
  const passthrough = []
  for (const entry of entries) {
    const dimension = projectionDimension(entry)
    if (!dimension || !Number.isFinite(entry?.amount) || entry.amount <= 0) {
      passthrough.push(structuredClone(entry))
      continue
    }
    groups.set(dimension, [...(groups.get(dimension) ?? []), entry])
  }

  const reconciled = []
  const targetsByDimension = {}
  const allocatedByDimension = {}
  const suppressedProjectionIds = []
  const cappedProjectionIds = []
  for (const [dimension, dimensionEntries] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const actual = Number.isFinite(actualByDimension[dimension]) ? roundAmount(actualByDimension[dimension], currencyDecimalPlaces) : 0
    const historical = Number.isFinite(historicalByDimension[dimension]) ? roundAmount(historicalByDimension[dimension], currencyDecimalPlaces) : actual
    const explicitDue = roundAmount(
      dimensionEntries.filter(({ sourceKind, bundleId }) => sourceKind === 'defined' || bundleId).reduce((total, entry) => total + entry.amount, 0),
      currencyDecimalPlaces,
    )
    const target = roundAmount(Math.max(actual, historical, actual + explicitDue), currencyDecimalPlaces)
    let capacityUnits = Math.max(0, Math.round((target - actual) * scale))
    let allocatedUnits = 0
    for (const entry of [...dimensionEntries].sort(
      (left, right) =>
        (sourceOrder[left.sourceKind] ?? 9) - (sourceOrder[right.sourceKind] ?? 9) ||
        String(left.date ?? '').localeCompare(String(right.date ?? '')) ||
        String(left.id).localeCompare(String(right.id)),
    )) {
      const requestedUnits = Math.max(0, Math.round(entry.amount * scale))
      const grantedUnits = Math.min(requestedUnits, capacityUnits)
      if (grantedUnits === 0) {
        suppressedProjectionIds.push(String(entry.id))
        continue
      }
      if (grantedUnits < requestedUnits) cappedProjectionIds.push(String(entry.id))
      reconciled.push(scaleProjectedEntry(entry, grantedUnits / scale, currencyDecimalPlaces))
      capacityUnits -= grantedUnits
      allocatedUnits += grantedUnits
    }
    targetsByDimension[dimension] = target
    allocatedByDimension[dimension] = allocatedUnits / scale
  }

  return {
    entries: [...reconciled, ...passthrough].sort(
      (left, right) =>
        String(left.date ?? '').localeCompare(String(right.date ?? '')) ||
        String(left.sourceKind ?? '').localeCompare(String(right.sourceKind ?? '')) ||
        String(left.id).localeCompare(String(right.id)),
    ),
    targetsByDimension,
    allocatedByDimension,
    suppressedProjectionIds: suppressedProjectionIds.sort(),
    cappedProjectionIds: cappedProjectionIds.sort(),
  }
}

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

const normalizeIdentityText = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')

const historyIdentityFor = (entry) => {
  const { context } = projectionContext(entry)
  const external = context.direction === 'income' ? entry?.sourceAccount : context.direction === 'expense' ? entry?.destinationAccount : null
  return {
    direction: context.direction,
    sourceAccountId: context.sourceAccountId,
    sourceKind: context.sourceKind,
    destinationAccountId: context.destinationAccountId,
    destinationKind: context.destinationKind,
    categoryId: context.categoryId,
    payee: normalizeIdentityText(entry?.payee ?? entry?.description ?? external?.attributes?.name ?? external?.name ?? external?.id),
  }
}

const durableAccountIdentityKeys = ['sourceAccountId', 'destinationAccountId']
const hasCategoryIdentity = (identity) => Boolean(identity && Object.hasOwn(identity, 'categoryId'))
const normalizedCategoryIdentity = (value) => String(value ?? ANALYTICS_UNCATEGORIZED_ID)
const hasDurableIdentity = (identity) => hasCategoryIdentity(identity) && durableAccountIdentityKeys.every((key) => identity?.[key] !== null && identity?.[key] !== undefined && identity?.[key] !== '')
const durableIdentityMatches = (expected, actual) =>
  hasDurableIdentity(expected) &&
  durableAccountIdentityKeys.every((key) => String(expected[key]) === String(actual[key] ?? '')) &&
  normalizedCategoryIdentity(expected.categoryId) === normalizedCategoryIdentity(actual.categoryId)

const authoritativeIdentityMatches = (candidate, entry) => {
  const expected = candidate?.identity ?? {}
  const actual = historyIdentityFor(entry)
  if (expected.direction !== actual.direction) return false
  for (const key of ['sourceAccountId', 'sourceKind', 'destinationAccountId', 'destinationKind']) {
    if (expected[key] && String(expected[key]) !== String(actual[key] ?? '')) return false
  }
  if (hasCategoryIdentity(expected) && normalizedCategoryIdentity(expected.categoryId) !== normalizedCategoryIdentity(actual.categoryId)) return false
  const durableMatch = durableIdentityMatches(expected, actual)
  const payeeMatch = Boolean(expected.payee && normalizeIdentityText(expected.payee) === actual.payee)
  if (expected.payee && !payeeMatch && !durableMatch) return false
  const externalKey = expected.direction === 'income' ? 'sourceAccountId' : expected.direction === 'expense' ? 'destinationAccountId' : null
  return Boolean(durableMatch || payeeMatch || (externalKey && expected[externalKey] && String(expected[externalKey]) === String(actual[externalKey])))
}

const subscriptionKnownIdentityMatches = (candidate, entry) => {
  if (candidate?.source?.type !== 'subscription') return false
  const expected = candidate?.identity ?? {}
  const actual = historyIdentityFor(entry)
  if (expected.direction !== actual.direction) return false
  for (const key of ['sourceAccountId', 'sourceKind', 'destinationAccountId', 'destinationKind']) {
    if (expected[key] && String(expected[key]) !== String(actual[key] ?? '')) return false
  }
  return !expected.categoryId || normalizedCategoryIdentity(expected.categoryId) === normalizedCategoryIdentity(actual.categoryId)
}

const occurrenceMatchingCandidates = (candidates) =>
  candidates.map((candidate) =>
    candidate?.source?.authoritative === true && hasDurableIdentity(candidate.identity)
      ? { ...candidate, identity: { ...candidate.identity, categoryId: normalizedCategoryIdentity(candidate.identity.categoryId), payee: null }, identityVariants: [] }
      : candidate,
  )

const authoritativeAmountRange = ({ candidate, amount }) => {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const original = candidate?.expectedAmount?.value
  const originalMin = candidate?.expectedAmount?.min
  const originalMax = candidate?.expectedAmount?.max
  if (Number.isFinite(original) && original > 0 && Number.isFinite(originalMin) && Number.isFinite(originalMax)) {
    return { min: amount * (Math.min(originalMin, originalMax) / original), max: amount * (Math.max(originalMin, originalMax) / original) }
  }
  const tolerance = Number(candidate?.matching?.amountTolerance)
  const ratio = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0
  return { min: amount * (1 - ratio), max: amount * (1 + ratio) }
}

const authoritativeHistoryDates = (candidate, months) => {
  const cadence = candidate?.cadence
  if (!cadence || months.length === 0) return []
  if (['monthly', 'twiceMonthly'].includes(cadence.type)) {
    const dates = []
    for (const month of months) {
      const [year, monthNumber] = month.split('-').map(Number)
      for (const day of cadence.days ?? []) {
        if (Number.isInteger(day) && day > 0) dates.push(`${month}-${String(Math.min(day, daysInMonth(year, monthNumber))).padStart(2, '0')}`)
      }
      for (const offset of cadence.fromMonthEnd ?? []) {
        if (Number.isInteger(offset) && offset >= 0 && offset < daysInMonth(year, monthNumber)) dates.push(`${month}-${String(daysInMonth(year, monthNumber) - offset).padStart(2, '0')}`)
      }
    }
    return unique(dates).sort()
  }
  if (cadence.type === 'yearly') {
    const anchor = dateParts(candidate?.expectedDates?.[0] ?? cadence.anchorDate ?? candidate?.bounds?.start)
    if (!anchor) return []
    return months
      .filter((month) => Number(month.slice(5, 7)) === anchor.month)
      .map((month) => `${month}-${String(Math.min(anchor.day, daysInMonth(Number(month.slice(0, 4)), anchor.month))).padStart(2, '0')}`)
  }
  if (!['weekly', 'biweekly'].includes(cadence.type)) return []
  const intervalDays = Number(cadence.intervalWeeks) * 7
  const first = dateParts(`${months[0]}-01`)
  const last = dateParts(monthEnd(months.at(-1)))
  const anchor = dateParts(cadence.anchorDate ?? candidate?.expectedDates?.[0] ?? candidate?.bounds?.start)
  if (!first || !last || !anchor || !Number.isInteger(intervalDays) || intervalDays < 7) return []
  let cursor = anchor.date
  while (formatDate(cursor) > first.key) cursor = addDays(cursor, -intervalDays)
  while (formatDate(cursor) < first.key) cursor = addDays(cursor, intervalDays)
  const dates = []
  for (; formatDate(cursor) <= last.key; cursor = addDays(cursor, intervalDays)) dates.push(formatDate(cursor))
  return dates
}

const matchedAuthoritativeHistoryIds = ({ candidates, entries, months, candidateAmounts, accountContexts, currencyDecimalPlaces, excludedEntryIds }) => {
  const usedEntryIds = new Set(excludedEntryIds)
  const matchedEntryIds = []
  const matchedEntriesByCandidateId = new Map()
  const historyEntries = entries.filter(({ id, monthKey, value }) => months.includes(monthKey) && Number.isFinite(value) && !usedEntryIds.has(String(id)))
  for (const candidate of candidates.filter(({ source }) => source?.authoritative === true).sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const input = candidateProjectionInput({ candidate, candidateAmounts, accountContexts })
    if (input.reasons.some((reason) => reason !== 'missingAccountContext')) continue
    const range = authoritativeAmountRange({ candidate, amount: input.amount })
    if (!range) continue
    const roundingTolerance = 1 / 10 ** currencyDecimalPlaces
    const expectedDates = authoritativeHistoryDates(candidate, months)
    const candidateMatches = []
    const candidateUsedEntryIds = new Set(usedEntryIds)
    for (const expectedDate of expectedDates) {
      const amountAndDateMatches = historyEntries.filter(
        (entry) =>
          !candidateUsedEntryIds.has(String(entry.id)) &&
          amountOf(entry) >= range.min - roundingTolerance &&
          amountOf(entry) <= range.max + roundingTolerance &&
          calendarDayDistance(entry.date, expectedDate) <= (candidate?.matching?.dateWindowDays ?? 4),
      )
      const identityMatches = amountAndDateMatches.filter((entry) => authoritativeIdentityMatches(candidate, entry))
      const fallbackMatches = identityMatches.length === 0 ? amountAndDateMatches.filter((entry) => subscriptionKnownIdentityMatches(candidate, entry)) : []
      const choices = identityMatches.length > 0 ? identityMatches : fallbackMatches.length === 1 ? fallbackMatches : []
      const match = choices.sort(
        (left, right) =>
          calendarDayDistance(left.date, expectedDate) - calendarDayDistance(right.date, expectedDate) ||
          Math.abs(amountOf(left) - input.amount) - Math.abs(amountOf(right) - input.amount) ||
          String(left.date).localeCompare(String(right.date)) ||
          String(left.id).localeCompare(String(right.id)),
      )[0]
      if (!match) continue
      candidateUsedEntryIds.add(String(match.id))
      candidateMatches.push({ entry: match, fallback: identityMatches.length === 0 })
    }
    const fallbackMatches = candidateMatches.filter(({ fallback }) => fallback)
    const fallbackIsDurable = fallbackMatches.length === 0 || (candidateMatches.length >= 3 && unique(candidateMatches.map(({ entry }) => contextKey(projectionContext(entry).context))).length === 1)
    const acceptedMatches = fallbackIsDurable ? candidateMatches : candidateMatches.filter(({ fallback }) => !fallback)
    for (const { entry } of acceptedMatches) {
      usedEntryIds.add(String(entry.id))
      matchedEntryIds.push(String(entry.id))
      matchedEntriesByCandidateId.set(String(candidate.id), [...(matchedEntriesByCandidateId.get(String(candidate.id)) ?? []), entry])
    }
  }
  return { entryIds: matchedEntryIds.sort(), entriesByCandidateId: matchedEntriesByCandidateId }
}

const candidateWithMatchedContext = (candidate, entries) => {
  const contexts = entries.map((entry) => projectionContext(entry).context)
  if (contexts.length === 0 || unique(contexts.map(contextKey)).length !== 1) return candidate
  const context = contexts[0]
  return {
    ...candidate,
    identity: {
      ...candidate.identity,
      sourceAccountId: candidate.identity.sourceAccountId || context.sourceAccountId,
      sourceKind: candidate.identity.sourceKind || context.sourceKind,
      destinationAccountId: candidate.identity.destinationAccountId || context.destinationAccountId,
      destinationKind: candidate.identity.destinationKind || context.destinationKind,
      categoryId: candidate.identity.categoryId || context.categoryId,
    },
  }
}

const budgetAttribution = ({ explicitBudgetId = null, entries = [] }) => {
  if (explicitBudgetId !== null && explicitBudgetId !== undefined && String(explicitBudgetId)) return { status: 'exact', budgetId: String(explicitBudgetId), budgetIds: [String(explicitBudgetId)] }
  const memberships = entries.map(({ budgetId }) => (budgetId === null || budgetId === undefined || !String(budgetId) ? null : String(budgetId)))
  const budgetIds = unique(memberships.filter((budgetId) => budgetId !== null)).sort()
  if (memberships.some((budgetId) => budgetId === null)) return { status: 'incomplete', budgetId: null, budgetIds, missingMembership: true }
  if (budgetIds.length === 1) return { status: 'exact', budgetId: budgetIds[0], budgetIds }
  if (budgetIds.length > 1) return { status: 'ambiguous', budgetId: null, budgetIds }
  return { status: 'unassigned', budgetId: null, budgetIds: [] }
}

const candidateWithBudgetAttribution = ({ candidate, entries, candidateAmounts }) => ({
  ...candidate,
  budgetAttribution:
    projectionContext(candidate).context.direction === 'expense'
      ? budgetAttribution({ explicitBudgetId: candidate?.budgetId ?? candidateAmounts?.[candidate.id]?.budgetId, entries })
      : { status: 'unassigned', budgetId: null, budgetIds: [] },
})

const robustAuthoritativeAmount = ({ candidate, input, entries, currencyDecimalPlaces }) => {
  if (!candidate?.source?.authoritative || entries.length === 0) return { amount: input.amount, evidenceIds: [] }
  const range = authoritativeAmountRange({ candidate, amount: input.amount })
  const samples = entries
    .filter((entry) => usableLedgerValue(entry) && (!range || (amountOf(entry) >= range.min && amountOf(entry) <= range.max)))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.id).localeCompare(String(right.id)))
    .slice(-3)
  const linkedMedian = median(samples.map(amountOf))
  if (!Number.isFinite(linkedMedian)) return { amount: input.amount, evidenceIds: [] }
  const amount = range ? Math.min(range.max, Math.max(range.min, linkedMedian)) : linkedMedian
  return {
    amount: roundAmount(amount, currencyDecimalPlaces),
    evidenceIds: unique(samples.flatMap(({ id, transactionId }) => [id, transactionId])).sort(),
  }
}

const yearlyCandidateCorroborated = (candidate, entries) => {
  if (candidate?.cadence?.type !== 'yearly') return true
  const target = dateParts(unique(candidate.expectedDates ?? [])[0])
  if (!target) return false
  return unique([...(candidate?.evidence?.dates ?? []), ...entries.map(({ date }) => date)]).some((value) => {
    const evidence = dateParts(value)
    if (!evidence || evidence.year !== target.year - 1) return false
    const targetPreviousYear = `${evidence.year}-${String(target.month).padStart(2, '0')}-${String(Math.min(target.day, daysInMonth(evidence.year, target.month))).padStart(2, '0')}`
    return calendarDayDistance(evidence.key, targetPreviousYear) <= (candidate?.matching?.dateWindowDays ?? 4)
  })
}

const canonicalExpectedDates = (candidate) => {
  const dates = unique(candidate?.expectedDates ?? [])
    .map(dateKey)
    .filter(Boolean)
    .sort()
  if (candidate?.cadence?.type !== 'yearly') return dates
  const byYear = new Map()
  for (const value of dates) byYear.set(value.slice(0, 4), [...(byYear.get(value.slice(0, 4)) ?? []), value])
  return [...byYear.values()].map((yearDates) => {
    const nominal = `${yearDates[0].slice(0, 4)}-${String(candidate.cadence.month).padStart(2, '0')}-${String(candidate.cadence.day).padStart(2, '0')}`
    return [...yearDates].sort((left, right) => calendarDayDistance(left, nominal) - calendarDayDistance(right, nominal) || left.localeCompare(right))[0]
  })
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

const splitBundleProjectionParts = ({ candidate, amount, accountContexts, currencyDecimalPlaces }) => {
  const components = [...(candidate?.inferenceBundle?.candidates ?? [])].sort(
    (left, right) => Number(right.expectedAmount?.value) - Number(left.expectedAmount?.value) || String(left.id).localeCompare(String(right.id)),
  )
  if (components.length < 2) return null
  const weighted = components.map((component) => {
    const { context, missingAccountIds, missingAccountEndpoints } = projectionContext(component, accountContexts, true)
    return { component, context, missingAccountIds, missingAccountEndpoints, weight: Number(component.expectedAmount?.value) }
  })
  if (
    weighted.some(
      ({ context, missingAccountIds, missingAccountEndpoints, weight }) =>
        !Number.isFinite(weight) || weight <= 0 || missingAccountIds.length > 0 || missingAccountEndpoints.length > 0 || !context.sourceKind || !context.destinationKind,
    )
  )
    return null
  const scale = 10 ** currencyDecimalPlaces
  const targetUnits = Math.round(amount * scale)
  const totalWeight = weighted.reduce((total, { weight }) => total + weight, 0)
  const shares = weighted.map((item, index) => {
    const exact = (targetUnits * item.weight) / totalWeight
    return { ...item, index, units: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  let residual = targetUnits - shares.reduce((total, { units }) => total + units, 0)
  for (const share of [...shares].sort((left, right) => right.fraction - left.fraction || left.component.id.localeCompare(right.component.id))) {
    if (residual === 0) break
    share.units += 1
    residual -= 1
  }
  return shares.map(({ component, context, units }) => ({ component, context, amount: units / scale }))
}

const bundleComponentLabel = (entry, context) => {
  const external = context.direction === 'income' ? entry?.sourceAccount : context.direction === 'expense' ? entry?.destinationAccount : null
  return String(entry?.description ?? external?.attributes?.name ?? external?.name ?? entry?.categoryId ?? external?.id ?? 'Recurring component')
}

const precedingBusinessDay = (value) => {
  let result = dateParts(value)?.date
  if (!result) return null
  while ([0, 6].includes(result.getDay())) result = addDays(result, -1)
  return formatDate(result)
}

const bundleEntryCurrency = (entry) => String(entry?.conversion?.displayCurrency ?? entry?.conversion?.sourceCurrency ?? '')

const bundleComponentIsCumulativeMaterial = (entry, currencyDecimalPlaces) =>
  [...CUMULATIVE_METRICS].some((metric) => flowAmountsFor(projectionContext(entry).context, 1, currencyDecimalPlaces)[metric] !== 0)

const bundleComponentHasProjectedFlow = (component, currencyDecimalPlaces) => FLOW_KEYS.some((metric) => flowAmountsFor(component.context, 1, currencyDecimalPlaces)[metric] !== 0)

const bundleComponentDescription = (entry) =>
  String(entry?.description ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')

const recurringBundleComponents = (entries) => {
  const byContext = new Map()
  for (const entry of entries) {
    const key = contextKey(projectionContext(entry).context)
    byContext.set(key, [...(byContext.get(key) ?? []), entry])
  }
  const components = new Map()
  const ambiguousKeys = []
  for (const [baseKey, contextEntries] of [...byContext.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = contextEntries.sort(
      (left, right) =>
        bundleComponentDescription(left).localeCompare(bundleComponentDescription(right)) ||
        amountOf(right) - amountOf(left) ||
        String(left.transactionId).localeCompare(String(right.transactionId)) ||
        String(left.id).localeCompare(String(right.id)),
    )
    if (sorted.length === 1) {
      const description = bundleComponentDescription(sorted[0])
      components.set(description ? `${baseKey}|component:${description}` : baseKey, sorted[0])
      continue
    }
    const descriptions = sorted.map(bundleComponentDescription)
    if (descriptions.some((description) => !description) || new Set(descriptions).size !== descriptions.length) {
      ambiguousKeys.push(baseKey)
      continue
    }
    for (const entry of sorted) components.set(`${baseKey}|component:${bundleComponentDescription(entry)}`, entry)
  }
  return { components, ambiguousKeys }
}

const recurringBundleOccurrences = ({ entries, months = null, conflictingTransactionIds, currencyDecimalPlaces }) => {
  const conflictingTransactions = new Set(conflictingTransactionIds)
  const byDate = new Map()
  for (const entry of entries) {
    if ((months && !months.includes(entry.monthKey)) || !usableLedgerValue(entry) || !entry.transactionId || conflictingTransactions.has(String(entry.transactionId)) || !entry.date) continue
    byDate.set(String(entry.date), [...(byDate.get(String(entry.date)) ?? []), entry])
  }

  const occurrences = []
  for (const [date, dateEntries] of [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedEntries = dateEntries.sort((left, right) => String(left.id).localeCompare(String(right.id)))
    const anchorGroups = new Map()
    const anchorGroupByEntryId = new Map()
    for (const entry of sortedEntries) {
      const context = projectionContext(entry).context
      const flows = flowAmountsFor(context, amountOf(entry), currencyDecimalPlaces)
      if (flows.income <= 0 || flows.availableCashChange <= 0 || !context.sourceAccountId || !context.destinationAccountId) continue
      const key = [context.sourceAccountId, context.destinationAccountId, bundleEntryCurrency(entry)].join('|')
      const group = anchorGroups.get(key) ?? { key, context, entries: [] }
      group.entries.push(entry)
      anchorGroups.set(key, group)
      anchorGroupByEntryId.set(String(entry.id), key)
    }

    const groups = [...anchorGroups.values()]
      .map((group) => ({
        ...group,
        entries: group.entries.sort(
          (left, right) =>
            flowAmountsFor(projectionContext(right).context, amountOf(right), currencyDecimalPlaces).availableCashChange -
              flowAmountsFor(projectionContext(left).context, amountOf(left), currencyDecimalPlaces).availableCashChange || String(left.id).localeCompare(String(right.id)),
        ),
      }))
      .sort((left, right) => left.key.localeCompare(right.key))
    const assigned = new Map(groups.map(({ key }) => [key, []]))

    for (const entry of sortedEntries) {
      const ownAnchorGroup = anchorGroupByEntryId.get(String(entry.id))
      if (ownAnchorGroup) {
        assigned.get(ownAnchorGroup).push(entry)
        continue
      }
      const context = projectionContext(entry).context
      const currency = bundleEntryCurrency(entry)
      const matchingGroups = groups.filter(
        (group) =>
          bundleEntryCurrency(group.entries[0]) === currency &&
          (context.sourceAccountId === group.context.destinationAccountId ||
            context.sourceAccountId === group.context.sourceAccountId ||
            context.destinationAccountId === group.context.destinationAccountId),
      )
      if (matchingGroups.length === 1) assigned.get(matchingGroups[0].key).push(entry)
    }

    for (const group of groups) {
      const cohort = assigned.get(group.key).sort((left, right) => String(left.id).localeCompare(String(right.id)))
      const { components, ambiguousKeys } = recurringBundleComponents(cohort)
      if (components.size < 2) continue
      const anchor = group.entries[0]
      const anchorBaseKey = contextKey(projectionContext(anchor).context)
      const anchorKey = [...components.entries()].find(([, entry]) => entry === anchor)?.[0]
      if (!anchorKey) continue
      occurrences.push({
        date,
        monthKey: String(anchor.monthKey),
        transactionId: String(anchor.transactionId),
        transactionIds: unique(cohort.map(({ transactionId }) => String(transactionId))).sort(),
        entries: cohort,
        components,
        ambiguousKeys,
        anchorBaseKey,
        anchorKey,
      })
    }
  }
  return occurrences.sort((left, right) => left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId) || left.anchorKey.localeCompare(right.anchorKey))
}

const recurringBundleComponent = ({ key, occurrences, phase = 'both', bundleId, anchorKey, currencyDecimalPlaces }) => {
  const evidence = occurrences
    .map((occurrence) => ({ occurrence, entry: occurrence.components.get(key) }))
    .filter(({ entry }) => entry)
    .sort((left, right) => left.occurrence.date.localeCompare(right.occurrence.date) || left.occurrence.transactionId.localeCompare(right.occurrence.transactionId))
  const representative = evidence.at(-1)?.entry
  const context = projectionContext(representative).context
  const id = `${bundleId}:component:${stableHash(key)}`
  return {
    id,
    key,
    label: bundleComponentLabel(key === anchorKey && representative.descriptionFromLedger ? { ...representative, description: null } : representative, context),
    phase,
    context,
    budgetAttribution: context.direction === 'expense' ? budgetAttribution({ entries: evidence.map(({ entry }) => entry) }) : { status: 'unassigned', budgetId: null, budgetIds: [] },
    reconciliationOnly: !bundleComponentIsCumulativeMaterial(representative, currencyDecimalPlaces),
    evidenceEntryIds: evidence.map(({ entry }) => String(entry.id)).sort(),
    evidenceTransactionIds: unique(evidence.map(({ entry }) => String(entry.transactionId))).sort(),
    samples: evidence.map(({ entry, occurrence }) => ({ id: String(entry.id), transactionId: String(entry.transactionId), date: occurrence.date, value: amountOf(entry) })),
  }
}

const bundleCandidateMatchesAdmittedComponent = ({ candidate, bundle, amount }) => {
  const explicitEntryIds = new Set((candidate?.evidence?.entryIds ?? []).map(String))
  const matchingEntryIds = candidate?.source?.authoritative === true ? bundle.matchingEntryIds : bundle.candidateMatchingEntryIds
  if (explicitEntryIds.size > 0) return [...explicitEntryIds].every((id) => matchingEntryIds.includes(id))
  const transactionIds = new Set((candidate?.evidence?.transactionIds ?? []).map(String))
  if (transactionIds.size === 0) return false
  const candidateContext = projectionContext(candidate).context
  const amountRange = authoritativeAmountRange({ candidate, amount })
  const matchesAmount = (value) => !amountRange || !Number.isFinite(value) || (value >= amountRange.min && value <= amountRange.max)
  return [...transactionIds].every((evidenceTransactionId) =>
    bundle.matchingComponents.some(({ context, samples }) => {
      if (contextKey(context) !== contextKey(candidateContext)) return false
      return samples.some(({ id, transactionId, value, transactionEntries }) => {
        if (String(transactionId) !== evidenceTransactionId || !matchesAmount(value)) return false
        const possibleEntries = transactionEntries.filter((entry) => contextKey(entry.context) === contextKey(candidateContext) && matchesAmount(entry.value))
        return possibleEntries.length === 1 && possibleEntries[0].id === id
      })
    }),
  )
}

const discoverRecurringBundles = ({ entries, months, conflictingTransactionIds, today, endDate, currencyDecimalPlaces }) => {
  const entriesByTransactionId = new Map()
  for (const entry of entries) {
    if (!entry.transactionId) continue
    const transactionId = String(entry.transactionId)
    entriesByTransactionId.set(transactionId, [...(entriesByTransactionId.get(transactionId) ?? []), entry])
  }
  const families = new Map()
  for (const occurrence of recurringBundleOccurrences({ entries, months, conflictingTransactionIds, currencyDecimalPlaces })) {
    const { anchorKey } = occurrence
    families.set(anchorKey, [...(families.get(anchorKey) ?? []), occurrence])
  }

  const discovered = []
  for (const [anchorKey, family] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const occurrences = family.sort((left, right) => left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId))
    if (occurrences.length < 3 || new Set(occurrences.map(({ transactionId }) => transactionId)).size < 3 || new Set(occurrences.map(({ monthKey }) => monthKey)).size < 2) continue
    const middleOccurrences = occurrences.filter(({ date }) => dateParts(date).day <= 20)
    const monthEndOccurrences = occurrences.filter(({ date }) => dateParts(date).day > 20)
    if (
      middleOccurrences.length < 2 ||
      monthEndOccurrences.length < 2 ||
      new Set(middleOccurrences.map(({ monthKey }) => monthKey)).size < 2 ||
      new Set(monthEndOccurrences.map(({ monthKey }) => monthKey)).size < 2
    )
      continue

    const allKeys = unique(occurrences.flatMap(({ components, ambiguousKeys }) => [...components.keys(), ...ambiguousKeys.map((key) => `${key}|component:ambiguous`)])).sort()
    const commonKeys = allKeys.filter((key) => occurrences.every(({ components }) => components.has(key)))
    if (commonKeys.length < 2 || !commonKeys.includes(anchorKey)) continue
    const historicalSignature = commonKeys.join('||')
    const id = `bundle:${stableHash(`${anchorKey}|${historicalSignature}`)}`
    const phaseComponents = { middle: [], monthEnd: [] }
    for (const [phase, phaseOccurrences, oppositeOccurrences] of [
      ['middle', middleOccurrences, monthEndOccurrences],
      ['monthEnd', monthEndOccurrences, middleOccurrences],
    ]) {
      if (phaseOccurrences.length < 3 || new Set(phaseOccurrences.map(({ monthKey }) => monthKey)).size < 3) continue
      phaseComponents[phase] = [...phaseOccurrences[0].components.keys()]
        .filter((key) => !commonKeys.includes(key) && phaseOccurrences.every(({ components }) => components.has(key)) && oppositeOccurrences.every(({ components }) => !components.has(key)))
        .sort()
    }

    const latestPair = occurrences.slice(-2)
    const older = occurrences.slice(0, -2)
    const phaseOnlyKeys = new Set([...phaseComponents.middle, ...phaseComponents.monthEnd])
    const eligibleSignature = ({ components }) =>
      [...components.keys()]
        .filter((key) => !phaseOnlyKeys.has(key) && bundleComponentIsCumulativeMaterial(components.get(key), currencyDecimalPlaces))
        .sort()
        .join('||')
    const latestPairStableMaterialKeys = unique(latestPair.flatMap(({ components }) => [...components.keys()]))
      .filter(
        (key) => !phaseOnlyKeys.has(key) && latestPair.every(({ components }) => components.has(key)) && bundleComponentIsCumulativeMaterial(latestPair[0].components.get(key), currencyDecimalPlaces),
      )
      .sort()
    const pairSignaturesAgree = eligibleSignature(latestPair[0]) === eligibleSignature(latestPair[1])
    const pairAmountsAgree = latestPairStableMaterialKeys.every(
      (key) => roundAmount(amountOf(latestPair[0].components.get(key)), currencyDecimalPlaces) === roundAmount(amountOf(latestPair[1].components.get(key)), currencyDecimalPlaces),
    )
    const olderAnchorMedian = median(older.map(({ components }) => amountOf(components.get(anchorKey))))
    const latestAnchorAmount = amountOf(latestPair[1].components.get(anchorKey))
    const regimeChanged =
      pairSignaturesAgree && pairAmountsAgree && Number.isFinite(olderAnchorMedian) && olderAnchorMedian > 0 && Math.abs(latestAnchorAmount - olderAnchorMedian) / olderAnchorMedian >= 0.02
    const regimePolicy = regimeChanged ? 'latestEquivalentPairAtLeastTwoPercent' : 'recencyWeightedMedian'
    const confidence = {
      score: regimeChanged ? 0.9 : 0.7,
      level: regimeChanged ? 'high' : 'medium',
      reasons: [regimeChanged ? 'Latest two equivalent occurrences establish a new regime' : 'No two-occurrence regime change; uses a recency-weighted median'],
    }
    const regimeComponentKeys = regimeChanged ? unique([...commonKeys, ...latestPairStableMaterialKeys]).sort() : commonKeys
    const signature = regimeComponentKeys.join('||')
    const components = [
      ...regimeComponentKeys.map((key) => recurringBundleComponent({ key, occurrences, bundleId: id, anchorKey, currencyDecimalPlaces })),
      ...phaseComponents.middle.map((key) => recurringBundleComponent({ key, occurrences: middleOccurrences, phase: 'middle', bundleId: id, anchorKey, currencyDecimalPlaces })),
      ...phaseComponents.monthEnd.map((key) => recurringBundleComponent({ key, occurrences: monthEndOccurrences, phase: 'monthEnd', bundleId: id, anchorKey, currencyDecimalPlaces })),
    ].sort((left, right) => left.id.localeCompare(right.id))
    const matchingComponents = components.map(({ context, samples }) => ({
      context,
      samples: samples.map(({ id, transactionId, value }) => ({
        id,
        transactionId,
        value,
        transactionEntries: (entriesByTransactionId.get(transactionId) ?? []).map((entry) => ({ id: String(entry.id), context: projectionContext(entry).context, value: amountOf(entry) })),
      })),
    }))
    for (const component of components) {
      component.amount = roundAmount(
        regimeChanged && component.phase === 'both' && !component.reconciliationOnly ? latestPair[1].components.get(component.key).value : recencyWeightedMedian(component.samples),
        currencyDecimalPlaces,
      )
      delete component.samples
    }
    const admittedComponentKeys = new Set(components.map(({ key }) => key))
    const inconsistentComponentKeys = allKeys.filter((key) => !admittedComponentKeys.has(key))
    const stableInconsistentComponentKeys = inconsistentComponentKeys.filter(
      (key) =>
        occurrences.filter(({ components }) => components.has(key)).length >= 3 && new Set(occurrences.filter(({ components }) => components.has(key)).map(({ monthKey }) => monthKey)).size >= 2,
    )

    const target = dateParts(today)
    const middleDay = Math.round(median(middleOccurrences.map(({ date }) => dateParts(date).day)))
    const middleDate = precedingBusinessDay(`${target.year}-${String(target.month).padStart(2, '0')}-${String(Math.min(middleDay, daysInMonth(target.year, target.month))).padStart(2, '0')}`)
    const endOfMonthDate = precedingBusinessDay(`${target.year}-${String(target.month).padStart(2, '0')}-${String(daysInMonth(target.year, target.month)).padStart(2, '0')}`)
    const phaseWindowDays = 4
    const phaseDates = [
      {
        date: middleDate,
        phase: 'middle',
        windowStart: formatDate(addDays(dateParts(middleDate).date, -phaseWindowDays)),
        windowEnd: formatDate(addDays(dateParts(middleDate).date, phaseWindowDays)),
      },
      { date: endOfMonthDate, phase: 'monthEnd', windowStart: formatDate(addDays(dateParts(middleDate).date, phaseWindowDays + 1)), windowEnd: endOfMonthDate },
    ]
    const projectedDates = phaseDates.filter(({ date }) => date > today && date <= endDate).map(({ date, phase }) => ({ date, phase }))
    if (projectedDates.length === 0) continue
    discovered.push({
      id,
      anchorKey,
      signature,
      label: bundleComponentLabel(occurrences.at(-1).components.get(anchorKey), projectionContext(occurrences.at(-1).components.get(anchorKey)).context),
      occurrenceDates: occurrences.map(({ date }) => date),
      transactionIds: unique(components.flatMap(({ evidenceTransactionIds }) => evidenceTransactionIds)).sort(),
      entryIds: unique(components.flatMap(({ evidenceEntryIds }) => evidenceEntryIds)).sort(),
      selectedRegimeTransactionIds: latestPair.map(({ transactionId }) => transactionId).sort(),
      selectedRegimeEntryIds: unique(latestPair.flatMap(({ components }) => [...admittedComponentKeys].map((key) => components.get(key)?.id).filter(Boolean))).sort(),
      inconsistentComponentKeys,
      confidence,
      regimePolicy,
      schedulePolicy: { type: 'semimonthly', middleDay, monthEnd: true, weekendAdjustment: 'previousBusinessDay' },
      phaseDates,
      projectedDates,
      components,
      matchingComponents,
      matchingEntryIds: unique(occurrences.flatMap(({ components }) => [...admittedComponentKeys].map((key) => components.get(key)?.id).filter(Boolean))).sort(),
      candidateMatchingEntryIds: unique(
        occurrences.flatMap(({ components }) => [...admittedComponentKeys, ...stableInconsistentComponentKeys].map((key) => components.get(key)?.id).filter(Boolean)),
      ).sort(),
    })
  }
  return discovered.sort((left, right) => left.id.localeCompare(right.id))
}

const fulfillRecurringBundles = ({ bundles, currentEntries, conflictingTransactionIds, currencyDecimalPlaces }) => {
  const occurrences = recurringBundleOccurrences({ entries: currentEntries, conflictingTransactionIds, currencyDecimalPlaces })

  return bundles.map((bundle) => {
    const remainingDates = [...bundle.projectedDates]
    const fulfilledPhases = []
    const knownKeys = new Set(bundle.components.map(({ key }) => key))
    for (const occurrence of occurrences.filter(({ components }) => components.has(bundle.anchorKey))) {
      const recognizedKeys = [...occurrence.components.keys()].filter((key) => knownKeys.has(key)).sort()
      const matchingPhases = bundle.phaseDates
        .filter(({ phase }) => !fulfilledPhases.some((fulfilled) => fulfilled.phase === phase))
        .filter(({ phase }) => {
          const expected = bundle.components.filter((component) => component.phase === 'both' || component.phase === phase)
          const expectedKeys = expected.map(({ key }) => key).sort()
          return (
            JSON.stringify(recognizedKeys) === JSON.stringify(expectedKeys) &&
            expected.every(
              ({ key, amount, reconciliationOnly }) =>
                reconciliationOnly || roundAmount(amountOf(occurrence.components.get(key)), currencyDecimalPlaces) === roundAmount(amount, currencyDecimalPlaces),
            )
          )
        })
      const explicitMatches = matchingPhases.filter(({ phase }) => bundle.components.some((component) => component.phase === phase))
      const classifiedPhases = (
        explicitMatches.length > 0 ? explicitMatches : matchingPhases.filter(({ windowStart, windowEnd }) => occurrence.date >= windowStart && occurrence.date <= windowEnd)
      ).sort((left, right) => calendarDayDistance(occurrence.date, left.date) - calendarDayDistance(occurrence.date, right.date) || left.phase.localeCompare(right.phase))
      const matched = classifiedPhases[0]
      if (!matched) continue
      const projectedIndex = remainingDates.findIndex(({ phase }) => phase === matched.phase)
      if (projectedIndex >= 0) remainingDates.splice(projectedIndex, 1)
      const matchedEntries = bundle.components
        .filter((component) => component.phase === 'both' || component.phase === matched.phase)
        .map(({ key }) => occurrence.components.get(key))
        .filter(Boolean)
      fulfilledPhases.push({
        phase: matched.phase,
        entryIds: matchedEntries.map(({ id }) => String(id)).sort(),
        transactionIds: unique(matchedEntries.map(({ transactionId }) => String(transactionId))).sort(),
      })
    }
    return { ...bundle, projectedDates: remainingDates, fulfilledPhases: fulfilledPhases.sort((left, right) => left.phase.localeCompare(right.phase)) }
  })
}

const recurringBundleAudit = (bundles) =>
  bundles.map((bundle) => {
    const audit = structuredClone(bundle)
    delete audit.matchingEntryIds
    delete audit.matchingComponents
    delete audit.candidateMatchingEntryIds
    delete audit.phaseDates
    return audit
  })

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
  projectedFlowAmounts = null,
  evidenceIds = null,
  bundleCandidateId = null,
  budgetAttribution: projectedBudgetAttribution = null,
}) => {
  const roundedAmount = roundAmount(amount, currencyDecimalPlaces)
  const flowAmounts = projectedFlowAmounts ?? flowAmountsFor(context, roundedAmount, currencyDecimalPlaces)
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
    sourceAccountKind: context.sourceKind || null,
    destinationAccountKind: context.destinationKind || null,
    sourceKind,
    sourceId: String(candidate?.source?.id ?? id),
    sourceLabel: candidate?.source?.label ?? null,
    candidateId: candidate?.id ?? null,
    expectedId,
    evidenceIds: evidenceIds ?? (candidate ? candidateEvidenceIds(candidate) : []),
    flowAmounts,
    confidence,
    reasons,
    overdue,
    budgetId: projectedBudgetAttribution?.budgetId ?? null,
    budgetAttribution: projectedBudgetAttribution ? structuredClone(projectedBudgetAttribution) : { status: 'unassigned', budgetId: null, budgetIds: [] },
    ...(bundleCandidateId ? { bundleCandidateId } : {}),
    ...(conversion ? { conversion: structuredClone(conversion) } : {}),
    ...(profile ? { profile } : {}),
  }
}

const projectRecurringBundles = ({ bundles, currencyDecimalPlaces }) =>
  bundles.flatMap((bundle) =>
    bundle.projectedDates.flatMap(({ date, phase }) =>
      bundle.components
        .filter((component) => bundleComponentHasProjectedFlow(component, currencyDecimalPlaces) && (component.phase === 'both' || component.phase === phase))
        .map((component) => ({
          ...projectedEntry({
            id: `projected:inferred:${bundle.id}:${phase}:${component.id}:${date}`,
            date,
            amount: component.amount,
            context: component.context,
            sourceKind: 'inferred',
            currencyDecimalPlaces,
            confidence: structuredClone(bundle.confidence),
            reasons: [...bundle.confidence.reasons],
            evidenceIds: [bundle.id, component.id],
            budgetAttribution: component.budgetAttribution,
          }),
          sourceId: bundle.id,
          sourceLabel: bundle.label,
          bundleId: bundle.id,
          bundleComponentId: component.id,
          bundleLabel: component.label,
        }))
        .sort((left, right) => left.bundleComponentId.localeCompare(right.bundleComponentId)),
    ),
  )

const aggregateBundleCandidateReconciliation = ({ candidates, bundles, candidateAmounts, accountContexts }) => {
  const reconciled = []
  for (const candidate of candidates.filter(({ source }) => source?.authoritative === true)) {
    const input = candidateProjectionInput({ candidate, candidateAmounts, accountContexts })
    if (input.reasons.length > 0 || !Number.isFinite(input.amount)) continue
    const aggregateEntryIds = unique([...(candidate?.aggregateEvidence?.entryIds ?? []), ...(candidate?.evidence?.entryIds ?? [])].map(String)).sort()
    const aggregateTransactionIds = unique([...(candidate?.aggregateEvidence?.transactionIds ?? []), ...(candidate?.evidence?.transactionIds ?? [])].map(String)).sort()
    if (aggregateEntryIds.length === 0 && aggregateTransactionIds.length === 0) continue
    const expectedMonths = new Set(
      unique(candidate.expectedDates ?? [])
        .map(dateKey)
        .filter(Boolean)
        .map((date) => date.slice(0, 7)),
    )
    if (expectedMonths.size === 0) continue
    const matchingBundles = bundles.filter((bundle) => bundle.projectedDates.some(({ date }) => expectedMonths.has(date.slice(0, 7))))
    const matchingComponents = matchingBundles.flatMap((bundle) =>
      bundle.components.filter(({ context, reconciliationOnly }) => !reconciliationOnly && contextKey(context) === contextKey(input.context)).map((component) => ({ bundle, component })),
    )
    if (matchingComponents.length === 0) continue
    const coveredEntryIds = new Set(matchingComponents.flatMap(({ component }) => component.evidenceEntryIds).map(String))
    const coveredTransactionIds = new Set(
      aggregateTransactionIds.filter((transactionId) =>
        matchingComponents.some(({ bundle }) =>
          bundle.matchingComponents.some(({ context, samples }) => {
            if (contextKey(context) !== contextKey(input.context)) return false
            return samples.some(({ id, transactionId: sampleTransactionId, transactionEntries }) => {
              if (String(sampleTransactionId) !== transactionId) return false
              const possibleEntries = transactionEntries.filter((entry) => contextKey(entry.context) === contextKey(input.context))
              return possibleEntries.length === 1 && possibleEntries[0].id === id
            })
          }),
        ),
      ),
    )
    if (!aggregateEntryIds.every((id) => coveredEntryIds.has(id)) || !aggregateTransactionIds.every((id) => coveredTransactionIds.has(id))) continue
    reconciled.push({
      candidateId: String(candidate.id),
      bundleIds: unique(matchingComponents.map(({ bundle }) => String(bundle.id))).sort(),
      entryIds: aggregateEntryIds,
      transactionIds: aggregateTransactionIds,
      reason: 'bundleEvidenceCovered',
    })
  }
  return reconciled.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
}

const variableEnvelopeIdentity = (entry) => {
  const { context } = projectionContext(entry)
  if (context.direction === 'expense') {
    const budgetId = entry?.budgetId ? String(entry.budgetId) : null
    const categoryId = context.categoryId || ANALYTICS_UNCATEGORIZED_ID
    const label = String(entry?.categoryLabel ?? '').trim() || null
    return { key: budgetId ? `budget:${budgetId}` : `category:${categoryId}`, budgetId, categoryId, label, context }
  }
  const flow = primaryFlow(flowAmountsFor(context, amountOf(entry), 2))
  return flow === 'transfer' ? null : { key: `metric:${flow}`, budgetId: null, categoryId: null, context }
}

const normalizedBudgetPlans = (plans) => {
  const groups = new Map()
  for (const plan of plans.filter(({ id, type, period, amount }) => id && ['reset', 'rollover', 'adjusted'].includes(type) && period === 'monthly' && Number.isFinite(amount) && amount > 0)) {
    const normalized = { id: String(plan.id), type: plan.type, period: plan.period, amount: Number(plan.amount), label: String(plan.label ?? '').trim() || null }
    groups.set(normalized.id, [...(groups.get(normalized.id) ?? []), normalized])
  }
  const normalized = []
  const conflictingPlanIds = []
  for (const [id, candidates] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const variants = unique(candidates.map(({ type, period, amount }) => JSON.stringify({ type, period, amount })))
    if (variants.length > 1) conflictingPlanIds.push(id)
    else normalized.push({ ...candidates[0], label: unique(candidates.map(({ label }) => label).filter(Boolean)).sort()[0] ?? null })
  }
  return { plans: normalized, conflictingPlanIds }
}

const buildVariableEnvelopes = ({ entries, currentEntries, projectedEntries, removedHistorySet, knownCurrentEntryIds, months, historyReady, budgetPlans, currencyDecimalPlaces }) => {
  const { plans, conflictingPlanIds } = normalizedBudgetPlans(budgetPlans)
  const planById = new Map(plans.map((plan) => [plan.id, plan]))
  const conflictingPlanIdSet = new Set(conflictingPlanIds)
  const incompleteAttributions = [
    ...new Map(
      projectedEntries
        .filter(({ budgetAttribution: attribution }) => attribution?.status === 'incomplete')
        .map(({ candidateId, budgetAttribution: attribution }) => [String(candidateId), { candidateId: String(candidateId), budgetIds: [...attribution.budgetIds], missingMembership: true }]),
    ).values(),
  ].sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  const incompleteBudgetIdSet = new Set(incompleteAttributions.flatMap(({ budgetIds }) => budgetIds))
  const hasUnscopedIncompleteAttribution = incompleteAttributions.some(({ budgetIds }) => budgetIds.length === 0)
  const groups = new Map()
  const ensureGroup = ({ key, budgetId = null, categoryId = null, label = null, context = null, budgetAttribution: groupBudgetAttribution = null }) => {
    const group = groups.get(key) ?? {
      key,
      budgetId,
      categoryId,
      context,
      monthly: Object.fromEntries(months.map((month) => [month, 0])),
      actual: 0,
      known: 0,
      evidenceIds: new Set(),
      labels: new Set(),
      observedMonths: new Set(),
      budgetAttribution: null,
    }
    if (!group.context && context) group.context = context
    if (!group.categoryId && categoryId) group.categoryId = categoryId
    if (!group.budgetAttribution && groupBudgetAttribution) group.budgetAttribution = groupBudgetAttribution
    if (label) group.labels.add(label)
    groups.set(key, group)
    return group
  }
  for (const plan of plans) ensureGroup({ key: `budget:${plan.id}`, budgetId: plan.id })
  for (const id of conflictingPlanIds) ensureGroup({ key: `budget:${id}`, budgetId: id })
  const addEntry = (entry, target) => {
    const identity = variableEnvelopeIdentity(entry)
    if (!identity) return
    const group = ensureGroup(identity)
    target(group, amountOf(entry))
    if (entry.id) group.evidenceIds.add(String(entry.id))
    if (entry.transactionId) group.evidenceIds.add(String(entry.transactionId))
  }
  for (const entry of entries.filter(({ monthKey, value }) => months.includes(monthKey) && Number.isFinite(value))) {
    const identity = variableEnvelopeIdentity(entry)
    if (!identity) continue
    ensureGroup(identity).observedMonths.add(entry.monthKey)
  }
  for (const entry of entries.filter(({ id, monthKey, value }) => months.includes(monthKey) && Number.isFinite(value) && !removedHistorySet.has(String(id)))) {
    addEntry(entry, (group, amount) => {
      group.monthly[entry.monthKey] = roundAmount(group.monthly[entry.monthKey] + amount, currencyDecimalPlaces)
    })
  }
  for (const entry of currentEntries.filter(({ id, value }) => Number.isFinite(value) && !knownCurrentEntryIds.has(String(id)))) {
    addEntry(entry, (group, amount) => {
      group.actual = roundAmount(group.actual + amount, currencyDecimalPlaces)
    })
  }
  for (const entry of projectedEntries) {
    const identity = variableEnvelopeIdentity(entry)
    if (!identity) continue
    const group = ensureGroup({ ...identity, budgetAttribution: entry.budgetAttribution ?? null })
    group.known = roundAmount(group.known + entry.amount, currencyDecimalPlaces)
  }
  const envelopes = [...groups.values()]
    .map((group) => {
      const plan = group.budgetId ? planById.get(group.budgetId) : null
      const samples = months.map((month) => group.monthly[month])
      const historySufficient = historyReady && months.length >= 3 && months.every((month) => group.observedMonths.has(month))
      const historical = historySufficient ? roundAmount(median(samples), currencyDecimalPlaces) : null
      const attributionIncomplete = incompleteBudgetIdSet.has(group.budgetId) || (hasUnscopedIncompleteAttribution && Boolean(plan) && !historySufficient)
      const selectedPlan = !attributionIncomplete && plan?.type === 'reset' ? plan.amount : null
      const expected = historySufficient ? historical : selectedPlan
      const variableRemaining = Number.isFinite(expected) ? roundAmount(Math.max(0, expected - group.actual), currencyDecimalPlaces) : 0
      return {
        id: `variable-envelope:${group.key}`,
        budgetId: group.budgetId,
        categoryId: group.categoryId,
        label: plan?.label ?? [...group.labels].sort()[0] ?? null,
        actual: group.actual,
        known: group.known,
        historical,
        plan: plan?.amount ?? null,
        planStatus: conflictingPlanIdSet.has(group.budgetId) ? 'conflicting' : attributionIncomplete ? 'attributionIncomplete' : plan ? 'ready' : 'none',
        expected,
        remaining: roundAmount(variableRemaining + group.known, currencyDecimalPlaces),
        confidence: historySufficient ? 'high' : Number.isFinite(selectedPlan) ? 'low' : 'insufficient',
        evidenceIds: [...group.evidenceIds].sort(),
        budgetAttribution: group.budgetAttribution ? structuredClone(group.budgetAttribution) : group.budgetId ? { status: 'exact', budgetId: group.budgetId, budgetIds: [group.budgetId] } : null,
        historySamples: historyReady ? samples : null,
        flowAmounts: group.context
          ? flowAmountsFor(group.context, variableRemaining, currencyDecimalPlaces)
          : flowAmountsFor({ direction: 'expense', sourceKind: 'available', destinationKind: 'expense' }, variableRemaining, currencyDecimalPlaces),
      }
    })
    .filter(
      ({ actual, known, historical, plan, remaining, evidenceIds, planStatus }) =>
        planStatus === 'conflicting' || evidenceIds.length > 0 || [actual, known, historical, plan, remaining].some((value) => Number.isFinite(value) && value !== 0),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
  return { envelopes, conflictingPlanIds, incompleteAttributions }
}

export function summarizeProjectedSources(sources = [], evidencePreviewLimit = 8) {
  const groups = new Map()
  for (const source of sources) {
    if (!Number.isFinite(source?.amount) || source.amount === 0) continue
    const identity = source.sourceKind === 'variable' ? 'variable' : (source.candidateId ?? source.sourceId ?? source.sourceLabel ?? source.id)
    const id = `${source.sourceKind}:${identity}`
    const group = groups.get(id) ?? []
    group.push(source)
    groups.set(id, group)
  }
  const oneValue = (entries, key) => {
    const values = unique(entries.map((entry) => entry[key]))
    return values.length === 1 ? values[0] : null
  }
  const oneObject = (entries, key) => {
    const values = unique(entries.map((entry) => (entry[key] ? JSON.stringify(entry[key]) : null)))
    return values.length === 1 ? JSON.parse(values[0]) : null
  }
  const limit = Math.max(0, Math.floor(Number(evidencePreviewLimit) || 0))
  const order = { defined: 0, inferred: 1, variable: 2 }
  return [...groups.entries()]
    .map(([id, entries]) => {
      const evidenceIds = unique(entries.flatMap((entry) => entry.evidenceIds ?? []).map(String)).sort()
      return {
        id,
        sourceKind: entries[0].sourceKind,
        sourceLabel: oneValue(entries, 'sourceLabel'),
        sourceId: entries[0].sourceKind === 'variable' ? null : oneValue(entries, 'sourceId'),
        candidateId: entries[0].sourceKind === 'variable' ? null : oneValue(entries, 'candidateId'),
        amount: roundRatio(
          entries.reduce((sum, entry) => sum + entry.amount, 0),
          12,
        ),
        overdue: entries.some(({ overdue }) => overdue === true),
        reasons: unique(entries.flatMap((entry) => entry.reasons ?? [])).sort(),
        confidence: oneObject(entries, 'confidence'),
        conversion: oneObject(entries, 'conversion'),
        evidenceIds: evidenceIds.slice(0, limit),
        evidenceOmittedCount: Math.max(0, evidenceIds.length - limit),
      }
    })
    .sort((left, right) => (order[left.sourceKind] ?? 99) - (order[right.sourceKind] ?? 99) || Math.abs(right.amount) - Math.abs(left.amount) || left.id.localeCompare(right.id))
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

export function buildRemainingActivityForecast({
  ledger,
  candidates = [],
  candidateAmounts = {},
  accountContexts = {},
  budgetPlans = [],
  fetchCoverage = null,
  currencyDecimalPlaces,
  historyMonths,
  today,
  endDate,
}) {
  const todayKey = dateKey(today)
  const endKey = dateKey(endDate)
  const months = completedMonths(todayKey, Number(historyMonths))
  const invalidInput = !todayKey || !endKey || endKey < todayKey || !validDecimalPlaces(currencyDecimalPlaces)
  const normalizedEntries = [...(ledger?.entries ?? [])]
    .map((entry) => ({ ...entry, date: dateKey(entry?.date), monthKey: dateKey(entry?.date)?.slice(0, 7) ?? entry?.monthKey ?? null }))
    .sort((left, right) => String(left.date ?? '').localeCompare(String(right.date ?? '')) || String(left.id ?? '').localeCompare(String(right.id ?? '')))
  const canonicalLedger = canonicalizeLedgerEntries(normalizedEntries)
  const entries = canonicalLedger.entries.map((entry) => (usableLedgerValue(entry) ? entry : { ...entry, value: null }))
  const currentMonthKey = todayKey?.slice(0, 7)
  const relevantEntries = entries.filter((entry) => months.includes(entry.monthKey) || (entry.monthKey === currentMonthKey && entry.date <= todayKey))
  const conflictingRelevantEntries = canonicalLedger.conflicts
    .flatMap(({ entries }) => entries)
    .filter((entry) => months.includes(entry.monthKey) || (entry.monthKey === currentMonthKey && entry.date <= todayKey))
  const conflictingEntryIds = unique(conflictingRelevantEntries.map(({ id }) => String(id))).sort()
  const unavailableEntries = [...relevantEntries.filter((entry) => !Number.isFinite(entry.value)), ...conflictingRelevantEntries]
  if (invalidInput) {
    const values = emptyTotals(null)
    return {
      actualToDate: values,
      historicalBaseline: { ...values },
      final: { ...values },
      knownFinal: { ...values },
      remainingFromToday: { ...values },
      knownRemainingFromToday: { ...values },
      progress: { ...values },
      progressState: Object.fromEntries(FLOW_KEYS.map((key) => [key, 'notApplicable'])),
      confidence: { level: 'unavailable', reasons: ['Missing or unavailable forecast input'] },
      status: 'unavailable',
      statusByMetric: Object.fromEntries(FLOW_KEYS.map((key) => [key, 'unavailable'])),
      dailyProjectedEntries: [],
      variableEnvelopes: [],
      actualTransactionIds: Object.fromEntries(FLOW_KEYS.map((key) => [key, []])),
      audit: {
        bundles: [],
        history: { months, coverage: 'unavailable', samples: null, variableRemainderSamples: null },
        budgets: { conflictingPlanIds: [] },
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
        allocation: { targetsByDimension: {}, allocatedByDimension: {}, suppressedProjectionIds: [], cappedProjectionIds: [] },
        unavailable: { affectedMetricIds: [...FLOW_KEYS], missingCurrencies: [], entryIds: conflictingEntryIds, candidateIds: [], ...(conflictingEntryIds.length > 0 ? { conflictingEntryIds } : {}) },
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
  const suppressedCandidateIds = unique([
    ...canonicalCandidates.candidates.filter((candidate) => !candidateEligible(candidate)).map(({ id }) => String(id)),
    ...canonicalCandidates.candidates.flatMap((candidate) => candidate.suppressedCandidateIds ?? []).map(String),
  ]).sort()
  const conflictingTransactionIds = conflictingRecurringTransactionIds(relevantEntries)
  const authoritativeRecurringIds = recurringHistoryIds(eligibleCandidates.filter(({ source }) => source?.authoritative === true))
  const authoritativeEvidencedHistoryEntryIds = entries
    .filter((entry) => months.includes(entry.monthKey) && (authoritativeRecurringIds.entryIds.has(String(entry.id)) || authoritativeRecurringIds.transactionIds.has(String(entry.transactionId))))
    .map(({ id }) => String(id))
    .sort()
  const matchedHistory = matchedAuthoritativeHistoryIds({
    candidates: eligibleCandidates,
    entries,
    months,
    candidateAmounts,
    accountContexts,
    currencyDecimalPlaces,
    excludedEntryIds: authoritativeEvidencedHistoryEntryIds,
  })
  const uncorroboratedYearlyCandidateIds = eligibleCandidates
    .filter((candidate) => !yearlyCandidateCorroborated(candidate, matchedHistory.entriesByCandidateId.get(String(candidate.id)) ?? []))
    .map(({ id }) => String(id))
  const uncorroboratedYearlyCandidateIdSet = new Set(uncorroboratedYearlyCandidateIds)
  const preparedProjectionCandidates = eligibleCandidates
    .filter(({ id }) => !uncorroboratedYearlyCandidateIdSet.has(String(id)))
    .map((candidate) => {
      const matchedEntries = matchedHistory.entriesByCandidateId.get(String(candidate.id)) ?? []
      return candidateWithBudgetAttribution({
        candidate: { ...candidateWithMatchedContext(candidate, matchedEntries), expectedDates: canonicalExpectedDates(candidate) },
        entries: matchedEntries,
        candidateAmounts,
      })
    })
  const discoveredBundles = discoverRecurringBundles({
    entries,
    months,
    conflictingTransactionIds,
    today: todayKey,
    endDate: endKey,
    currencyDecimalPlaces,
  })
  const bundleSuppressedCandidateIds = preparedProjectionCandidates
    .filter((candidate) =>
      discoveredBundles.some((bundle) => bundleCandidateMatchesAdmittedComponent({ candidate, bundle, amount: Number(candidateAmounts?.[candidate.id]?.value ?? candidate?.expectedAmount?.value) })),
    )
    .map(({ id }) => String(id))
  const bundleSuppressedCandidateIdSet = new Set(bundleSuppressedCandidateIds)
  const aggregateReconciliation = aggregateBundleCandidateReconciliation({
    candidates: preparedProjectionCandidates.filter(({ id }) => !bundleSuppressedCandidateIdSet.has(String(id))),
    bundles: discoveredBundles,
    candidateAmounts,
    accountContexts,
  })
  const aggregateSuppressedCandidateIds = aggregateReconciliation.map(({ candidateId }) => candidateId)
  const suppressedBundleCandidateIdSet = new Set([...bundleSuppressedCandidateIds, ...aggregateSuppressedCandidateIds])
  const projectionCandidates = preparedProjectionCandidates.filter(({ id }) => !suppressedBundleCandidateIdSet.has(String(id)))
  const recurringIds = recurringHistoryIds(projectionCandidates)
  const evidencedHistoryEntryIds = entries
    .filter((entry) => months.includes(entry.monthKey) && (recurringIds.entryIds.has(String(entry.id)) || recurringIds.transactionIds.has(String(entry.transactionId))))
    .map(({ id }) => String(id))
    .sort()
  const currentEntries = entries.filter(({ date }) => date?.startsWith(todayKey.slice(0, 7)) && date <= todayKey)
  const bundles = fulfillRecurringBundles({ bundles: discoveredBundles, currentEntries, conflictingTransactionIds, currencyDecimalPlaces })
  const bundleEntryIds = new Set(bundles.flatMap(({ entryIds }) => entryIds))
  const recurring = matchRecurringOccurrences({ candidates: occurrenceMatchingCandidates(projectionCandidates), actualEntries: currentEntries, today: todayKey })
  const candidateById = new Map(projectionCandidates.map((candidate) => [candidate.id, candidate]))
  const removedHistoryEntryIds = unique([...evidencedHistoryEntryIds, ...matchedHistory.entryIds, ...bundleEntryIds]).sort()
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
  const historicalBaseline = historyReady ? medianSamples(historySamples, currencyDecimalPlaces) : emptyTotals(null)

  const projectionCandidateAmounts = { ...candidateAmounts }
  const linkedAmountEvidenceIds = new Map()
  for (const candidate of projectionCandidates) {
    const candidateId = String(candidate.id)
    const input = candidateProjectionInput({ candidate, candidateAmounts, accountContexts })
    const robust = robustAuthoritativeAmount({ candidate, input, entries: matchedHistory.entriesByCandidateId.get(candidateId) ?? [], currencyDecimalPlaces })
    if (!Number.isFinite(robust.amount)) continue
    projectionCandidateAmounts[candidateId] = { ...(candidateAmounts?.[candidateId] ?? {}), value: robust.amount }
    linkedAmountEvidenceIds.set(candidateId, robust.evidenceIds)
  }

  let projected = projectRecurringBundles({ bundles, currencyDecimalPlaces })
  for (const occurrence of recurring.remaining.sort((left, right) => left.expectedDate.localeCompare(right.expectedDate) || left.expectedId.localeCompare(right.expectedId))) {
    const candidate = candidateById.get(occurrence.candidateId)
    if (!candidate) continue
    const input = candidateProjectionInput({ candidate, candidateAmounts: projectionCandidateAmounts, accountContexts })
    let projectedFlowAmounts = null
    if (input.reasons.length > 0) {
      candidateConversions.set(String(candidate.id), candidateConversionAudit({ candidateId: candidate.id, conversion: input.conversion, resolution: 'unresolved' }))
      const onlyMissingAccountContext = input.reasons.length === 1 && input.reasons[0] === 'missingAccountContext' && Number.isFinite(input.amount)
      const partialProjection = onlyMissingAccountContext ? partialFlowAmountsForMissingAccountContext(input.context, input.amount, currencyDecimalPlaces) : null
      const candidateAffectedMetrics = partialProjection
        ? partialProjection.affectedMetricIds
        : input.reasons.includes('missingAccountContext')
          ? potentiallyAffectedMetricsForMissingAccountContext(input.context, currencyDecimalPlaces)
          : affectedMetricsFor(input.context, currencyDecimalPlaces)
      projectedFlowAmounts = partialProjection?.flowAmounts ?? null
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
      if (!projectedFlowAmounts) continue
    }
    const expectedDate = occurrence.expectedDate > todayKey ? occurrence.expectedDate : nextOverdueDate({ candidate, today: todayKey, endDate: endKey })
    if (!expectedDate || expectedDate <= todayKey || expectedDate > endKey) continue
    const sourceKind = candidate.source.authoritative ? 'defined' : 'inferred'
    candidateConversions.set(String(candidate.id), candidateConversionAudit({ candidateId: candidate.id, conversion: input.conversion, resolution: 'projected' }))
    const bundleParts = sourceKind === 'defined' ? splitBundleProjectionParts({ candidate, amount: input.amount, accountContexts, currencyDecimalPlaces }) : null
    if (bundleParts) {
      bundleParts.forEach(({ component, context, amount }, index) => {
        projected.push(
          projectedEntry({
            id: `projected:${sourceKind}:${occurrence.expectedId}:split:${String(index).padStart(2, '0')}:${expectedDate}`,
            date: expectedDate,
            amount,
            context,
            sourceKind,
            currencyDecimalPlaces,
            candidate,
            expectedId: occurrence.expectedId,
            overdue: occurrence.expectedDate <= todayKey,
            confidence: structuredClone(candidate.confidence),
            reasons: occurrence.expectedDate <= todayKey ? ['Expected occurrence is overdue and was moved to a future date'] : [...(candidate.confidence?.reasons ?? [])],
            conversion: input.conversion,
            evidenceIds: unique([...candidateEvidenceIds(candidate), ...candidateEvidenceIds(component), ...(linkedAmountEvidenceIds.get(String(candidate.id)) ?? [])]).sort(),
            bundleCandidateId: component.id,
            budgetAttribution: candidate.budgetAttribution,
          }),
        )
      })
    } else {
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
          projectedFlowAmounts,
          evidenceIds: unique([...candidateEvidenceIds(candidate), ...(linkedAmountEvidenceIds.get(String(candidate.id)) ?? [])]).sort(),
          budgetAttribution: candidate.budgetAttribution,
        }),
      )
    }
  }

  const dimensionInputs = projectionDimensionInputs({ entries, currentEntries, months, projectedEntries: projected, historyReady, currencyDecimalPlaces })
  const allocation = reconcileProjectedActivity({ ...dimensionInputs, entries: projected, currencyDecimalPlaces })
  projected = allocation.entries
  const knownCurrentEntryIds = new Set([
    ...recurring.fulfilled.flatMap(({ actualEntryIds }) => actualEntryIds ?? []),
    ...bundles.flatMap(({ fulfilledPhases }) => fulfilledPhases.flatMap(({ entryIds }) => entryIds ?? [])),
  ])
  const variableEnvelopeResult = buildVariableEnvelopes({
    entries,
    currentEntries,
    projectedEntries: projected,
    removedHistorySet,
    knownCurrentEntryIds,
    months,
    historyReady,
    budgetPlans,
    currencyDecimalPlaces,
  })
  const variableEnvelopes = variableEnvelopeResult.envelopes
  const remainingFromToday = emptyTotals()
  for (const entry of projected) addAmounts(remainingFromToday, entry.flowAmounts, currencyDecimalPlaces)
  const knownRemainingFromToday = { ...remainingFromToday }
  for (const envelope of variableEnvelopes) addAmounts(remainingFromToday, envelope.flowAmounts, currencyDecimalPlaces)
  const hasProjectedSource = projected.length > 0
  const hasPlanFallback = variableEnvelopes.some(({ expected, historical }) => Number.isFinite(expected) && historical === null)
  const sourceStatus = historyReady ? 'ready' : hasProjectedSource || recurring.fulfilled.length > 0 || hasPlanFallback ? 'partial' : 'insufficientHistory'
  const orderedAffectedMetricIds = FLOW_KEYS.filter((key) => affectedMetricIds.has(key))
  const status =
    canonicalCandidates.conflictingCandidateIds.length > 0
      ? 'partial'
      : orderedAffectedMetricIds.length === FLOW_KEYS.length
        ? 'unavailable'
        : orderedAffectedMetricIds.length > 0 || unresolvedCandidates.length > 0
          ? 'partial'
          : sourceStatus
  const final = emptyTotals(null)
  const knownFinal = emptyTotals(null)
  const progress = emptyTotals(null)
  const progressState = Object.fromEntries(FLOW_KEYS.map((key) => [key, sourceStatus === 'insufficientHistory' ? 'insufficientHistory' : 'notApplicable']))
  const statusByMetric = Object.fromEntries(FLOW_KEYS.map((key) => [key, affectedMetricIds.has(key) ? 'unavailable' : sourceStatus === 'ready' ? 'ready' : sourceStatus]))
  for (const key of FLOW_KEYS) {
    if (actualUnavailableMetricIds.has(key)) actualToDate[key] = null
    if (historyUnavailableMetricIds.has(key)) historicalBaseline[key] = null
    if (forecastUnavailableMetricIds.has(key)) remainingFromToday[key] = null
    if (sourceStatus !== 'insufficientHistory') {
      knownFinal[key] = projectMetricForecast({
        metric: key,
        actual: actualToDate[key],
        historicalAverage: historicalBaseline[key],
        remainingActivity: knownRemainingFromToday[key],
        currencyDecimalPlaces,
      }).final
    }
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

  const confidence = {
    level:
      sourceStatus === 'insufficientHistory'
        ? 'insufficient'
        : status === 'partial' || status === 'unavailable' || hasPlanFallback
          ? 'low'
          : variableEnvelopes.some(({ expected }) => Number.isFinite(expected))
            ? 'medium'
            : 'high',
    reasons: unique([
      ...(historyReady ? [`Uses ${months.length} completed months`] : ['Selected completed-month history is incomplete']),
      ...(hasPlanFallback ? ['Some variable activity uses a reset budget because completed history is insufficient'] : []),
      ...(sourceStatus === 'partial' ? ['Only defined or recurring evidence is available'] : []),
      ...(orderedAffectedMetricIds.length > 0 ? ['Some forecast inputs are unavailable'] : []),
    ]),
  }

  return {
    actualToDate,
    historicalBaseline,
    final,
    knownFinal,
    remainingFromToday,
    knownRemainingFromToday,
    progress,
    progressState,
    confidence,
    status,
    statusByMetric,
    dailyProjectedEntries: projected,
    variableEnvelopes,
    actualTransactionIds: Object.fromEntries(FLOW_KEYS.map((key) => [key, [...actualIds[key]].sort()])),
    audit: {
      bundles: recurringBundleAudit(bundles),
      history: {
        months,
        coverage: historyReady ? 'complete' : coverageStart ? 'partial' : 'unavailable',
        samples: historyReady ? historySamples : null,
        variableRemainderSamples: historyReady ? Object.fromEntries(variableEnvelopes.map((envelope) => [envelope.id, envelope.historySamples])) : null,
      },
      budgets: {
        conflictingPlanIds: variableEnvelopeResult.conflictingPlanIds,
        ...(variableEnvelopeResult.incompleteAttributions.length > 0 ? { incompleteAttributions: variableEnvelopeResult.incompleteAttributions } : {}),
      },
      recurring: {
        fulfilledExpectedIds: recurring.fulfilled.map(({ expectedId }) => expectedId).sort(),
        remainingExpectedIds: recurring.remaining.map(({ expectedId }) => expectedId).sort(),
        removedHistoryEntryIds,
        suppressedCandidateIds: unique([...suppressedCandidateIds, ...uncorroboratedYearlyCandidateIds, ...bundleSuppressedCandidateIds, ...aggregateSuppressedCandidateIds]).sort(),
        unresolvedCandidates: unresolvedCandidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        candidateConversions: [...candidateConversions.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        deduplicatedCandidateIds: canonicalCandidates.deduplicatedCandidateIds,
        conflictingCandidateIds: canonicalCandidates.conflictingCandidateIds,
        aggregateReconciliation,
        ...(conflictingTransactionIds.length > 0 ? { conflictingTransactionIds } : {}),
      },
      allocation: {
        targetsByDimension: allocation.targetsByDimension,
        allocatedByDimension: allocation.allocatedByDimension,
        suppressedProjectionIds: allocation.suppressedProjectionIds,
        cappedProjectionIds: allocation.cappedProjectionIds,
      },
      unavailable: {
        affectedMetricIds: orderedAffectedMetricIds,
        missingCurrencies: [...missingCurrencies].sort(),
        entryIds: unique(unavailableEntryIds).sort(),
        candidateIds: [...unavailableCandidateIds].sort(),
        ...(conflictingEntryIds.length > 0 ? { conflictingEntryIds } : {}),
      },
      missingCurrencies: [...missingCurrencies].sort(),
      unavailableEntryIds: unique(unavailableEntryIds).sort(),
    },
  }
}
