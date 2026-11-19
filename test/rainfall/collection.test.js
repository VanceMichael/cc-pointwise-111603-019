import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../../source/server.js';
import { TrackedSourceClient } from '../../src/rainfall/source-client.js';
import { CalibrationCatalog } from '../../src/rainfall/calibrations.js';
import { ObservationStore } from '../../src/rainfall/observation-store.js';
import { collectOnce } from '../../src/rainfall/collection.js';
import { ROUTES } from '../../src/rainfall/adapter.js';
import { STATUS, UNCERTAINTY } from '../../src/rainfall/evaluation.js';

const scenarioPath = new URL('../../fixtures/rainfall-scenario.json', import.meta.url);
const catalog = new CalibrationCatalog([
  { version: 'c1', source: 'sensor', metric: 'rainfall-total', multiplier: 1, unit: 'mm' },
  { version: 'c2', source: 'sensor', metric: 'rainfall-total', multiplier: 1.1, unit: 'mm', effectiveFrom: '2026-11-16T00:00:00Z' },
]);
const expectedSeries = [
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-total', unit: 'mm' },
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-estimate', unit: 'mm' },
];

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'rainfall-collect-'));
  const source = await startSource(scenarioPath);
  const store = new ObservationStore(join(directory, 'observations.json'));
  await store.load();
  return {
    directory,
    source,
    store,
    client: new TrackedSourceClient(source.url),
    cleanup: async () => { await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('多源首采：两个口径各自入库，网页估值不覆盖传感器原值', async () => {
  const h = await harness();
  try {
    const result = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, now: '2026-11-16T08:10:00Z',
    });
    const outcomes = Object.fromEntries(result.routeResults.map((route) => [route.source, route.outcome]));
    assert.deepEqual(outcomes, { sensor: 'updated', web: 'updated' });
    const sensorRow = result.values.find((row) => row.metric === 'rainfall-total');
    const webRow = result.values.find((row) => row.metric === 'rainfall-estimate');
    assert.equal(sensorRow.value, 2);
    assert.equal(sensorRow.selectedSource, 'sensor');
    assert.equal(webRow.value, 3);
    assert.ok(webRow.uncertainty.includes(UNCERTAINTY.WEB_ESTIMATE));
  } finally { await h.cleanup(); }
});

test('ETag 304 重采不产生重复版本；来源 503 只记可用性事件且不把缺失写成零', async () => {
  const h = await harness();
  try {
    await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, now: '2026-11-16T08:10:00Z',
    });
    h.source.failNext('/weather/sensor-1', 503);
    const second = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, now: '2026-11-16T08:20:00Z',
    });
    const sensorRoute = second.routeResults.find((route) => route.source === 'sensor');
    const webRoute = second.routeResults.find((route) => route.source === 'web');
    assert.equal(sensorRoute.outcome, 'unavailable');
    assert.equal(webRoute.outcome, 'not-modified');
    assert.equal(h.store.history('s1-08').length, 1, '304 与失败都不产生新版本');
    const sensorRow = second.values.find((row) => row.metric === 'rainfall-total');
    assert.equal(sensorRow.value, 2, '保留上次观测值');
    assert.ok(sensorRow.uncertainty.includes(UNCERTAINTY.SOURCE_UNAVAILABLE));
    assert.ok(sensorRow.uncertainty.includes(UNCERTAINTY.STALE));
  } finally { await h.cleanup(); }
});

test('来源撤回后重新评估为 withdrawn/null；晚到替换恢复服务值并标注不确定性', async () => {
  const h = await harness();
  try {
    const first = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, now: '2026-11-16T08:10:00Z',
    });
    const evaluations = [first.evaluation];

    h.source.publish('revised');
    const revised = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, previousEvaluations: evaluations, now: '2026-11-16T08:40:00Z',
    });
    evaluations.push(revised.evaluation);
    const revisedRow = revised.values.find((row) => row.metric === 'rainfall-total');
    assert.equal(revisedRow.value, 2.4, '迟到修订重新评估当前服务值');
    assert.ok(revisedRow.uncertainty.includes(UNCERTAINTY.LATE_ARRIVAL));

    h.source.publish('withdrawn');
    const withdrawn = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, previousEvaluations: evaluations, now: '2026-11-16T09:10:00Z',
    });
    evaluations.push(withdrawn.evaluation);
    const withdrawnRow = withdrawn.values.find((row) => row.metric === 'rainfall-total');
    assert.equal(withdrawnRow.status, STATUS.WITHDRAWN);
    assert.equal(withdrawnRow.value, null);
    assert.equal(withdrawnRow.zeroAssumed, false);
    const webStillIndependent = withdrawn.values.find((row) => row.metric === 'rainfall-estimate');
    assert.equal(webStillIndependent.selectedObservationId, 'p1-08');

    h.source.publish('late-replacement');
    const replaced = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, previousEvaluations: evaluations, now: '2026-11-16T10:10:00Z',
    });
    const replacedRow = replaced.values.find((row) => row.metric === 'rainfall-total');
    assert.equal(replacedRow.selectedObservationId, 's1-08b');
    assert.equal(replacedRow.value, 1.98);
    assert.equal(replacedRow.calibrationVersion, 'c2');
    assert.ok(replacedRow.uncertainty.includes(UNCERTAINTY.LATE_ARRIVAL));
    assert.equal(replacedRow.status, STATUS.UNCERTAIN);
  } finally { await h.cleanup(); }
});

test('断开连接被记为来源不可用事件，不产生任何零值观测', async () => {
  const h = await harness();
  try {
    await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, now: '2026-11-16T08:10:00Z',
    });
    h.source.failNext('/weather/sensor-1', 'disconnect');
    const result = await collectOnce({
      client: h.client, store: h.store, catalog, routes: ROUTES,
      expectedSeries, now: '2026-11-16T08:25:00Z',
    });
    const sensorRoute = result.routeResults.find((route) => route.source === 'sensor');
    assert.equal(sensorRoute.outcome, 'unavailable');
    const events = h.store.availabilityEvents('sensor');
    assert.equal(events.length, 1);
    assert.ok(result.values.every((row) => row.value !== 0));
  } finally { await h.cleanup(); }
});

test('TrackedSourceClient 仍只接受回环来源并校验 origin', () => {
  assert.throws(() => new TrackedSourceClient('https://example.com'), /local source required/);
});
