import { ANALYTICS_UNCATEGORIZED_ID, convertAnalyticsAmount, getAnalyticsAccountKind } from './AnalyticsUtils.js'
import { format } from 'date-fns'

const unique = (values) => [...new Set(values.filter(Boolean))]
const valuePresent = (value) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
const idOf = (value) => (value === null || value === undefined || value === '' ? null : String(value))

const accountIdOf = (item, side) => idOf(item?.[`${side}_id`] ?? item?.[`account${side === 'source' ? 'Source' : 'Destination'}`]?.id)

const endpointOf = (item, side, accountsById) => {
  const id = accountIdOf(item, side)
  return accountsById.get(id) ?? item?.[`account${side === 'source' ? 'Source' : 'Destination'}`] ?? (id ? { id } : null)
}

const ledgerAccountKind = (account) => {
  if (!account) return 'unknown'
  const kind = getAnalyticsAccountKind(account)
  if (kind === 'savings') return account?.attributes?.include_net_worth === true ? 'savingsAccessible' : 'savingsRestricted'
  if (kind.startsWith('liability')) return 'liability'
  return ['available', 'revenue', 'expense'].includes(kind) ? kind : 'unknown'
}

const dateKey = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : format(value, 'yyyy-MM-dd')
  const match = String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? null
}

const normalizedTags = (...values) =>
  unique(
    values
      .flat()
      .map((value) => (typeof value === 'string' ? value : (value?.name ?? value?.attributes?.name ?? null)))
      .filter(Boolean),
  )

const isRefundTag = (tags) => tags.some((tag) => ['refund', '#refund'].includes(tag.trim().toLowerCase()))

const isIncomingRefundLeg = ({ sourceKind, destinationKind }) => sourceKind === 'expense' && ['available', 'savingsAccessible', 'savingsRestricted', 'liability'].includes(destinationKind)

const linkValue = (attributes, key) => idOf(attributes?.[key] ?? attributes?.[key.replace('_id', 'Id')])

const isRefundLink = ({ link, linkType }) => {
  const attributes = link?.attributes ?? link ?? {}
  const type = linkType?.attributes ?? linkType ?? attributes.link_type ?? attributes.linkType ?? attributes.type ?? null
  const values = [
    attributes.link_type_name,
    attributes.linkTypeName,
    attributes.name,
    typeof type === 'string' ? type : null,
    type?.name,
    type?.type,
    type?.inward,
    type?.outward,
    type?.attributes?.name,
    type?.attributes?.type,
    type?.attributes?.inward,
    type?.attributes?.outward,
  ]
  return values.some((value) =>
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .includes('refund'),
  )
}

const conversionFor = ({ item, primaryCurrencyCode, displayCurrencyCode, rates }) => {
  const sourceCurrency = valuePresent(item?.primary_amount) ? (item?.primary_currency_code ?? primaryCurrencyCode) : item?.currency_code
  const converted = convertAnalyticsAmount({
    amount: item?.amount,
    currencyCode: item?.currency_code,
    primaryAmount: item?.primary_amount,
    primaryCurrencyCode: item?.primary_currency_code ?? primaryCurrencyCode,
    displayCurrencyCode,
    rates,
  })
  const mode =
    converted.missingCurrency || !Number.isFinite(converted.value) ? 'unavailable' : valuePresent(item?.primary_amount) ? 'exactPrimary' : sourceCurrency === displayCurrencyCode ? 'exact' : 'rate'
  return {
    converted,
    conversion: {
      mode,
      sourceCurrency: sourceCurrency ?? null,
      ...(converted.missingCurrency ? { missingCurrency: converted.missingCurrency } : {}),
    },
  }
}

const refundState = () => ({
  isRefund: false,
  signals: [],
  linkedPurchaseTransactionId: null,
  linkedPurchaseMonthKey: null,
  coverageCategoryId: null,
  coverageMonthKey: null,
  coverageValue: null,
  isLinked: false,
})

const markRefund = ({ entry, signal, purchase = null }) => {
  entry.refund.isRefund = true
  entry.refund.signals = unique([...entry.refund.signals, signal]).sort()
  if (!purchase) {
    entry.refund.coverageCategoryId = entry.categoryId
    entry.refund.coverageMonthKey = entry.monthKey
    entry.refund.coverageValue = Number.isFinite(entry.value) ? Math.abs(entry.value) : null
    return
  }

  entry.refund.isLinked = true
  entry.refund.linkedPurchaseTransactionId = purchase.transactionId
  entry.refund.linkedPurchaseMonthKey = purchase.monthKey
  entry.refund.coverageCategoryId = purchase.categoryId
  entry.refund.coverageMonthKey = purchase.monthKey
  entry.refund.coverageValue = Number.isFinite(entry.value) ? Math.abs(entry.value) : null
}

