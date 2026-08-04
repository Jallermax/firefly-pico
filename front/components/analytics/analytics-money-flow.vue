<template>
  <van-cell-group inset class="analytics-card analytics-money-flow-card">
    <div class="van-cell-group-title analytics-card-title analytics-flow-card-title">
      <div class="analytics-flow-heading flex-1">
        <div class="flex-center-vertical gap-2">
          <span>{{ $t('analytics.flow.title') }}</span>
        </div>
        <div class="analytics-card-subtitle">{{ $t('analytics.flow.subtitle') }}</div>
      </div>
      <div class="analytics-flow-month-controls">
        <button type="button" class="analytics-flow-month-button" :disabled="!canPrevious" :aria-label="$t('analytics.flow.previous_month')" @click="moveMonth(-1)">
          <app-icon :icon="TablerIconConstants.leftArrow" :size="18" />
        </button>
        <strong class="analytics-flow-month-title">{{ selectedMonthLabel }}</strong>
        <button type="button" class="analytics-flow-month-button" :disabled="!canNext" :aria-label="$t('analytics.flow.next_month')" @click="moveMonth(1)">
          <app-icon :icon="TablerIconConstants.rightArrow" :size="18" />
        </button>
      </div>
    </div>

    <div class="analytics-flow-detail-control">
      <span>{{ $t('analytics.flow.graph_detail') }}</span>
      <app-tabs v-model="analyticsStore.graphDetail" :items="detailItems" />
    </div>

    <div v-if="isBlockingLoading" class="analytics-card-state">
      <van-loading size="20" />
      <span>{{ $t('analytics.common.loading') }}</span>
    </div>
    <div v-else-if="isBlockingError" class="analytics-card-state">
      <span>{{ $t('analytics.flow.error') }}</span>
      <van-button size="small" @click="analyticsStore.retryFlow">{{ $t('analytics.common.retry') }}</van-button>
    </div>
    <template v-else>
      <div v-if="analyticsStore.flowState.status === 'error'" class="analytics-card-state analytics-card-state-compact">
        <span>{{ $t('analytics.flow.error') }}</span>
        <van-button size="small" @click="analyticsStore.retryFlow">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-if="analyticsStore.flowState.isStale && ['loading', 'error'].includes(analyticsStore.flowState.status)" class="analytics-assumption-note">{{ $t('analytics.common.stale') }}</div>

      <div v-if="presentation.showAudit" class="analytics-flow-unbalanced" role="alert">
        <strong>{{ stateLabel }}</strong>
        <span v-if="presentation.reason !== 'missing_rates'">{{ stateDescription }}</span>
        <div v-if="hasUnclassified" class="analytics-flow-audit-row">
          <span>{{ $t('analytics.flow.audit.unclassified') }}</span
          ><strong>{{ formatCurrency(flow.unclassified.value) }}</strong>
        </div>
        <div v-if="flow.unclassified?.transactionIds?.length" class="analytics-flow-transaction-ids">
          {{ $t('analytics.flow.transaction_ids', { ids: flow.unclassified.transactionIds.join(', ') }) }}
        </div>
        <van-button size="small" @click="analyticsStore.retryFlow">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <div v-else-if="presentation.showEmpty" class="analytics-card-state analytics-flow-empty">{{ $t('analytics.flow.empty') }}</div>
      <layered-money-flow-chart
        v-if="presentation.showGraph"
        :graph="chartGraph"
        :detail-level="analyticsStore.graphDetail"
        :currency-code="analyticsStore.displayCurrencyCode"
        :aria-label="$t('analytics.flow.chart_label', { month: selectedMonthLabel, currency: analyticsStore.displayCurrencyCode })"
        @select-node="openDetails"
        @select-link="openDetails"
        @mode-change="chartMode = $event"
      />
      <div v-if="presentation.showGraph && chartMode === 'condensed'" class="analytics-flow-condensed-notice">{{ $t('analytics.flow.condensed_mobile') }}</div>

      <details class="analytics-flow-exact-values">
        <summary>
          <span>{{ $t('analytics.flow.exact_values') }}</span>
          <strong>{{ fullLinks.length }}</strong>
        </summary>
        <div class="analytics-flow-audit-section">
          <button v-for="link in fullLinks" :key="link.id" type="button" class="analytics-flow-reallocation-row" @click="openDetails(link)">
            <span>{{ itemLabel(link) }}</span
            ><strong>{{ formatCurrency(link.value) }}</strong>
          </button>
        </div>
      </details>

      <details class="analytics-flow-audit">
        <summary>
          <span>{{ $t('analytics.flow.audit.title') }}</span>
          <strong :class="flow.isBalanced ? 'success' : 'danger'">{{ flow.isBalanced ? $t('analytics.flow.audit.balanced') : $t('analytics.flow.audit.unbalanced') }}</strong>
        </summary>
        <section v-for="section in auditSections" :key="section.id" class="analytics-flow-audit-section">
          <h4>{{ section.label }}</h4>
          <div v-for="row in section.rows" :key="row.id" class="analytics-flow-audit-row">
            <span>{{ row.label }}</span
            ><strong>{{ formatCurrency(row.value) }}</strong>
          </div>
        </section>
        <section v-if="liabilityReallocations.length" class="analytics-flow-audit-section">
          <h4>{{ $t('analytics.flow.audit.liability_reallocations') }}</h4>
          <button v-for="row in liabilityReallocations" :key="row.id" type="button" class="analytics-flow-reallocation-row" @click="openDetails(row)">
            <span>{{ row.label }}</span
            ><strong>{{ formatCurrency(row.value) }}</strong>
          </button>
        </section>
        <p class="analytics-flow-definition">{{ $t('analytics.flow.definition') }}</p>
      </details>
    </template>

    <app-popup v-model:show="detailsVisible" popup-style="max-width: 560px">
      <div v-if="selectedItem" class="analytics-flow-details">
        <div class="analytics-flow-details-header">
          <div class="flex-1">
            <strong>{{ selectedItemLabel }}</strong>
            <div class="analytics-card-subtitle">{{ formatCurrency(selectedItem.value) }}</div>
            <div v-if="selectedItemDetails.sourcePercent !== null" class="analytics-card-subtitle">
              {{ $t('analytics.flow.source') }}: {{ formatPercent(selectedItemDetails.sourcePercent) }} · {{ $t('analytics.flow.destination') }}:
              {{ formatPercent(selectedItemDetails.destinationPercent) }}
            </div>
          </div>
          <van-button size="small" @click="detailsVisible = false">{{ $t('ok') }}</van-button>
        </div>
        <div class="analytics-flow-details-list">
          <div v-for="row in selectedRows" :key="row.id" class="analytics-flow-detail-row">
            <div class="analytics-flow-detail-value">
              <span>{{ row.label }}</span
              ><strong>{{ formatCurrency(row.value) }}</strong>
            </div>
            <div v-if="row.transactionIds.length" class="analytics-flow-transaction-ids">{{ $t('analytics.flow.transaction_ids', { ids: row.transactionIds.join(', ') }) }}</div>
          </div>
          <div v-if="selectedRefundCoverage" class="analytics-flow-detail-row analytics-flow-refund-coverage">
            <div class="analytics-flow-detail-value">
              <span>{{ $t('analytics.flow.refund_category') }}</span
              ><strong>{{ formatCurrency(selectedRefundCoverage.value) }}</strong>
            </div>
            <div v-if="selectedRefundCoverage.transactionIds.length" class="analytics-flow-transaction-ids">
              {{ $t('analytics.flow.transaction_ids', { ids: selectedRefundCoverage.transactionIds.join(', ') }) }}
            </div>
          </div>
        </div>
        <van-button v-if="selectedTransactionIds.length" block type="primary" @click="openTransactions">
          {{ $t('analytics.flow.view_transactions', { count: selectedTransactionIds.length }) }}
        </van-button>
      </div>
    </app-popup>
  </van-cell-group>
