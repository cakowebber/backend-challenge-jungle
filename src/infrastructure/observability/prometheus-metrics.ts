import type { MetricLabels, Metrics } from '../../application/ports/observability';
import { METRIC_CATALOG, type MetricDefinition } from './metric-catalog';

export interface GaugeSample {
  readonly name: string;
  readonly labels?: MetricLabels;
  readonly value: number;
}

interface CounterSeries {
  labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  labels: MetricLabels;
  counts: number[];
  sum: number;
  count: number;
}

export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<string, Map<string, CounterSeries>>();
  private readonly histograms = new Map<string, Map<string, HistogramSeries>>();

  constructor(private readonly catalog: Readonly<Record<string, MetricDefinition>> = METRIC_CATALOG) {}

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    const series = seriesOf(this.counters, name);
    const key = labelKey(labels);
    const current = series.get(key);
    if (current === undefined) {
      series.set(key, { labels, value: by });
    } else {
      current.value += by;
    }
  }

  observe(name: string, seconds: number, labels: MetricLabels = {}): void {
    const buckets = this.bucketsOf(name);
    const series = seriesOf(this.histograms, name);
    const key = labelKey(labels);
    let current = series.get(key);
    if (current === undefined) {
      current = { labels, counts: new Array<number>(buckets.length + 1).fill(0), sum: 0, count: 0 };
      series.set(key, current);
    }
    const position = buckets.findIndex((upperBound) => seconds <= upperBound);
    const index = position === -1 ? buckets.length : position;
    current.counts[index] = (current.counts[index] ?? 0) + 1;
    current.sum += seconds;
    current.count += 1;
  }

  value(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels))?.value ?? 0;
  }

  observations(name: string, labels: MetricLabels = {}): number {
    let total = 0;
    for (const series of this.histograms.get(name)?.values() ?? []) {
      if (Object.entries(labels).every(([label, value]) => series.labels[label] === value)) {
        total += series.count;
      }
    }
    return total;
  }

  render(gauges: readonly GaugeSample[] = []): string {
    const lines: string[] = [];
    for (const [name, definition] of Object.entries(this.catalog)) {
      lines.push(`# HELP ${name} ${definition.help}`, `# TYPE ${name} ${definition.type}`);
      switch (definition.type) {
        case 'counter':
          lines.push(...this.renderCounter(name, (definition.labels ?? []).length > 0));
          break;
        case 'histogram':
          lines.push(...this.renderHistogram(name));
          break;
        case 'gauge':
          for (const sample of gauges) {
            if (sample.name === name) {
              lines.push(`${name}${formatLabels(sample.labels ?? {})} ${formatNumber(sample.value)}`);
            }
          }
          break;
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private renderCounter(name: string, labeled: boolean): string[] {
    const series = [...(this.counters.get(name)?.values() ?? [])];
    if (series.length === 0) {
      return labeled ? [] : [`${name} 0`];
    }
    return series.map((entry) => `${name}${formatLabels(entry.labels)} ${formatNumber(entry.value)}`);
  }

  private renderHistogram(name: string): string[] {
    const buckets = this.bucketsOf(name);
    const lines: string[] = [];
    for (const entry of this.histograms.get(name)?.values() ?? []) {
      let cumulative = 0;
      buckets.forEach((upperBound, index) => {
        cumulative += entry.counts[index] ?? 0;
        lines.push(`${name}_bucket${formatLabels({ ...entry.labels, le: String(upperBound) })} ${cumulative}`);
      });
      lines.push(
        `${name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`,
        `${name}_sum${formatLabels(entry.labels)} ${formatNumber(entry.sum)}`,
        `${name}_count${formatLabels(entry.labels)} ${entry.count}`,
      );
    }
    return lines;
  }

  private bucketsOf(name: string): readonly number[] {
    const buckets = this.catalog[name]?.buckets;
    if (buckets === undefined) {
      throw new Error(`métrica "${name}" não é um histograma do catálogo`);
    }
    return buckets;
  }
}

function seriesOf<T>(store: Map<string, Map<string, T>>, name: string): Map<string, T> {
  let series = store.get(name);
  if (series === undefined) {
    series = new Map<string, T>();
    store.set(name, series);
  }
  return series;
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label]}`)
    .join(',');
}

function formatLabels(labels: MetricLabels): string {
  const pairs = Object.entries(labels).map(([label, value]) => `${label}="${escapeLabelValue(value)}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
