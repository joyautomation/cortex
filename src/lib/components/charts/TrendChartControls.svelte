<script lang="ts">
	import type { MetricInfo, TimeRange, TimeRangePreset } from './types';
	import { PRESET_LABELS, REALTIME_PRESETS } from './types';
	import { getMetricKey } from './utils';

	type Props = {
		availableMetrics: MetricInfo[];
		selectedMetrics: MetricInfo[];
		timeRange: TimeRange;
		samples: number;
		raw: boolean;
		showDataPoints: boolean;
		paused: boolean;
		onAddMetric: (metric: MetricInfo) => void;
	};

	let { availableMetrics, selectedMetrics, timeRange = $bindable(), samples = $bindable(), raw = $bindable(), showDataPoints = $bindable(), paused = $bindable(), onAddMetric }: Props = $props();

	// Sample presets
	const samplePresets = [50, 100, 200, 500, 1000];

	// Local state for date inputs
	let startDateStr = $state('');
	let endDateStr = $state('');

	// Sync dates when switching to historical mode
	$effect(() => {
		if (timeRange.mode === 'historical') {
			if (timeRange.start) {
				startDateStr = formatDateTimeLocal(timeRange.start);
			}
			if (timeRange.end) {
				endDateStr = formatDateTimeLocal(timeRange.end);
			}
		}
	});

	function formatDateTimeLocal(date: Date): string {
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	function handlePresetChange(e: Event) {
		const target = e.target as HTMLSelectElement;
		timeRange = { ...timeRange, preset: target.value as TimeRangePreset };
	}

	function handleStartChange(e: Event) {
		const target = e.target as HTMLInputElement;
		startDateStr = target.value;
		if (startDateStr) {
			timeRange = { ...timeRange, start: new Date(startDateStr) };
		}
	}

	function handleEndChange(e: Event) {
		const target = e.target as HTMLInputElement;
		endDateStr = target.value;
		if (endDateStr) {
			timeRange = { ...timeRange, end: new Date(endDateStr) };
		}
	}

	function handleMetricSelect(e: Event) {
		const target = e.target as HTMLSelectElement;
		const idx = parseInt(target.value);
		if (!isNaN(idx) && idx >= 0) {
			onAddMetric(availableMetrics[idx]);
		}
		target.value = '';
	}

	// Filter out already selected metrics
	let unselectedMetrics = $derived(
		availableMetrics.filter(
			(m) => !selectedMetrics.some((s) => getMetricKey(s) === getMetricKey(m))
		)
	);
</script>

<div class="controls">
	{#if timeRange.mode === 'realtime'}
		<div class="control-group control-group--range">
			<label class="control-label">Time Range</label>
			<select class="control-select" value={timeRange.preset} onchange={handlePresetChange}>
				{#each REALTIME_PRESETS as preset}
					<option value={preset}>{PRESET_LABELS[preset]}</option>
				{/each}
			</select>
		</div>
		<div class="control-group control-group--pause">
			<button
				class="pause-button"
				class:paused
				onclick={() => paused = !paused}
				title={paused ? 'Resume' : 'Pause'}
			>
				{#if paused}
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M8 5v14l11-7z"/>
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
					</svg>
				{/if}
			</button>
		</div>
	{:else}
		<div class="control-group control-group--start">
			<label class="control-label">Start</label>
			<input
				type="datetime-local"
				class="control-input"
				value={startDateStr}
				onchange={handleStartChange}
			/>
		</div>
		<div class="control-group control-group--end">
			<label class="control-label">End</label>
			<input
				type="datetime-local"
				class="control-input"
				value={endDateStr}
				onchange={handleEndChange}
			/>
		</div>
	{/if}

	<div class="control-group control-group--samples">
		<label class="control-label">Samples</label>
		<select class="control-select control-select--small" bind:value={samples}>
			{#each samplePresets as preset}
				<option value={preset}>{preset}</option>
			{/each}
		</select>
	</div>

	<div class="control-group metric-selector">
		<label class="control-label">Add Metric</label>
		<select class="control-select" onchange={handleMetricSelect}>
			<option value="">Select a metric...</option>
			{#each unselectedMetrics as metric, i}
				{@const originalIdx = availableMetrics.indexOf(metric)}
				<option value={originalIdx}>
					{metric.name} ({metric.deviceId || metric.nodeId})
				</option>
			{/each}
		</select>
	</div>

	{#if timeRange.mode === 'historical'}
		<div class="control-group control-group--raw">
			<label class="toggle-switch toggle-switch--small">
				<input
					type="checkbox"
					bind:checked={raw}
				/>
				<span class="toggle-switch__slider"></span>
				<span class="toggle-switch__label">Raw</span>
			</label>
		</div>
	{/if}

	<div class="control-group control-group--points">
		<label class="toggle-switch toggle-switch--small">
			<input
				type="checkbox"
				bind:checked={showDataPoints}
			/>
			<span class="toggle-switch__slider"></span>
			<span class="toggle-switch__label">Points</span>
		</label>
	</div>
</div>

<style lang="scss">
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: calc(var(--spacing-unit) * 2) calc(var(--spacing-unit) * 3);
		margin-bottom: calc(var(--spacing-unit) * 2);
		align-items: flex-end;
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: calc(var(--spacing-unit) * 1);
	}

	.control-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--theme-neutral-500);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.control-select,
	.control-input {
		height: 36px;
		padding: 0 calc(var(--spacing-unit) * 2);
		border: 1px solid var(--theme-neutral-300);
		border-radius: var(--rounded-md);
		background-color: var(--theme-neutral-100);
		color: var(--theme-text);
		font-size: 0.875rem;

		&:focus {
			outline: none;
			border-color: var(--theme-primary);
		}
	}

	.control-select--small {
		min-width: 80px;
	}

	.metric-selector {
		flex: 1;
	}

	.toggle-switch {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 2);
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--theme-text);
		user-select: none;
		height: 36px;

		input[type='checkbox'] {
			position: absolute;
			opacity: 0;
			width: 0;
			height: 0;
		}

		&:has(input:checked) .toggle-switch__slider {
			background-color: var(--theme-primary);

			&::before {
				transform: translateX(16px);
			}
		}
	}

	.toggle-switch__slider {
		position: relative;
		width: 36px;
		height: 20px;
		background-color: var(--theme-neutral-400);
		border-radius: 10px;
		transition: background-color 0.2s ease;
		flex-shrink: 0;

		&::before {
			content: '';
			position: absolute;
			top: 2px;
			left: 2px;
			width: 16px;
			height: 16px;
			background-color: white;
			border-radius: 50%;
			transition: transform 0.2s ease;
			box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
		}
	}

	.toggle-switch--small {
		// No extra padding needed - all elements now same height
	}

	.pause-button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border: 1px solid var(--theme-neutral-300);
		border-radius: var(--rounded-md);
		background-color: var(--theme-neutral-100);
		color: var(--theme-text);
		cursor: pointer;
		transition: all 0.15s ease;

		&:hover {
			background-color: var(--theme-neutral-200);
			border-color: var(--theme-neutral-400);
		}

		&.paused {
			background-color: var(--theme-primary);
			border-color: var(--theme-primary);
			color: white;

			&:hover {
				background-color: var(--theme-primary-600, var(--theme-primary));
			}
		}
	}

	/* Tablet and small desktop - 2 column grid for date inputs */
	@media (max-width: 900px) {
		.controls {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: calc(var(--spacing-unit) * 2);
			align-items: end;
		}

		.control-group {
			min-width: 0;
		}

		/* Date inputs side by side */
		.control-group--start {
			order: 1;
		}
		.control-group--end {
			order: 2;
		}

		/* Samples and Raw share a row */
		.control-group--samples {
			order: 3;
		}
		.control-group--raw {
			order: 4;
			justify-self: start;
		}

		/* Points toggle */
		.control-group--points {
			order: 5;
			justify-self: start;
		}

		/* Realtime controls */
		.control-group--range {
			order: 1;
		}
		.control-group--pause {
			order: 2;
			justify-self: start;
		}

		/* Metric selector full width at bottom */
		.metric-selector {
			order: 10;
			grid-column: 1 / -1;
		}

		.control-select,
		.control-input {
			width: 100%;
			min-width: 0;
		}

		.control-select--small {
			min-width: 0;
			width: 100%;
		}
	}

	/* Phone - single column stack */
	@media (max-width: 500px) {
		.controls {
			grid-template-columns: 1fr;
		}

		.control-group--start,
		.control-group--end,
		.control-group--samples,
		.control-group--raw,
		.control-group--points,
		.control-group--range,
		.control-group--pause {
			grid-column: 1 / -1;
		}
	}
</style>
