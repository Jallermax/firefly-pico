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
        <path :d="node.path" class="analytics-flow-band-hit" :style="{ strokeWidth: Math.max(44, node.width) }" />
        <path :d="node.path" class="analytics-flow-band" :style="{ strokeWidth: node.width, stroke: node.color }" />
        <text :x="node.labelX" :y="node.labelY" :text-anchor="node.textAnchor">{{ node.label }} · {{ node.valueLabel }}</text>
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
        <path :d="node.path" class="analytics-flow-band-hit" :style="{ strokeWidth: Math.max(44, node.width) }" />
        <path :d="node.path" class="analytics-flow-band" :style="{ strokeWidth: node.width, stroke: node.color }" />
        <text :x="node.labelX" :y="node.labelY" :text-anchor="node.textAnchor">{{ node.label }} · {{ node.valueLabel }}</text>
      </g>
    </svg>

    <ul class="analytics-flow-list">
      <li v-for="node in accessibleNodes" :key="node.side + node.id">
        <button type="button" @click="emit('select-node', node)">{{ node.sideLabel }}: {{ node.label }} — {{ node.valueLabel }}</button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { useAppStore } from '~/stores/appStore.js'

const props = defineProps({
  sources: { type: Array, default: () => [] },
  destinations: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  ariaLabel: { type: String, required: true },
  busLabel: { type: String, required: true },
})

const emit = defineEmits(['select-node'])
const appStore = useAppStore()

const bandWidth = (value) => Math.max(4, (Math.max(0, Number(value)) / Math.max(1, Number(props.total))) * 180)
const labelPosition = (index, count, start, end) => (count <= 1 ? (start + end) / 2 : start + (index / (count - 1)) * (end - start))
const stackedAnchors = (nodes, center) => {
  const widths = nodes.map(({ value }) => bandWidth(value))
  let offset = center - widths.reduce((sum, width) => sum + width, 0) / 2
  return widths.map((width) => {
    const anchor = offset + width / 2
    offset += width
    return { anchor, width }
  })
}

const layout = computed(() =>
  appStore.isDesktopLayout
    ? {
        viewBox: '0 0 1000 520',
        bus: { x: 478, y: 40, width: 44, height: 440, labelX: 500, labelY: 260, transform: 'rotate(-90 500 260)' },
      }
    : {
        viewBox: '0 0 600 720',
        bus: { x: 40, y: 338, width: 520, height: 44, labelX: 300, labelY: 365, transform: null },
      },
)

const geometryFor = (nodes, side) => {
  const anchors = stackedAnchors(nodes, appStore.isDesktopLayout ? 260 : 300)
  return nodes.map((node, index) => {
    const { anchor, width } = anchors[index]
    const labelAxis = appStore.isDesktopLayout
      ? labelPosition(index, nodes.length, 70, 450)
      : side === 'source'
        ? labelPosition(index, nodes.length, 45, 265)
        : labelPosition(index, nodes.length, 455, 655)
    const path = appStore.isDesktopLayout
      ? side === 'source'
        ? `M 210 ${labelAxis} C 330 ${labelAxis}, 390 ${anchor}, 478 ${anchor}`
        : `M 522 ${anchor} C 610 ${anchor}, 670 ${labelAxis}, 790 ${labelAxis}`
      : side === 'source'
        ? `M 220 ${labelAxis} C 300 ${labelAxis}, ${anchor} 285, ${anchor} 338`
        : `M ${anchor} 382 C ${anchor} 435, 300 ${labelAxis}, 220 ${labelAxis}`
    return {
      ...node,
      side,
      width,
      path,
      labelX: appStore.isDesktopLayout ? (side === 'source' ? 195 : 805) : 20,
      labelY: labelAxis + 5,
      textAnchor: appStore.isDesktopLayout ? (side === 'source' ? 'end' : 'start') : 'start',
      ariaLabel: `${node.sideLabel}: ${node.label} — ${node.valueLabel}`,
    }
  })
}

const sourceGeometry = computed(() => geometryFor(props.sources, 'source'))
const destinationGeometry = computed(() => geometryFor(props.destinations, 'destination'))
const accessibleNodes = computed(() => [...sourceGeometry.value, ...destinationGeometry.value])
</script>
