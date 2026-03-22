<script lang="ts">
	import { onMount } from 'svelte';
	import Spinner from '../Spinner.svelte';
	import type {
		MetricInfo,
		MetricIdentifier,
		MetricHistory,
		ChartSeries,
		TimeRange,
		TimeRangePreset,
		PaneConfig,
		CrosshairValue,
		HistoryDataPoint,
		ContainerSettings,
		ChartViewData
	} from './types';
	import { PRESET_DURATIONS } from './types';
	import { createColorScale, getMetricKey } from './utils';
	import TrendChartPane from './TrendChartPane.svelte';
	import TrendChartTooltip from './TrendChartTooltip.svelte';

	type Props = {
		storageKey: string;
		exposePanes?: (panes: PaneConfig[]) => void;
		exposeAddMetric?: (fn: (paneId: string, metric: MetricInfo) => void) => void;
		fetchHistory: (params: {
			start: Date;
			end: Date;
			metrics: MetricIdentifier[];
			samples: number;
			raw: boolean;
		}) => Promise<MetricHistory[]>;
		subscribeRealtime?: (
			metrics: MetricInfo[],
			onData: (updates: Array<{ groupId: string; nodeId: string; deviceId: string; metricId: string; value: string; timestamp: number }>) => void
		) => (() => void);
		fetchChartViews?: () => Promise<ChartViewData[]>;
		saveChartView?: (name: string, config: ContainerSettings) => Promise<ChartViewData>;
		deleteChartView?: (viewId: string) => Promise<void>;
	};

	let {
		storageKey,
		exposePanes,
		exposeAddMetric,
		fetchHistory: fetchHistoryCallback,
		subscribeRealtime,
		fetchChartViews: fetchChartViewsCallback,
		saveChartView: saveChartViewCallback,
		deleteChartView: deleteChartViewCallback
	}: Props = $props();

	// Shared state
	let timeRange = $state<TimeRange>({ mode: 'realtime', preset: '15m' });
	let samples = $state(200);
	let raw = $state(false);
	let showDataPoints = $state(false);
	let paused = $state(false);

	// Pane configurations
	let panes = $state<PaneConfig[]>([{ id: 'pane-1', metrics: [] }]);

	// All series data (keyed by metric key)
	let allSeries = $state<Map<string, ChartSeries>>(new Map());

	// Custom colors for metrics
	let customColors = $state<Record<string, string>>({});

	// Hidden metrics (persisted visibility state)
	let hiddenMetrics = $state<string[]>([]);

	// Loading/error state
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Crosshair state
	let crosshairTimestamp = $state<Date | null>(null);
	let crosshairValues = $state<Map<string, CrosshairValue[]>>(new Map());
	let crosshairScreenX = $state<number>(0);
	let mouseY = $state<number>(0);
	let mouseClientX = $state<number>(0);
	let mouseClientY = $state<number>(0);

	// Container ref for positioning
	let panesContainerRef: HTMLDivElement | undefined = $state();
	let containerWidth = $state(800);

	// Real-time tick
	let realtimeTick = $state(Date.now());

	// Page visibility
	let pageVisible = $state(true);
	let mounted = $state(false);

	// Chart views state
	let chartViews = $state<ChartViewData[]>([]);
	let isSavingView = $state(false);
	let viewNameInput = $state('');
	let savingInProgress = $state(false);
	let activeViewId = $state<string | null>(null);
	let skipActiveViewClear = false;
	let viewNameInputRef: HTMLInputElement | undefined = $state();

	// Realtime unsubscribe function
	let realtimeUnsubscribe: (() => void) | null = null;

	// LocalStorage key
	const STORAGE_KEY = `trendchart-container-${storageKey}`;

	// Load settings
	function loadSettings(): Partial<ContainerSettings> | null {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (!stored) return null;
			const parsed = JSON.parse(stored);
			if (parsed.timeRange?.start) parsed.timeRange.start = new Date(parsed.timeRange.start);
			if (parsed.timeRange?.end) parsed.timeRange.end = new Date(parsed.timeRange.end);
			return parsed;
		} catch {
			return null;
		}
	}

	// Save settings
	function saveSettings() {
		try {
			const settings: ContainerSettings = {
				panes,
				timeRange,
				samples,
				raw,
				showDataPoints,
				customColors,
				hiddenMetrics,
				activeViewId
			};
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch {
			// Ignore storage errors
		}
	}

	// Chart views
	async function fetchChartViews() {
		if (!fetchChartViewsCallback) return;
		try {
			chartViews = await fetchChartViewsCallback();
		} catch {
			// Views are a convenience feature — fail silently
		}
	}

	async function saveChartView() {
		if (!saveChartViewCallback) return;
		const name = viewNameInput.trim();
		if (!name || savingInProgress) return;

		savingInProgress = true;
		try {
			const config: ContainerSettings = {
				panes,
				timeRange,
				samples,
				raw,
				showDataPoints,
				customColors,
				hiddenMetrics
			};

			const view = await saveChartViewCallback(name, config);
			chartViews = [...chartViews, view];
			activeViewId = view.id;
			isSavingView = false;
			viewNameInput = '';
		} catch {
			// Fail silently
		} finally {
			savingInProgress = false;
		}
	}

	function loadChartView(view: ChartViewData) {
		skipActiveViewClear = true;
		const config = view.config;
		if (config.panes) panes = config.panes;
		if (config.timeRange) {
			const tr = { ...config.timeRange };
			if (tr.start) tr.start = new Date(tr.start as unknown as string);
			if (tr.end) tr.end = new Date(tr.end as unknown as string);
			timeRange = tr;
		}
		if (config.samples !== undefined) samples = config.samples;
		if (config.raw !== undefined) raw = config.raw;
		if (config.showDataPoints !== undefined) showDataPoints = config.showDataPoints;
		if (config.customColors) customColors = config.customColors;
		if (config.hiddenMetrics) hiddenMetrics = config.hiddenMetrics;
		activeViewId = view.id;
		requestAnimationFrame(() => {
			skipActiveViewClear = false;
		});
	}

	async function deleteChartView(viewId: string) {
		if (!deleteChartViewCallback) return;
		try {
			await deleteChartViewCallback(viewId);
			chartViews = chartViews.filter((v) => v.id !== viewId);
			if (activeViewId === viewId) {
				activeViewId = null;
			}
		} catch {
			// Fail silently
		}
	}

	function handleViewNameKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			saveChartView();
		} else if (event.key === 'Escape') {
			isSavingView = false;
			viewNameInput = '';
		}
	}

	function startSavingView() {
		isSavingView = true;
		viewNameInput = '';
		// Focus input on next tick
		requestAnimationFrame(() => {
			viewNameInputRef?.focus();
		});
	}

	// Whether views feature is available
	let hasViews = $derived(
		fetchChartViewsCallback !== undefined ||
		saveChartViewCallback !== undefined ||
		deleteChartViewCallback !== undefined
	);

	// Whether realtime is available
	let hasRealtime = $derived(subscribeRealtime !== undefined);

	// Color scale
	let allSelectedMetrics = $derived(panes.flatMap((p) => p.metrics));
	let colorScale = $derived(createColorScale(allSelectedMetrics));

	// Get color for a metric
	function getMetricColor(metricKey: string): string {
		return customColors[metricKey] || colorScale(metricKey);
	}

	// Derived: time bounds
	let timeBounds = $derived.by(() => {
		if (timeRange.mode === 'historical' && timeRange.start && timeRange.end) {
			return { start: timeRange.start, end: timeRange.end };
		}
		const now = new Date(realtimeTick);
		const preset = timeRange.preset || '15m';
		const start = new Date(now.getTime() - PRESET_DURATIONS[preset]);
		return { start, end: now };
	});

	// Compute fetch time bounds (separate from render to avoid fetching every second)
	function getFetchTimeBounds() {
		if (timeRange.mode === 'historical' && timeRange.start && timeRange.end) {
			return { start: timeRange.start, end: timeRange.end };
		}
		const now = new Date();
		const preset = timeRange.preset || '15m';
		const start = new Date(now.getTime() - PRESET_DURATIONS[preset]);
		return { start, end: now };
	}

	// Get series for a specific pane
	function getPaneSeries(pane: PaneConfig): ChartSeries[] {
		return pane.metrics.map((metric) => {
			const key = getMetricKey(metric);
			const existing = allSeries.get(key);
			const currentColor = getMetricColor(key);

			if (existing) {
				// Always use current color (from scale or custom), not stale stored color
				return {
					...existing,
					color: currentColor
				};
			}

			return {
				metric,
				data: [],
				color: currentColor,
				visible: !hiddenMetrics.includes(key)
			};
		});
	}

	// Fetch history for all metrics across all panes
	async function fetchHistory() {
		if (allSelectedMetrics.length === 0) {
			allSeries = new Map();
			return;
		}

		loading = true;
		error = null;

		const fetchBounds = getFetchTimeBounds();

		try {
			const historyData = await fetchHistoryCallback({
				start: fetchBounds.start,
				end: fetchBounds.end,
				metrics: allSelectedMetrics.map((m) => ({
					groupId: m.groupId,
					nodeId: m.nodeId,
					deviceId: m.deviceId,
					metricId: m.metricId
				})),
				samples,
				raw
			});

			// Build new series map
			const newSeries = new Map<string, ChartSeries>();

			allSelectedMetrics.forEach((metric) => {
				const key = getMetricKey(metric);
				const existing = allSeries.get(key);

				// Find history data
				let historyItem = historyData.find(
					(h) =>
						h.groupId === metric.groupId &&
						h.nodeId === metric.nodeId &&
						h.deviceId === metric.deviceId &&
						h.metricId === metric.metricId
				);
				if (!historyItem) {
					historyItem = historyData.find(
						(h) => h.metricId === metric.metricId
					);
				}

				const points: HistoryDataPoint[] = (historyItem?.history || [])
					.filter((p) => !isNaN(p.value))
					.sort(
						(a, b) =>
							a.timestamp.getTime() - b.timestamp.getTime()
					);

				newSeries.set(key, {
					metric,
					data: points,
					color: getMetricColor(key),
					visible: existing?.visible ?? !hiddenMetrics.includes(key)
				});
			});

			allSeries = newSeries;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error';
		} finally {
			loading = false;
		}
	}

	// Realtime subscription
	function connectRealtime() {
		if (realtimeUnsubscribe) {
			realtimeUnsubscribe();
			realtimeUnsubscribe = null;
		}
		if (!subscribeRealtime || allSelectedMetrics.length === 0 || timeRange.mode !== 'realtime') {
			return;
		}

		realtimeUnsubscribe = subscribeRealtime(allSelectedMetrics, (updates) => {
			if (paused) return;

			const preset = timeRange.preset || '15m';
			const visibleDuration = PRESET_DURATIONS[preset];
			const cutoffTime = Date.now() - visibleDuration * 2;

			// Update series
			const updatedSeries = new Map(allSeries);
			let hasChanges = false;

			for (const [key, series] of updatedSeries) {
				const allMatching = updates.filter(
					(m) =>
						m.groupId === series.metric.groupId &&
						m.nodeId === series.metric.nodeId &&
						m.deviceId === series.metric.deviceId &&
						m.metricId === series.metric.name
				);

				if (allMatching.length > 0) {
					let newData = series.data.filter((p) => p.timestamp.getTime() > cutoffTime);
					let added = 0;

					for (const matching of allMatching) {
						if (!matching.timestamp) continue;
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

					if (added > 0 || newData.length !== series.data.length) {
						newData.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
						updatedSeries.set(key, { ...series, data: newData });
						hasChanges = true;
					}
				}
			}

			if (hasChanges) {
				allSeries = updatedSeries;
			}
		});
	}

	// Pane management
	function addPane() {
		const id = `pane-${Date.now()}`;
		panes = [...panes, { id, metrics: [] }];
	}

	function removePane(paneId: string) {
		if (panes.length <= 1) return;
		panes = panes.filter((p) => p.id !== paneId);
	}

	// Metric management per pane
	function addMetricToPane(paneId: string, metric: MetricInfo) {
		panes = panes.map((p) => {
			if (p.id !== paneId) return p;
			if (p.metrics.some((m) => getMetricKey(m) === getMetricKey(metric))) return p;
			return { ...p, metrics: [...p.metrics, metric] };
		});
	}

	function removeMetricFromPane(paneId: string, metric: MetricInfo) {
		panes = panes.map((p) => {
			if (p.id !== paneId) return p;
			return { ...p, metrics: p.metrics.filter((m) => getMetricKey(m) !== getMetricKey(metric)) };
		});
	}

	function toggleMetricVisibility(paneId: string, metric: MetricInfo) {
		const key = getMetricKey(metric);
		const existing = allSeries.get(key);
		if (existing) {
			const nowVisible = !existing.visible;
			const updated = new Map(allSeries);
			updated.set(key, { ...existing, visible: nowVisible });
			allSeries = updated;

			if (nowVisible) {
				hiddenMetrics = hiddenMetrics.filter((k) => k !== key);
			} else {
				hiddenMetrics = [...hiddenMetrics, key];
			}
		}
	}

	function setPaneTitle(paneId: string, title: string) {
		panes = panes.map((p) => {
			if (p.id !== paneId) return p;
			return { ...p, title };
		});
	}

	// Expose panes and addMetricToPane to parent
	$effect(() => {
		exposePanes?.(panes);
	});

	$effect(() => {
		exposeAddMetric?.(addMetricToPane);
	});

	function setMetricColor(paneId: string, metric: MetricInfo, color: string) {
		const key = getMetricKey(metric);
		customColors = { ...customColors, [key]: color };
		// Update series color
		const existing = allSeries.get(key);
		if (existing) {
			const updated = new Map(allSeries);
			updated.set(key, { ...existing, color });
			allSeries = updated;
		}
	}

	// Mode change
	function handleModeChange() {
		if (timeRange.mode === 'realtime') {
			const now = new Date();
			const start = new Date(now.getTime() - 60 * 60 * 1000);
			timeRange = { mode: 'historical', start, end: now };
		} else {
			raw = false;
			timeRange = { mode: 'realtime', preset: '15m' };
		}
	}

	// Crosshair handling
	function handleCrosshairMove(timestamp: Date | null, screenX?: number) {
		crosshairTimestamp = timestamp;
		if (screenX !== undefined) {
			crosshairScreenX = screenX;
		}
		if (!timestamp) {
			crosshairValues = new Map();
		}
	}

	function handleCrosshairValues(paneId: string, values: CrosshairValue[]) {
		const updated = new Map(crosshairValues);
		if (values.length === 0) {
			updated.delete(paneId);
		} else {
			updated.set(paneId, values);
		}
		crosshairValues = updated;
	}

	// Handle mouse move on panes container
	function handlePanesMouseMove(event: MouseEvent) {
		if (panesContainerRef) {
			const rect = panesContainerRef.getBoundingClientRect();
			crosshairScreenX = event.clientX - rect.left;
			mouseY = event.clientY - rect.top;
			mouseClientX = event.clientX;
			mouseClientY = event.clientY;
		}
	}

	// Tooltip data from all panes (deduplicated by metric)
	let tooltipData = $derived.by(() => {
		if (!crosshairTimestamp || crosshairValues.size === 0) return null;

		// Collect all values and deduplicate by metric key
		const seenMetrics = new Set<string>();
		const uniqueValues: CrosshairValue[] = [];

		for (const values of crosshairValues.values()) {
			for (const v of values) {
				const key = getMetricKey(v.metric);
				if (!seenMetrics.has(key)) {
					seenMetrics.add(key);
					uniqueValues.push(v);
				}
			}
		}

		if (uniqueValues.length === 0) return null;

		// Store timestamp in a local variable to satisfy TypeScript
		const timestamp = crosshairTimestamp;

		return {
			x: crosshairScreenX,
			y: mouseY,
			timestamp,
			values: uniqueValues.map((v) => ({
				metric: v.metric,
				value: v.value,
				color: v.color,
				screenX: crosshairScreenX,
				screenY: v.screenY,
				timestamp
			})),
			containerWidth
		};
	});

	// Lifecycle
	onMount(() => {
		// Load settings (skip active view clearing during restore)
		skipActiveViewClear = true;
		const saved = loadSettings();
		if (saved) {
			if (saved.panes) {
				panes = saved.panes;
			}
			if (saved.timeRange) timeRange = saved.timeRange;
			if (saved.samples !== undefined) samples = saved.samples;
			if (saved.raw !== undefined) raw = saved.raw;
			if (saved.showDataPoints !== undefined) showDataPoints = saved.showDataPoints;
			if (saved.customColors) customColors = saved.customColors;
			if (saved.hiddenMetrics) hiddenMetrics = saved.hiddenMetrics;
			if (saved.activeViewId) activeViewId = saved.activeViewId;
		}

		mounted = true;
		requestAnimationFrame(() => {
			skipActiveViewClear = false;
		});

		// Fetch saved chart views
		fetchChartViews();

		// Page visibility
		function handleVisibilityChange() {
			pageVisible = !document.hidden;
		}
		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			if (realtimeUnsubscribe) {
				realtimeUnsubscribe();
				realtimeUnsubscribe = null;
			}
		};
	});

	// Track panes container width for tooltip positioning
	$effect(() => {
		if (!panesContainerRef) return;

		const observer = new ResizeObserver((entries) => {
			containerWidth = entries[0].contentRect.width;
		});
		observer.observe(panesContainerRef);

		return () => observer.disconnect();
	});

	// Effects
	$effect(() => {
		if (!mounted || !pageVisible) return;
		const _ = [
			allSelectedMetrics,
			timeRange.mode,
			timeRange.preset,
			timeRange.start,
			timeRange.end,
			samples,
			raw,
			pageVisible
		];
		fetchHistory();
	});

	$effect(() => {
		if (!mounted) return;
		const _ = [panes, timeRange.mode, timeRange.preset, samples, raw, showDataPoints, customColors, hiddenMetrics, activeViewId];
		saveSettings();
	});

	// Clear active view highlight when user manually changes settings
	$effect(() => {
		if (!mounted) return;
		const _ = [panes, timeRange.mode, timeRange.preset, samples, raw, showDataPoints, customColors, hiddenMetrics];
		if (skipActiveViewClear) return;
		activeViewId = null;
	});

	$effect(() => {
		if (!mounted) return;
		const _ = [timeRange.mode, allSelectedMetrics, storageKey, pageVisible];

		if (timeRange.mode === 'realtime' && allSelectedMetrics.length > 0 && pageVisible && hasRealtime) {
			connectRealtime();
		} else if (realtimeUnsubscribe) {
			realtimeUnsubscribe();
			realtimeUnsubscribe = null;
		}

		return () => {
			if (realtimeUnsubscribe) {
				realtimeUnsubscribe();
				realtimeUnsubscribe = null;
			}
		};
	});

	$effect(() => {
		if (timeRange.mode !== 'realtime' || !mounted || paused || !pageVisible) return;

		const interval = setInterval(() => {
			realtimeTick = Date.now();
		}, 1000);

		return () => clearInterval(interval);
	});

	// Sample presets
	const samplePresets = [50, 100, 200, 500, 1000];

	// Date input state
	let startDateStr = $state('');
	let endDateStr = $state('');

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

	import { PRESET_LABELS, REALTIME_PRESETS } from './types';
