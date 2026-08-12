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

const averageSamples = (samples, currencyDecimalPlaces) =>
  Object.fromEntries(FLOW_KEYS.map((key) => [key, roundAmount(samples[key].reduce((total, value) => total + value, 0) / samples[key].length, currencyDecimalPlaces)]))

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

const recurringBundleComponent = ({ key, occurrences, phase = 'both', bundleId, currencyDecimalPlaces }) => {
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
    label: bundleComponentLabel(representative, context),
    phase,
    context,
    reconciliationOnly: FLOW_KEYS.every((metric) => flowAmountsFor(context, 1, currencyDecimalPlaces)[metric] === 0),
    evidenceEntryIds: evidence.map(({ entry }) => String(entry.id)).sort(),
    evidenceTransactionIds: unique(evidence.map(({ occurrence }) => occurrence.transactionId)).sort(),
    samples: evidence.map(({ entry, occurrence }) => ({ id: String(entry.id), date: occurrence.date, value: amountOf(entry) })),
  }
}

const discoverRecurringBundles = ({ entries, months, excludedEntryIds, today, endDate, currencyDecimalPlaces }) => {
  const excluded = new Set(excludedEntryIds)
  const grouped = new Map()
  for (const entry of entries) {
    if (!months.includes(entry.monthKey) || excluded.has(String(entry.id)) || !Number.isFinite(entry.value) || !entry.transactionId || !entry.date) continue
    const key = `${entry.date}|${entry.transactionId}`
    grouped.set(key, [...(grouped.get(key) ?? []), entry])
  }

  const families = new Map()
  for (const group of [...grouped.values()]) {
    const sortedEntries = group.sort((left, right) => String(left.id).localeCompare(String(right.id)))
    const components = new Map()
    let duplicateComponent = false
    for (const entry of sortedEntries) {
      const key = contextKey(projectionContext(entry).context)
      if (components.has(key)) duplicateComponent = true
      components.set(key, entry)
    }
    if (duplicateComponent || components.size < 2) continue
    const anchor = sortedEntries
      .map((entry) => ({ entry, flowAmounts: flowAmountsFor(projectionContext(entry).context, amountOf(entry), currencyDecimalPlaces) }))
      .filter(({ flowAmounts }) => flowAmounts.income > 0 && flowAmounts.availableCashChange > 0)
      .sort((left, right) => right.flowAmounts.availableCashChange - left.flowAmounts.availableCashChange || String(left.entry.id).localeCompare(String(right.entry.id)))[0]?.entry
    if (!anchor) continue
    const anchorKey = contextKey(projectionContext(anchor).context)
    const occurrence = { date: String(anchor.date), monthKey: String(anchor.monthKey), transactionId: String(anchor.transactionId), components, anchorKey }
    families.set(anchorKey, [...(families.get(anchorKey) ?? []), occurrence])
  }

  const discovered = []
  for (const [anchorKey, family] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const occurrences = family.sort((left, right) => left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId))
    if (occurrences.length < 3 || new Set(occurrences.map(({ monthKey }) => monthKey)).size < 2) continue
    const middleOccurrences = occurrences.filter(({ date }) => dateParts(date).day <= 20)
    const monthEndOccurrences = occurrences.filter(({ date }) => dateParts(date).day > 20)
    if (
      middleOccurrences.length < 2 ||
      monthEndOccurrences.length < 2 ||
      new Set(middleOccurrences.map(({ monthKey }) => monthKey)).size < 2 ||
      new Set(monthEndOccurrences.map(({ monthKey }) => monthKey)).size < 2
    )
      continue

    const allKeys = unique(occurrences.flatMap(({ components }) => [...components.keys()])).sort()
    const commonKeys = allKeys.filter((key) => occurrences.every(({ components }) => components.has(key)))
    if (commonKeys.length < 2 || !commonKeys.includes(anchorKey)) continue
    const signature = commonKeys.join('||')
    const id = `bundle:${stableHash(`${anchorKey}|${signature}`)}`
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
        .filter((key) => !phaseOnlyKeys.has(key))
        .sort()
        .join('||')
    const pairSignaturesAgree = eligibleSignature(latestPair[0]) === eligibleSignature(latestPair[1]) && eligibleSignature(latestPair[0]) === signature
    const pairAmountsAgree = commonKeys.every(
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
    const components = [
      ...commonKeys.map((key) => recurringBundleComponent({ key, occurrences, bundleId: id, currencyDecimalPlaces })),
      ...phaseComponents.middle.map((key) => recurringBundleComponent({ key, occurrences: middleOccurrences, phase: 'middle', bundleId: id, currencyDecimalPlaces })),
      ...phaseComponents.monthEnd.map((key) => recurringBundleComponent({ key, occurrences: monthEndOccurrences, phase: 'monthEnd', bundleId: id, currencyDecimalPlaces })),
    ].sort((left, right) => left.id.localeCompare(right.id))
    for (const component of components) {
      component.amount = roundAmount(regimeChanged && component.phase === 'both' ? latestPair[1].components.get(component.key).value : recencyWeightedMedian(component.samples), currencyDecimalPlaces)
      delete component.samples
    }
    const admittedComponentKeys = new Set(components.map(({ key }) => key))
    const inconsistentComponentKeys = allKeys.filter((key) => !admittedComponentKeys.has(key))

    const target = dateParts(today)
    const middleDay = Math.round(median(middleOccurrences.map(({ date }) => dateParts(date).day)))
    const middleDate = precedingBusinessDay(`${target.year}-${String(target.month).padStart(2, '0')}-${String(Math.min(middleDay, daysInMonth(target.year, target.month))).padStart(2, '0')}`)
    const endOfMonthDate = precedingBusinessDay(`${target.year}-${String(target.month).padStart(2, '0')}-${String(daysInMonth(target.year, target.month)).padStart(2, '0')}`)
    const projectedDates = [
      ...(middleDate > today && middleDate <= endDate ? [{ date: middleDate, phase: 'middle' }] : []),
      ...(endOfMonthDate > today && endOfMonthDate <= endDate ? [{ date: endOfMonthDate, phase: 'monthEnd' }] : []),
    ]
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
      projectedDates,
      components,
      matchingEntryIds: unique(occurrences.flatMap(({ components }) => [...components.values()].map(({ id }) => String(id)))).sort(),
    })
  }
  return discovered.sort((left, right) => left.id.localeCompare(right.id))
}

