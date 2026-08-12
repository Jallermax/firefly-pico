<template>
  <div class="analytics-daily-forecast-full-details">
    <section class="analytics-daily-forecast-detail-section analytics-daily-forecast-day-details">
      <h2 class="analytics-daily-forecast-section-title">{{ $t('analytics.daily_forecast.day_details') }}</h2>
      <div v-if="selectedDay" class="analytics-calculation-details" aria-live="polite">
        <div class="analytics-daily-forecast-details-heading">
          <strong>{{ selectedDayLabel }}</strong>
          <span>{{ selectedDay.isToday ? $t('today') : '' }}</span>
        </div>
        <div class="analytics-daily-forecast-day-summary">
          <div v-for="item in selectedDayTotals" :key="item.id">
            <span>{{ item.label }}</span>
            <strong>{{ formatCurrency(item.value) }}</strong>
          </div>
        </div>
        <div v-if="selectedDayEntries.length" class="analytics-daily-forecast-component-list">
          <button
            v-for="entry in selectedDayEntries"
            :key="entry.id"
            type="button"
            class="analytics-daily-forecast-detail-row"
            :disabled="!canNavigateEntry(entry)"
            @click="onEntry(entry, 'pointer')"
            @keydown.enter.prevent="onEntry(entry, 'keyboard')"
          >
            <span class="analytics-daily-forecast-detail-main">
              <span class="font-weight-600">{{ entry.sourceLabel || sourceLabel(entry.sourceKind) }}</span>
              <small>{{ sourceLabel(entry.sourceKind) }}</small>
            </span>
            <span :class="entry.displayAmount < 0 ? 'analytics-negative-value' : 'analytics-positive-value'">{{ formatSignedCurrency(entry.displayAmount) }}</span>
          </button>
        </div>
        <div v-else class="analytics-assumption-note">{{ $t('analytics.daily_forecast.no_activity_for_day') }}</div>
      </div>
      <div v-else class="analytics-assumption-note">{{ $t('analytics.daily_forecast.select_day') }}</div>
    </section>

    <section class="analytics-daily-forecast-detail-section analytics-daily-forecast-monthly-impact">
      <h2 class="analytics-daily-forecast-section-title">{{ $t('analytics.daily_forecast.monthly_impact') }}</h2>
      <div class="analytics-daily-forecast-impact-grid">
        <div v-for="item in impact.items" :key="item.id" class="analytics-daily-forecast-impact-row">
          <strong>{{ impactLabel(item.id) }}</strong>
          <span>{{ $t('analytics.daily_forecast.actual_through_today') }}: {{ formatSignedCurrency(item.actual) }}</span>
          <span>{{ $t('analytics.daily_forecast.remaining_activity') }}: {{ formatSignedCurrency(item.remaining) }}</span>
          <span>{{ $t('analytics.daily_forecast.end_of_month_change') }}: {{ formatSignedCurrency(item.final) }}</span>
          <small v-if="item.status && item.status !== 'ready'">{{ $t(`analytics.daily_forecast.${item.status}`) }}</small>
        </div>
      </div>
      <div v-if="payrollImpactEvents.length" class="analytics-daily-forecast-payroll-impact">
        <details v-for="event in payrollImpactEvents" :key="event.id" class="analytics-daily-forecast-disclosure">
          <summary>
            <span>
              <strong>{{ event.label }}</strong>
              <small>{{ event.dateLabel }}</small>
              <small v-if="confidenceLevel(event.confidence)">{{ $t('analytics.daily_forecast.confidence', { level: confidenceLabel(event.confidence) }) }}</small>
            </span>
            <strong>{{ formatSignedCurrency(event.impact.availableCashChange) }}</strong>
          </summary>
          <div class="analytics-daily-forecast-disclosure-body">
            <div v-for="component in event.components" :key="component.id" class="analytics-daily-forecast-payroll-component">
              <div class="analytics-daily-forecast-evidence-heading">
                <strong>{{ component.label }}</strong>
                <small>{{
                  $t('analytics.daily_forecast.account_route', { source: accountKindLabel(component.sourceAccountKind), destination: accountKindLabel(component.destinationAccountKind) })
                }}</small>
              </div>
              <div class="analytics-daily-forecast-evidence-grid">
                <div v-for="row in componentImpactRows(component)" :key="row.id">
                  <span>{{ impactLabel(row.id) }}</span>
                  <strong>{{ formatSignedCurrency(row.value) }}</strong>
                </div>
              </div>
            </div>
          </div>
        </details>
      </div>
    </section>

    <section class="analytics-daily-forecast-detail-section analytics-daily-forecast-events">
      <h2 class="analytics-daily-forecast-section-title">{{ $t('analytics.daily_forecast.scheduled_events') }}</h2>
      <details v-for="event in scheduledEventSummaries" :key="event.id" class="analytics-daily-forecast-disclosure analytics-daily-forecast-event">
        <summary>
          <span>
            <strong>{{ event.label }}</strong>
            <small>{{ event.dateLabel }}</small>
            <small v-if="confidenceLevel(event.confidence)">{{ $t('analytics.daily_forecast.confidence', { level: confidenceLabel(event.confidence) }) }}</small>
          </span>
          <strong>{{ formatSignedCurrency(event.availableCashChange) }}</strong>
        </summary>
        <div class="analytics-daily-forecast-disclosure-body">
          <div class="analytics-daily-forecast-component-list">
            <div v-for="row in event.detailRows.filter(({ value }) => Number.isFinite(value) && value !== 0)" :key="row.id" class="analytics-daily-forecast-component-row">
              <span>{{ row.label }}</span>
              <strong :class="row.value < 0 ? 'analytics-negative-value' : 'analytics-positive-value'">{{ formatSignedCurrency(row.value) }}</strong>
            </div>
          </div>
        </div>
      </details>
      <div v-if="scheduledEventSummaries.length === 0" class="analytics-assumption-note">{{ $t('analytics.daily_forecast.no_scheduled_events') }}</div>
    </section>

    <section class="analytics-daily-forecast-detail-section analytics-daily-forecast-envelope">
      <h2 class="analytics-daily-forecast-section-title">{{ $t('analytics.daily_forecast.variable_envelope') }}</h2>
      <div class="analytics-assumption-note">{{ $t('analytics.daily_forecast.undated_estimate') }}</div>
      <div v-for="item in variableEnvelopeItems" :key="item.id" class="analytics-daily-forecast-evidence-item">
        <div class="analytics-daily-forecast-evidence-heading">
          <strong>{{ item.label }}</strong>
          <small v-if="confidenceLevel(item.confidence)">{{ $t('analytics.daily_forecast.confidence', { level: confidenceLabel(item.confidence) }) }}</small>
        </div>
        <div class="analytics-daily-forecast-evidence-grid">
          <div v-for="row in item.rows" :key="row.id">
            <span>{{ row.label }}</span>
            <strong>{{ formatCurrency(row.value) }}</strong>
          </div>
        </div>
      </div>
      <div v-if="variableEnvelopeItems.length === 0" class="analytics-assumption-note">{{ $t('analytics.daily_forecast.no_variable_envelope') }}</div>
    </section>

    <section class="analytics-daily-forecast-detail-section analytics-daily-forecast-evidence-issues">
      <h2 class="analytics-daily-forecast-section-title">{{ $t('analytics.daily_forecast.evidence_and_issues') }}</h2>
      <div v-if="state.sourceErrors?.length" class="analytics-daily-forecast-source-errors">
        <div v-for="error in state.sourceErrors" :key="error.source">{{ $t('analytics.daily_forecast.error') }} ({{ error.source }})</div>
        <van-button class="analytics-daily-forecast-retry" size="small" @click="$emit('retry')">{{ $t('analytics.common.retry') }}</van-button>
      </div>
      <details class="analytics-daily-forecast-disclosure analytics-daily-forecast-technical-evidence">
        <summary>{{ $t('analytics.daily_forecast.technical_evidence') }}</summary>
        <div class="analytics-daily-forecast-evidence">
          <template v-for="event in eventSummaries" :key="event.id">
            <span v-if="event.sourceIds.length">{{ $t('analytics.daily_forecast.source_id', { id: event.sourceIds.join(', ') }) }}</span>
            <span v-if="event.candidateIds.length">{{ $t('analytics.daily_forecast.candidate_id', { id: event.candidateIds.join(', ') }) }}</span>
            <span v-if="event.evidenceIds.length">{{ $t('analytics.daily_forecast.evidence_ids', { ids: event.evidenceIds.join(', ') }) }}</span>
          </template>
          <span v-for="item in forecast.audit?.aggregateReconciliation ?? []" :key="item.candidateId">
            {{ $t('analytics.daily_forecast.aggregate_reconciled', { count: item.bundleIds.length }) }}
            · {{ $t('analytics.daily_forecast.candidate_id', { id: item.candidateId }) }} · {{ $t('analytics.daily_forecast.source_id', { id: item.bundleIds.join(', ') }) }} ·
            {{ $t('analytics.daily_forecast.evidence_ids', { ids: [...(item.entryIds ?? []), ...(item.transactionIds ?? [])].join(', ') }) }}
          </span>
          <span v-if="unavailableEvidenceSummary.previewIds.length">{{ unavailableEvidenceSummary.previewIds.join(', ') }}</span>
          <span v-if="unavailableEvidenceSummary.omittedCount">{{ $t('analytics.common.more_items', { count: unavailableEvidenceSummary.omittedCount }) }}</span>
        </div>
      </details>
    </section>
  </div>
