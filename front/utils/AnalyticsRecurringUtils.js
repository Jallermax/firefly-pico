const THRESHOLDS = {
  occurrences: 3,
  coverage: 0.6,
  identityStability: 0.8,
  dateMadDays: 4,
  relativeAmountMad: 0.25,
  cadenceFit: 0.8,
}

const round = (value, precision = 6) => Number(value.toFixed(precision))
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]
const idOf = (value) => (value === null || value === undefined || value === '' ? null : String(value))
const attributesOf = (value) => value?.attributes ?? value ?? {}
const codeOf = (value) => value?.fireflyCode ?? value?.code ?? value

const normalizeText = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')

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
const daysBetween = (left, right) => Math.round((dateParts(right).date - dateParts(left).date) / 86400000)
const daysInMonth = (year, month) => new Date(year, month, 0).getDate()
const monthIndex = ({ year, month }) => year * 12 + month - 1
const currentMonthStart = (value) => {
  const { year, month } = dateParts(value)
  return `${year}-${String(month).padStart(2, '0')}-01`
}
const completedEnd = (value) => {
  const { year, month } = dateParts(value)
  return formatDate(new Date(year, month - 1, 0))
}

const median = (values) => {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const medianAbsoluteDeviation = (values) => {
  const center = median(values)
  return center === null ? null : median(values.map((value) => Math.abs(value - center)))
}

const mode = (values) => {
  const counts = new Map()
  for (const value of values) counts.set(value ?? null, (counts.get(value ?? null) ?? 0) + 1)
  const sorted = [...counts.entries()].sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || String(leftValue ?? '').localeCompare(String(rightValue ?? '')))
  const [value, count] = sorted[0] ?? [null, 0]
  return { value, count, ratio: values.length ? count / values.length : 0 }
}

const directionOf = (entry) => {
  if (entry?.destinationKind === 'expense') return 'expense'
  if (entry?.sourceKind === 'revenue') return 'income'
  if (entry?.sourceKind === 'expense' && entry?.destinationKind !== 'expense') return 'income'
  return 'transfer'
}

const accountId = (entry, side) => idOf(entry?.[`${side}Account`]?.id ?? entry?.[`${side}AccountId`] ?? entry?.[`${side}_id`])

const payeeOf = (entry, direction = directionOf(entry)) => {
  const external = direction === 'income' ? entry?.sourceAccount : direction === 'expense' ? entry?.destinationAccount : null
  return normalizeText(entry?.payee ?? entry?.description ?? external?.attributes?.name ?? external?.name ?? external?.id)
}

const identityOf = (entry) => {
  const direction = directionOf(entry)
  return {
    direction,
    sourceAccountId: accountId(entry, 'source'),
    sourceKind: entry?.sourceKind ?? null,
    destinationAccountId: accountId(entry, 'destination'),
    destinationKind: entry?.destinationKind ?? null,
    categoryId: idOf(entry?.categoryId ?? entry?.category_id),
    payee: payeeOf(entry, direction),
  }
}

const signatureOf = (identity) =>
  [identity.direction, identity.sourceKind, identity.sourceAccountId, identity.destinationKind, identity.destinationAccountId, identity.categoryId, identity.payee]
    .map((value) => value ?? '')
    .join('|')