export function buildAnalyticsLedger({ transactions = [], transactionLinks = [], linkTypes = [], accounts = [], displayCurrencyCode, primaryCurrencyCode, rates }) {
  const accountsById = new Map(accounts.map((account) => [idOf(account?.id), account]).filter(([id]) => id))
  const linkTypesById = new Map(linkTypes.map((linkType) => [idOf(linkType?.id), linkType]).filter(([id]) => id))
  const entries = []
  const months = {}
  const journalEntries = new Map()
  const missingCurrencies = new Set()
  const fxTransactionIds = new Set()
  const unclassifiedTransactionIds = new Set()
  const unmatchedRefundLinkIds = new Set()
  let fxIsEstimated = false
  let unclassifiedValue = 0
  let hasUnavailableUnclassifiedValue = false
  let startMonth = null
  let endDate = null

  for (const transaction of transactions) {
    const transactionId = idOf(transaction?.id)
    for (const [splitIndex, item] of (transaction?.attributes?.transactions ?? []).entries()) {
      const journalId = idOf(item?.transaction_journal_id ?? item?.journal_id ?? item?.transactionJournalId ?? transactionId)
      const date = dateKey(item?.date)
      const monthKey = date?.slice(0, 7) ?? null
      const sourceId = accountIdOf(item, 'source')
      const destinationId = accountIdOf(item, 'destination')
      const sourceAccount = endpointOf(item, 'source', accountsById)
      const destinationAccount = endpointOf(item, 'destination', accountsById)
      const sourceKind = ledgerAccountKind(accountsById.get(sourceId))
      const destinationKind = ledgerAccountKind(accountsById.get(destinationId))
      const { converted, conversion } = conversionFor({ item, primaryCurrencyCode, displayCurrencyCode, rates })
      const tags = normalizedTags(item?.tags, transaction?.attributes?.tags)
      const entry = {
        id: `${transactionId ?? 'unknown'}:${journalId ?? 'unknown'}:${splitIndex}`,
        transactionId,
        journalId,
        splitIndex,
        date,
        monthKey,
        day: date ? Number(date.slice(-2)) : null,
        value: Number.isFinite(converted.value) ? converted.value : null,
        isEstimated: converted.isEstimated,
        conversion,
        sourceAccount,
        destinationAccount,
        sourceKind,
        destinationKind,
        categoryId: item?.category_id ?? ANALYTICS_UNCATEGORIZED_ID,
        tags,
        refund: refundState(),
      }
      entries.push(entry)
      if (journalId) journalEntries.set(journalId, [...(journalEntries.get(journalId) ?? []), entry])
      if (monthKey) {
        const month = (months[monthKey] ??= { entryIds: [], transactionIds: new Set() })
        month.entryIds.push(entry.id)
        if (transactionId) month.transactionIds.add(transactionId)
        startMonth = !startMonth || monthKey < startMonth ? monthKey : startMonth
      }
      endDate = !endDate || (date && date > endDate) ? date : endDate
      if (converted.isEstimated) {
        fxIsEstimated = true
        if (transactionId) fxTransactionIds.add(transactionId)
      }
      if (converted.missingCurrency) {
        missingCurrencies.add(converted.missingCurrency)
        if (transactionId) fxTransactionIds.add(transactionId)
      }
      if (sourceKind === 'unknown' || destinationKind === 'unknown') {
        if (transactionId) unclassifiedTransactionIds.add(transactionId)
        if (Number.isFinite(entry.value)) unclassifiedValue += Math.abs(entry.value)
        else hasUnavailableUnclassifiedValue = true
      }
      if (isRefundTag(tags) && isIncomingRefundLeg(entry)) markRefund({ entry, signal: 'tag' })
    }
  }

  for (const link of transactionLinks) {
    const attributes = link?.attributes ?? link ?? {}
    const linkType = linkTypesById.get(idOf(attributes.link_type_id ?? attributes.linkTypeId))
    if (!isRefundLink({ link, linkType })) continue
    const purchaseEntries = journalEntries.get(linkValue(attributes, 'inward_id')) ?? []
    const refundEntries = journalEntries.get(linkValue(attributes, 'outward_id')) ?? []
    if (purchaseEntries.length === 0 || refundEntries.length === 0) {
      if (link?.id) unmatchedRefundLinkIds.add(String(link.id))
      continue
    }
    for (const entry of refundEntries) markRefund({ entry, signal: 'link', purchase: purchaseEntries[0] })
  }

  for (const entry of entries.filter(({ refund }) => refund.isRefund && !refund.isLinked)) markRefund({ entry, signal: entry.refund.signals[0] })
  for (const month of Object.values(months)) month.transactionIds = [...month.transactionIds].sort()

  return {
    entries,
    months,
    coverage: { startMonth, endDate },
    fx: { isEstimated: fxIsEstimated, missingCurrencies: [...missingCurrencies].sort(), transactionIds: [...fxTransactionIds].sort() },
    audit: {
      unclassifiedValue: hasUnavailableUnclassifiedValue ? null : unclassifiedValue,
      transactionIds: [...unclassifiedTransactionIds].sort(),
      unmatchedRefundLinkIds: [...unmatchedRefundLinkIds].sort(),
    },
  }
}
