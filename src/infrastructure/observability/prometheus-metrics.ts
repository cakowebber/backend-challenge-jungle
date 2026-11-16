import type { MetricLabels, Metrics } from '../../application/ports/observability';
import { METRIC_CATALOG, type MetricDefinition } from './metric-catalog';

/** Um valor de gauge lido na hora do scrape. */
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
  /** Observações por bucket (não acumulado); a última posição é o +Inf. */
  counts: number[];
  sum: number;
  count: number;
}

/**
 * Métricas do processo, em memória, expostas no formato texto do Prometheus.
 *
 * Sem biblioteca: são três tipos (contador, gauge, histograma de buckets
 * fixos) e um formato de texto estável. Os valores são do processo e zeram
 * quando ele reinicia — o Prometheus trata isso em `rate()`; com várias
 * instâncias, cada uma expõe o seu /metrics e a soma é feita na consulta.
 */
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

  /** Valor atual de um contador (para os testes). */
  value(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels))?.value ?? 0;
  }

  /** Quantas observações um histograma recebeu, somando as séries que têm estes labels (para os testes). */
  observations(name: string, labels: MetricLabels = {}): number {
    let total = 0;
    for (const series of this.histograms.get(name)?.values() ?? []) {
      if (Object.entries(labels).every(([label, value]) => series.labels[label] === value)) {
        total += series.count;
      }
    }
    return total;
  }

  /**
   * Texto de /metrics: tudo que está no catálogo, na ordem do catálogo, mais
   * os gauges recebidos. Contador sem label aparece com 0 desde o início, para
   * a série existir antes do primeiro evento. Contador com label só ganha
   * séries quando o evento acontece (não dá para adivinhar os valores do label).
   */
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
      // No formato do Prometheus os buckets são ACUMULADOS: cada `le` conta
      // todas as observações menores ou iguais a ele.
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

/** Identidade de uma série: os labels em ordem alfabética. */
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

/** Escapes exigidos pelo formato: barra invertida, aspas e quebra de linha. */
function escapeLabelValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}