const stableHash = (value) => {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const cadenceKey = (cadence) => [cadence.type, ...(cadence.days ?? []), ...(cadence.fromMonthEnd ?? []), cadence.weekday ?? '', cadence.intervalWeeks ?? ''].join(':')

const sortedEvidence = (entries) => ({
  entryIds: unique(entries.map(({ id }) => idOf(id))).sort(),
  transactionIds: unique(entries.map(({ transactionId }) => idOf(transactionId))).sort(),
  dates: unique(entries.map(({ date }) => dateKey(date))).sort(),
})

const identityVariantsFor = (entries) => {
  const variants = new Map()
  for (const entry of entries) {
    const identity = identityOf(entry)
    const signature = signatureOf(identity)
    const variant = variants.get(signature) ?? { signature, identity, entries: [] }
    variant.entries.push(entry)
    variants.set(signature, variant)
  }
  return [...variants.values()]
    .map(({ signature, identity, entries: variantEntries }) => ({ signature, identity, count: variantEntries.length, evidence: sortedEvidence(variantEntries) }))
    .sort((left, right) => right.count - left.count || left.signature.localeCompare(right.signature))
}

const dominantIdentity = (entries) => {
  const variants = identityVariantsFor(entries)
  return { identity: variants[0]?.identity ?? identityOf({}), stability: entries.length ? (variants[0]?.count ?? 0) / entries.length : 0, variants }
}

const groupKeyFor = (entry) => {
  const identity = identityOf(entry)
  const externalAccountId = identity.direction === 'income' ? identity.sourceAccountId : identity.direction === 'expense' ? identity.destinationAccountId : null
  return `${identity.direction}|${externalAccountId ?? identity.payee ?? signatureOf(identity)}`
}

const weeklyScore = ({ entries, intervalWeeks, completedThrough }) => {
  const anchorDate = entries[0].date
  const cycleDays = intervalWeeks * 7
  const cycles = entries.map(({ date }) => Math.floor(daysBetween(anchorDate, date) / cycleDays))
  const distinctCycles = new Set(cycles).size
  const eligibleCycles = Math.max(0, Math.floor(daysBetween(anchorDate, completedThrough) / cycleDays) + 1)
  const weekdays = entries.map(({ date }) => {
    const weekday = dateParts(date).date.getDay()
    return weekday === 0 ? 7 : weekday
  })
  const weekday = mode(weekdays)
  const cadenceFit = Math.min(distinctCycles / entries.length, weekday.ratio)
  return {
    cadence: { type: intervalWeeks === 1 ? 'weekly' : 'biweekly', intervalWeeks, weekday: weekday.value, anchorDate },
    distinctCycles,
    eligibleCycles,
    coverage: eligibleCycles ? distinctCycles / eligibleCycles : 0,
    cadenceFit,
    dateMadDays: 0,
  }
}

const monthlyScore = ({ entries, twice = false, completedThrough }) => {
  const first = dateParts(entries[0].date)
  const last = dateParts(completedThrough)
  const eligibleMonths = Math.max(0, monthIndex(last) - monthIndex(first) + 1)
  const cycleKeys = entries.map(({ date }) => {
    const parts = dateParts(date)
    return `${parts.year}-${parts.month}:${twice ? (parts.day <= 20 ? 1 : 2) : 1}`
  })
  const distinctCycles = new Set(cycleKeys).size
  const firstHalf = entries.filter(({ date }) => dateParts(date).day <= 20).map(({ date }) => dateParts(date).day)
  const secondHalf = entries
    .filter(({ date }) => dateParts(date).day > 20)
    .map(({ date }) => {
      const { year, month, day } = dateParts(date)
      return daysInMonth(year, month) - day
    })
  const deviations = twice
    ? [...firstHalf.map((day) => Math.abs(day - median(firstHalf))), ...secondHalf.map((offset) => Math.abs(offset - median(secondHalf)))]
    : entries.map(({ date }) => dateParts(date).day).map((day, index, days) => Math.abs(day - median(days)))
  return {
    cadence: twice
      ? { type: 'twiceMonthly', days: [Math.round(median(firstHalf))], fromMonthEnd: [Math.round(median(secondHalf))] }
      : { type: 'monthly', days: [Math.round(median(entries.map(({ date }) => dateParts(date).day)))] },
    distinctCycles,
    eligibleCycles: eligibleMonths * (twice ? 2 : 1),
    coverage: eligibleMonths ? distinctCycles / (eligibleMonths * (twice ? 2 : 1)) : 0,
    cadenceFit: distinctCycles / entries.length,
    dateMadDays: median(deviations) ?? Infinity,
  }
}

const reasonsFor = ({ entries, score, identityStability, relativeAmountMad, amountMedian }) => {
  const reasons = []
  if (score.distinctCycles < THRESHOLDS.occurrences) reasons.push({ code: 'occurrenceCount', actual: score.distinctCycles, minimum: THRESHOLDS.occurrences })
  if (score.coverage < THRESHOLDS.coverage) reasons.push({ code: 'cycleCoverage', actual: round(score.coverage), minimum: THRESHOLDS.coverage })
  if (identityStability < THRESHOLDS.identityStability) reasons.push({ code: 'identityStability', actual: round(identityStability), minimum: THRESHOLDS.identityStability })
  if (score.cadenceFit < THRESHOLDS.cadenceFit) reasons.push({ code: 'cadenceFit', actual: round(score.cadenceFit), minimum: THRESHOLDS.cadenceFit })
  if (['monthly', 'twiceMonthly'].includes(score.cadence.type) && score.dateMadDays > THRESHOLDS.dateMadDays)
    reasons.push({ code: 'dateDispersion', actual: round(score.dateMadDays), maximum: THRESHOLDS.dateMadDays })
  if (relativeAmountMad > THRESHOLDS.relativeAmountMad) reasons.push({ code: 'amountDispersion', actual: round(relativeAmountMad), maximum: THRESHOLDS.relativeAmountMad })
  if (amountMedian === 0) reasons.push({ code: 'zeroMagnitude', actual: 0, minimumExclusive: 0 })
  if (entries.length < THRESHOLDS.occurrences && !reasons.some(({ code }) => code === 'occurrenceCount'))
    reasons.push({ code: 'occurrenceCount', actual: entries.length, minimum: THRESHOLDS.occurrences })
  return reasons
}

const confidenceFor = ({ entries, score, identityStability, relativeAmountMad, reasons }) => {
  const amountFactor = Math.max(0, 1 - relativeAmountMad / THRESHOLDS.relativeAmountMad)
  const dateFactor = ['monthly', 'twiceMonthly'].includes(score.cadence.type) ? Math.max(0, 1 - score.dateMadDays / (THRESHOLDS.dateMadDays + 1)) : 1
  return {
    score: round((Math.min(1, score.coverage) + identityStability + score.cadenceFit + amountFactor + dateFactor) / 5),
    factors: {
      occurrences: entries.length,
      distinctCycles: score.distinctCycles,
      eligibleCycles: score.eligibleCycles,
      coverage: round(score.coverage),
      identityStability: round(identityStability),
      cadenceFit: round(score.cadenceFit),
      dateMadDays: round(score.dateMadDays),
      relativeAmountMad: round(relativeAmountMad),
    },
    reasons: reasons.length
      ? reasons.map(({ code }) => code)
      : [
          `Observed in ${score.distinctCycles} of ${score.eligibleCycles} eligible cycles`,
          `Identity stability ${Math.round(identityStability * 100)}%`,
          `Relative amount dispersion ${Math.round(relativeAmountMad * 100)}%`,
        ],
  }
}

const cadenceScores = ({ entries, completedThrough }) => [
  weeklyScore({ entries, intervalWeeks: 1, completedThrough }),
  weeklyScore({ entries, intervalWeeks: 2, completedThrough }),
  monthlyScore({ entries, completedThrough }),
  monthlyScore({ entries, twice: true, completedThrough }),
]

const candidateFrom = ({ entries, score, identity, identityVariants, confidence, amountMedian, amountMin, amountMax }) => {
  const signature = signatureOf(identity)
  const id = `inferred:${stableHash(`${signature}|${cadenceKey(score.cadence)}`)}`
  return {
    id,
    signature,
    identity,
    identityVariants,
    direction: identity.direction,
    cadence: score.cadence,
    expectedAmount: { value: amountMedian, min: amountMin, max: amountMax },
    source: { type: 'inferred', id, authoritative: false },
    evidence: sortedEvidence(entries),
    confidence,
    matching: {
      dateWindowDays: ['monthly', 'twiceMonthly'].includes(score.cadence.type) ? 4 : 2,
      amountTolerance: THRESHOLDS.relativeAmountMad,
      amountEnvelope: { min: amountMedian * (1 - THRESHOLDS.relativeAmountMad), max: amountMedian * (1 + THRESHOLDS.relativeAmountMad) },
    },
    expectedDates: [],
  }
}

export function detectRecurringCandidates({ entries = [], startDate, endDate }) {
  const start = dateKey(startDate)
  const end = dateKey(endDate)
  if (!start || !end) return { candidates: [], audit: { accepted: [], rejected: [] } }
  const completedThrough = completedEnd(end)
  const eligibleEntries = entries
    .map((entry) => ({ ...entry, date: dateKey(entry?.date) }))
    .filter((entry) => entry.date && entry.date >= start && entry.date <= completedThrough && Number.isFinite(entry?.value) && !entry?.refund?.isRefund)
    .sort((left, right) => left.date.localeCompare(right.date) || String(left.id ?? '').localeCompare(String(right.id ?? '')))
  const groups = new Map()
  for (const entry of eligibleEntries) groups.set(groupKeyFor(entry), [...(groups.get(groupKeyFor(entry)) ?? []), entry])

  const candidates = []
  const rejected = []
  for (const [groupId, groupEntries] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const { identity, stability, variants } = dominantIdentity(groupEntries)
    const amounts = groupEntries.map(({ value }) => Math.abs(value))
    const amountMedian = median(amounts)
    const amountMad = medianAbsoluteDeviation(amounts)
    const relativeAmountMad = amountMedian === 0 ? (amountMad === 0 ? 0 : Infinity) : amountMad / Math.abs(amountMedian)
    const attempts = cadenceScores({ entries: groupEntries, completedThrough }).map((score) => {
      const reasons = reasonsFor({ entries: groupEntries, score, identityStability: stability, relativeAmountMad, amountMedian })
      return { score, reasons, confidence: confidenceFor({ entries: groupEntries, score, identityStability: stability, relativeAmountMad, reasons }) }
    })
    attempts.sort(
      (left, right) =>
        Number(left.reasons.length === 0) - Number(right.reasons.length === 0) || right.confidence.score - left.confidence.score || left.score.cadence.type.localeCompare(right.score.cadence.type),
    )
    const accepted = attempts
      .filter(({ reasons }) => reasons.length === 0)
      .sort((left, right) => right.confidence.score - left.confidence.score || left.score.cadence.type.localeCompare(right.score.cadence.type))[0]
    if (accepted) {
      candidates.push(
        candidateFrom({
          entries: groupEntries,
          score: accepted.score,
          identity,
          identityVariants: variants,
          confidence: accepted.confidence,
          amountMedian,
          amountMin: Math.min(...amounts),
          amountMax: Math.max(...amounts),
        }),
      )
      continue
    }
    const best = attempts.sort(
      (left, right) => left.reasons.length - right.reasons.length || right.confidence.score - left.confidence.score || left.score.cadence.type.localeCompare(right.score.cadence.type),
    )[0]
    rejected.push({ groupId, identity, identityVariants: variants, cadence: best.score.cadence, evidence: sortedEvidence(groupEntries), confidence: best.confidence, reasons: best.reasons })
  }

  candidates.sort((left, right) => left.id.localeCompare(right.id))
  rejected.sort((left, right) => left.groupId.localeCompare(right.groupId))
  return { candidates, audit: { accepted: candidates.map(({ id }) => id), rejected } }
}

const cadenceFromDefinition = ({ attributes, repetition = {}, dates, sourceType }) => {
  const type = repetition.type ?? codeOf(attributes.repetitionType) ?? attributes.repeat_freq
  const normalizedType = normalizeText(type).replace(/ /g, '')
  const skip = Number(repetition.skip ?? attributes.repetitionSkip ?? attributes.skip ?? 0)
  const definitionStart = dateKey(attributes.first_date ?? attributes.firstDate ?? attributes.date)
  if (normalizedType === 'weekly') {
    const weekday = Number(repetition.moment ?? codeOf(attributes.repetitionWeekday)) || (dates[0] || definitionStart ? dateParts(dates[0] ?? definitionStart).date.getDay() || 7 : null)
    return { type: skip === 1 ? 'biweekly' : 'weekly', intervalWeeks: skip + 1, weekday, anchorDate: dates[0] ?? definitionStart }
  }
  if (['monthly', 'month'].includes(normalizedType)) {
    const day = Number(repetition.moment ?? attributes.repetitionDay) || (dates[0] || definitionStart ? dateParts(dates[0] ?? definitionStart).day : null)
    return day ? { type: 'monthly', days: [day] } : null
  }
  if (sourceType === 'subscription' && dates.length > 1) {
    const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date))
    const gap = median(gaps)
    if (gap >= 6 && gap <= 8) {
      const weekday = dateParts(dates[0]).date.getDay() || 7
      return { type: 'weekly', intervalWeeks: 1, weekday, anchorDate: dates[0] }
    }
    if (gap >= 12 && gap <= 16) {
      const weekday = dateParts(dates[0]).date.getDay() || 7
      return { type: 'biweekly', intervalWeeks: 2, weekday, anchorDate: dates[0] }
    }
  }
  return null
}