</template>

<script setup>
import { parseISO } from 'date-fns'
import RouteConstants from '~/constants/RouteConstants.js'
import { projectLineChartSelection } from '~/utils/ChartUtils.js'
import { formatNumberForDashboard } from '~/utils/NumberUtils.js'
import TransactionFilterUtils from '~/utils/TransactionFilterUtils.js'

const props = defineProps({
  forecast: { type: Object, required: true },
  state: { type: Object, required: true },
  impact: { type: Object, required: true },
  selectedDate: { type: String, default: null },
  displayCurrencyCode: { type: String, required: true },
  language: { type: String, required: true },
})
defineEmits(['retry'])
const { t } = useI18n()
const formatCurrency = (value) => (Number.isFinite(value) ? `${formatNumberForDashboard(value)} ${props.displayCurrencyCode}` : '—')
const formatSignedCurrency = (value) => (Number.isFinite(value) ? `${value > 0 ? '+' : ''}${formatCurrency(value)}` : '—')
const sourceLabel = (sourceKind) => t(`analytics.daily_forecast.source_${sourceKind}`)
const confidenceLevel = (confidence) => (typeof confidence === 'string' ? confidence : confidence?.level)
const confidenceLabel = (confidence) => t(`analytics.daily_forecast.confidence_${confidenceLevel(confidence)}`)
const materialRows = (rows) => rows.filter(({ value }) => Number.isFinite(value) && value !== 0)
const eventDetailRows = (event) => [
  ...materialRows(
    event.components.flatMap((component) => {
      const flow = component.flowAmounts ?? {}
      return [
        { id: `${component.id}:income`, label: component.bundleLabel || component.sourceLabel || t('analytics.daily_forecast.gross_inflow'), value: (flow.income ?? 0) + (flow.refunds ?? 0) },
        { id: `${component.id}:expenses`, label: component.bundleLabel || component.sourceLabel || t('analytics.daily_forecast.expected_outflow'), value: -(flow.expenses ?? 0) },
        { id: `${component.id}:debt`, label: t('analytics.daily_forecast.debt'), value: (flow.newDebt ?? 0) - (flow.debtRepayments ?? 0) },
        { id: `${component.id}:savings`, label: t('analytics.daily_forecast.savings'), value: (flow.savingsWithdrawals ?? 0) - (flow.savingsDeposits ?? 0) },
      ]
    }),
  ),
  ...(Number.isFinite(event.availableCashChange) ? [{ id: `${event.id}:available`, label: t('analytics.daily_forecast.available_change'), value: event.availableCashChange }] : []),
]
const eventSummaries = computed(() =>
  props.forecast.eventSummaries.map((event) => ({
    ...event,
    label: event.bundleLabel || sourceLabel(event.sourceKind),
    dateLabel: new Intl.DateTimeFormat(props.language, { month: 'short', day: 'numeric' }).format(parseISO(event.date)),
    detailRows: eventDetailRows(event),
  })),
)
const scheduledEventSummaries = computed(() => eventSummaries.value.filter(({ bundleId }) => !bundleId))
const envelopeRows = (item) =>
  [
    { id: 'actual', label: t('analytics.daily_forecast.actual_variable_activity'), value: item.actual },
    { id: 'known', label: t('analytics.daily_forecast.known_scheduled_activity'), value: item.known },
    { id: 'remaining', label: t('analytics.daily_forecast.remaining_activity'), value: item.remaining },
    { id: 'expected', label: t('analytics.daily_forecast.expected_range'), value: item.expected },
    { id: 'plan', label: t('analytics.daily_forecast.plan'), value: item.plan },
    { id: 'history', label: t('analytics.daily_forecast.history'), value: item.historical },
  ].filter(({ value }) => Number.isFinite(value))
