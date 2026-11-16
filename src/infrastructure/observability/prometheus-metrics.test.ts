import { describe, expect, test } from 'bun:test';
import { MetricName } from '../../application/ports/observability';
import { GaugeName, METRIC_CATALOG, type MetricDefinition } from './metric-catalog';
import { PrometheusMetrics } from './prometheus-metrics';

const CATALOG: Record<string, MetricDefinition> = {
  eventos_total: { type: 'counter', help: 'Eventos.' },
  por_motivo_total: { type: 'counter', help: 'Eventos por motivo.', labels: ['reason', 'kind'] },
  duracao_seconds: { type: 'histogram', help: 'Duração.', buckets: [0.1, 0.5, 1] },
  fila_mensagens: { type: 'gauge', help: 'Mensagens na fila.' },
};

describe('PrometheusMetrics', () => {
  test('contador: soma por conjunto de labels, e a ordem dos labels não cria outra série', () => {
    const metrics = new PrometheusMetrics(CATALOG);

    metrics.increment('por_motivo_total', { reason: 'A', kind: 'X' });
    metrics.increment('por_motivo_total', { kind: 'X', reason: 'A' }, 4);
    metrics.increment('por_motivo_total', { reason: 'B', kind: 'X' });

    expect(metrics.value('por_motivo_total', { reason: 'A', kind: 'X' })).toBe(5);
    expect(metrics.value('por_motivo_total', { reason: 'B', kind: 'X' })).toBe(1);
    expect(metrics.value('por_motivo_total', { reason: 'C', kind: 'X' })).toBe(0);
  });

  test('contador sem label aparece com 0 antes do primeiro evento', () => {
    const text = new PrometheusMetrics(CATALOG).render();

    expect(text).toContain('# HELP eventos_total Eventos.\n# TYPE eventos_total counter\neventos_total 0\n');
  });

  test('contador com label não ganha uma série sem label: só o cabeçalho até o primeiro evento', () => {
    const metrics = new PrometheusMetrics(CATALOG);
    expect(metrics.render()).toContain('# TYPE por_motivo_total counter\n# HELP duracao_seconds');

    metrics.increment('por_motivo_total', { reason: 'A', kind: 'X' });
    expect(metrics.render()).toContain('# TYPE por_motivo_total counter\npor_motivo_total{reason="A",kind="X"} 1\n');
  });

  test('histograma: buckets acumulados, +Inf, soma e contagem', () => {
    const metrics = new PrometheusMetrics(CATALOG);

    for (const seconds of [0.05, 0.1, 0.3, 0.7, 4]) {
      metrics.observe('duracao_seconds', seconds, { source: 'http' });
    }

    const lines = metrics.render().split('\n');
    expect(lines).toContain('# TYPE duracao_seconds histogram');
    // 0.1 inclui o próprio limite (le = "menor ou igual").
    expect(lines).toContain('duracao_seconds_bucket{source="http",le="0.1"} 2');
    expect(lines).toContain('duracao_seconds_bucket{source="http",le="0.5"} 3');
    expect(lines).toContain('duracao_seconds_bucket{source="http",le="1"} 4');
    expect(lines).toContain('duracao_seconds_bucket{source="http",le="+Inf"} 5');
    expect(lines).toContain('duracao_seconds_sum{source="http"} 5.15');
    expect(lines).toContain('duracao_seconds_count{source="http"} 5');
    expect(metrics.observations('duracao_seconds', { source: 'http' })).toBe(5);
    expect(metrics.observations('duracao_seconds', { source: 'sqs' })).toBe(0);
  });

  test('observar uma métrica que não é histograma do catálogo é erro de programação', () => {
    const metrics = new PrometheusMetrics(CATALOG);

    expect(() => metrics.observe('eventos_total', 1)).toThrow('não é um histograma');
  });

  test('gauges recebidos no render saem com os seus labels; gauge sem amostra fica só com o cabeçalho', () => {
    const metrics = new PrometheusMetrics(CATALOG);

    const withSamples = metrics.render([
      { name: 'fila_mensagens', labels: { state: 'visible' }, value: 3 },
      { name: 'fila_mensagens', labels: { state: 'in_flight' }, value: 0.123456789 },
    ]);
    expect(withSamples).toContain('fila_mensagens{state="visible"} 3\n');
    expect(withSamples).toContain('fila_mensagens{state="in_flight"} 0.123457\n');

    const withoutSamples = metrics.render();
    expect(withoutSamples).toContain('# TYPE fila_mensagens gauge\n');
    expect(withoutSamples).not.toContain('fila_mensagens{');
  });

  test('valor de label com aspas, barra e quebra de linha é escapado', () => {
    const metrics = new PrometheusMetrics(CATALOG);

    metrics.increment('por_motivo_total', { reason: 'a"b\\c\nd' });

    expect(metrics.render()).toContain('por_motivo_total{reason="a\\"b\\\\c\\nd"} 1\n');
  });
});

describe('catálogo de métricas', () => {
  test('toda métrica que o código registra tem tipo e descrição no catálogo', () => {
    for (const name of [...Object.values(MetricName), ...Object.values(GaugeName)]) {
      expect(METRIC_CATALOG[name]?.help, name).toBeString();
    }
  });

  test('toda métrica de duração é histograma com buckets crescentes', () => {
    for (const [name, definition] of Object.entries(METRIC_CATALOG)) {
      if (definition.type !== 'histogram') continue;
      const buckets = definition.buckets ?? [];
      expect(buckets.length, name).toBeGreaterThan(0);
      expect([...buckets].sort((a, b) => a - b), name).toEqual([...buckets]);
    }
  });
});