const datesFromDefinition = ({ attributes, repetition = null, sourceType }) => {
  const values = repetition ? (repetition.occurrences ?? []) : sourceType === 'subscription' ? [...(attributes.pay_dates ?? []), attributes.next_expected_match] : (attributes.occurrences ?? [])
  return unique(values.map(dateKey)).sort()
}

const datesForCadence = ({ cadence, startDate, endDate }) => {
  if (!cadence) return []
  const start = dateParts(startDate)
  const end = dateParts(endDate)
  const dates = []
  if (['monthly', 'twiceMonthly'].includes(cadence.type)) {
    for (let index = monthIndex(start); index <= monthIndex(end); index++) {
      const year = Math.floor(index / 12)
      const month = (index % 12) + 1
      for (const day of cadence.days ?? []) dates.push(`${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, daysInMonth(year, month))).padStart(2, '0')}`)
      for (const offset of cadence.fromMonthEnd ?? []) dates.push(`${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month) - offset).padStart(2, '0')}`)
    }
  } else if (['weekly', 'biweekly'].includes(cadence.type) && cadence.anchorDate) {
    let cursor = dateParts(cadence.anchorDate).date
    while (formatDate(cursor) < start.key) cursor = addDays(cursor, cadence.intervalWeeks * 7)
    while (formatDate(cursor) <= end.key) {
      dates.push(formatDate(cursor))
      cursor = addDays(cursor, cadence.intervalWeeks * 7)
    }
  }
  return unique(dates.filter((date) => date >= start.key && date <= end.key)).sort()
}

