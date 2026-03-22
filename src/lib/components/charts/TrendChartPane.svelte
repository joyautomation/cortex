<script lang="ts">
	import { onMount } from 'svelte';
	import * as d3 from 'd3';
	import type { MetricInfo, ChartSeries, HistoryDataPoint, CrosshairValue } from './types';
	import { getMetricKey, formatValue, getCSSVariable } from './utils';
	import TrendChartLegend from './TrendChartLegend.svelte';
	import Spinner from '../Spinner.svelte';

	type Props = {
		paneId: string;
		title?: string;
		series: ChartSeries[];
		timeBounds: { start: Date; end: Date };
		showDataPoints: boolean;
		crosshairTimestamp: Date | null;
		height?: number;
		loading?: boolean;
		onRemoveMetric: (paneId: string, metric: MetricInfo) => void;
		onToggleVisibility: (paneId: string, metric: MetricInfo) => void;
		onColorChange: (paneId: string, metric: MetricInfo, color: string) => void;
		onTitleChange: (paneId: string, title: string) => void;
		onCrosshairMove: (timestamp: Date | null, screenX?: number) => void;
		onCrosshairValues: (paneId: string, values: CrosshairValue[]) => void;
		onRemovePane?: () => void;
	};

	let {
		paneId,
		title,
		series,
		timeBounds,
		showDataPoints,
		crosshairTimestamp,
		height = 250,
		loading = false,
		onRemoveMetric,
		onToggleVisibility,
		onColorChange,
		onTitleChange,
		onCrosshairMove,
		onCrosshairValues,
		onRemovePane
	}: Props = $props();

	// Editable title state
	let editingTitle = $state(false);
	let titleDraft = $state('');
	let titleInputRef: HTMLInputElement | undefined = $state();

	// DOM refs
	let containerRef: HTMLDivElement | undefined = $state();
	let svgRef: SVGSVGElement | undefined = $state();
	let containerWidth = $state(800);
	let mounted = $state(false);

	// Track if chart structure needs full rebuild
	let chartInitialized = $state(false);
	let lastSeriesKeys = $state<string>('');

	// Store scales
	let currentXScale: d3.ScaleTime<number, number> | null = null;
	let currentYScale: d3.ScaleLinear<number, number> | null = null;

	// Y-axis bounds for real-time mode
	let yBoundsMin: number | null = null;
	let yBoundsMax: number | null = null;

	// Track if mouse is hovering
	let isHovering = $state(false);

	// Track last reported crosshair timestamp to avoid reporting loops
	let lastReportedTimestamp: number | null = null;

	// Margins
	const margin = { top: 10, right: 30, bottom: 25, left: 60 };

	// Boolean strip constants
	const BOOLEAN_STRIP_HEIGHT = 20;
	const BOOLEAN_STRIP_GAP = 6;
	const BOOLEAN_AREA_PADDING = 24;

	// Maximum points
	const MAX_TOTAL_POINTS = 10000;

	// Derived: separate boolean and numeric series
	const isBooleanType = (type: string) => {
		const lowerType = type.toLowerCase();
		if (lowerType.startsWith('bool')) return true;
		if (type === '11') return true;
		return false;
	};

	let booleanSeries = $derived(series.filter((s) => isBooleanType(s.metric.type)));
	let numericSeries = $derived(series.filter((s) => !isBooleanType(s.metric.type)));

	let booleanAreaHeight = $derived(
		booleanSeries.length > 0
			? booleanSeries.length * BOOLEAN_STRIP_HEIGHT +
					(booleanSeries.length - 1) * BOOLEAN_STRIP_GAP +
					BOOLEAN_AREA_PADDING
			: 0
	);

	let totalPoints = $derived(series.reduce((sum, s) => sum + s.data.length, 0));
	let tooManyPoints = $derived(totalPoints > MAX_TOTAL_POINTS);
	let hasNoData = $derived(
		series.length > 0 && series.every((s) => s.data.length === 0) && !loading
	);
	let isEmpty = $derived(series.length === 0);

	// Check if chart structure changed
	function getSeriesKeys(): string {
		return (
			`${booleanAreaHeight}|` +
			series
				.map((s) => `${getMetricKey(s.metric)}:${s.visible}`)
				.sort()
				.join('|')
		);
	}

	// Initialize chart structure
	function initializeChart() {
		if (!svgRef || !mounted) return;

		const svg = d3.select(svgRef);
		svg.selectAll('*').remove();

		const width = containerWidth;
		const innerWidth = width - margin.left - margin.right;
		const chartBottom = margin.bottom + booleanAreaHeight;
		const innerHeight = height - margin.top - chartBottom;

		if (innerWidth <= 0 || innerHeight <= 0) return;

		const visibleSeries = series.filter((s) => s.visible);
		const visibleNumericSeries = numericSeries.filter((s) => s.visible);
		const visibleBooleanSeries = booleanSeries.filter((s) => s.visible);
		const allNumericPoints = visibleNumericSeries.flatMap((s) => s.data);

		if (allNumericPoints.length === 0 && visibleBooleanSeries.length === 0) {
			currentXScale = null;
			currentYScale = null;
			chartInitialized = false;
			return;
		}

		// Clip paths
		svg
			.append('defs')
			.append('clipPath')
			.attr('id', `chart-clip-${paneId}`)
			.append('rect')
			.attr('x', margin.left)
			.attr('y', margin.top)
			.attr('width', innerWidth)
			.attr('height', innerHeight);

		svg
			.select('defs')
			.append('clipPath')
			.attr('id', `boolean-clip-${paneId}`)
			.append('rect')
			.attr('x', margin.left)
			.attr('y', height - margin.bottom - booleanAreaHeight)
			.attr('width', innerWidth)
			.attr('height', booleanAreaHeight);

		// Grid group
		svg.append('g').attr('class', 'grid').attr('transform', `translate(${margin.left},0)`);

		// X Axis group
		svg
			.append('g')
			.attr('class', 'x-axis')
			.attr('transform', `translate(0,${height - chartBottom})`);

		// Y Axis group
		svg.append('g').attr('class', 'y-axis').attr('transform', `translate(${margin.left},0)`);

		// Lines group
		const linesGroup = svg
			.append('g')
			.attr('class', 'lines-group')
			.attr('clip-path', `url(#chart-clip-${paneId})`);

		// Create path for each numeric series
		visibleNumericSeries.forEach((s) => {
			const safeKey = getMetricKey(s.metric).replace(/[^a-zA-Z0-9]/g, '-');
			linesGroup
				.append('path')
				.attr('class', `line line-${safeKey}`)
				.attr('fill', 'none')
				.attr('stroke', s.color)
				.attr('stroke-width', 2);
		});

		// Boolean strips group
		svg.append('g').attr('class', 'boolean-strips-group');

		// Data points group
		svg.append('g').attr('class', 'points-group').attr('clip-path', `url(#chart-clip-${paneId})`);

		// Highlight group
		svg
			.append('g')
			.attr('class', 'highlight-group')
			.attr('clip-path', `url(#chart-clip-${paneId})`);

		// Crosshair line
		svg
			.append('line')
			.attr('class', 'crosshair-line')
			.attr('stroke', getCSSVariable('--theme-neutral-500') || '#888')
			.attr('stroke-width', 1)
			.attr('stroke-dasharray', '3,3')
			.attr('x1', margin.left)
			.attr('x2', margin.left)
			.attr('y1', margin.top)
			.attr('y2', height - margin.bottom)
			.style('display', 'none');

		// Overlay for mouse events
		svg
			.append('rect')
			.attr('class', 'overlay')
			.attr('fill', 'none')
			.attr('pointer-events', 'all')
			.attr('x', margin.left)
			.attr('y', margin.top)
			.attr('width', innerWidth)
			.attr('height', innerHeight + booleanAreaHeight);

		chartInitialized = true;
		lastSeriesKeys = getSeriesKeys();

		updateChart();
	}

	// Update chart with transitions
	function updateChart() {
		if (!svgRef || !mounted || !chartInitialized) return;
		if (tooManyPoints) return;

		const svg = d3.select(svgRef);
		const width = containerWidth;
		const innerWidth = width - margin.left - margin.right;
		const chartBottom = margin.bottom + booleanAreaHeight;
		const innerHeight = height - margin.top - chartBottom;

		if (innerWidth <= 0 || innerHeight <= 0) return;

		const visibleNumericSeries = numericSeries.filter((s) => s.visible);
		const visibleBooleanSeries = booleanSeries.filter((s) => s.visible);
		const allNumericPoints = visibleNumericSeries.flatMap((s) => s.data);

		if (allNumericPoints.length === 0 && visibleBooleanSeries.length === 0) return;

		// X scale from shared time bounds
		const xScale = d3
			.scaleTime()
			.domain([timeBounds.start, timeBounds.end])
			.range([margin.left, width - margin.right]);

		// Y scale for this pane's data
		let yScale: d3.ScaleLinear<number, number>;
		if (allNumericPoints.length > 0) {
			const yExtent = d3.extent(allNumericPoints, (d) => d.value) as [number, number];
			const yPadding = (yExtent[1] - yExtent[0]) * 0.1 || 1;
			const dataMin = yExtent[0] - yPadding;
			const dataMax = yExtent[1] + yPadding;

			// Expand bounds only (don't shrink) to prevent pulsing
			let yMin = yBoundsMin === null ? dataMin : Math.min(yBoundsMin, dataMin);
			let yMax = yBoundsMax === null ? dataMax : Math.max(yBoundsMax, dataMax);
			yBoundsMin = yMin;
			yBoundsMax = yMax;

			yScale = d3
				.scaleLinear()
				.domain([yMin, yMax])
				.range([height - chartBottom, margin.top]);
		} else {
			yScale = d3
				.scaleLinear()
				.domain([0, 1])
				.range([height - chartBottom, margin.top]);
		}

		currentXScale = xScale;
		currentYScale = yScale;

		const transitionDuration = 300;
		const t = svg.transition().duration(transitionDuration).ease(d3.easeLinear);

		// Detect theme from body class for proper contrast
		const isDarkMode =
			document.body.classList.contains('themeDark') ||
			(document.body.classList.contains('themeSystem') &&
				window.matchMedia('(prefers-color-scheme: dark)').matches);

		// Update grid - use theme-aware color
		const gridColor = isDarkMode ? '#374151' : '#d1d5db'; // neutral-700 for dark, neutral-300 for light
		svg
			.select<SVGGElement>('.grid')
			.transition(t as any)
			.call(
				d3
					.axisLeft(yScale)
					.tickSize(-innerWidth)
					.tickFormat(() => '') as any
			)
			.call((g) => g.select('.domain').remove())
			.call((g) => g.selectAll('.tick line').attr('stroke', gridColor).attr('stroke-opacity', 0.5));
		const textColor = isDarkMode ? '#e5e7eb' : '#374151'; // neutral-200 for dark, neutral-700 for light
		const axisColor = isDarkMode ? '#6b7280' : '#6b7280'; // neutral-500 for both modes

		const xAxis = d3.axisBottom(xScale).ticks(6);
		svg
			.select<SVGGElement>('.x-axis')
			.transition(t as any)
			.call(xAxis as any)
			.call((g) => g.select('.domain').attr('stroke', axisColor))
			.call((g) => g.selectAll('.tick line').attr('stroke', axisColor))
			.call((g) =>
				g
					.selectAll('.tick text')
					.attr('fill', textColor)
					.attr('font-size', '11px')
					.attr('font-weight', '500')
			);

		const yAxis = d3.axisLeft(yScale).ticks(4).tickFormat(d3.format('.2f'));
		svg
			.select<SVGGElement>('.y-axis')
			.transition(t as any)
			.call(yAxis as any)
			.call((g) => g.select('.domain').attr('stroke', axisColor))
			.call((g) => g.selectAll('.tick line').attr('stroke', axisColor))
			.call((g) =>
				g
					.selectAll('.tick text')
					.attr('fill', textColor)
					.attr('font-size', '11px')
					.attr('font-weight', '500')
			);

		// Update lines - connect all points (no gap detection)
		visibleNumericSeries.forEach((s) => {
			const safeKey = getMetricKey(s.metric).replace(/[^a-zA-Z0-9]/g, '-');
			const data = s.data;

			const lineGenerator = d3
				.line<HistoryDataPoint>()
				.x((d) => xScale(d.timestamp))
				.y((d) => yScale(d.value))
				.curve(d3.curveMonotoneX);

			svg.select(`.line-${safeKey}`).datum(data).attr('d', lineGenerator).attr('stroke', s.color);
		});

		// Update boolean strips
		const booleanStripsGroup = svg.select('.boolean-strips-group');
		const neutralColor = getCSSVariable('--theme-neutral-700') || '#374151';
		const booleanStripY = height - chartBottom + BOOLEAN_AREA_PADDING;

		booleanStripsGroup.selectAll('*').remove();

		visibleBooleanSeries.forEach((s, index) => {
			const stripY = booleanStripY + index * (BOOLEAN_STRIP_HEIGHT + BOOLEAN_STRIP_GAP);
			const data = s.data;

			if (data.length === 0) return;

			type Segment = { startTime: Date; endTime: Date; isTrue: boolean };
			const segments: Segment[] = [];

			for (let i = 0; i < data.length; i++) {
				const point = data[i];
				const nextPoint = data[i + 1];
				const isTrue = point.value === 1 || point.value > 0;
				const startTime = i === 0 ? timeBounds.start : point.timestamp;
				const endTime = nextPoint ? nextPoint.timestamp : timeBounds.end;

				const lastSegment = segments[segments.length - 1];
				if (lastSegment && lastSegment.isTrue === isTrue) {
					lastSegment.endTime = endTime;
				} else {
					segments.push({ startTime, endTime, isTrue });
				}
			}

			for (const segment of segments) {
				const x1 = xScale(segment.startTime);
				const x2 = xScale(segment.endTime);
				if (x2 < margin.left || x1 > width - margin.right) continue;

				const clampedX1 = Math.max(x1, margin.left);
				const clampedX2 = Math.min(x2, width - margin.right);
				const rectWidth = clampedX2 - clampedX1;

				if (rectWidth > 0) {
					booleanStripsGroup
						.append('rect')
						.attr('x', clampedX1)
						.attr('y', stripY)
						.attr('width', rectWidth)
						.attr('height', BOOLEAN_STRIP_HEIGHT)
						.attr('fill', segment.isTrue ? s.color : neutralColor)
						.attr('stroke', s.color)
						.attr('stroke-width', 1.5)
						.attr('opacity', segment.isTrue ? 1 : 0.5);
				}
			}

			booleanStripsGroup
				.append('text')
				.attr('x', margin.left + 6)
				.attr('y', stripY + BOOLEAN_STRIP_HEIGHT / 2)
				.attr('text-anchor', 'start')
				.attr('dominant-baseline', 'middle')
				.attr('fill', 'white')
				.attr('font-size', '10px')
				.attr('font-weight', '500')
				.text(s.metric.name);
		});

		// Update data points
		const pointsGroup = svg.select('.points-group');

		if (showDataPoints) {
			visibleNumericSeries.forEach((s) => {
				const safeKey = getMetricKey(s.metric).replace(/[^a-zA-Z0-9]/g, '-');
				const points = pointsGroup
					.selectAll<SVGCircleElement, HistoryDataPoint>(`.point-${safeKey}`)
					.data(s.data, (d: HistoryDataPoint) => d.timestamp.getTime().toString());

				points
					.enter()
					.append('circle')
					.attr('class', `data-point point-${safeKey}`)
					.attr('cx', (d) => xScale(d.timestamp))
					.attr('cy', (d) => yScale(d.value))
					.attr('r', 3)
					.attr('fill', 'white')
					.attr('stroke', s.color)
					.attr('stroke-width', 1.5);

				points
					.transition(t as any)
					.attr('cx', (d) => xScale(d.timestamp))
					.attr('cy', (d) => yScale(d.value))
					.attr('stroke', s.color);

				points.exit().remove();
			});
		} else {
			pointsGroup.selectAll('.data-point').remove();
		}

		// Mouse events
		const bisect = d3.bisector<HistoryDataPoint, Date>((d) => d.timestamp);
		const highlightGroup = svg.select('.highlight-group');
		const crosshairLine = svg.select('.crosshair-line');

		svg
			.select('.overlay')
			.on('mouseenter', () => {
				isHovering = true;
				// Reset tracking when we start hovering (this pane takes over)
				lastReportedTimestamp = null;
			})
			.on('mousemove', (event) => {
				isHovering = true;
				const [mx] = d3.pointer(event);
				const timestamp = xScale.invert(mx);
				const screenX = xScale(timestamp);

				// Report timestamp and screen position to parent (so other panes show crosshair)
				onCrosshairMove(timestamp, screenX);

				// Calculate and draw highlights
				const values = getCrosshairValues(
					timestamp,
					yScale,
					bisect,
					visibleNumericSeries,
					visibleBooleanSeries,
					booleanStripY
				);
				drawCrosshairHighlights(screenX, values);

				// Report values to parent (for tooltip)
				onCrosshairValues(paneId, values);
			})
			.on('mouseleave', () => {
				isHovering = false;
				lastReportedTimestamp = null;
				onCrosshairMove(null);
				onCrosshairValues(paneId, []);
				crosshairLine.style('display', 'none');
				highlightGroup.selectAll('circle').remove();
			});

		// Update crosshair from parent timestamp (when hovering on another pane)
		if (crosshairTimestamp && currentXScale && !isHovering) {
			const screenX = currentXScale(crosshairTimestamp);
			const timestampMs = crosshairTimestamp.getTime();
			if (screenX >= margin.left && screenX <= width - margin.right) {
				const values = getCrosshairValues(
					crosshairTimestamp,
					yScale,
					bisect,
					visibleNumericSeries,
					visibleBooleanSeries,
					booleanStripY
				);
				drawCrosshairHighlights(screenX, values);

				// Report values to parent for tooltip, but only once per timestamp
				// to avoid reactive loops
				if (lastReportedTimestamp !== timestampMs) {
					lastReportedTimestamp = timestampMs;
					onCrosshairValues(paneId, values);
				}
			} else {
				crosshairLine.style('display', 'none');
				highlightGroup.selectAll('circle').remove();
				if (lastReportedTimestamp !== null) {
					lastReportedTimestamp = null;
					onCrosshairValues(paneId, []);
				}
			}
		} else if (!isHovering && !crosshairTimestamp) {
			crosshairLine.style('display', 'none');
			highlightGroup.selectAll('circle').remove();
			if (lastReportedTimestamp !== null) {
				lastReportedTimestamp = null;
				onCrosshairValues(paneId, []);
			}
		}
	}

	// Calculate crosshair values for a given timestamp
	function getCrosshairValues(
		timestamp: Date,
		yScale: d3.ScaleLinear<number, number>,
		bisect: d3.Bisector<HistoryDataPoint, Date>,
		visibleNumericSeries: ChartSeries[],
		visibleBooleanSeries: ChartSeries[],
		booleanStripY: number
	): CrosshairValue[] {
		const values: CrosshairValue[] = [];

		// Numeric series
		visibleNumericSeries.forEach((s) => {
			if (s.data.length === 0) return;
			const i = bisect.left(s.data, timestamp);
			const d0 = s.data[i - 1];
			const d1 = s.data[i];
			if (!d0 && !d1) return;
			const d = !d0
				? d1
				: !d1
					? d0
					: timestamp.getTime() - d0.timestamp.getTime() >
						  d1.timestamp.getTime() - timestamp.getTime()
						? d1
						: d0;

			const screenY = yScale(d.value);
			values.push({
				paneId,
				metric: s.metric,
				value: d.value,
				color: s.color,
				screenY
			});
		});

		// Boolean series
		visibleBooleanSeries.forEach((s, index) => {
			if (s.data.length === 0) return;
			const i = bisect.left(s.data, timestamp);
			const d0 = s.data[i - 1];
			const d1 = s.data[i];
			if (!d0 && !d1) return;
			const d = !d0
				? d1
				: !d1
					? d0
					: timestamp.getTime() - d0.timestamp.getTime() >
						  d1.timestamp.getTime() - timestamp.getTime()
						? d1
						: d0;

			const screenY =
				booleanStripY +
				index * (BOOLEAN_STRIP_HEIGHT + BOOLEAN_STRIP_GAP) +
				BOOLEAN_STRIP_HEIGHT / 2;
			values.push({
				paneId,
				metric: s.metric,
				value: d.value,
				color: s.color,
				screenY
			});
		});

		return values;
	}

	// Draw crosshair highlights (visual only, no callback)
	function drawCrosshairHighlights(screenX: number, values: CrosshairValue[]) {
		if (!svgRef) return;

		const svg = d3.select(svgRef);
		const highlightGroup = svg.select('.highlight-group');
		const crosshairLine = svg.select('.crosshair-line');

		crosshairLine.attr('x1', screenX).attr('x2', screenX).style('display', null);

		// Update highlights (only for numeric)
		highlightGroup.selectAll('circle').remove();
		values
			.filter((v) => !isBooleanType(v.metric.type))
			.forEach((v) => {
				highlightGroup
					.append('circle')
					.attr('cx', screenX)
					.attr('cy', v.screenY)
					.attr('r', 5)
					.attr('fill', v.color)
					.attr('stroke', 'white')
					.attr('stroke-width', 2)
					.style('filter', 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))');
			});
	}

	// Main render function
	function renderChart() {
		if (!svgRef || !mounted) return;

		const currentKeys = getSeriesKeys();
		const structureChanged = currentKeys !== lastSeriesKeys || !chartInitialized;

		if (structureChanged) {
			initializeChart();
		} else {
			updateChart();
		}
	}

	function startTitleEdit() {
		titleDraft = title || '';
		editingTitle = true;
		// Focus the input after Svelte renders it
		requestAnimationFrame(() => titleInputRef?.select());
	}

	function saveTitleEdit() {
		editingTitle = false;
		const trimmed = titleDraft.trim();
		if (trimmed && trimmed !== title) {
			onTitleChange(paneId, trimmed);
		}
	}

	function cancelTitleEdit() {
		editingTitle = false;
	}

	// Reset Y bounds when series changes
	function resetYBounds() {
		yBoundsMin = null;
		yBoundsMax = null;
	}

	// Lifecycle
	onMount(() => {
		mounted = true;

		if (containerRef) {
			const observer = new ResizeObserver((entries) => {
				containerWidth = entries[0].contentRect.width;
				chartInitialized = false;
			});
			observer.observe(containerRef);
			return () => observer.disconnect();
		}
	});

	// Effects
	$effect(() => {
		if (!mounted) return;
		const _ = [series, containerWidth, height, showDataPoints, booleanAreaHeight, loading];
		renderChart();
	});

	$effect(() => {
		if (!mounted || !chartInitialized) return;
		const _ = [timeBounds, crosshairTimestamp];
		updateChart();
	});

	// Reset Y bounds when series changes
	$effect(() => {
		const _ = series.map((s) => getMetricKey(s.metric)).join(',');
		resetYBounds();
	});