</template>

<script setup>
import Account from '~/models/Account.js'
import Category from '~/models/Category.js'
import RouteConstants from '~/constants/RouteConstants.js'
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import { useAccountStore } from '~/stores/accountStore.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useCategoryStore } from '~/stores/categoryStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import {
  formatMoneyFlowPercent,
  formatMoneyFlowValue,
  projectMoneyFlowTransactionSelection,
  resolveMoneyFlowItemDetails,
  resolveMoneyFlowPresentation,
  resolveMoneyFlowSemanticColor,
} from '~/utils/ChartUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const analyticsStore = useAnalyticsStore()
const accountStore = useAccountStore()
const categoryStore = useCategoryStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const detailsVisible = ref(false)
const selectedItem = ref(null)
const selectedContextNodes = ref([])
const chartMode = ref('full')

const emptyFlow = {
  nodes: [],
  links: [],
  details: { nodes: [], links: [] },
  audit: { pools: { available: { incoming: 0, outgoing: 0, net: 0 }, savings: { incoming: 0, outgoing: 0, net: 0 } }, liabilityReallocations: [] },
  unclassified: { value: 0, transactionIds: [] },
  missingCurrencies: [],
  isBalanced: true,
}
const detailItems = computed(() => [
  { label: t('analytics.flow.top_5'), value: 5 },
  { label: t('analytics.flow.top_10'), value: 10 },
  { label: t('analytics.flow.all'), value: 'all' },
])
const flow = computed(() => analyticsStore.selectedFlow ?? emptyFlow)
const selectedMonth = computed(() => analyticsStore.selectedFlowMonth ?? new Date())
const canPrevious = computed(() => analyticsStore.canMoveFlowMonth(-1))
const canNext = computed(() => analyticsStore.canMoveFlowMonth(1))
const selectedMonthLabel = computed(() => new Intl.DateTimeFormat(profileStore.language, { month: 'long', year: 'numeric' }).format(selectedMonth.value))
const hasNodes = computed(() => flow.value.nodes.length > 0)
const hasUnclassified = computed(() => !Number.isFinite(flow.value.unclassified?.value) || Math.abs(flow.value.unclassified.value) > 0)
const hasMissingRates = computed(() => flow.value.missingCurrencies?.length > 0)
const presentation = computed(() =>
  resolveMoneyFlowPresentation({
    isBalanced: flow.value.isBalanced,
    hasNodes: hasNodes.value,
    hasUnclassified: hasUnclassified.value,
    hasMissingRates: hasMissingRates.value,
    isCondensed: chartMode.value === 'condensed',
    isStale: analyticsStore.flowState.isStale,
  }),
)
const hasRetainedData = computed(() => analyticsStore.flowState.isStale && hasNodes.value)
const isBlockingLoading = computed(() => analyticsStore.flowState.status === 'loading' && !hasRetainedData.value)
const isBlockingError = computed(() => analyticsStore.flowState.status === 'error' && !hasRetainedData.value)
const stateLabel = computed(() => t(`analytics.flow.state.${presentation.value.reason}`))
const stateDescription = computed(() => t(`analytics.flow.state.${presentation.value.reason}_description`))
const formatCurrency = (value) =>
  Number.isFinite(value)
    ? formatMoneyFlowValue({
        value,
        language: profileStore.language,
        currencyCode: analyticsStore.displayCurrencyCode,
        showAccountAmounts: profileStore.dashboard.showAccountAmounts,
        showDecimal: profileStore.dashboard.showDecimal,
      })
    : '—'