const expectedAmount = ({ value, min = value, max = value }) => {
  const parsedValue = Number(value)
  const parsedMin = Number(min)
  const parsedMax = Number(max)
  return {
    value: Number.isFinite(parsedValue) ? Math.abs(parsedValue) : null,
    min: Number.isFinite(parsedMin) ? Math.abs(parsedMin) : null,
    max: Number.isFinite(parsedMax) ? Math.abs(parsedMax) : null,
  }
}

const definitionBounds = (attributes) => ({
  start: dateKey(attributes.first_date ?? attributes.firstDate ?? attributes.date),
  end: dateKey(attributes.repeat_until ?? attributes.repeatUntil ?? attributes.end_date ?? attributes.endDate),
})

const definitionSchedules = ({ attributes, sourceType }) => {
  const repetitions = sourceType === 'recurringTransaction' ? (attributes.repetitions ?? []) : []
  let schedules = repetitions.length
    ? repetitions.map((repetition) => {
        const dates = datesFromDefinition({ attributes, repetition, sourceType })
        return { cadence: cadenceFromDefinition({ attributes, repetition, dates, sourceType }), dates }
      })
    : (() => {
        const dates = datesFromDefinition({ attributes, sourceType })
        return [{ cadence: cadenceFromDefinition({ attributes, dates, sourceType }), dates }]
      })()
  schedules = schedules.filter(({ cadence, dates }) => cadence || dates.length)

  if (schedules.length === 2 && schedules.every(({ cadence }) => cadence?.type === 'monthly')) {
    const ordered = [...schedules].sort((left, right) => left.cadence.days[0] - right.cadence.days[0])
    const middleDay = ordered[0].cadence.days[0]
    const monthEndDay = ordered[1].cadence.days[0]
    if (middleDay <= 20 && monthEndDay > 20) {
      const observedOffsets = ordered[1].dates.map((date) => {
        const { year, month, day } = dateParts(date)
        return daysInMonth(year, month) - day
      })
      const monthEndOffset = Math.round(median(observedOffsets) ?? Math.max(0, 31 - monthEndDay))
      schedules = [
        {
          cadence: { type: 'twiceMonthly', days: [middleDay], fromMonthEnd: [monthEndOffset] },
          dates: unique([...ordered[0].dates, ...ordered[1].dates]).sort(),
        },
      ]
    }
  }

  return schedules.sort(
    (left, right) => cadenceKey(left.cadence ?? { type: 'dates' }).localeCompare(cadenceKey(right.cadence ?? { type: 'dates' })) || left.dates.join('|').localeCompare(right.dates.join('|')),
  )
}