const fulfillRecurringBundles = ({ bundles, currentEntries, currencyDecimalPlaces }) => {
  const groups = new Map()
  for (const entry of currentEntries) {
    if (!Number.isFinite(entry.value) || !entry.transactionId || !entry.date) continue
    const key = `${entry.date}|${entry.transactionId}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  const occurrences = [...groups.values()]
    .map((entries) => {
      const sortedEntries = entries.sort((left, right) => String(left.id).localeCompare(String(right.id)))
      const components = new Map()
      for (const entry of sortedEntries) {
        const key = contextKey(projectionContext(entry).context)
        if (components.has(key)) return null
        components.set(key, entry)
      }
      return { date: String(sortedEntries[0].date), transactionId: String(sortedEntries[0].transactionId), entries: sortedEntries, components }
    })
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId))

  return bundles.map((bundle) => {
    const remainingDates = [...bundle.projectedDates]
    const fulfilledPhases = []
    const knownKeys = new Set(bundle.components.map(({ key }) => key))
    for (const occurrence of occurrences.filter(({ components }) => components.has(bundle.anchorKey))) {
      const recognizedKeys = [...occurrence.components.keys()].filter((key) => knownKeys.has(key)).sort()
      const matchingPhases = remainingDates
        .filter(({ phase }) => {
          const expected = bundle.components.filter((component) => component.phase === 'both' || component.phase === phase)
          const expectedKeys = expected.map(({ key }) => key).sort()
          return (
            JSON.stringify(recognizedKeys) === JSON.stringify(expectedKeys) &&
            expected.every(({ key, amount }) => roundAmount(amountOf(occurrence.components.get(key)), currencyDecimalPlaces) === roundAmount(amount, currencyDecimalPlaces))
          )
        })
        .sort((left, right) => calendarDayDistance(occurrence.date, left.date) - calendarDayDistance(occurrence.date, right.date) || left.phase.localeCompare(right.phase))
      const matched = matchingPhases[0]
      if (!matched) continue
      remainingDates.splice(
        remainingDates.findIndex(({ phase }) => phase === matched.phase),
        1,
      )
      fulfilledPhases.push({
        phase: matched.phase,
        entryIds: occurrence.entries.map(({ id }) => String(id)).sort(),
        transactionIds: [occurrence.transactionId],
      })
    }
    return { ...bundle, projectedDates: remainingDates, fulfilledPhases: fulfilledPhases.sort((left, right) => left.phase.localeCompare(right.phase)) }
  })
}

const recurringBundleAudit = (bundles) =>
  bundles.map((bundle) => {
    const audit = structuredClone(bundle)
    delete audit.matchingEntryIds
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
    ...(bundleCandidateId ? { bundleCandidateId } : {}),
    ...(conversion ? { conversion: structuredClone(conversion) } : {}),
    ...(profile ? { profile } : {}),
  }
}

const projectRecurringBundles = ({ bundles, currencyDecimalPlaces }) =>
  bundles.flatMap((bundle) =>
    bundle.projectedDates.flatMap(({ date, phase }) =>
      bundle.components
        .filter((component) => !component.reconciliationOnly && (component.phase === 'both' || component.phase === phase))
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
      knownFinal: { ...values },
      remainingFromToday: { ...values },
      knownRemainingFromToday: { ...values },
      progress: { ...values },
      progressState: Object.fromEntries(FLOW_KEYS.map((key) => [key, 'notApplicable'])),
      confidence: { level: 'unavailable', reasons: ['Missing or unavailable forecast input'] },
      status: 'unavailable',
      statusByMetric: Object.fromEntries(FLOW_KEYS.map((key) => [key, 'unavailable'])),
      dailyProjectedEntries: [],
      actualTransactionIds: Object.fromEntries(FLOW_KEYS.map((key) => [key, []])),
      audit: {
        bundles: [],
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
        allocation: { targetsByDimension: {}, allocatedByDimension: {}, suppressedProjectionIds: [], cappedProjectionIds: [] },
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
  const suppressedCandidateIds = unique([
    ...canonicalCandidates.candidates.filter((candidate) => !candidateEligible(candidate)).map(({ id }) => String(id)),
    ...canonicalCandidates.candidates.flatMap((candidate) => candidate.suppressedCandidateIds ?? []).map(String),
  ]).sort()
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
  const preparedProjectionCandidates = eligibleCandidates.map((candidate) => candidateWithMatchedContext(candidate, matchedHistory.entriesByCandidateId.get(String(candidate.id)) ?? []))
  const discoveredBundles = discoverRecurringBundles({
    entries,
    months,
    excludedEntryIds: [...authoritativeEvidencedHistoryEntryIds, ...matchedHistory.entryIds],
    today: todayKey,
    endDate: endKey,
    currencyDecimalPlaces,
  })
  const bundleMatchingEntryIds = new Set(discoveredBundles.flatMap(({ matchingEntryIds }) => matchingEntryIds))
  const bundleSuppressedCandidateIds = preparedProjectionCandidates
    .filter((candidate) => (candidate.evidence?.entryIds ?? []).some((id) => bundleMatchingEntryIds.has(String(id))))
    .map(({ id }) => String(id))
  const bundleSuppressedCandidateIdSet = new Set(bundleSuppressedCandidateIds)
  const projectionCandidates = preparedProjectionCandidates.filter(({ id }) => !bundleSuppressedCandidateIdSet.has(String(id)))
  const recurringIds = recurringHistoryIds(projectionCandidates)
  const evidencedHistoryEntryIds = entries
    .filter((entry) => months.includes(entry.monthKey) && (recurringIds.entryIds.has(String(entry.id)) || recurringIds.transactionIds.has(String(entry.transactionId))))
    .map(({ id }) => String(id))
    .sort()
  const currentEntries = entries.filter(({ date }) => date?.startsWith(todayKey.slice(0, 7)) && date <= todayKey)
  const bundles = fulfillRecurringBundles({ bundles: discoveredBundles, currentEntries, currencyDecimalPlaces })
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
  const historicalBaseline = historyReady ? averageSamples(historySamples, currencyDecimalPlaces) : emptyTotals(null)

  const variableGroups = new Map()
  if (historyReady) {
    for (const entry of entries.filter(({ monthKey, value }) => months.includes(monthKey) && Number.isFinite(value))) {
      if (removedHistorySet.has(String(entry.id))) continue
      const parts = dateParts(entry.date)
      if (!parts) continue
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

  let projected = projectRecurringBundles({ bundles, currencyDecimalPlaces })
  for (const occurrence of recurring.remaining.sort((left, right) => left.expectedDate.localeCompare(right.expectedDate) || left.expectedId.localeCompare(right.expectedId))) {
    const candidate = candidateById.get(occurrence.candidateId)
    if (!candidate) continue
    const input = candidateProjectionInput({ candidate, candidateAmounts, accountContexts })
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
            evidenceIds: unique([...candidateEvidenceIds(candidate), ...candidateEvidenceIds(component)]).sort(),
            bundleCandidateId: component.id,
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
        }),
      )
    }
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

  const dimensionInputs = projectionDimensionInputs({ entries, currentEntries, months, projectedEntries: projected, historyReady, currencyDecimalPlaces })
  const allocation = reconcileProjectedActivity({ ...dimensionInputs, entries: projected, currencyDecimalPlaces })
  projected = allocation.entries
  const remainingFromToday = emptyTotals()
  for (const entry of projected) addAmounts(remainingFromToday, entry.flowAmounts, currencyDecimalPlaces)
  const knownRemainingFromToday = { ...remainingFromToday }
  const hasProjectedSource = projected.some(({ sourceKind }) => sourceKind !== 'variable')
  const sourceStatus = historyReady ? 'ready' : hasProjectedSource || recurring.fulfilled.length > 0 ? 'partial' : 'insufficientHistory'
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
    knownFinal,
    remainingFromToday,
    knownRemainingFromToday,
    progress,
    progressState,
    confidence,
    status,
    statusByMetric,
    dailyProjectedEntries: projected,
    actualTransactionIds: Object.fromEntries(FLOW_KEYS.map((key) => [key, [...actualIds[key]].sort()])),
    audit: {
      bundles: recurringBundleAudit(bundles),
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
        suppressedCandidateIds: unique([...suppressedCandidateIds, ...bundleSuppressedCandidateIds]).sort(),
        unresolvedCandidates: unresolvedCandidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        candidateConversions: [...candidateConversions.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
        deduplicatedCandidateIds: canonicalCandidates.deduplicatedCandidateIds,
        conflictingCandidateIds: canonicalCandidates.conflictingCandidateIds,
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
        entryIds: unavailableEntryIds.sort(),
        candidateIds: [...unavailableCandidateIds].sort(),
      },
      missingCurrencies: [...missingCurrencies].sort(),
      unavailableEntryIds: unavailableEntryIds.sort(),
    },
  }
}
