<script lang="ts">
	import type { ChartSeries, MetricInfo } from './types';
	import { formatValue } from './utils';

	type Props = {
		series: ChartSeries[];
		onToggleVisibility: (metric: MetricInfo) => void;
		onRemoveMetric: (metric: MetricInfo) => void;
		onColorChange?: (metric: MetricInfo, color: string) => void;
	};

	let { series, onToggleVisibility, onRemoveMetric, onColorChange }: Props = $props();

	function handleColorChange(metric: MetricInfo, event: Event) {
		const input = event.target as HTMLInputElement;
		if (onColorChange) {
			onColorChange(metric, input.value);
		}
	}

	// Convert CSS variable color to hex for color input
	function cssColorToHex(color: string): string {
		if (color.startsWith('#')) return color;
		if (color.startsWith('rgb')) {
			const match = color.match(/\d+/g);
			if (match && match.length >= 3) {
				const r = parseInt(match[0]).toString(16).padStart(2, '0');
				const g = parseInt(match[1]).toString(16).padStart(2, '0');
				const b = parseInt(match[2]).toString(16).padStart(2, '0');
				return `#${r}${g}${b}`;
			}
		}
		return '#14b8a6';
	}

	function getCurrentValue(s: ChartSeries): string | null {
		if (s.data.length === 0) return null;
		return formatValue(s.data[s.data.length - 1].value);
	}
</script>

<div class="legend">
	{#each series as s}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="legend-row" class:legend-row--hidden={!s.visible} onclick={() => onToggleVisibility(s.metric)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleVisibility(s.metric); }}} role="button" tabindex="0" title="{s.metric.name} ({s.metric.deviceId || s.metric.nodeId}) — click to {s.visible ? 'hide' : 'show'}">
			<input
				type="color"
				class="legend-color"
				value={cssColorToHex(s.color)}
				onchange={(e) => handleColorChange(s.metric, e)}
				oninput={(e) => handleColorChange(s.metric, e)}
				onclick={(e) => e.stopPropagation()}
				title="Change color"
			/>
			<div class="legend-info">
				<span class="legend-name">{s.metric.name}</span>
				<span class="legend-source">{s.metric.deviceId || s.metric.nodeId}</span>
			</div>
			<span class="legend-value" style:color={s.visible ? s.color : undefined}>
				{getCurrentValue(s) ?? '—'}
			</span>
			<button
				class="legend-remove"
				onclick={(e) => { e.stopPropagation(); onRemoveMetric(s.metric); }}
				title="Remove"
				aria-label="Remove metric"
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
		</div>
	{/each}
</div>

<style lang="scss">
	.legend {
		display: flex;
		flex-direction: column;
		max-height: 200px;
		overflow-y: auto;
		overflow-x: hidden;
		background-color: var(--theme-neutral-100);

		// Custom scrollbar
		scrollbar-width: thin;
		scrollbar-color: var(--theme-neutral-400) transparent;

		&::-webkit-scrollbar {
			width: 6px;
		}

		&::-webkit-scrollbar-track {
			background: transparent;
		}

		&::-webkit-scrollbar-thumb {
			background-color: var(--theme-neutral-400);
			border-radius: 3px;

			&:hover {
				background-color: var(--theme-neutral-500);
			}
		}
	}

	.legend-row {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 1.5) calc(var(--spacing-unit) * 2);
		font-size: 0.75rem;
		transition: opacity 0.2s ease;
		border: none;
		box-sizing: border-box;
		background: transparent;
		cursor: pointer;
		text-align: left;

		&:hover {
			background-color: var(--theme-neutral-200);
		}

		&--hidden {
			opacity: 0.5;

			.legend-color {
				opacity: 0.3;
			}
		}
	}

	.legend-color {
		width: 14px;
		height: 14px;
		padding: 0;
		border: none;
		border-radius: 2px;
		cursor: pointer;
		flex-shrink: 0;
		background: transparent;

		&::-webkit-color-swatch-wrapper {
			padding: 0;
		}

		&::-webkit-color-swatch {
			border: 1px solid var(--theme-neutral-400);
			border-radius: 2px;
		}

		&::-moz-color-swatch {
			border: 1px solid var(--theme-neutral-400);
			border-radius: 2px;
		}

		&:hover {
			transform: scale(1.2);
		}
	}

	.legend-info {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.legend-name {
		color: var(--theme-text);
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		line-height: 1.3;
	}

	.legend-source {
		color: var(--theme-neutral-500);
		font-size: 0.6875rem;
		line-height: 1.2;
	}

	.legend-value {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		text-align: right;
	}

	@media (max-width: 400px) {
		.legend-row {
			font-size: 0.625rem;
		}

		.legend-source {
			font-size: 0.5625rem;
		}
	}

	.legend-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--theme-neutral-400);
		cursor: pointer;
		border-radius: 2px;
		flex-shrink: 0;
		position: relative;
		transition: color 0.15s ease, background-color 0.15s ease;

		// Expand touch target to 44x44 without affecting layout
		&::after {
			content: '';
			position: absolute;
			inset: -14px;
		}

		&:hover {
			color: var(--theme-error-600);
			background-color: var(--theme-error-100);
		}
	}
</style>