const definedCandidate = ({ item, sourceType, startDate, endDate, schedule, includeStreamId }) => {
  const attributes = attributesOf(item)
  if (attributes.active === false) return null
  const transaction = attributes.transactions?.[0] ?? {}
  const directDates = schedule.dates
  const cadence = schedule.cadence
  if (!cadence && directDates.length === 0) return null
  const bounds = definitionBounds(attributes)
  const effectiveStart = [startDate, bounds.start].filter(Boolean).sort().at(-1)
  const effectiveEnd = [endDate, bounds.end].filter(Boolean).sort()[0]
  if (!effectiveStart || !effectiveEnd || effectiveStart > effectiveEnd) return null
  const boundedDirectDates = directDates.filter((date) => (!bounds.start || date >= bounds.start) && (!bounds.end || date <= bounds.end) && date >= effectiveStart && date <= effectiveEnd)
  const expectedDates = boundedDirectDates.length ? boundedDirectDates : datesForCadence({ cadence, startDate: effectiveStart, endDate: effectiveEnd })
  if (expectedDates.length === 0) return null
  const direction =
    sourceType === 'subscription' ? 'expense' : normalizeText(codeOf(attributes.type)) === 'deposit' ? 'income' : normalizeText(codeOf(attributes.type)) === 'transfer' ? 'transfer' : 'expense'
  const transformedSource = attributes.accountSource
  const transformedDestination = attributes.accountDestination
  const identity = {
    direction,
    sourceAccountId: idOf(transaction.source_id ?? transformedSource?.id),
    sourceKind: null,
    destinationAccountId: idOf(transaction.destination_id ?? transformedDestination?.id),
    destinationKind: null,
    categoryId: idOf(transaction.category_id ?? attributes.category?.id),
    payee: normalizeText(transaction.description ?? attributes.description ?? attributes.name ?? attributes.title),
  }
  const sourceId = idOf(item?.id)
  const amount =
    sourceType === 'subscription'
      ? expectedAmount({ value: attributes.pc_amount_avg ?? attributes.amount_avg, min: attributes.pc_amount_min ?? attributes.amount_min, max: attributes.pc_amount_max ?? attributes.amount_max })
      : expectedAmount({ value: transaction.amount ?? attributes.amount })
  const paidTransactionIds = unique((attributes.paid_dates ?? []).map(({ transaction_group_id }) => idOf(transaction_group_id))).sort()
  const streamId = includeStreamId ? `:${stableHash(`${cadenceKey(cadence ?? { type: 'dates' })}|${expectedDates.join('|')}`)}` : ''
  const amountEnvelope = Number.isFinite(amount.min) && Number.isFinite(amount.max) ? { min: Math.min(amount.min, amount.max), max: Math.max(amount.min, amount.max) } : null
  return {
    id: `defined:${sourceType}:${sourceId}${streamId}`,
    signature: signatureOf(identity),
    identity,
    identityVariants: [],
    direction,
    cadence,
    expectedAmount: amount,
    source: { type: sourceType, id: sourceId, authoritative: true },
    evidence: { entryIds: [], transactionIds: paidTransactionIds, dates: unique((attributes.paid_dates ?? []).map(({ date }) => dateKey(date))).sort() },
    confidence: { score: 1, factors: { authoritative: true }, reasons: ['Authoritative Firefly schedule'] },
    matching: { dateWindowDays: ['monthly', 'twiceMonthly'].includes(cadence?.type) ? 4 : 2, amountTolerance: THRESHOLDS.relativeAmountMad, amountEnvelope },
    bounds,
    expectedDates,
  }
}

