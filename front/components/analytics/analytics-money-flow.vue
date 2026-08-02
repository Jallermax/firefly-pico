<template>
  <van-cell-group inset class="analytics-card analytics-money-flow-card">
    <div class="van-cell-group-title analytics-card-title analytics-flow-card-title">
      <span class="flex-1">{{ $t('analytics.flow.title') }}</span>
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

      <div v-if="!flow.isBalanced" class="analytics-flow-unbalanced" role="alert">
        <strong>{{ $t('analytics.flow.audit.unbalanced') }}</strong>
        <div class="analytics-flow-audit-row">
          <span>{{ $t('analytics.flow.audit.source_total') }}</span
          ><strong>{{ formatCurrency(flow.audit.sourceTotal) }}</strong>
        </div>
        <div class="analytics-flow-audit-row">
          <span>{{ $t('analytics.flow.audit.destination_total') }}</span
          ><strong>{{ formatCurrency(flow.audit.destinationTotal) }}</strong>
        </div>
        <div class="analytics-flow-audit-row">
          <span>{{ $t('analytics.flow.audit.equation_difference') }}</span
          ><strong>{{ formatCurrency(flow.audit.equationDifference) }}</strong>
        </div>
      </div>
      <div v-else-if="!hasNodes" class="analytics-card-state analytics-flow-empty">{{ $t('analytics.flow.empty') }}</div>
      <money-flow-chart
        v-else
        :sources="sources"
        :destinations="destinations"
        :total="flow.total"
        :bus-label="$t('analytics.flow.available')"
        :aria-label="$t('analytics.flow.chart_label', { month: selectedMonthLabel, currency: analyticsStore.displayCurrencyCode })"
        @select-node="onSelectNode"
      />

      <details class="analytics-flow-audit" open>
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
      </details>

      <div class="analytics-assumption-note">{{ $t('analytics.flow.definition') }}</div>
      <div v-if="flow.isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="flow.missingCurrencies?.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: flow.missingCurrencies.join(', ') }) }}</div>
    </template>

    <template v-if="isBlockingLoading || isBlockingError">
      <div class="analytics-assumption-note">{{ $t('analytics.flow.definition') }}</div>
      <div v-if="flow.isEstimated" class="analytics-assumption-note">{{ $t('analytics.common.estimated_current_rates') }}</div>
      <div v-if="flow.missingCurrencies?.length" class="analytics-warning">{{ $t('analytics.common.missing_rates', { currencies: flow.missingCurrencies.join(', ') }) }}</div>
    </template>

    <app-popup v-model:show="residualDetailsVisible" popup-style="max-width: 520px">
      <div v-if="residualDetails" class="analytics-flow-residual-details">
        <div class="analytics-flow-details-header">
          <strong class="flex-1">{{ residualDetails.label }}</strong>
          <van-button size="small" @click="residualDetailsVisible = false">{{ $t('ok') }}</van-button>
        </div>
        <p>{{ residualDetails.expression }}</p>
        <div class="analytics-flow-audit-row">
          <span>{{ residualDetails.leftLabel }}</span
          ><strong>{{ formatCurrency(residualDetails.leftValue) }}</strong>
        </div>
        <div class="analytics-flow-audit-row">
          <span>{{ residualDetails.rightLabel }}</span
          ><strong>{{ formatCurrency(residualDetails.rightValue) }}</strong>
        </div>
        <div class="analytics-flow-audit-row analytics-flow-residual-result">
          <span>{{ $t('analytics.flow.audit.result') }}</span
          ><strong>{{ formatCurrency(residualDetails.value) }}</strong>
        </div>
      </div>
    </app-popup>
  </van-cell-group>
</template>

<script setup>
import { addMonths, startOfMonth } from 'date-fns'
import RouteConstants from '~/constants/RouteConstants.js'
import TablerIconConstants from '~/constants/TablerIconConstants.js'
import { useAnalyticsStore } from '~/stores/analyticsStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const NODE_CONFIG = {
  income: { key: 'income', color: 'var(--income1)' },
  savingsWithdrawn: { key: 'savings_withdrawn', color: 'var(--transfer1)' },
  newDebt: { key: 'new_debt', color: 'var(--van-warning-color)' },
  priorExcessUsed: { key: 'prior_excess_used', color: 'var(--van-text-color-3)' },
  netRefunds: { key: 'net_refunds', color: 'var(--income2)' },
  expenses: { key: 'expenses', color: 'var(--expense1)' },
  savingsDeposited: { key: 'savings_deposited', color: 'var(--transfer2)' },
  debtRepaid: { key: 'debt_repaid', color: 'var(--van-warning-color)' },
  newExcess: { key: 'new_excess', color: 'var(--primary-action)' },
}
const GROSS_AUDIT_IDS = ['income', 'expensePurchases', 'refunds', 'savingsIn', 'savingsOut', 'debtIncrease', 'debtRepayment']
const NET_AUDIT_IDS = ['expenses', 'netRefunds', 'savingsDeposited', 'savingsWithdrawn', 'newDebt', 'debtRepaid']
const EQUATION_AUDIT_IDS = ['classifiedSources', 'priorExcessUsed', 'sourceTotal', 'classifiedDestinations', 'newExcess', 'destinationTotal', 'equationDifference']
const RESIDUAL_IDS = new Set(['priorExcessUsed', 'newExcess'])

