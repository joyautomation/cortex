<script lang="ts">
	import { onMount } from 'svelte';
	import * as d3 from 'd3';
	import type {
		MetricInfo,
		ChartSeries,
		TimeRange,
		TimeRangePreset,
		TooltipData,
		TooltipValue,
		HistoryDataPoint
	} from './types';
	import { PRESET_DURATIONS } from './types';
	import { createColorScale, getMetricKey, formatValue, formatTimestamp, getCSSVariable } from './utils';
	import TrendChartControls from './TrendChartControls.svelte';
	import TrendChartLegend from './TrendChartLegend.svelte';
	import TrendChartTooltip from './TrendChartTooltip.svelte';

	type Props = {
		spaceId: string;
		availableMetrics: MetricInfo[];
		chartId?: string;
		title?: string;
		height?: number;
		onRemove?: () => void;
	};

	let { spaceId, availableMetrics, chartId = 'default', title = 'Trend Chart', height = 350, onRemove }: Props = $props();

	// State
	let selectedMetrics = $state<MetricInfo[]>([]);
	let timeRange = $state<TimeRange>({ mode: 'realtime', preset: '15m' });
	let samples = $state(200);
	let raw = $state(false);
	let showDataPoints = $state(false);
	let paused = $state(false);
	let series = $state<ChartSeries[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let tooltipData = $state<TooltipData | null>(null);
	let customColors = $state<Record<string, string>>({});

	// DOM refs
	let containerRef: HTMLDivElement | undefined = $state();
	let svgRef: SVGSVGElement | undefined = $state();
	let containerWidth = $state(800);
	let mounted = $state(false);

	// Real-time tick for updating time bounds (updates every second in real-time mode)
	let realtimeTick = $state(Date.now());

	// Track if chart structure needs full rebuild vs just update
	let chartInitialized = $state(false);
	let lastSeriesKeys = $state<string>('');

	// Store scales for use in effects
	let currentXScale: d3.ScaleTime<number, number> | null = null;
	let currentYScale: d3.ScaleLinear<number, number> | null = null;

	// Track Y-axis bounds to prevent constant rescaling in real-time mode
	// Using non-reactive variables so they persist across effect re-runs
	let yBoundsMin: number | null = null;
	let yBoundsMax: number | null = null;

	// Track previous mode to detect mode changes
	let previousMode: 'realtime' | 'historical' = timeRange.mode;

	// Track if mouse is actively hovering (for restore logic)
	let isHovering = $state(false);

	// Margins
	const margin = { top: 20, right: 30, bottom: 30, left: 60 };

	// LocalStorage key for persisting settings
	const STORAGE_KEY = `trendchart-settings-${spaceId}-${chartId}`;

	// Settings type for localStorage
	type ChartSettings = {
		selectedMetrics: MetricInfo[];
		timeRange: TimeRange;
		samples: number;
		raw: boolean;
		showDataPoints: boolean;
		customColors: Record<string, string>;
	};

	// Load settings from localStorage
	function loadSettings(): Partial<ChartSettings> | null {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return null;
			const parsed = JSON.parse(stored);
			// Convert date strings back to Date objects for historical mode
			if (parsed.timeRange?.start) parsed.timeRange.start = new Date(parsed.timeRange.start);
			if (parsed.timeRange?.end) parsed.timeRange.end = new Date(parsed.timeRange.end);
			return parsed;
		} catch {
			return null;
		}
	}

	// Save settings to localStorage
	function saveSettings() {
		try {
			const settings: ChartSettings = {
				selectedMetrics,
				timeRange,
				samples,
				raw,
				showDataPoints,
				customColors
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch {
			// Ignore storage errors
		}
	}

	// Transition duration in ms
	const transitionDuration = 300;

	// Maximum total points to render (prevents browser lockup)
	const MAX_TOTAL_POINTS = 10000;

	// Derived: color scale (used as fallback for metrics without custom colors)
	let colorScale = $derived(createColorScale(selectedMetrics));

	// Get color for a metric, using custom color if set, otherwise falling back to scale
	function getMetricColor(metricKey: string): string {
		return customColors[metricKey] || colorScale(metricKey);
	}

	// Update color for a metric
	function setMetricColor(metric: MetricInfo, color: string) {
		const key = getMetricKey(metric);
		customColors = { ...customColors, [key]: color };
		// Directly update the series color to avoid effect loops
		series = series.map((s) => {
			if (getMetricKey(s.metric) === key) {
				return { ...s, color };
			}
			return s;
		});
	}

	// Derived: separate boolean and numeric series
	// Check for various boolean type names (Boolean, Bool, boolean, bool) and Sparkplug datatype 11
	const isBooleanType = (type: string) => {
		const lowerType = type.toLowerCase();
		// String type names
		if (lowerType.startsWith('bool')) return true;
		// Sparkplug B datatype code 11 = Boolean
		if (type === '11') return true;
		return false;
	};

	let booleanSeries = $derived(series.filter((s) => isBooleanType(s.metric.type)));
	let numericSeries = $derived(series.filter((s) => !isBooleanType(s.metric.type)));

	// Height for boolean strips (each strip is 20px with 6px gap)
	const BOOLEAN_STRIP_HEIGHT = 20;
	const BOOLEAN_STRIP_GAP = 6;
	const BOOLEAN_AREA_PADDING = 24; // Padding above strips to separate from x-axis labels
	let booleanAreaHeight = $derived(
		booleanSeries.length > 0
			? booleanSeries.length * BOOLEAN_STRIP_HEIGHT + (booleanSeries.length - 1) * BOOLEAN_STRIP_GAP + BOOLEAN_AREA_PADDING
			: 0
	);

	// Derived: total point count and too many points flag
	let totalPoints = $derived(series.reduce((sum, s) => sum + s.data.length, 0));
	let tooManyPoints = $derived(totalPoints > MAX_TOTAL_POINTS);

	// Derived: time bounds (depends on realtimeTick in real-time mode)
	let timeBounds = $derived.by(() => {
		if (timeRange.mode === 'historical' && timeRange.start && timeRange.end) {
			return { start: timeRange.start, end: timeRange.end };
		}
		// Use realtimeTick to ensure this recalculates periodically
		const now = new Date(realtimeTick);
		const preset = timeRange.preset || '15m';
		const start = new Date(now.getTime() - PRESET_DURATIONS[preset]);
		return { start, end: now };
	});

	// Compute fetch time bounds (separate from render timeBounds to avoid fetching every second)
	function getFetchTimeBounds() {
		if (timeRange.mode === 'historical' && timeRange.start && timeRange.end) {
			return { start: timeRange.start, end: timeRange.end };
		}
		const now = new Date();
		const preset = timeRange.preset || '15m';
		const start = new Date(now.getTime() - PRESET_DURATIONS[preset]);
		return { start, end: now };
	}

	// Fetch history data
	async function fetchHistory() {
		if (selectedMetrics.length === 0) {
			series = [];
			return;
		}

		loading = true;
		error = null;

		// Use separate time bounds calculation to avoid depending on realtimeTick
		const fetchBounds = getFetchTimeBounds();

		try {
			const response = await fetch(`/api/space/${spaceId}/history`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					start: fetchBounds.start.toISOString(),
					end: fetchBounds.end.toISOString(),
					metrics: selectedMetrics.map((m) => ({
						groupId: m.groupId,
						nodeId: m.nodeId,
						deviceId: m.deviceId,
						metricId: m.metricId
					})),
					samples,
					raw
				})
			});

			if (!response.ok) {
				const err = await response.json();
				throw new Error(err.error || 'Failed to fetch history');
			}

			const data = await response.json();
			const historyData = data.history || [];

			// Transform to ChartSeries, preserving visibility state
			series = selectedMetrics.map((metric) => {
				const key = getMetricKey(metric);
				const existingSeries = series.find((s) => getMetricKey(s.metric) === key);
				// Try exact match first, then fallback to just metricId match
				let historyItem = historyData.find(
					(h: { groupId: string; nodeId: string; deviceId: string; metricId: string }) =>
						h.groupId === metric.groupId &&
						h.nodeId === metric.nodeId &&
						h.deviceId === metric.deviceId &&
						h.metricId === metric.metricId
				);
				// Fallback: match by metricId only (in case other fields differ slightly)
				if (!historyItem) {
					historyItem = historyData.find(
						(h: { metricId: string }) => h.metricId === metric.metricId
					);
				}

				const points: HistoryDataPoint[] = (historyItem?.history || [])
					.map((p: { value: string; timestamp: string }) => {
						// Handle boolean string values ("true"/"false") and numeric values
						let value: number;
						const lowerValue = p.value.toLowerCase();
						if (lowerValue === 'true') {
							value = 1;
						} else if (lowerValue === 'false') {
							value = 0;
						} else {
							value = parseFloat(p.value);
						}
						return {
							value,
							timestamp: new Date(p.timestamp)
						};
					})
					.filter((p: HistoryDataPoint) => !isNaN(p.value))
					.sort((a: HistoryDataPoint, b: HistoryDataPoint) => a.timestamp.getTime() - b.timestamp.getTime());

				return {
					metric,
					data: points,
					color: getMetricColor(key),
					visible: existingSeries?.visible ?? true
				};
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error';
			series = [];
		} finally {
			loading = false;
		}
	}

	// Check if chart structure changed (needs full rebuild)
	// Include booleanAreaHeight to trigger rebuild when boolean metrics are added/removed
	function getSeriesKeys(): string {
		return `${booleanAreaHeight}|` + series.map(s => `${getMetricKey(s.metric)}:${s.visible}`).sort().join('|');
	}

	// Initialize chart structure (called when series structure changes)
	function initializeChart() {
		if (!svgRef || !mounted) return;

		const svg = d3.select(svgRef);
		svg.selectAll('*').remove();

		const width = containerWidth;
		const innerWidth = width - margin.left - margin.right;
		// Account for boolean strips area at the bottom
		const chartBottom = margin.bottom + booleanAreaHeight;
		const innerHeight = height - margin.top - chartBottom;

		if (innerWidth <= 0 || innerHeight <= 0) return;

		const visibleSeries = series.filter((s) => s.visible);
		const visibleNumericSeries = numericSeries.filter((s) => s.visible);
		const visibleBooleanSeries = booleanSeries.filter((s) => s.visible);
		const allNumericPoints = visibleNumericSeries.flatMap((s) => s.data);

		if (allNumericPoints.length === 0 && visibleBooleanSeries.length === 0) {
			svg
				.append('text')
				.attr('class', 'empty-text')
				.attr('x', width / 2)
				.attr('y', height / 2)
				.attr('text-anchor', 'middle')
				.attr('fill', getCSSVariable('--theme-neutral-500'))
				.attr('font-size', '14px')
				.text(selectedMetrics.length === 0 ? 'Select metrics to display' : 'No data available');
			currentXScale = null;
			currentYScale = null;
			chartInitialized = false;
			return;
		}

		// Create clip path for smooth edge transitions
		svg.append('defs')
			.append('clipPath')
			.attr('id', 'chart-clip')
			.append('rect')
			.attr('x', margin.left)
			.attr('y', margin.top)
			.attr('width', innerWidth)
			.attr('height', innerHeight);

		// Create clip path for boolean strips
		svg.select('defs')
			.append('clipPath')
			.attr('id', 'boolean-clip')
			.append('rect')
			.attr('x', margin.left)
			.attr('y', height - margin.bottom - booleanAreaHeight)
			.attr('width', innerWidth)
			.attr('height', booleanAreaHeight);

		// Grid group
		svg.append('g').attr('class', 'grid').attr('transform', `translate(${margin.left},0)`);

		// X Axis group (positioned above boolean strips if present)
		svg.append('g').attr('class', 'x-axis').attr('transform', `translate(0,${height - chartBottom})`);

		// Y Axis group
		svg.append('g').attr('class', 'y-axis').attr('transform', `translate(${margin.left},0)`);

		// Lines group (clipped)
		const linesGroup = svg.append('g').attr('class', 'lines-group').attr('clip-path', 'url(#chart-clip)');

		// Create a path for each numeric series (not booleans)
		visibleNumericSeries.forEach((s) => {
			const safeKey = getMetricKey(s.metric).replace(/[^a-zA-Z0-9]/g, '-');
			linesGroup
				.append('path')
				.attr('class', `line line-${safeKey}`)
				.attr('fill', 'none')
				.attr('stroke', s.color)
				.attr('stroke-width', 2);
		});

		// Boolean strips group (no clip needed - we manually clamp x positions)
		svg.append('g').attr('class', 'boolean-strips-group');

		// Data points group (clipped)
		svg.append('g').attr('class', 'points-group').attr('clip-path', 'url(#chart-clip)');

		// Highlight group (clipped to keep highlights within chart area)
		svg.append('g').attr('class', 'highlight-group').attr('clip-path', 'url(#chart-clip)');

		// Tooltip line - initially hidden with explicit x positions (extends through boolean area)
		svg.append('line')
			.attr('class', 'tooltip-line')
			.attr('stroke', getCSSVariable('--theme-neutral-500') || '#888')
			.attr('stroke-width', 1)
			.attr('stroke-dasharray', '3,3')
			.attr('x1', margin.left)
			.attr('x2', margin.left)
			.attr('y1', margin.top)
			.attr('y2', height - margin.bottom)
			.style('display', 'none');

		// Overlay for mouse events (covers both chart and boolean area)
		svg.append('rect')
			.attr('class', 'overlay')
			.attr('fill', 'none')
			.attr('pointer-events', 'all')
			.attr('x', margin.left)
			.attr('y', margin.top)
			.attr('width', innerWidth)
			.attr('height', innerHeight + booleanAreaHeight);

		chartInitialized = true;
		lastSeriesKeys = getSeriesKeys();

		// Now update with current data
		updateChart();
	}

	// Update chart with transitions (called on time tick updates)
	function updateChart() {
		if (!svgRef || !mounted || !chartInitialized) return;
		// Skip rendering if too many points (would lock up browser)
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

		// Allow chart to render even with only boolean data
		if (allNumericPoints.length === 0 && visibleBooleanSeries.length === 0) return;

		// Create scales
		const xScale = d3
			.scaleTime()
			.domain([timeBounds.start, timeBounds.end])
			.range([margin.left, width - margin.right]);

		// Y scale only uses numeric data (not boolean)
		let yScale: d3.ScaleLinear<number, number>;
		if (allNumericPoints.length > 0) {
			const yExtent = d3.extent(allNumericPoints, (d) => d.value) as [number, number];
			const yPadding = (yExtent[1] - yExtent[0]) * 0.1 || 1;
			const dataMin = yExtent[0] - yPadding;
			const dataMax = yExtent[1] + yPadding;

			// In real-time mode, only expand Y bounds (don't shrink) to prevent pulsing
			// In historical mode, always use exact data bounds
			let yMin: number, yMax: number;
			if (timeRange.mode === 'realtime') {
				yMin = yBoundsMin === null ? dataMin : Math.min(yBoundsMin, dataMin);
				yMax = yBoundsMax === null ? dataMax : Math.max(yBoundsMax, dataMax);
				yBoundsMin = yMin;
				yBoundsMax = yMax;
			} else {
				yMin = dataMin;
				yMax = dataMax;
			}

			yScale = d3
				.scaleLinear()
				.domain([yMin, yMax])
				.range([height - chartBottom, margin.top]);
		} else {
			// No numeric data, create a dummy scale
			yScale = d3
				.scaleLinear()
				.domain([0, 1])
				.range([height - chartBottom, margin.top]);
		}

		currentXScale = xScale;
		currentYScale = yScale;

		const t = svg.transition().duration(transitionDuration).ease(d3.easeLinear);

		// Update grid
		const gridColor = getCSSVariable('--theme-neutral-300') || '#e5e5e5';
		svg.select<SVGGElement>('.grid')
			.transition(t as any)
			.call(
				d3.axisLeft(yScale)
					.tickSize(-innerWidth)
					.tickFormat(() => '') as any
			)
			.call((g) => g.select('.domain').remove())
			.call((g) => g.selectAll('.tick line').attr('stroke', gridColor).attr('stroke-opacity', 0.3));

		// Update axes with transitions
		const textColor = getCSSVariable('--theme-text') || '#333';
		const axisColor = getCSSVariable('--theme-neutral-400') || '#9ca3af';

		const xAxis = d3.axisBottom(xScale).ticks(6);
		svg.select<SVGGElement>('.x-axis')
			.transition(t as any)
			.call(xAxis as any)
			.call((g) => g.select('.domain').attr('stroke', axisColor))
			.call((g) => g.selectAll('.tick line').attr('stroke', axisColor))
			.call((g) => g.selectAll('.tick text').attr('fill', textColor).attr('font-size', '12px').attr('font-weight', '500'));

		const yAxis = d3.axisLeft(yScale).ticks(5).tickFormat(d3.format('.2f'));
		svg.select<SVGGElement>('.y-axis')
			.transition(t as any)
			.call(yAxis as any)
			.call((g) => g.select('.domain').attr('stroke', axisColor))
			.call((g) => g.selectAll('.tick line').attr('stroke', axisColor))
			.call((g) => g.selectAll('.tick text').attr('fill', textColor).attr('font-size', '11px'));

		// Update lines with transitions (only numeric series)
		// Each series gets its own line generator with gap detection
		visibleNumericSeries.forEach((s) => {
			const safeKey = getMetricKey(s.metric).replace(/[^a-zA-Z0-9]/g, '-');
			const data = s.data;

			// Calculate gap threshold using multiple strategies:
			// 1. Use 25th percentile interval * 5 (robust against outliers)
			// 2. Minimum threshold of 30 seconds (for real-time data)
			// 3. Maximum threshold of 5% of visible time range
			let gapThreshold = Infinity;
			if (data.length > 2) {
				const intervals: number[] = [];
				for (let i = 1; i < data.length; i++) {
					intervals.push(data[i].timestamp.getTime() - data[i - 1].timestamp.getTime());
				}
				intervals.sort((a, b) => a - b);

				// Use 25th percentile to be more robust against the one huge gap
				const p25Index = Math.floor(intervals.length * 0.25);
				const typicalInterval = intervals[p25Index];

				// Gap threshold: 5x typical interval, but at least 30s and at most 5% of time range
				const timeRangeMs = timeBounds.end.getTime() - timeBounds.start.getTime();
				const minThreshold = 30 * 1000; // 30 seconds
				const maxThreshold = timeRangeMs * 0.05; // 5% of visible range

				gapThreshold = Math.max(minThreshold, Math.min(maxThreshold, typicalInterval * 5));
			}

			// Build path string manually to handle gaps without transition interpolation issues
			// D3 transitions can interpolate through gaps, so we set the path directly
			const lineGenerator = d3
				.line<HistoryDataPoint>()
				.x((d) => xScale(d.timestamp))
				.y((d) => yScale(d.value))
				.defined((d, i) => {
					if (i === 0) return true;
					const gap = d.timestamp.getTime() - data[i - 1].timestamp.getTime();
					return gap <= gapThreshold;
				})
				.curve(d3.curveMonotoneX);

			// Set path directly (not via transition) to avoid gap interpolation issues
			svg.select(`.line-${safeKey}`)
				.datum(data)
				.attr('d', lineGenerator)
				.attr('stroke', s.color);
		});

		// Update boolean strips
		const booleanStripsGroup = svg.select('.boolean-strips-group');
		const neutralColor = getCSSVariable('--theme-neutral-700') || '#374151';
		const booleanStripY = (height - chartBottom) + BOOLEAN_AREA_PADDING; // Position relative to x-axis

		// Clear existing boolean strips
		booleanStripsGroup.selectAll('*').remove();

		visibleBooleanSeries.forEach((s, index) => {
			const stripY = booleanStripY + index * (BOOLEAN_STRIP_HEIGHT + BOOLEAN_STRIP_GAP);
			const data = s.data;

			if (data.length === 0) return;

			// Merge consecutive segments with the same value to avoid internal stroke lines
			type Segment = { startTime: Date; endTime: Date; isTrue: boolean };
			const segments: Segment[] = [];

			for (let i = 0; i < data.length; i++) {
				const point = data[i];
				const nextPoint = data[i + 1];
				const isTrue = point.value === 1 || point.value > 0;

				// Calculate start time (first point extends to visible range start)
				const startTime = i === 0 ? timeBounds.start : point.timestamp;
				// Calculate end time (last point extends to visible range end)
				const endTime = nextPoint ? nextPoint.timestamp : timeBounds.end;

				// Try to merge with previous segment if same value
				const lastSegment = segments[segments.length - 1];
				if (lastSegment && lastSegment.isTrue === isTrue) {
					// Extend the previous segment
					lastSegment.endTime = endTime;
				} else {
					// Start a new segment
					segments.push({ startTime, endTime, isTrue });
				}
			}

			// Draw merged segments
			for (const segment of segments) {
				const x1 = xScale(segment.startTime);
				const x2 = xScale(segment.endTime);

				// Only render if within visible bounds
				if (x2 < margin.left || x1 > width - margin.right) continue;

				// Clamp to visible area
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

			// Add label inside the bar
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

		// Update data points with transitions (only if showDataPoints is enabled, only for numeric series)
		const pointsGroup = svg.select('.points-group');

		if (showDataPoints) {
			visibleNumericSeries.forEach((s) => {
				const safeKey = getMetricKey(s.metric).replace(/[^a-zA-Z0-9]/g, '-');

				const points = pointsGroup
					.selectAll<SVGCircleElement, HistoryDataPoint>(`.point-${safeKey}`)
					.data(s.data, (d: HistoryDataPoint) => d.timestamp.getTime().toString());

				// Enter new points
				points.enter()
					.append('circle')
					.attr('class', `data-point point-${safeKey}`)
					.attr('cx', (d) => xScale(d.timestamp))
					.attr('cy', (d) => yScale(d.value))
					.attr('r', 3)
					.attr('fill', 'white')
					.attr('stroke', s.color)
					.attr('stroke-width', 1.5);

				// Update existing points (including color)
				points
					.transition(t as any)
					.attr('cx', (d) => xScale(d.timestamp))
					.attr('cy', (d) => yScale(d.value))
					.attr('stroke', s.color);

				// Remove old points
				points.exit().remove();
			});
		} else {
			// Remove all data points when disabled
			pointsGroup.selectAll('.data-point').remove();
		}

		// Setup mouse events
		const bisect = d3.bisector<HistoryDataPoint, Date>((d) => d.timestamp).left;
		const highlightGroup = svg.select('.highlight-group');
		const tooltipLine = svg.select('.tooltip-line');

		svg.select('.overlay')
			.on('mouseenter', () => {
				isHovering = true;
			})
			.on('mousemove', (event) => {
				isHovering = true;
				const [mx] = d3.pointer(event);
				const x0 = xScale.invert(mx);

				// Get values from numeric series (for chart highlights)
				const values: TooltipValue[] = visibleNumericSeries
					.map((s) => {
						if (s.data.length === 0) return null;
						const i = bisect(s.data, x0);
						const d0 = s.data[i - 1];
						const d1 = s.data[i];
						if (!d0 && !d1) return null;
						const d =
							!d0
								? d1
								: !d1
									? d0
									: x0.getTime() - d0.timestamp.getTime() > d1.timestamp.getTime() - x0.getTime()
										? d1
										: d0;
						return {
							metric: s.metric,
							value: d.value,
							color: s.color,
							screenX: xScale(d.timestamp),
							screenY: yScale(d.value),
							timestamp: d.timestamp
						};
					})
					.filter((v): v is TooltipValue => v !== null);

				// Also get boolean values for tooltip display (but no chart highlight)
				const booleanValues: TooltipValue[] = visibleBooleanSeries
					.map((s, index) => {
						if (s.data.length === 0) return null;
						const i = bisect(s.data, x0);
						const d0 = s.data[i - 1];
						const d1 = s.data[i];
						if (!d0 && !d1) return null;
						const d =
							!d0
								? d1
								: !d1
									? d0
									: x0.getTime() - d0.timestamp.getTime() > d1.timestamp.getTime() - x0.getTime()
										? d1
										: d0;
						// Position boolean tooltip values at their strip Y position
						const stripY = booleanStripY + index * (BOOLEAN_STRIP_HEIGHT + BOOLEAN_STRIP_GAP) + BOOLEAN_STRIP_HEIGHT / 2;
						return {
							metric: s.metric,
							value: d.value,
							color: s.color,
							screenX: xScale(d.timestamp),
							screenY: stripY,
							timestamp: d.timestamp
						};
					})
					.filter((v): v is TooltipValue => v !== null);

				const allValues = [...values, ...booleanValues];

				if (allValues.length > 0) {
					tooltipData = {
						x: mx,
						y: event.offsetY,
						timestamp: allValues[0].timestamp,
						values: allValues,
						containerWidth
					};

					tooltipLine
						.attr('x1', mx)
						.attr('x2', mx)
						.style('display', null);

					// Only show highlight circles for numeric values
					highlightGroup.selectAll('circle').remove();
					values.forEach((v) => {
						highlightGroup
							.append('circle')
							.attr('cx', v.screenX)
							.attr('cy', v.screenY)
							.attr('r', 6)
							.attr('fill', v.color)
							.attr('stroke', 'white')
							.attr('stroke-width', 2)
							.style('filter', 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))');
					});
				}
			})
			.on('mouseleave', () => {
				isHovering = false;
				tooltipData = null;
				tooltipLine.style('display', 'none');
				highlightGroup.selectAll('circle').remove();
			});

		// Restore highlights only if mouse is actively hovering and data is valid
		if (isHovering && tooltipData && tooltipData.values.length > 0 && tooltipData.timestamp) {
			// Recalculate positions based on new scales
			const newX = xScale(tooltipData.timestamp);
			// Only show if position is valid and within bounds
			if (!isNaN(newX) && newX >= margin.left && newX <= width - margin.right) {
				tooltipLine
					.attr('x1', newX)
					.attr('x2', newX)
					.style('display', null);

				highlightGroup.selectAll('circle').remove();
				tooltipData.values.forEach((v) => {
					const screenX = xScale(v.timestamp);
					const screenY = yScale(v.value);
					// Only draw if positions are valid
					if (!isNaN(screenX) && !isNaN(screenY)) {
						highlightGroup
							.append('circle')
							.attr('cx', screenX)
							.attr('cy', screenY)
							.attr('r', 6)
							.attr('fill', v.color)
							.attr('stroke', 'white')
							.attr('stroke-width', 2)
							.style('filter', 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))');
					}
				});
			} else {
				tooltipLine.style('display', 'none');
				highlightGroup.selectAll('circle').remove();
			}
		}
	}

	// Main render function - decides whether to init or update
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

	// Handle metric addition
	function addMetric(metric: MetricInfo) {
		if (!selectedMetrics.some((m) => getMetricKey(m) === getMetricKey(metric))) {
			selectedMetrics = [...selectedMetrics, metric];
			resetYBounds();
		}
	}

	// Handle metric removal
	function removeMetric(metric: MetricInfo) {
		selectedMetrics = selectedMetrics.filter((m) => getMetricKey(m) !== getMetricKey(metric));
		resetYBounds();
	}

	// Handle visibility toggle
	function toggleVisibility(metric: MetricInfo) {
		series = series.map((s) =>
			getMetricKey(s.metric) === getMetricKey(metric) ? { ...s, visible: !s.visible } : s
		);
	}

	// Handle mode change
	function handleModeChange() {
		if (timeRange.mode === 'realtime') {
			// Switching to historical
			const now = new Date();
			const start = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
			timeRange = { mode: 'historical', start, end: now };
		} else {
			// Switching to realtime - reset raw mode (not available in realtime)
			raw = false;
			timeRange = { mode: 'realtime', preset: '15m' };
		}
	}

	// SSE event source for real-time updates
	let eventSource: EventSource | null = null;

	// Track page visibility to pause SSE when hidden
	let pageVisible = $state(true);

	function connectSSE() {
		if (eventSource) {
			eventSource.close();
		}
		if (!spaceId || selectedMetrics.length === 0 || timeRange.mode !== 'realtime') {
			return;
		}

		const url = `/api/space/${spaceId}/realtime?includeNodeMetrics=true`;
		eventSource = new EventSource(url);

		// Listen for real-time metric updates from Mantle subscription
		eventSource.addEventListener('metric_update', (event) => {
			// Skip updates when paused
			if (paused) return;

			try {
				const data = JSON.parse(event.data);
				if (!data.metrics || !Array.isArray(data.metrics)) return;

				// Calculate cutoff time for pruning old data (keep 2x the visible range for smooth scrolling)
				const preset = timeRange.preset || '15m';
				const visibleDuration = PRESET_DURATIONS[preset];
				const cutoffTime = Date.now() - (visibleDuration * 2);

				// Add ALL new data points from subscription with proper timestamps
				series = series.map((s) => {
					// Use filter to get ALL matching metrics, not just the first one
					const allMatching = data.metrics.filter(
						(m: { groupId: string; nodeId: string; deviceId: string; metricId: string; timestamp: number; value: string }) =>
							m.groupId === s.metric.groupId &&
							m.nodeId === s.metric.nodeId &&
							m.deviceId === s.metric.deviceId &&
							m.metricId === s.metric.name
					);

					if (allMatching.length > 0) {
						// Prune old data points first
						let newData = s.data.filter((p) => p.timestamp.getTime() > cutoffTime);
						let added = 0;

						for (const matching of allMatching) {
							if (!matching.timestamp) continue;
							// Handle boolean string values ("true"/"false") and numeric values
							let value: number;
							const lowerValue = String(matching.value).toLowerCase();
							if (lowerValue === 'true') {
								value = 1;
							} else if (lowerValue === 'false') {
								value = 0;
							} else {
								value = parseFloat(matching.value);
							}
							if (isNaN(value)) continue;

							const timestamp = new Date(matching.timestamp);
							const existingPoint = newData.find(
								(p) => p.timestamp.getTime() === timestamp.getTime()
							);

							if (!existingPoint) {
								newData.push({ value, timestamp });
								added++;
							}
						}

						if (added > 0 || newData.length !== s.data.length) {
							newData.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
							return { ...s, data: newData };
						}
					}
					return s;
				});
			} catch {
				// Ignore parse errors
			}
		});

		eventSource.onerror = () => {
			// Silently handle errors
		};
	}

	// Effects
	onMount(() => {
		// Load persisted settings
		const saved = loadSettings();
		if (saved) {
			// Filter selectedMetrics to only include metrics that still exist in availableMetrics
			if (saved.selectedMetrics) {
				selectedMetrics = saved.selectedMetrics.filter((sm) =>
					availableMetrics.some(
						(am) =>
							am.groupId === sm.groupId &&
							am.nodeId === sm.nodeId &&
							am.deviceId === sm.deviceId &&
							am.metricId === sm.metricId
					)
				);
			}
			if (saved.timeRange) timeRange = saved.timeRange;
			if (saved.samples !== undefined) samples = saved.samples;
			if (saved.raw !== undefined) raw = saved.raw;
			if (saved.showDataPoints !== undefined) showDataPoints = saved.showDataPoints;
			if (saved.customColors) customColors = saved.customColors;
		}

		mounted = true;

		// Track page visibility
		function handleVisibilityChange() {
			pageVisible = !document.hidden;
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);

		if (containerRef) {
			const observer = new ResizeObserver((entries) => {
				containerWidth = entries[0].contentRect.width;
				chartInitialized = false; // Force rebuild on resize
			});
			observer.observe(containerRef);
			return () => {
				observer.disconnect();
				document.removeEventListener('visibilitychange', handleVisibilityChange);
				if (eventSource) {
					eventSource.close();
				}
			};
		}

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	function resetYBounds() {
		yBoundsMin = null;
		yBoundsMax = null;
	}

	// Reset Y-axis bounds when mode changes (not on every reactive update)
	$effect(() => {
		const currentMode = timeRange.mode;
		if (currentMode !== previousMode) {
			previousMode = currentMode;
			resetYBounds();
		}
	});

	// Fetch data when metrics, time range, samples, raw settings change, or page becomes visible
	$effect(() => {
		if (!mounted || !pageVisible) return;
		const _ = [selectedMetrics, timeRange.mode, timeRange.preset, timeRange.start, timeRange.end, samples, raw, pageVisible];
		fetchHistory();
	});

	// Save settings to localStorage when they change
	$effect(() => {
		if (!mounted) return;
		const _ = [selectedMetrics, timeRange.mode, timeRange.preset, samples, raw, showDataPoints, customColors];
		saveSettings();
	});

	// Re-render chart when series, dimensions, or display settings change
	$effect(() => {
		if (!mounted) return;
		const _ = [series, containerWidth, height, showDataPoints, booleanAreaHeight];
		renderChart();
	});

	// Update chart on time tick (smooth transitions)
	$effect(() => {
		if (!mounted || !chartInitialized) return;
		const _ = [timeBounds];
		updateChart();
	});

	// SSE connection for real-time updates (respects page visibility)
	$effect(() => {
		if (!mounted) return;
		const _ = [timeRange.mode, selectedMetrics, spaceId, pageVisible];

		if (timeRange.mode === 'realtime' && selectedMetrics.length > 0 && pageVisible) {
			connectSSE();
		} else if (eventSource) {
			eventSource.close();
			eventSource = null;
		}

		return () => {
			if (eventSource) {
				eventSource.close();
				eventSource = null;
			}
		};
	});

	// Real-time tick updater (pauses when page is hidden)
	$effect(() => {
		if (timeRange.mode !== 'realtime' || !mounted || paused || !pageVisible) return;

		const interval = setInterval(() => {
			realtimeTick = Date.now();
		}, 1000);

		return () => clearInterval(interval);
	});

	// Note: Periodic history fetch removed - in real-time mode, we rely on:
	// 1. Initial history fetch for backfill
	// 2. SSE subscription for live updates
	// Periodic fetching caused visual artifacts where sampled history data
	// met high-frequency real-time data at different values
</script>

<div class="trend-chart-card">
	<div class="card-header">
		<h3 class="card-title">{title}</h3>
		<div class="card-header__actions">
			<label class="mode-toggle">
				<input
					type="checkbox"
					checked={timeRange.mode === 'realtime'}
					onchange={handleModeChange}
				/>
				<span class="mode-toggle__slider"></span>
				<span class="mode-toggle__label">
					{timeRange.mode === 'realtime' ? 'Real-time' : 'Historical'}
				</span>
			</label>
			{#if onRemove}
				<button type="button" class="remove-chart-btn" onclick={onRemove} title="Remove chart" aria-label="Remove chart">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<line x1="18" y1="6" x2="6" y2="18"/>
						<line x1="6" y1="6" x2="18" y2="18"/>
					</svg>
				</button>
			{/if}
		</div>
	</div>
	<div class="card-body">
		<TrendChartControls
			{availableMetrics}
			{selectedMetrics}
			bind:timeRange
			bind:samples
			bind:raw
			bind:showDataPoints
			bind:paused
			onAddMetric={addMetric}
		/>

		<div class="chart-container" bind:this={containerRef}>
			{#if loading && series.length === 0}
				<div class="chart-loading">Loading...</div>
			{/if}

			<svg bind:this={svgRef} width={containerWidth} {height}></svg>

			{#if tooltipData}
				<TrendChartTooltip data={tooltipData} />
			{/if}
		</div>

		{#if series.length > 0}
			<TrendChartLegend {series} onToggleVisibility={toggleVisibility} onRemoveMetric={removeMetric} onColorChange={setMetricColor} />
		{/if}

		{#if tooManyPoints}
			<div class="chart-warning">
				Too many data points ({totalPoints.toLocaleString()}) to render. Try reducing the time range, lowering the samples setting, or disabling raw mode.
			</div>
		{/if}

		{#if error}
			<div class="chart-error">{error}</div>
		{/if}
	</div>
</div>

<style lang="scss">
	.trend-chart-card {
		width: 100%;
		min-width: 0;
		border: 1px solid var(--theme-neutral-300);
		border-radius: var(--rounded-md);
		background-color: var(--theme-neutral-50);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 2) calc(var(--spacing-unit) * 3);
		border-bottom: 1px solid var(--theme-neutral-300);
		background-color: var(--theme-neutral-100);
	}

	.card-title {
		margin: 0;
		color: var(--theme-primary);
		font-size: 1rem;
		font-weight: 600;
	}

	.card-header__actions {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 2);
	}

	.remove-chart-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: calc(var(--spacing-unit) * 1);
		background: transparent;
		border: none;
		border-radius: var(--rounded-sm);
		color: var(--theme-neutral-400);
		cursor: pointer;
		transition: color 0.15s ease, background-color 0.15s ease;

		&:hover {
			color: var(--theme-rose-600);
			background-color: var(--theme-rose-100);
		}
	}

	.mode-toggle {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 2);
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--theme-text);
		user-select: none;

		input[type='checkbox'] {
			position: absolute;
			opacity: 0;
			width: 0;
			height: 0;
		}

		&:has(input:checked) .mode-toggle__slider {
			background-color: var(--theme-primary);

			&::before {
				transform: translateX(16px);
			}
		}
	}

	.mode-toggle__slider {
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

	.mode-toggle__label {
		min-width: 5.5em;
	}

	.card-body {
		padding: calc(var(--spacing-unit) * 3);
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.chart-container {
		position: relative;
		width: 100%;
		background-color: var(--theme-neutral-100);
		border: 1px solid var(--theme-neutral-200);
		border-radius: var(--rounded-sm);
		overflow: hidden;
	}

	.chart-loading {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		color: var(--theme-neutral-500);
		font-size: 14px;
	}

	.chart-error {
		margin-top: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 2);
		background-color: var(--theme-error-100);
		color: var(--theme-error-700);
		border-radius: var(--rounded-md);
		font-size: 14px;
	}

	.chart-warning {
		margin-top: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 2);
		background-color: var(--theme-warning-100, #fef3c7);
		color: var(--theme-warning-700, #b45309);
		border-radius: var(--rounded-md);
		font-size: 14px;
	}

	:global(.trend-chart-card svg) {
		display: block;
	}

	:global(.trend-chart-card .data-point) {
		transition: r 0.15s ease;
	}

	:global(.trend-chart-card .data-point:hover) {
		r: 5;
	}

	/* Ensure tooltip line is hidden by default */
	:global(.trend-chart-card .tooltip-line) {
		pointer-events: none;
	}

	/* Ensure grid and axis lines have proper colors */
	:global(.trend-chart-card .grid line) {
		stroke: var(--theme-neutral-300);
		stroke-opacity: 0.3;
	}

	/* Hide the grid domain path - D3 recreates it during transitions */
	:global(.trend-chart-card .grid .domain) {
		display: none !important;
	}

	:global(.trend-chart-card .x-axis line),
	:global(.trend-chart-card .y-axis line) {
		stroke: var(--theme-neutral-400);
	}

	:global(.trend-chart-card .x-axis text),
	:global(.trend-chart-card .y-axis text) {
		fill: var(--theme-text);
	}
</style>