const formatPercent = (value) => formatMoneyFlowPercent({ value, language: profileStore.language })
const categoryLabel = (id) => (['uncategorized', 'uncategorized-income'].includes(id) ? t('analytics.category.uncategorized') : Category.getDisplayName(categoryStore.categoryDictionary[id]) || id)
const accountLabel = (id) => Account.getDisplayName(accountStore.accountDictionary[id]) || id

const semanticLabelKeys = {
  available: 'available_pool',
  savings: 'savings_pool',
  income: 'new_income',
  expenses: 'expenses',
  savingsDeposited: 'savings_deposited',
  newExcess: 'new_excess',
  debtPaid: 'debt_paid',
  liabilityExtended: 'liability_extended',
  existingAvailable: 'existing_available',
  existingSavings: 'existing_savings_used',
  newDebt: 'new_debt',
  liabilityCollected: 'liability_collected',
  refund: 'refund_category',
  expenseCategory: 'expense_category',
  savingsDeposit: 'savings_account_deposit',
}
const accountKinds = new Set(['existingSavings', 'savingsDeposit', 'newDebt', 'liabilityCollected', 'debtPaid', 'liabilityExtended'])
const categoryKinds = new Set(['expenseCategory', 'refund'])
const nodeLabel = (node) => {
  if (!node) return ''
  if (String(node.kind).startsWith('other')) return t('analytics.flow.other')
  if (node.kind === 'income' && node.refId) return categoryStore.categoryDictionary[node.refId] ? categoryLabel(node.refId) : node.label || node.refId
  if (categoryKinds.has(node.kind) && node.refId) return categoryLabel(node.refId)
  if (accountKinds.has(node.kind) && node.refId) return accountLabel(node.refId)
  return semanticLabelKeys[node.kind] ? t(`analytics.flow.${semanticLabelKeys[node.kind]}`) : node.label || node.refId || node.id
}
const chartGraph = computed(() => ({
  ...flow.value,
  nodes: flow.value.nodes.map((node) => ({ ...node, label: nodeLabel(node), color: resolveMoneyFlowSemanticColor(node) })),
  links: flow.value.links.map((link) => ({ ...link, color: resolveMoneyFlowSemanticColor(link) })),
}))