const analyticsStore = useAnalyticsStore()
const profileStore = useProfileStore()
const { t } = useI18n()
const residualDetailsVisible = ref(false)
const selectedResidual = ref(null)

const emptyFlow = { sources: [], destinations: [], total: 0, audit: {}, isEstimated: false, missingCurrencies: [], isBalanced: true }
const flow = computed(() => analyticsStore.selectedFlow ?? emptyFlow)
const selectedMonth = computed(() => startOfMonth(analyticsStore.selectedFlowMonth ?? new Date()))
const monthMin = computed(() => (analyticsStore.flowMonthMin ? startOfMonth(analyticsStore.flowMonthMin) : null))
const monthMax = computed(() => startOfMonth(analyticsStore.flowMonthMax ?? new Date()))
const canPrevious = computed(() => monthMin.value !== null && selectedMonth.value.getTime() > monthMin.value.getTime())
const canNext = computed(() => selectedMonth.value.getTime() < monthMax.value.getTime())
const selectedMonthLabel = computed(() => new Intl.DateTimeFormat(profileStore.language, { month: 'long', year: 'numeric' }).format(selectedMonth.value))
const hasNodes = computed(() => flow.value.sources.length + flow.value.destinations.length > 0)
const hasRetainedData = computed(() => analyticsStore.flowState.isStale)
const isBlockingLoading = computed(() => analyticsStore.flowState.status === 'loading' && !hasRetainedData.value)
const isBlockingError = computed(() => analyticsStore.flowState.status === 'error' && !hasRetainedData.value)
const formatCurrency = (value) => `${formatNumberForDashboard(Number(value) || 0)} ${analyticsStore.displayCurrencyCode}`
const auditLabel = (id) => t(`analytics.flow.audit.${id.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())}`)
const enrichNodes = (nodes, side) =>
  nodes.map((node) => ({
    ...node,
    label: t(`analytics.flow.${NODE_CONFIG[node.id].key}`),
    color: NODE_CONFIG[node.id].color,
    valueLabel: formatCurrency(node.value),
    sideLabel: t(`analytics.flow.${side}`),
  }))

const sources = computed(() => enrichNodes(flow.value.sources, 'source'))
const destinations = computed(() => enrichNodes(flow.value.destinations, 'destination'))
const auditRows = (ids) => ids.map((id) => ({ id, label: auditLabel(id), value: flow.value.audit?.[id] ?? 0 }))
const auditSections = computed(() => [
  { id: 'gross', label: t('analytics.flow.audit.gross'), rows: auditRows(GROSS_AUDIT_IDS) },
  { id: 'net', label: t('analytics.flow.audit.net'), rows: auditRows(NET_AUDIT_IDS) },
  { id: 'equation', label: t('analytics.flow.audit.equation'), rows: auditRows(EQUATION_AUDIT_IDS) },
])

const residualDetails = computed(() => {
  if (!selectedResidual.value) return null
  const isPrior = selectedResidual.value.id === 'priorExcessUsed'
  return {
    ...selectedResidual.value,
    expression: isPrior ? 'max(0, classifiedDestinations - classifiedSources)' : 'max(0, classifiedSources - classifiedDestinations)',
    leftLabel: auditLabel(isPrior ? 'classifiedDestinations' : 'classifiedSources'),
    leftValue: flow.value.audit?.[isPrior ? 'classifiedDestinations' : 'classifiedSources'] ?? 0,
    rightLabel: auditLabel(isPrior ? 'classifiedSources' : 'classifiedDestinations'),
    rightValue: flow.value.audit?.[isPrior ? 'classifiedSources' : 'classifiedDestinations'] ?? 0,
  }
})

const moveMonth = (amount) => {
  if ((amount < 0 && !canPrevious.value) || (amount > 0 && !canNext.value)) return
  analyticsStore.selectedFlowMonth = startOfMonth(addMonths(selectedMonth.value, amount))
}

const onSelectNode = async (node) => {
  if (node.transactionIds?.length > 0) {
    const ids = [...new Set(node.transactionIds)].join(',')
    await navigateTo(RouteConstants.ROUTE_TRANSACTION_LIST + '?' + TransactionFilterUtils.filters.id.toUrl(ids))
    return
  }
  if (!RESIDUAL_IDS.has(node.id)) return
  selectedResidual.value = node
  residualDetailsVisible.value = true
}
</script>