export function buildDefinedOccurrences({ recurringTransactions = [], subscriptions = [], startDate, endDate }) {
  const start = dateKey(startDate)
  const end = dateKey(endDate)
  if (!start || !end) return []
  const candidatesFor = (item, sourceType) => {
    const attributes = attributesOf(item)
    if (attributes.active === false) return []
    const schedules = definitionSchedules({ attributes, sourceType })
    return schedules.map((schedule) => definedCandidate({ item, sourceType, startDate: start, endDate: end, schedule, includeStreamId: schedules.length > 1 })).filter(Boolean)
  }
  return [...recurringTransactions.flatMap((item) => candidatesFor(item, 'recurringTransaction')), ...subscriptions.flatMap((item) => candidatesFor(item, 'subscription'))]
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
}

const compatibleIdentity = (left, right) => {
  if (left.direction !== right.direction) return false
  for (const key of ['sourceAccountId', 'sourceKind', 'destinationAccountId', 'destinationKind', 'categoryId', 'payee']) if (left[key] && right[key] && left[key] !== right[key]) return false
  const leftExternal = left.direction === 'income' ? left.sourceAccountId : left.destinationAccountId
  const rightExternal = right.direction === 'income' ? right.sourceAccountId : right.destinationAccountId
  return Boolean((left.payee && right.payee && left.payee === right.payee) || (leftExternal && rightExternal && leftExternal === rightExternal))
}