const auditLabel = (id) => t(`analytics.flow.audit.${id.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())}`)
const auditRows = (ids) => ids.map((id) => ({ id, label: auditLabel(id), value: flow.value.audit?.[id] ?? 0 }))
const poolRows = (pool) => ['incoming', 'outgoing', 'net'].map((id) => ({ id: `${pool}-${id}`, label: t(`analytics.flow.audit.${pool}_${id}`), value: flow.value.audit?.pools?.[pool]?.[id] ?? 0 }))
const auditSections = computed(() => [
  { id: 'available', label: t('analytics.flow.available_pool'), rows: poolRows('available') },
  { id: 'savings', label: t('analytics.flow.savings_pool'), rows: poolRows('savings') },
  { id: 'outer', label: t('analytics.flow.audit.outer'), rows: auditRows(['totalSources', 'totalDestinations', 'equationDifference', 'unclassified']) },
  { id: 'savings-movement', label: t('analytics.flow.audit.savings_movement'), rows: auditRows(['positiveSavingsMovement', 'negativeSavingsMovement', 'netSavings']) },
  { id: 'liabilities', label: t('analytics.flow.audit.liabilities'), rows: auditRows(['liabilityIncrease', 'liabilityReduction', 'netDebtChange']) },
])
const liabilityReallocations = computed(() =>
  (flow.value.audit?.liabilityReallocations ?? []).map((item) => ({
    ...item,
    id: `reallocation:${item.sourceId}:${item.targetId}`,
    label: t('analytics.flow.liability_reallocation', { source: accountLabel(item.sourceId), destination: accountLabel(item.targetId) }),
  })),
)