</script>

<div class="pane">
	<div class="pane-header">
		<div class="pane-title-wrapper">
			{#if editingTitle}
				<input
					bind:this={titleInputRef}
					class="pane-title-input"
					type="text"
					bind:value={titleDraft}
					onblur={saveTitleEdit}
					onkeydown={(e) => {
						if (e.key === 'Enter') saveTitleEdit();
						if (e.key === 'Escape') cancelTitleEdit();
					}}
				/>
			{:else}
				<button class="pane-title-btn" onclick={startTitleEdit} title="Rename pane">
					<span class="pane-title-text">{title}</span>
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
				</button>
			{/if}
		</div>
		{#if onRemovePane}
			<button
				type="button"
				class="remove-pane-btn"
				onclick={onRemovePane}
				title="Remove pane"
				aria-label="Remove pane"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
		{/if}
	</div>

	<div class="chart-area" bind:this={containerRef}>
		<svg bind:this={svgRef} width={containerWidth} {height}></svg>
		{#if loading && series.length > 0 && series.every((s) => s.data.length === 0)}
			<div class="chart-empty-overlay">
				<Spinner size={24} color="var(--theme-neutral-400)" />
			</div>
		{:else if isEmpty || hasNoData}
			<div class="chart-empty-overlay">
				<span class="chart-empty-text">{isEmpty ? 'Add metrics to this pane' : 'No data available'}</span>
			</div>
		{/if}
	</div>

	{#if series.length > 0}
		<TrendChartLegend
			{series}
			onToggleVisibility={(metric) => onToggleVisibility(paneId, metric)}
			onRemoveMetric={(metric) => onRemoveMetric(paneId, metric)}
			onColorChange={(metric, color) => onColorChange(paneId, metric, color)}
		/>
	{/if}

	{#if tooManyPoints}
		<div class="pane-warning">
			Too many points ({totalPoints.toLocaleString()}). Reduce time range or samples.
		</div>
	{/if}
</div>

<style lang="scss">
	.pane {
		border: 1px solid var(--theme-neutral-300);
		border-radius: var(--rounded-md);
		background-color: var(--theme-neutral-50);
	}

	.pane-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 1.5) calc(var(--spacing-unit) * 2);
		border-bottom: 1px solid var(--theme-neutral-200);
		background-color: var(--theme-neutral-100);
		border-radius: var(--rounded-md) var(--rounded-md) 0 0;
	}

	.pane-title-wrapper {
		flex: 1;
		min-width: 0;
	}

	.pane-title-btn {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 1.5);
		min-height: 44px;
		padding: calc(var(--spacing-unit) * 1) calc(var(--spacing-unit) * 1.5);
		border: 1px solid transparent;
		border-radius: var(--rounded-sm);
		background: transparent;
		color: var(--theme-text);
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background-color 0.15s ease;

		svg {
			color: var(--theme-neutral-400);
			flex-shrink: 0;
		}

		&:hover {
			border-color: var(--theme-neutral-300);
			background-color: var(--theme-neutral-200);

			svg {
				color: var(--theme-neutral-600);
			}
		}
	}

	.pane-title-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pane-title-input {
		width: 100%;
		min-height: 44px;
		padding: calc(var(--spacing-unit) * 0.5) calc(var(--spacing-unit) * 1.5);
		border: 1px solid var(--theme-primary);
		border-radius: var(--rounded-sm);
		background-color: var(--theme-neutral-50);
		color: var(--theme-text);
		font-size: 0.875rem;
		font-weight: 600;
		font-family: inherit;

		&:focus {
			outline: none;
		}
	}

	.remove-pane-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		padding: calc(var(--spacing-unit) * 1);
		border: none;
		border-radius: var(--rounded-sm);
		background: transparent;
		color: var(--theme-neutral-400);
		cursor: pointer;
		transition:
			color 0.15s ease,
			background-color 0.15s ease;

		&:hover {
			color: var(--theme-rose-600);
			background-color: var(--theme-rose-100);
		}
	}

	.chart-area {
		position: relative;
		width: 100%;
		background-color: var(--theme-neutral-100);
	}

	.chart-empty-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}

	.chart-empty-text {
		color: var(--theme-neutral-500);
		font-size: 0.875rem;
	}

	.pane-warning {
		padding: calc(var(--spacing-unit) * 1.5) calc(var(--spacing-unit) * 2);
		background-color: var(--theme-warning-100, #fef3c7);
		color: var(--theme-warning-700, #b45309);
		font-size: 0.75rem;
	}

	:global(.pane .grid .domain) {
		display: none !important;
	}

	:global(.pane .crosshair-line) {
		pointer-events: none;
	}
</style>
