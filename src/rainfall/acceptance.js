import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../../source/server.js';
import { TrackedSourceClient } from './source-client.js';
import { CalibrationCatalog } from './calibrations.js';
import { ObservationStore } from './observation-store.js';
import { ForecastLedger } from './forecast-ledger.js';
import { collectOnce } from './collection.js';
import { ROUTES } from './adapter.js';
import { STATUS, UNCERTAINTY } from './evaluation.js';

const scenarioPath = new URL('../../fixtures/rainfall-scenario.json', import.meta.url);
const calibrationPath = new URL('../../fixtures/calibrations.json', import.meta.url);
const expectedSeries = [
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-total', unit: 'mm' },
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-estimate', unit: 'mm' },
];

const source = await startSource(scenarioPath);
const directory = await mkdtemp(join(tmpdir(), 'rainfall-acceptance-'));
try {
  const catalog = new CalibrationCatalog(JSON.parse(await readFile(calibrationPath, 'utf8')));
  const storePath = join(directory, 'observations.json');
  const store = new ObservationStore(storePath);
  const ledger = new ForecastLedger(join(directory, 'forecasts.jsonl'));
  await store.load();
  const client = new TrackedSourceClient(source.url);
  const evaluations = [];
  const collect = async (now) => {
    const result = await collectOnce({
      client, store, catalog, routes: ROUTES, expectedSeries,
      previousEvaluations: evaluations, now,
    });
    evaluations.push(result.evaluation);
    return result;
  };
  const sensorRowOf = (result) => result.values.find((row) => row.metric === 'rainfall-total');
  const webRowOf = (result) => result.values.find((row) => row.metric === 'rainfall-estimate');

  // 1. 首采：单位/时段/来源/校准版本全部可追溯；网页估值与传感器原值分属不同口径。
  const opening = await collect('2026-11-16T08:10:00Z');
  assert.equal(sensorRowOf(opening).value, 2);
  assert.equal(sensorRowOf(opening).calibrationVersion, 'c1');
  assert.equal(webRowOf(opening).selectedObservationId, 'p1-08');
  assert.equal(webRowOf(opening).calibrationApplied, false);
  assert.ok(webRowOf(opening).uncertainty.includes(UNCERTAINTY.WEB_ESTIMATE));

  // 2. 已发提示固化发出时刻的观测签名与校准依据。
  const issued = await ledger.issue(sensorRowOf(opening), { id: 'acceptance-issued-1', issuedAt: '2026-11-16T08:30:00Z' });
  assert.equal(issued.basis.observationSignature, store.latestVersion('s1-08').signature);

  // 3. ETag 304 重采不产生新版本。
  const replay = await collect('2026-11-16T08:15:00Z');
  assert.ok(replay.routeResults.every((route) => route.outcome === 'not-modified'));
  assert.equal(store.history('s1-08').length, 1);

  // 4. 晚到修订重新评估当前服务值并标不确定性；已发记录不变。
  source.publish('revised');
  const revised = await collect('2026-11-16T08:40:00Z');
  assert.equal(sensorRowOf(revised).value, 2.4);
  assert.ok(sensorRowOf(revised).uncertainty.includes(UNCERTAINTY.LATE_ARRIVAL));
  assert.equal((await ledger.list())[0].value, 2);

  // 5. 撤回：当前服务值 withdrawn/null，不补零，网页估值不顶替，历史版本保留。
  source.publish('withdrawn');
  const withdrawn = await collect('2026-11-16T09:10:00Z');
  assert.equal(sensorRowOf(withdrawn).status, STATUS.WITHDRAWN);
  assert.equal(sensorRowOf(withdrawn).value, null);
  assert.equal(webRowOf(withdrawn).selectedObservationId, 'p1-08');
  assert.equal(store.history('s1-08').length, 3);
  await assert.rejects(ledger.issue(sensorRowOf(withdrawn)), /refuse to issue/);

  // 6. 晚到替换恢复服务值，按观测自己引用的 c2 校准，仍标不确定性。
  source.publish('late-replacement');
  const replaced = await collect('2026-11-16T10:10:00Z');
  assert.equal(sensorRowOf(replaced).selectedObservationId, 's1-08b');
  assert.equal(sensorRowOf(replaced).value, 1.98);
  assert.equal(sensorRowOf(replaced).calibrationVersion, 'c2');
  assert.ok(sensorRowOf(replaced).uncertainty.includes(UNCERTAINTY.LATE_ARRIVAL));

  // 7. 来源故障只产生可用性事件：不写零值，不产生新版本。
  source.failNext('/weather/sensor-1', 503);
  const degraded = await collect('2026-11-16T10:20:00Z');
  assert.equal(degraded.routeResults.find((route) => route.source === 'sensor').outcome, 'unavailable');
  assert.ok(degraded.values.every((row) => row.value !== 0));
  assert.equal(store.availabilityEvents('sensor').length, 1);

  // 8. 已发账本只追加：从头到尾仍是同一条 c1/value=2 的原始依据，并能核对出已被取代。
  const entries = await ledger.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 2);
  assert.equal(entries[0].basis.calibrationVersion, 'c1');
  const verdicts = await ledger.verifyAgainst(store, catalog);
  assert.equal(verdicts[0].basisStillHolds, false);
  assert.equal(verdicts[0].current, 'superseded');

  // 9. 重启回读：版本库、ETag 与可用性事件从同一状态文件恢复。
  const reopened = new ObservationStore(storePath);
  await reopened.load();
  assert.equal(reopened.history('s1-08').length, 3);
  assert.equal(reopened.etagFor('/weather/sensor-1'), '"late-sensor"');
  assert.equal(reopened.availabilityEvents('sensor').length, 1);

  console.log(JSON.stringify({
    stages: 5,
    issuedRecords: entries.length,
    issuedValueFrozen: entries[0].value,
    finalServiceValue: sensorRowOf(replaced).value,
    status: 'ok',
  }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
