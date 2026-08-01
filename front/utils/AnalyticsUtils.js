const codeOf = (value) => value?.fireflyCode ?? value ?? null
const unique = (values) => [...new Set(values.filter(Boolean))]

export const ANALYTICS_UNCATEGORIZED_ID = 'uncategorized'

export function getAnalyticsAccountGroups(accounts) {
  const active = accounts.filter((account) => account?.attributes?.active === true)
  const typeOf = (account) => codeOf(account?.attributes?.type)
  const roleOf = (account) => codeOf(account?.attributes?.account_role)
  const directionOf = (account) => codeOf(account?.attributes?.liability_direction)
  const balanceHolding = (account) => ['asset', 'cash', 'liabilities'].includes(typeOf(account))

  return {
    netWorth: active.filter((account) => balanceHolding(account) && account?.attributes?.include_net_worth === true),
    savings: active.filter((account) => typeOf(account) === 'asset' && roleOf(account) === 'savingAsset'),
    debt: active.filter((account) => (typeOf(account) === 'asset' && roleOf(account) === 'ccAsset') || (typeOf(account) === 'liabilities' && directionOf(account) === 'debit')),
  }
}

export function convertAnalyticsAmount({ amount, currencyCode, primaryAmount, primaryCurrencyCode, displayCurrencyCode, rates }) {
  const hasPrimary = primaryAmount !== null && primaryAmount !== undefined && primaryCurrencyCode
  const sourceAmount = Number(hasPrimary ? primaryAmount : amount)
  const sourceCurrency = hasPrimary ? primaryCurrencyCode : currencyCode

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

const entriesForLine = ({ line, primaryCurrencyCode }) => {
  if (line?.pc_entries && Object.keys(line.pc_entries).length > 0) {
    return {
      entries: line.pc_entries,
      currencyCode: line.pc_currency_code ?? primaryCurrencyCode,
      isPrimary: true,
    }
  }
  return {
    entries: line?.entries ?? {},
    currencyCode: line?.currency_code,
    isPrimary: false,
  }
}

export function normalizeBalanceSeries({ chartLines, metric, displayCurrencyCode, primaryCurrencyCode, rates }) {
  const normalizedLines = chartLines.map((line) => {
    const source = entriesForLine({ line, primaryCurrencyCode })
    const points = Object.entries(source.entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([x, amount]) => {
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
      for (const line of normalizedLines) {
        const available = line.points.filter((point) => point.x <= x && point.value !== null)
        const point = available.at(-1)
        if (!point) continue
        hasValue = true
        value += metric === 'debt' ? Math.max(0, -point.value) : point.value
      }
      return hasValue ? { x, value } : null
    })
    .filter(Boolean)

  return { points, isEstimated, missingCurrencies }
}