const variableEnvelopeItems = computed(() =>
  props.forecast.variableEnvelope.items
    .filter(
      (item) =>
        [item.expected, item.plan, item.historical, item.remaining].some((value) => Number.isFinite(value) && value !== 0) ||
        item.evidenceIds?.length ||
        (item.planStatus && item.planStatus !== 'ready'),
    )
    .map((item) => ({
      ...item,
      label:
        item.label || t(item.budgetId ? 'analytics.daily_forecast.budget_activity' : item.categoryId ? 'analytics.daily_forecast.category_activity' : 'analytics.daily_forecast.variable_envelope'),
      rows: envelopeRows(item),
    })),
)
const selectedDay = computed(() => props.forecast.days.find(({ date }) => date === props.selectedDate) ?? null)
const selectedDayLabel = computed(() => (selectedDay.value ? new Intl.DateTimeFormat(props.language, { month: 'long', day: 'numeric' }).format(parseISO(selectedDay.value.date)) : ''))
const directionKeys = { sources: ['income', 'refunds', 'savingsWithdrawals', 'newDebt'], uses: ['expenses', 'savingsDeposits', 'debtRepayments'] }
const entryValue = (entry) => {
  const sources = directionKeys.sources.reduce((total, key) => total + (entry.flowAmounts?.[key] ?? 0), 0)
  const uses = directionKeys.uses.reduce((total, key) => total + (entry.flowAmounts?.[key] ?? 0), 0)
  return sources - uses
}
const selectedDayEntries = computed(() =>
  [...(selectedDay.value?.actual?.entries ?? []), ...(selectedDay.value?.projected?.entries ?? [])]
    .map((entry) => ({ ...entry, displayAmount: entryValue(entry) }))
    .filter(({ displayAmount, transactionIds = [], evidenceIds = [] }) => displayAmount !== 0 || transactionIds.length > 0 || evidenceIds.length > 0)
    .sort((left, right) => Math.abs(right.displayAmount) - Math.abs(left.displayAmount) || String(left.id).localeCompare(String(right.id))),
)
const selectedDayTotals = computed(() => {
  if (!selectedDay.value) return []
  return [
    { id: 'inflow', label: t('analytics.daily_forecast.inflow'), value: selectedDay.value.sources },
    { id: 'outflow', label: t('analytics.daily_forecast.outflow'), value: Number.isFinite(selectedDay.value.uses) ? -selectedDay.value.uses : null },
    { id: 'available', label: t('analytics.daily_forecast.available_change'), value: selectedDay.value.availableCashChange },
  ]
})
const canNavigateEntry = (entry) => entry.sourceKind === 'actual' && entry.transactionIds?.length > 0
const onEntry = async (entry, activation) => {
  if (!canNavigateEntry(entry)) return
  const selection = projectLineChartSelection({
    activation,
    transactionIds: entry.transactionIds,
    kind: 'actual',
    route: RouteConstants.ROUTE_TRANSACTION_LIST,
    toUrl: TransactionFilterUtils.filters.id.toUrl,
  })
  if (selection.route) await navigateTo(selection.route)
}
const impactLabelKeys = {
  availableCashChange: 'impact_available_change',
  savingsChange: 'savings',
  savingsIncluded: 'impact_savings_included',
  savingsExcluded: 'impact_savings_excluded',
  debtChange: 'impact_debt_change',
  netWorthChange: 'impact_net_worth_change',
}
const impactLabel = (id) => t(`analytics.daily_forecast.${impactLabelKeys[id]}`)
const accountKindLabelKeys = {
  outside: 'analytics.daily_forecast.account_outside',
  revenue: 'analytics.daily_forecast.account_outside',
  expense: 'analytics.daily_forecast.account_outside',
  available: 'analytics.flow.available_pool',
  savingsAccessible: 'analytics.daily_forecast.impact_savings_included',
  savingsRestricted: 'analytics.daily_forecast.impact_savings_excluded',
  liability: 'analytics.daily_forecast.debt',
}
const accountKindLabel = (kind) => t(accountKindLabelKeys[kind] ?? 'analytics.daily_forecast.account_unknown')
const componentImpactRows = (component) =>
  ['availableCashChange', 'savingsChange', 'debtChange', 'netWorthChange'].map((id) => ({ id, value: component.impact?.[id] })).filter(({ value }) => Number.isFinite(value) && value !== 0)
const payrollImpactEvents = computed(() =>
  (props.impact.payrollEvents ?? []).map((event) => ({
    ...event,
    label: event.bundleLabel || sourceLabel('inferred'),
    dateLabel: new Intl.DateTimeFormat(props.language, { month: 'short', day: 'numeric' }).format(parseISO(event.date)),
  })),
)
const unavailableEvidenceSummary = computed(() => props.state.unavailableEvidenceSummary ?? { count: 0, previewIds: [], omittedCount: 0 })
</script>
