<template>
  <div ref="root" class="analytics-flow" :class="{ 'analytics-flow-mobile': !appStore.isDesktopLayout, 'analytics-flow-animated': profileStore.showAnimations }" @keydown.esc.stop="clearPinned">
    <svg class="analytics-flow-svg" :viewBox="layout.viewBox" :style="{ aspectRatio: `${layout.width} / ${layout.height}` }" role="group" :aria-label="props.ariaLabel" @pointerdown.self="clearPinned">
      <defs>
        <pattern id="analytics-flow-refund-pattern" width="8" height="8" patternUnits="userSpaceOnUse">
          <path class="analytics-flow-pattern-line" d="M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6" />
        </pattern>
        <pattern id="analytics-flow-savings-accessible-pattern" width="8" height="8" patternUnits="userSpaceOnUse">
          <circle class="analytics-flow-pattern-dot" cx="4" cy="4" r="1.5" />
        </pattern>
        <pattern id="analytics-flow-savings-restricted-pattern" width="8" height="8" patternUnits="userSpaceOnUse">
          <path class="analytics-flow-pattern-line" d="M 0 0 L 8 8 M 8 0 L 0 8" />
        </pattern>
      </defs>
      <g
        v-for="ribbon in layout.ribbons"
        :key="ribbon.id"
        class="analytics-flow-ribbon"
        data-flow-target
        role="button"
        tabindex="0"
        :aria-label="linkAriaLabel(ribbon.link)"
        @focus="activateLink(ribbon)"
        @blur="clearPreview"
        @pointerenter="activateLink(ribbon)"
        @pointerleave="clearPreview"
        @pointerdown="activateLink(ribbon)"
        @click="selectLink(ribbon)"
        @keydown.enter.prevent="selectLink(ribbon)"
        @keydown.space.prevent="selectLink(ribbon)"
        @keydown.left.prevent="focusRelative($event, -1)"
        @keydown.up.prevent="focusRelative($event, -1)"
        @keydown.right.prevent="focusRelative($event, 1)"
        @keydown.down.prevent="focusRelative($event, 1)"
      >
        <title>{{ linkAriaLabel(ribbon.link) }}</title>
        <rect class="analytics-flow-interaction-target" :x="ribbon.hitBox.x" :y="ribbon.hitBox.y" :width="ribbon.hitBox.width" :height="ribbon.hitBox.height" fill="transparent" />
        <path class="analytics-flow-ribbon-shape" :d="ribbon.path" :fill="linkColor(ribbon)" :opacity="linkOpacity(ribbon)" pointer-events="none" />
        <path v-if="itemPattern(ribbon.link)" class="analytics-flow-ribbon-pattern" :d="ribbon.path" :fill="itemPattern(ribbon.link)" :opacity="linkOpacity(ribbon)" pointer-events="none" />
      </g>

      <g
        v-for="node in layout.nodes"
        :key="node.id"
        class="analytics-flow-node"
        data-flow-target
        role="button"
        tabindex="0"
        :aria-label="nodeAriaLabel(node.node)"
        @focus="activateNode(node)"
        @blur="clearPreview"
        @pointerenter="activateNode(node)"
        @pointerleave="clearPreview"
        @pointerdown="activateNode(node)"
        @click="selectNode(node)"
        @keydown.enter.prevent="selectNode(node)"
        @keydown.space.prevent="selectNode(node)"
        @keydown.left.prevent="focusRelative($event, -1)"
        @keydown.up.prevent="focusRelative($event, -1)"
        @keydown.right.prevent="focusRelative($event, 1)"
        @keydown.down.prevent="focusRelative($event, 1)"
      >
        <title>{{ nodeAriaLabel(node.node) }}</title>
        <rect class="analytics-flow-interaction-target" :x="node.hitBox.x" :y="node.hitBox.y" :width="node.hitBox.width" :height="node.hitBox.height" fill="transparent" />
        <rect
          :class="{ 'analytics-flow-pool-bar': isPool(node) }"
          :x="node.x"
          :y="node.y"
          :width="node.width"
          :height="node.height"
          :fill="nodeColor(node)"
          :opacity="nodeOpacity(node)"
          rx="0.5"
          pointer-events="none"
        />
        <rect
          v-if="itemPattern(node.node)"
          :x="node.x"
          :y="node.y"
          :width="node.width"
          :height="node.height"
          :fill="itemPattern(node.node)"
          :opacity="nodeOpacity(node)"
          rx="0.5"
          pointer-events="none"
        />
        <text class="analytics-flow-node-label" :x="nodeLabel(node).x" :y="nodeLabel(node).y" :text-anchor="nodeLabel(node).anchor" :opacity="nodeOpacity(node)">{{ nodeLabelText(node.node) }}</text>
        <text class="analytics-flow-node-amount" :x="nodeLabel(node).x" :y="nodeLabel(node).amountY" :text-anchor="nodeLabel(node).anchor" :opacity="nodeOpacity(node)">
          {{ formatValue(node.node) }}
        </text>
      </g>
    </svg>
    <div v-if="activeItem" class="analytics-flow-hover-details" role="status" aria-live="polite">
      <strong>{{ activeItemLabel }}</strong>
      <span>{{ formatValue(activeItem) }}</span>
      <span v-if="activeDetails.sourcePercent !== null">{{ $t('analytics.flow.source') }}: {{ formatPercent(activeDetails.sourcePercent) }}</span>
      <span v-if="activeDetails.destinationPercent !== null">{{ $t('analytics.flow.destination') }}: {{ formatPercent(activeDetails.destinationPercent) }}</span>
      <span v-if="activeDetails.refundCoverage">{{ $t('analytics.flow.refund_category') }}: {{ formatValue(activeDetails.refundCoverage) }}</span>
      <span v-if="activeDetails.transactionIds.length">{{ $t('analytics.flow.view_transactions', { count: activeDetails.transactionIds.length }) }}</span>
    </div>
  </div>