const cadencePhaseCompatible = (left, right, windowDays) => {
  if (!left || !right || left.type !== right.type) return false
  if (left.type === 'monthly') return left.days.length === right.days.length && left.days.every((day, index) => Math.abs(day - right.days[index]) <= windowDays)
  if (left.type === 'twiceMonthly') {
    return (
      left.days.length === right.days.length &&
      left.fromMonthEnd.length === right.fromMonthEnd.length &&
      left.days.every((day, index) => Math.abs(day - right.days[index]) <= windowDays) &&
      left.fromMonthEnd.every((offset, index) => Math.abs(offset - right.fromMonthEnd[index]) <= windowDays)
    )
  }
  if (['weekly', 'biweekly'].includes(left.type)) {
    if (left.intervalWeeks !== right.intervalWeeks) return false
    const cycleDays = left.intervalWeeks * 7
    if (left.anchorDate && right.anchorDate) {
      const phase = Math.abs(daysBetween(left.anchorDate, right.anchorDate)) % cycleDays
      return Math.min(phase, cycleDays - phase) <= windowDays
    }
    return Math.abs((left.weekday ?? 0) - (right.weekday ?? 0)) <= windowDays
  }
  return cadenceKey(left) === cadenceKey(right)
}

const amountEnvelopesOverlap = (left, right) => {
  const leftEnvelope = left.matching?.amountEnvelope
  const rightEnvelope = right.matching?.amountEnvelope
  if (!leftEnvelope || !rightEnvelope) return true
  return leftEnvelope.min <= rightEnvelope.max && rightEnvelope.min <= leftEnvelope.max
}

export function mergeRecurringCandidates({ defined = [], inferred = [] }) {
  const inferredCandidates = Array.isArray(inferred) ? inferred : (inferred?.candidates ?? [])
  const result = defined.map((candidate) => structuredClone(candidate)).sort((left, right) => left.id.localeCompare(right.id))
  for (const candidate of [...inferredCandidates].sort((left, right) => right.confidence.score - left.confidence.score || left.id.localeCompare(right.id))) {
    const match = result.find(
      (definedCandidate) =>
        definedCandidate.source.authoritative &&
        compatibleIdentity(definedCandidate.identity, candidate.identity) &&
        cadencePhaseCompatible(definedCandidate.cadence, candidate.cadence, Math.min(definedCandidate.matching?.dateWindowDays ?? 4, candidate.matching?.dateWindowDays ?? 4)) &&
        amountEnvelopesOverlap(definedCandidate, candidate),
    )
    if (!match) {
      result.push(structuredClone(candidate))
      continue
    }
    match.evidence = {
      entryIds: unique([...match.evidence.entryIds, ...candidate.evidence.entryIds]).sort(),
      transactionIds: unique([...match.evidence.transactionIds, ...candidate.evidence.transactionIds]).sort(),
      dates: unique([...match.evidence.dates, ...candidate.evidence.dates]).sort(),
    }
    match.identity = Object.fromEntries(Object.keys(match.identity).map((key) => [key, match.identity[key] ?? candidate.identity[key]]))
    match.signature = signatureOf(match.identity)
    match.identityVariants = structuredClone(candidate.identityVariants ?? [])
    match.inference = { id: candidate.id, confidence: candidate.confidence }
  }
  return result.sort((left, right) => Number(right.source.authoritative) - Number(left.source.authoritative) || right.confidence.score - left.confidence.score || left.id.localeCompare(right.id))
}