</script>

<div class="container">
	<div class="container-header">
		<h3 class="container-title">
			Trend Analysis
			{#if loading && allSeries.size === 0}
				<Spinner size={16} color="var(--theme-neutral-500)" />
			{/if}
		</h3>
		<div class="header-actions">
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
		</div>
	</div>

	{#if hasViews}
		<div class="views-bar">
			{#each chartViews as view (view.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="view-chip"
					class:view-chip--active={activeViewId === view.id}
					onclick={() => loadChartView(view)}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') loadChartView(view); }}
					role="button"
					tabindex="0"
					title="Load view: {view.name}"
				>
					<span class="view-chip__name">{view.name}</span>
					<button
						class="view-chip__delete"
						onclick={(e) => { e.stopPropagation(); deleteChartView(view.id); }}
						title="Delete view"
						aria-label="Delete view {view.name}"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" stroke-width="2.5"
							stroke-linecap="round" stroke-linejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>
			{/each}

			{#if isSavingView}
				<div class="view-save-input">
					<input
						bind:this={viewNameInputRef}
						type="text"
						class="view-name-input"
						placeholder="View name..."
						bind:value={viewNameInput}
						onkeydown={handleViewNameKeydown}
						onblur={() => { if (!viewNameInput.trim()) { isSavingView = false; } }}
					/>
					<button
						class="view-save-confirm"
						onclick={saveChartView}
						disabled={!viewNameInput.trim() || savingInProgress}
					>
						{savingInProgress ? '...' : 'Save'}
					</button>
				</div>
			{:else}
				<button class="view-add-btn" onclick={startSavingView} title="Save current view">
					<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
						fill="none" stroke="currentColor" stroke-width="2.5">
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
					Save View
				</button>
			{/if}
		</div>
	{/if}

	<div class="controls">
		{#if timeRange.mode === 'realtime'}
			<div class="control-group">
				<label class="control-label">Time Range</label>
				<select class="control-select" value={timeRange.preset} onchange={handlePresetChange}>
					{#each REALTIME_PRESETS as preset}
						<option value={preset}>{PRESET_LABELS[preset]}</option>
					{/each}
				</select>
			</div>
			<div class="control-group">
				<button
					class="pause-button"
					class:paused
					onclick={() => (paused = !paused)}
					title={paused ? 'Resume' : 'Pause'}
				>
					{#if paused}
						<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
							<path d="M8 5v14l11-7z" />
						</svg>
					{:else}
						<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
							<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
						</svg>
					{/if}
				</button>
			</div>
		{:else}
			<div class="control-group">
				<label class="control-label">Start</label>
				<input
					type="datetime-local"
					class="control-input"
					value={startDateStr}
					onchange={handleStartChange}
				/>
			</div>
			<div class="control-group">
				<label class="control-label">End</label>
				<input
					type="datetime-local"
					class="control-input"
					value={endDateStr}
					onchange={handleEndChange}
				/>
			</div>
		{/if}

		<div class="control-group">
			<label class="control-label">Samples</label>
			<select class="control-select control-select--small" bind:value={samples}>
				{#each samplePresets as preset}
					<option value={preset}>{preset}</option>
				{/each}
			</select>
		</div>

		{#if timeRange.mode === 'historical'}
			<div class="control-group">
				<label class="toggle-switch">
					<input type="checkbox" bind:checked={raw} />
					<span class="toggle-switch__slider"></span>
					<span class="toggle-switch__label">Raw</span>
				</label>
			</div>
		{/if}

		<div class="control-group">
			<label class="toggle-switch">
				<input type="checkbox" bind:checked={showDataPoints} />
				<span class="toggle-switch__slider"></span>
				<span class="toggle-switch__label">Points</span>
			</label>
		</div>

		<div class="control-group control-group--end">
			<button class="add-pane-btn" onclick={addPane}>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<line x1="12" y1="5" x2="12" y2="19" />
					<line x1="5" y1="12" x2="19" y2="12" />
				</svg>
				Add Pane
			</button>
		</div>
	</div>

	{#if error}
		<div class="error">{error}</div>
	{/if}

	<div class="panes" bind:this={panesContainerRef} onmousemove={handlePanesMouseMove}>
		{#each panes as pane, i (pane.id)}
			<TrendChartPane
				paneId={pane.id}
				title={pane.title || `Pane ${i + 1}`}
				series={getPaneSeries(pane)}
				{timeBounds}
				{showDataPoints}
				{crosshairTimestamp}
				{loading}
				onRemoveMetric={removeMetricFromPane}
				onToggleVisibility={toggleMetricVisibility}
				onColorChange={setMetricColor}
				onTitleChange={setPaneTitle}
				onCrosshairMove={handleCrosshairMove}
				onCrosshairValues={handleCrosshairValues}
				onRemovePane={panes.length > 1 ? () => removePane(pane.id) : undefined}
			/>
		{/each}

		{#if tooltipData}
			<div class="tooltip-wrapper">
				<TrendChartTooltip data={tooltipData} />
			</div>
		{/if}
	</div>
</div>

<style lang="scss">
	.container {
		position: relative;
		z-index: 1;
		width: 100%;
		min-width: 0;
		border: 1px solid var(--theme-neutral-300);
		border-radius: var(--rounded-md);
		background-color: var(--theme-neutral-50);
		overflow: visible;
	}

	.container-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 2) calc(var(--spacing-unit) * 3);
		border-bottom: 1px solid var(--theme-neutral-300);
		background-color: var(--theme-neutral-100);
		border-radius: var(--rounded-md) var(--rounded-md) 0 0;
	}

	.container-title {
		margin: 0;
		color: var(--theme-primary);
		font-size: 1rem;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 2);
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 2);
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

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: calc(var(--spacing-unit) * 2) calc(var(--spacing-unit) * 3);
		padding: calc(var(--spacing-unit) * 2) calc(var(--spacing-unit) * 3);
		border-bottom: 1px solid var(--theme-neutral-200);
		align-items: flex-end;
	}

	.control-group {
		display: flex;
		flex-direction: column;
		gap: calc(var(--spacing-unit) * 1);

		&--end {
			margin-left: auto;
		}
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
		min-width: 150px;

		&:focus {
			outline: none;
			border-color: var(--theme-primary);
		}
	}

	.control-select--small {
		min-width: 80px;
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

	.views-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: calc(var(--spacing-unit) * 1);
		padding: calc(var(--spacing-unit) * 1.5) calc(var(--spacing-unit) * 3);
		border-bottom: 1px solid var(--theme-neutral-200);
	}

	.view-chip {
		display: inline-flex;
		align-items: center;
		box-sizing: border-box;
		gap: calc(var(--spacing-unit) * 1.5);
		height: 44px;
		padding: 0 calc(var(--spacing-unit) * 3);
		font-family: inherit;
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1;
		background-color: var(--theme-neutral-200);
		border: 1px solid var(--theme-neutral-300);
		border-radius: var(--rounded-sm);
		cursor: pointer;
		transition: all 0.15s ease;

		&:hover {
			background-color: var(--theme-neutral-300);
			border-color: var(--theme-neutral-400);
		}
	}

	.view-chip--active {
		background-color: var(--theme-primary);
		border-color: var(--theme-primary);
		color: white;

		&:hover {
			background-color: var(--theme-primary-hover);
		}

		.view-chip__delete {
			color: rgba(255, 255, 255, 0.7);

			&:hover {
				color: white;
			}
		}
	}

	.view-chip__name {
		max-width: 150px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.view-chip__delete {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		margin: -4px -6px -4px 0;
		background: none;
		border: none;
		border-radius: 50%;
		cursor: pointer;
		color: var(--theme-neutral-500);
		transition: all 0.15s ease;

		&:hover {
			color: var(--theme-neutral-800);
			background-color: rgba(0, 0, 0, 0.1);
		}
	}

	.view-save-input {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 1);
	}

	.view-name-input {
		height: 44px;
		padding: 0 calc(var(--spacing-unit) * 2);
		font-size: 0.875rem;
		border: 1px solid var(--theme-primary);
		border-radius: var(--rounded-sm);
		background-color: var(--theme-neutral-100);
		color: var(--theme-text);
		width: 160px;

		&:focus {
			outline: none;
			box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2);
		}
	}

	.view-save-confirm {
		height: 44px;
		padding: 0 calc(var(--spacing-unit) * 3);
		font-size: 0.875rem;
		font-weight: 500;
		background-color: var(--theme-primary);
		border: none;
		border-radius: var(--rounded-sm);
		color: white;
		cursor: pointer;
		transition: background-color 0.15s ease;

		&:hover:not(:disabled) {
			background-color: var(--theme-primary-hover);
		}

		&:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
	}

	.view-add-btn {
		display: inline-flex;
		align-items: center;
		box-sizing: border-box;
		gap: calc(var(--spacing-unit) * 1.5);
		height: 44px;
		padding: 0 calc(var(--spacing-unit) * 3);
		font-family: inherit;
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1;
		background: none;
		border: 1px dashed var(--theme-neutral-400);
		border-radius: var(--rounded-sm);
		color: var(--theme-neutral-500);
		cursor: pointer;
		transition: all 0.15s ease;

		&:hover {
			border-color: var(--theme-primary);
			color: var(--theme-primary);
			background-color: var(--theme-neutral-100);
		}
	}

	.add-pane-btn {
		display: flex;
		align-items: center;
		gap: calc(var(--spacing-unit) * 1);
		height: 36px;
		padding: 0 calc(var(--spacing-unit) * 2);
		border: 1px solid var(--theme-primary);
		border-radius: var(--rounded-md);
		background-color: transparent;
		color: var(--theme-primary);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;

		&:hover {
			background-color: var(--theme-primary);
			color: white;
		}
	}


	.error {
		margin: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 2);
		background-color: var(--theme-error-100);
		color: var(--theme-error-700);
		border-radius: var(--rounded-md);
		font-size: 14px;
	}

	.panes {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: calc(var(--spacing-unit) * 2);
		padding: calc(var(--spacing-unit) * 2);
	}

	.tooltip-wrapper {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 100;
		overflow: visible;
	}

	@media (max-width: 768px) {
		.controls {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: calc(var(--spacing-unit) * 2);
		}

		.control-group {
			min-width: 0;

			&--end {
				grid-column: 1 / -1;
				margin-left: 0;
			}
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
</style>
