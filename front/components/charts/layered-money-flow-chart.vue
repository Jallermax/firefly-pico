<template>
  <div ref="root" class="analytics-flow" :class="{ 'analytics-flow-mobile': !appStore.isDesktopLayout }">
    <svg class="analytics-flow-svg" :viewBox="layout.viewBox" :style="{ aspectRatio: `${layout.width} / ${layout.height}` }" role="group" :aria-label="props.ariaLabel">
      <g
        v-for="ribbon in layout.ribbons"
        :key="ribbon.id"
        role="button"
        tabindex="0"
        :aria-label="linkAriaLabel(ribbon.link)"
        @focus="activateLink(ribbon)"
        @blur="clearActive"
        @pointerenter="activateLink(ribbon)"
        @pointerleave="clearActive"
        @pointerdown="activateLink(ribbon)"
        @click="selectLink(ribbon)"
        @keydown.enter.prevent="selectLink(ribbon)"
        @keydown.space.prevent="selectLink(ribbon)"
      >
        <title>{{ linkAriaLabel(ribbon.link) }}</title>
        <rect :x="ribbon.hitBox.x" :y="ribbon.hitBox.y" :width="ribbon.hitBox.width" :height="ribbon.hitBox.height" fill="transparent" />
        <path :d="ribbon.path" :fill="linkColor(ribbon)" :opacity="linkOpacity(ribbon)" pointer-events="none" />
      </g>

      <g
        v-for="node in layout.nodes"
        :key="node.id"
        class="analytics-flow-node"
        role="button"
        tabindex="0"
        :aria-label="nodeAriaLabel(node.node)"
        @focus="activateNode(node)"
        @blur="clearActive"
        @pointerenter="activateNode(node)"
        @pointerleave="clearActive"
        @pointerdown="activateNode(node)"
        @click="selectNode(node)"
        @keydown.enter.prevent="selectNode(node)"
        @keydown.space.prevent="selectNode(node)"
      >
        <title>{{ nodeAriaLabel(node.node) }}</title>
        <rect :x="node.hitBox.x" :y="node.hitBox.y" :width="node.hitBox.width" :height="node.hitBox.height" fill="transparent" />
        <rect
          :class="{ 'analytics-flow-pool-bar': isPool(node) }"
          :x="node.x"
          :y="node.y"
          :width="node.width"
          :height="node.height"
          :fill="nodeColor(node)"
          :opacity="nodeOpacity(node)"
          rx="2"
          pointer-events="none"
        />
        <text class="analytics-flow-node-label" :x="nodeLabel(node).x" :y="nodeLabel(node).y" :text-anchor="nodeLabel(node).anchor" :opacity="nodeOpacity(node)">{{ nodeLabelText(node.node) }}</text>
        <text class="analytics-flow-node-amount" :x="nodeLabel(node).x" :y="nodeLabel(node).amountY" :text-anchor="nodeLabel(node).anchor" :opacity="nodeOpacity(node)">
          {{ formatValue(node.node) }}
        </text>
      </g>
    </svg>

    <details v-if="accessibleNodes.length || accessibleLinks.length" class="analytics-flow-values">
      <summary>{{ $t('analytics.common.exact_values') }}</summary>
      <ul class="analytics-flow-list">
        <li v-for="node in accessibleNodes" :key="`node:${node.id}`">
          <button type="button" @click="emit('select-node', node)">{{ nodeAriaLabel(node) }}</button>
        </li>
        <li v-for="link in accessibleLinks" :key="`link:${link.id}`">
          <button type="button" @click="emit('select-link', link)">{{ linkAriaLabel(link) }}</button>
        </li>
      </ul>
    </details>
  </div>
</template>

<script setup>
import { useElementSize } from '@vueuse/core'
import { useAppStore } from '~/stores/appStore.js'
import { limitMoneyFlowGraphDetail } from '~/utils/AnalyticsUtils.js'
import { buildMoneyFlowGraphGeometry, resolveMoneyFlowGraphMode } from '~/utils/ChartUtils.js'

const props = defineProps({
  graph: { type: Object, required: true },
  ariaLabel: { type: String, required: true },
  detailLevel: { type: [Number, String], default: 5 },
})

const emit = defineEmits(['select-node', 'select-link'])
const { t } = useI18n()
const appStore = useAppStore()
const root = ref(null)
const active = ref(null)
const { width: renderedWidth } = useElementSize(root)

const limitedGraph = computed(() => limitMoneyFlowGraphDetail({ graph: props.graph, detailLevel: props.detailLevel }))
const mode = computed(() => resolveMoneyFlowGraphMode({ nodes: limitedGraph.value.nodes, isDesktop: appStore.isDesktopLayout, renderedWidth: renderedWidth.value }))
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
const accessibleNodes = computed(() => [...layout.value.nodes.map(({ node }) => node), ...(layout.value.details?.nodes ?? [])])
const accessibleLinks = computed(() => [...layout.value.ribbons.map(({ link }) => link), ...(layout.value.details?.links ?? [])])
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
  available: 'analytics.flow.available',
  savings: 'analytics.balance.savings',
  income: 'analytics.flow.income',
  expenses: 'analytics.flow.expenses',
  savingsDeposited: 'analytics.flow.savings_deposited',
  newExcess: 'analytics.flow.new_excess',
  debtPaid: 'analytics.flow.debt_repaid',
  newDebt: 'analytics.flow.new_debt',
  refund: 'analytics.flow.net_refunds',
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
const nodeAriaLabel = (node) => `${nodeLabelText(node)}: ${formatValue(node)}`
const linkAriaLabel = (link) => {
  const source = nodeDictionary.value.get(link.sourceId)
  const target = nodeDictionary.value.get(link.targetId)
  return `${t('analytics.flow.source')}: ${nodeLabelText(source ?? { id: link.sourceId })}; ${t('analytics.flow.destination')}: ${nodeLabelText(target ?? { id: link.targetId })}; ${formatValue(link)}`
}
const isPool = ({ kind }) => ['available', 'savings'].includes(kind)
const nodeColor = ({ color, kind }) =>
  color ?? (kind === 'available' ? 'var(--transfer2)' : kind === 'savings' ? 'var(--income2)' : kind.includes('expense') ? 'var(--expense2)' : 'var(--primary-action)')
const linkColor = ({ color, fundingPool, kind }) => color ?? (fundingPool === 'savings' ? 'var(--income2)' : kind === 'expense' ? 'var(--expense2)' : 'var(--transfer2)')
const nodeOpacity = ({ id }) => (!related.value || related.value.nodes.has(id) ? 1 : 0.2)
const linkOpacity = ({ id }) => (!related.value || related.value.links.has(id) ? 0.72 : 0.12)
const nodeLabel = (node) => {
  if (!appStore.isDesktopLayout) return { x: node.x + node.width / 2, y: node.y - 12, amountY: node.y + node.height + 20, anchor: 'middle' }
  const isLeft = node.x < layout.value.width / 2
  return { x: isLeft ? node.x - 10 : node.x + node.width + 10, y: node.y + node.height / 2 - 3, amountY: node.y + node.height / 2 + 15, anchor: isLeft ? 'end' : 'start' }
}

const activateNode = ({ id }) => (active.value = { type: 'node', id })
const activateLink = ({ id }) => (active.value = { type: 'link', id })
const clearActive = () => (active.value = null)
const selectNode = ({ node }) => {
  activateNode(node)
  emit('select-node', node)
}
const selectLink = ({ link }) => {
  activateLink(link)
  emit('select-link', link)
}
</script>
