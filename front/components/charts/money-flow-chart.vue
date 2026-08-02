<template>
  <div class="analytics-flow" :class="{ 'analytics-flow-mobile': !appStore.isDesktopLayout }">
    <svg :viewBox="layout.viewBox" class="analytics-flow-svg" :aria-label="props.ariaLabel" role="img">
      <g
        v-for="node in sourceGeometry"
        :key="node.side + node.id"
        class="analytics-flow-node"
        tabindex="0"
        role="button"
        :aria-label="node.ariaLabel"
        @click="emit('select-node', node)"
        @keydown.enter.prevent="emit('select-node', node)"
        @keydown.space.prevent="emit('select-node', node)"
      >
        <title>{{ node.ariaLabel }}</title>
        <path :d="node.path" class="analytics-flow-band-hit" vector-effect="non-scaling-stroke" :style="{ strokeWidth: Math.max(44, node.width) }" />
        <path :d="node.path" class="analytics-flow-band" :style="{ strokeWidth: node.width, stroke: node.color }" />
        <text class="analytics-flow-node-label" :x="node.labelX" :y="node.labelY" :text-anchor="node.textAnchor">{{ node.label }}</text>
        <text class="analytics-flow-node-amount" :x="node.amountX" :y="node.amountY" :text-anchor="node.textAnchor">{{ node.valueLabel }}</text>
      </g>

      <rect class="analytics-flow-bus" :x="layout.bus.x" :y="layout.bus.y" :width="layout.bus.width" :height="layout.bus.height" rx="10" />
      <text class="analytics-flow-bus-label" :x="layout.bus.labelX" :y="layout.bus.labelY" text-anchor="middle" :transform="layout.bus.transform">{{ props.busLabel }}</text>

      <g
        v-for="node in destinationGeometry"
        :key="node.side + node.id"
        class="analytics-flow-node"
        tabindex="0"
        role="button"
        :aria-label="node.ariaLabel"
        @click="emit('select-node', node)"
        @keydown.enter.prevent="emit('select-node', node)"
        @keydown.space.prevent="emit('select-node', node)"
      >
        <title>{{ node.ariaLabel }}</title>
        <path :d="node.path" class="analytics-flow-band-hit" vector-effect="non-scaling-stroke" :style="{ strokeWidth: Math.max(44, node.width) }" />
        <path :d="node.path" class="analytics-flow-band" :style="{ strokeWidth: node.width, stroke: node.color }" />
        <text class="analytics-flow-node-label" :x="node.labelX" :y="node.labelY" :text-anchor="node.textAnchor">{{ node.label }}</text>
        <text class="analytics-flow-node-amount" :x="node.amountX" :y="node.amountY" :text-anchor="node.textAnchor">{{ node.valueLabel }}</text>
      </g>
    </svg>

    <details class="analytics-flow-values">
      <summary>{{ $t('analytics.common.exact_values') }}</summary>
      <ul class="analytics-flow-list">
        <li v-for="node in accessibleNodes" :key="node.side + node.id">
          <button type="button" @click="emit('select-node', node)">{{ node.sideLabel }}: {{ node.label }} — {{ node.valueLabel }}</button>
        </li>
      </ul>
    </details>
  </div>
</template>

<script setup>
import { useAppStore } from '~/stores/appStore.js'
import { buildMoneyFlowGeometry } from '~/utils/ChartUtils.js'

const props = defineProps({
  sources: { type: Array, default: () => [] },
  destinations: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  ariaLabel: { type: String, required: true },
  busLabel: { type: String, required: true },
})

const emit = defineEmits(['select-node'])
const appStore = useAppStore()

const layout = computed(() => buildMoneyFlowGeometry({ sources: props.sources, destinations: props.destinations, total: props.total, isDesktop: appStore.isDesktopLayout }))
const withAriaLabel = (node) => ({ ...node, ariaLabel: `${node.sideLabel}: ${node.label} — ${node.valueLabel}` })
const sourceGeometry = computed(() => layout.value.sources.map(withAriaLabel))
const destinationGeometry = computed(() => layout.value.destinations.map(withAriaLabel))
const accessibleNodes = computed(() => [...sourceGeometry.value, ...destinationGeometry.value])
</script>