</template>

<script setup>
import { onClickOutside, useElementSize } from '@vueuse/core'
import { useAppStore } from '~/stores/appStore.js'
import { useProfileStore } from '~/stores/profileStore.js'
import { limitMoneyFlowGraphDetail } from '~/utils/AnalyticsUtils.js'
import { buildMoneyFlowGraphGeometry, resolveMoneyFlowGraphMode, resolveMoneyFlowItemDetails } from '~/utils/ChartUtils.js'

const props = defineProps({
  graph: { type: Object, required: true },
  ariaLabel: { type: String, required: true },
  detailLevel: { type: [Number, String], default: 5 },
})

const emit = defineEmits(['select-node', 'select-link', 'mode-change'])
const { t } = useI18n()
const appStore = useAppStore()
const profileStore = useProfileStore()
const root = ref(null)
const preview = ref(null)
const pinned = ref(null)
const { width: renderedWidth } = useElementSize(root)

const limitedGraph = computed(() => limitMoneyFlowGraphDetail({ graph: props.graph, detailLevel: props.detailLevel }))
const mode = computed(() => resolveMoneyFlowGraphMode({ nodes: limitedGraph.value.nodes, isDesktop: appStore.isDesktopLayout, renderedWidth: renderedWidth.value }))
watch(mode, (value) => emit('mode-change', value), { immediate: true })
const layout = computed(() =>
  buildMoneyFlowGraphGeometry({
    nodes: limitedGraph.value.nodes,
    links: limitedGraph.value.links,
    isDesktop: appStore.isDesktopLayout,
    renderedWidth: renderedWidth.value,
    mode: mode.value,
  }),
)
const nodeDictionary = computed(() => new Map(limitedGraph.value.nodes.map((node) => [node.id, node])))
const linkDictionary = computed(() => new Map(limitedGraph.value.links.map((link) => [link.id, link])))
const active = computed(() => preview.value ?? pinned.value)
const activeItem = computed(() => (active.value?.type === 'link' ? linkDictionary.value.get(active.value.id) : nodeDictionary.value.get(active.value?.id)) ?? null)
const activeDetails = computed(() => resolveMoneyFlowItemDetails({ item: activeItem.value ?? {}, nodes: limitedGraph.value.nodes }))
const related = computed(() => {
  if (!active.value) return null
  if (active.value.type === 'link') {
    const link = limitedGraph.value.links.find(({ id }) => id === active.value.id)
    return link ? { nodes: new Set([link.sourceId, link.targetId]), links: new Set([link.id]) } : null
  }
  const links = limitedGraph.value.links.filter(({ sourceId, targetId }) => sourceId === active.value.id || targetId === active.value.id)
  return { nodes: new Set([active.value.id, ...links.flatMap(({ sourceId, targetId }) => [sourceId, targetId])]), links: new Set(links.map(({ id }) => id)) }
})

