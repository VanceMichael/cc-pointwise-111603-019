import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { ObservationStore } from '../src/observation-store.js';
import { ServiceValueStore } from '../src/service-value-store.js';
import { collectOnce } from '../src/collector.js';
import { SourceClient } from '../src/source-client.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const calibrations = [
  { version: 'c1', source: 'sensor', metric: 'rainfall-total', multiplier: 1, unit: 'mm' },
  { version: 'c2', source: 'sensor', metric: 'rainfall-total', multiplier: 1.1, unit: 'mm' },
];

test('collector re-evaluates service values across opening, withdrawal and late backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-'));
  const source = await startSource(scenarioPath);
  try {
    const observationStore = new ObservationStore(join(directory, 'observations.json'));
    const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));

    const opening = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    assert.equal(opening.appended, 3);
    assert.equal(opening.sourceGaps.length, 0);
    const slotKey = opening.evaluation.values.find((value) => value.metric === 'rainfall-total').slot;
    assert.equal(opening.evaluation.values.find((value) => value.slot === slotKey).serviceValue, 2);

    // 重放同一来源：无新版本，服务值不产生新修订
    const replay = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    assert.equal(replay.appended, 0);
    assert.equal((await serviceValueStore.revisions()).length, 2, '两个指标槽各一条初始修订，重放不追加');

    source.publish('updated');
    const updated = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    const uncertain = updated.evaluation.values.find((value) => value.slot === slotKey);
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.serviceValue, null);
    assert.equal(updated.evaluation.values.find((value) => value.metric === 'rainfall-estimate').serviceValue, 3,
      '网页估值仍在自己槽位，没有覆盖传感器槽');

    source.publish('backup');
    const backup = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    const recovered = backup.evaluation.values.find((value) => value.slot === slotKey);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.serviceValue, 2.75);
    assert.equal(recovered.selected.observationId, 's2-08');

    const revisions = await serviceValueStore.revisions();
    assert.ok(revisions.length >= 3, '初次、撤回、恢复各留修订轨迹');
    assert.ok(revisions.some((revision) => revision.after.status === 'uncertain'));
    assert.ok(revisions.some((revision) => revision.after.serviceValue === 2.75));
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('collector marks a 503 route as a source gap and keeps prior observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-gap-'));
  const source = await startSource(scenarioPath);
  try {
    const observationStore = new ObservationStore(join(directory, 'observations.json'));
    const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));
    await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });

    source.failNext('/weather/sensor-1', 503);
    const result = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    assert.equal(result.routes['/weather/sensor-1'].status, 'error');
    assert.equal(result.sourceGaps[0].route, '/weather/sensor-1');
    const sensorSlot = result.evaluation.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(sensorSlot.serviceValue, 2, '失败轮次保留上一轮观测，不删除也不当零');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a dropped connection becomes a source gap and never synthesizes a zero value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-disconnect-'));
  const source = await startSource(scenarioPath);
  try {
    const observationStore = new ObservationStore(join(directory, 'observations.json'));
    const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));
    await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });

    source.failNext('/weather/sensor-1', 'disconnect');
    const result = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    assert.match(result.routes['/weather/sensor-1'].error, /connection closed/);
    assert.equal(result.sourceGaps[0].route, '/weather/sensor-1');
    const sensorSlot = result.evaluation.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(sensorSlot.serviceValue, 2);
    assert.equal(sensorSlot.status, 'ok', '其他路由仍成功时既有服务值保持可用');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('collected versions retain route and etag provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collector-provenance-'));
  const source = await startSource(scenarioPath);
  try {
    const observationStore = new ObservationStore(join(directory, 'observations.json'));
    const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));
    await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    const versions = await observationStore.allVersions();
    const sensor = versions.find((entry) => entry.observationId === 's1-08');
    assert.equal(sensor.route, '/weather/sensor-1');
    assert.equal(sensor.etag, '"opening"');
    assert.equal(sensor.observation.unit, 'mm');
    assert.equal(sensor.observation.durationMinutes, 60);
    const direct = await new SourceClient(source.url).read('/weather/sensor-1');
    assert.equal(direct.etag, '"opening"');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