const fullNodes = computed(() => flow.value.details?.nodes ?? flow.value.nodes)
const fullLinks = computed(() => flow.value.details?.links ?? flow.value.links)
const fullNodeDictionary = computed(() => new Map(fullNodes.value.map((node) => [node.id, node])))
const itemLabel = (item, dictionary = fullNodeDictionary.value) => {
  if (!item) return ''
  if (item.label) return item.label
  if (!item.sourceId) return nodeLabel(item)
  return t('analytics.flow.exact_path', { source: nodeLabel(dictionary.get(item.sourceId)), destination: nodeLabel(dictionary.get(item.targetId)) })
}
const nodeDetailRows = (item) => {
  if (item.details?.nodes?.length) return item.details.nodes
  const related = fullLinks.value.filter(({ sourceId, targetId }) => sourceId === item.id || targetId === item.id)
  const detailed = related.map(({ sourceId, targetId }) => fullNodeDictionary.value.get(sourceId === item.id ? targetId : sourceId)).filter((node) => node?.refId)
  return detailed.length ? [...new Map(detailed.map((node) => [node.id, node])).values()] : [fullNodeDictionary.value.get(item.id) ?? item]
}
const linkDetailRows = (item) => {
  if (item.details?.availableToSavings && item.details?.savingsToAvailable) {
    return [
      {
        id: `${item.id}:available-to-savings`,
        label: t('analytics.flow.exact_path', { source: t('analytics.flow.available_pool'), destination: t('analytics.flow.savings_pool') }),
        ...item.details.availableToSavings,
      },
      {
        id: `${item.id}:savings-to-available`,
        label: t('analytics.flow.exact_path', { source: t('analytics.flow.savings_pool'), destination: t('analytics.flow.available_pool') }),
        ...item.details.savingsToAvailable,
      },
    ].filter(({ value }) => value > 0)
  }
  const visibleSource = selectedContextNodes.value.find(({ id }) => id === item.sourceId)
  const visibleTarget = selectedContextNodes.value.find(({ id }) => id === item.targetId)
  const sourceIds = new Set(visibleSource?.details?.nodes?.map(({ id }) => id) ?? [item.sourceId])
  const targetIds = new Set(visibleTarget?.details?.nodes?.map(({ id }) => id) ?? [item.targetId])
  const rows = fullLinks.value.filter(
    ({ sourceId, targetId, kind, fundingPool }) => sourceIds.has(sourceId) && targetIds.has(targetId) && kind === item.kind && (fundingPool ?? null) === (item.fundingPool ?? null),
  )
  return rows.length ? rows : [item]
}
const selectedRows = computed(() => {
  if (!selectedItem.value) return []
  const items = selectedItem.value.sourceId && selectedItem.value.targetId ? linkDetailRows(selectedItem.value) : nodeDetailRows(selectedItem.value)
  const selectedNodeDictionary = new Map(selectedContextNodes.value.map((node) => [node.id, node]))
  return items.map((item) => ({ id: item.id, label: itemLabel(item, selectedNodeDictionary), value: item.value, transactionIds: [...new Set(item.transactionIds ?? [])].sort() }))
})
const selectedNodeDictionary = computed(() => new Map(selectedContextNodes.value.map((node) => [node.id, node])))
const selectedItemLabel = computed(() => itemLabel(selectedItem.value, selectedNodeDictionary.value))
const selectedItemDetails = computed(() => resolveMoneyFlowItemDetails({ item: selectedItem.value ?? {}, nodes: selectedContextNodes.value }))
const selectedTransactionSelection = computed(() => projectMoneyFlowTransactionSelection({ item: selectedItem.value ?? {}, rows: selectedRows.value, nodes: fullNodes.value }))
const selectedRefundCoverage = computed(() => selectedTransactionSelection.value.refundCoverage)
const selectedTransactionIds = computed(() => selectedTransactionSelection.value.transactionIds)

const moveMonth = (amount) => analyticsStore.moveFlowMonth(amount)
const openDetails = (item, contextNodes = flow.value.nodes) => {
  selectedItem.value = item
  selectedContextNodes.value = contextNodes
  detailsVisible.value = true
}
const openTransactions = async () => {
  const query = TransactionFilterUtils.filters.id.toUrl(selectedTransactionSelection.value.queryValue)
  detailsVisible.value = false
  await navigateTo(RouteConstants.ROUTE_TRANSACTION_LIST + '?' + query)
}
</script>