const currentExpectedDates = (candidate, today) => {
  const start = currentMonthStart(today)
  const { year, month } = dateParts(today)
  const end = `${year}-${String(month).padStart(2, '0')}-${daysInMonth(year, month)}`
  const boundedStart = [start, candidate.bounds?.start].filter(Boolean).sort().at(-1)
  const boundedEnd = [end, candidate.bounds?.end].filter(Boolean).sort()[0]
  if (!boundedStart || !boundedEnd || boundedStart > boundedEnd) return []
  const definedDates = (candidate.expectedDates ?? []).filter((date) => date >= boundedStart && date <= boundedEnd)
  return definedDates.length ? definedDates : datesForCadence({ cadence: candidate.cadence, startDate: boundedStart, endDate: boundedEnd })
}

const entryMatches = (candidate, entry) => {
  const identity = identityOf(entry)
  if (candidate.identityVariants?.length) {
    if (!candidate.identityVariants.some((variant) => signatureOf(identity) === variant.signature)) return false
  } else if (!compatibleIdentity(candidate.identity, identity)) return false
  const expected = candidate.expectedAmount?.value
  if (!Number.isFinite(expected) || !Number.isFinite(entry.value)) return true
  const amount = Math.abs(entry.value)
  const envelope = candidate.matching?.amountEnvelope ?? { min: expected * (1 - THRESHOLDS.relativeAmountMad), max: expected * (1 + THRESHOLDS.relativeAmountMad) }
  return amount >= envelope.min && amount <= envelope.max
}

export function matchRecurringOccurrences({ candidates = [], actualEntries = [], today }) {
  const todayKey = dateKey(today)
  if (!todayKey) return { candidates: [], fulfilled: [], remaining: [] }
  const month = todayKey.slice(0, 7)
  const actual = actualEntries
    .filter((entry) => dateKey(entry?.date)?.startsWith(month) && dateKey(entry.date) <= todayKey && !entry?.refund?.isRefund)
    .map((entry) => ({ ...entry, date: dateKey(entry.date) }))
    .sort((left, right) => left.date.localeCompare(right.date) || String(left.id ?? '').localeCompare(String(right.id ?? '')))
  const usedEntries = new Set()
  const fulfilled = []
  const remaining = []
  const matchedCandidates = [...candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => {
      const occurrences = currentExpectedDates(candidate, todayKey).map((expectedDate) => {
        const match = actual
          .filter((entry) => !usedEntries.has(entry.id) && entryMatches(candidate, entry) && Math.abs(daysBetween(expectedDate, entry.date)) <= (candidate.matching?.dateWindowDays ?? 4))
          .sort(
            (left, right) =>
              Math.abs(daysBetween(expectedDate, left.date)) - Math.abs(daysBetween(expectedDate, right.date)) ||
              left.date.localeCompare(right.date) ||
              String(left.id).localeCompare(String(right.id)),
          )[0]
        const occurrence = {
          expectedId: `expected:${candidate.id}:${expectedDate}`,
          candidateId: candidate.id,
          expectedDate,
          status: match ? 'fulfilled' : 'remaining',
          actualEntryIds: match ? [match.id].filter(Boolean) : [],
          actualTransactionIds: match ? [match.transactionId].filter(Boolean) : [],
          source: candidate.source,
        }
        if (match) {
          usedEntries.add(match.id)
          fulfilled.push(occurrence)
        } else remaining.push(occurrence)
        return occurrence
      })
      return { ...structuredClone(candidate), occurrences }
    })
  return { candidates: matchedCandidates, fulfilled, remaining }
}