const semanticLabels = {
  available: 'analytics.flow.available_pool',
  savings: 'analytics.flow.savings_pool',
  income: 'analytics.flow.new_income',
  expenses: 'analytics.flow.expenses',
  savingsDeposited: 'analytics.flow.savings_deposited',
  newExcess: 'analytics.flow.new_excess',
  debtPaid: 'analytics.flow.debt_paid',
  newDebt: 'analytics.flow.new_debt',
  liabilityExtended: 'analytics.flow.liability_extended',
  liabilityCollected: 'analytics.flow.liability_collected',
  refund: 'analytics.flow.refund_category',
}
const nodeLabelText = (node) => node.label ?? (semanticLabels[node.kind] ? t(semanticLabels[node.kind]) : (node.refId ?? node.id))
const formatValue = (item) => {
  if (item.valueLabel) return item.valueLabel
  const value = Number(item.value)
  const currencyCode = props.graph.meta?.displayCurrencyCode
  return Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, currencyCode ? { style: 'currency', currency: currencyCode, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }).format(value)
    : ''
}
const formatPercent = (value) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value)
const itemDetailsLabel = (item) => {
  const details = resolveMoneyFlowItemDetails({ item, nodes: limitedGraph.value.nodes })
  return [
    formatValue(item),
    details.sourcePercent === null ? null : `${t('analytics.flow.source')}: ${formatPercent(details.sourcePercent)}`,
    details.destinationPercent === null ? null : `${t('analytics.flow.destination')}: ${formatPercent(details.destinationPercent)}`,
    details.refundCoverage ? `${t('analytics.flow.refund_category')}: ${formatValue(details.refundCoverage)}` : null,
    details.transactionIds.length ? t('analytics.flow.view_transactions', { count: details.transactionIds.length }) : null,
  ]
    .filter(Boolean)
    .join('; ')
}
const nodeAriaLabel = (node) => `${nodeLabelText(node)}: ${itemDetailsLabel(node)}`
const linkAriaLabel = (link) => {
  const source = nodeDictionary.value.get(link.sourceId)
  const target = nodeDictionary.value.get(link.targetId)
  return `${t('analytics.flow.source')}: ${nodeLabelText(source ?? { id: link.sourceId })}; ${t('analytics.flow.destination')}: ${nodeLabelText(target ?? { id: link.targetId })}; ${itemDetailsLabel(link)}`
}
const activeItemLabel = computed(() =>
  activeItem.value?.sourceId ? linkAriaLabel(activeItem.value).split(';')[0] + ' → ' + nodeLabelText(nodeDictionary.value.get(activeItem.value.targetId)) : nodeLabelText(activeItem.value),
)
const isPool = ({ kind }) => ['available', 'savings'].includes(kind)
const nodeColor = ({ color, kind }) =>
  color ?? (kind === 'available' ? 'var(--transfer2)' : kind === 'savings' ? 'var(--income2)' : kind.includes('expense') ? 'var(--expense2)' : 'var(--primary-action)')
const linkColor = ({ color, fundingPool, kind }) => color ?? (fundingPool === 'savings' ? 'var(--income2)' : kind === 'expense' ? 'var(--expense2)' : 'var(--transfer2)')
const itemPattern = (item) => {
  if (item.kind === 'refund' || item.refundCoverage) return 'url(#analytics-flow-refund-pattern)'
  const savingsGroup = item.savingsGroup ?? nodeDictionary.value.get(item.sourceId)?.savingsGroup ?? nodeDictionary.value.get(item.targetId)?.savingsGroup
  return savingsGroup ? `url(#analytics-flow-savings-${savingsGroup}-pattern)` : null
}
const nodeOpacity = ({ id }) => (!related.value || related.value.nodes.has(id) ? 1 : 0.2)
const linkOpacity = ({ id }) => (!related.value || related.value.links.has(id) ? 0.72 : 0.12)
const nodeLabel = (node) => {
  if (!appStore.isDesktopLayout) return { x: node.x + node.width / 2, y: node.y - 12, amountY: node.y + node.height + 20, anchor: 'middle' }
  const isLeft = node.x < layout.value.width / 2
  return { x: isLeft ? node.x - 10 : node.x + node.width + 10, y: node.y + node.height / 2 - 3, amountY: node.y + node.height / 2 + 15, anchor: isLeft ? 'end' : 'start' }
}

const activateNode = ({ id }) => (preview.value = { type: 'node', id })
const activateLink = ({ id }) => (preview.value = { type: 'link', id })
const clearPreview = () => (preview.value = null)
const clearPinned = () => {
  preview.value = null
  pinned.value = null
}
const focusRelative = (event, amount) => {
  const targets = [...root.value.querySelectorAll('[data-flow-target]')]
  const index = targets.indexOf(event.currentTarget)
  targets[(index + amount + targets.length) % targets.length]?.focus()
}
const selectNode = ({ node }) => {
  pinned.value = { type: 'node', id: node.id }
  emit('select-node', node)
}
const selectLink = ({ link }) => {
  pinned.value = { type: 'link', id: link.id }
  emit('select-link', link)
}
onClickOutside(root, clearPinned)
</script>
