import * as d3 from 'd3';
import type { MetricInfo } from './types';

// Color palette using hex values (CSS variables don't work in SVG fill attributes)
export const CHART_COLORS = [
	'#14b8a6', // teal-500
	'#a855f7', // purple-500
	'#06b6d4', // cyan-500
	'#f59e0b', // amber-500
	'#f43f5e', // rose-500
	'#84cc16', // lime-500
	'#6366f1', // indigo-500
	'#f97316' // orange-500
];

// Create a color scale for metrics
export function createColorScale(metrics: MetricInfo[]): d3.ScaleOrdinal<string, string> {
	return d3
		.scaleOrdinal<string>()
		.domain(metrics.map((m) => getMetricKey(m)))
		.range(CHART_COLORS);
}

// Create a unique key for a metric
export function getMetricKey(metric: MetricInfo): string {
	return `${metric.groupId}/${metric.nodeId}/${metric.deviceId}/${metric.metricId}`;
}

// Format date based on time range span
export function formatDate(date: Date, rangeMs: number): string {
	if (rangeMs <= 3600000) {
		// <= 1 hour: show HH:MM:SS
		return d3.timeFormat('%H:%M:%S')(date);
	} else if (rangeMs <= 86400000) {
		// <= 1 day: show HH:MM
		return d3.timeFormat('%H:%M')(date);
	} else if (rangeMs <= 7 * 86400000) {
		// <= 1 week: show MM/DD HH:MM
		return d3.timeFormat('%m/%d %H:%M')(date);
	} else {
		// > 1 week: show MM/DD
		return d3.timeFormat('%m/%d')(date);
	}
}

// Format value for display
export function formatValue(value: number): string {
	if (Math.abs(value) >= 1000000) {
		return d3.format('.2s')(value);
	} else if (Math.abs(value) >= 100) {
		return d3.format('.1f')(value);
	} else if (Math.abs(value) >= 1) {
		return d3.format('.2f')(value);
	} else {
		return d3.format('.3f')(value);
	}
}

// Format timestamp for tooltip
export function formatTimestamp(date: Date): string {
	return d3.timeFormat('%Y-%m-%d %H:%M:%S')(date);
}

// Calculate nice axis tick count based on width
export function getTickCount(width: number): number {
	if (width < 400) return 3;
	if (width < 600) return 5;
	if (width < 800) return 7;
	return 10;
}

// Parse ISO string to Date
export function parseTimestamp(timestamp: string): Date {
	return new Date(timestamp);
}

// Get computed CSS variable value
export function getCSSVariable(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}