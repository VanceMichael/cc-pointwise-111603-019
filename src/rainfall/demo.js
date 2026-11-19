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

const scenarioPath = new URL('../../fixtures/rainfall-scenario.json', import.meta.url);
const calibrationPath = new URL('../../fixtures/calibrations.json', import.meta.url);
const expectedSeries = [
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-total', unit: 'mm' },
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-estimate', unit: 'mm' },
];

const source = await startSource(scenarioPath);
const directory = await mkdtemp(join(tmpdir(), 'rainfall-demo-'));
try {
  const catalog = new CalibrationCatalog(JSON.parse(await readFile(calibrationPath, 'utf8')));
  const store = new ObservationStore(join(directory, 'observations.json'));
  const ledger = new ForecastLedger(join(directory, 'forecasts.jsonl'));
  await store.load();
  const client = new TrackedSourceClient(source.url);
  const evaluations = [];

  const stage = async (name, now) => {
    const result = await collectOnce({
      client, store, catalog, routes: ROUTES, expectedSeries,
      previousEvaluations: evaluations, now,
    });
    evaluations.push(result.evaluation);
    console.log(`\n=== ${name} @ ${now} ===`);
    for (const row of result.values) {
      console.log(JSON.stringify({
        series: row.seriesKey,
        status: row.status,
        value: row.value,
        selected: row.selectedObservationId,
        calibration: row.calibrationVersion,
        uncertainty: row.uncertainty,
      }));
    }
    return result;
  };

  const opening = await stage('首采：两口径各自入库，传感器优先且网页不覆盖', '2026-11-16T08:10:00Z');
  const sensorSeries = opening.values.find((row) => row.metric === 'rainfall-total');
  const issued = await ledger.issue(sensorSeries, { id: 'demo-issued-1', issuedAt: '2026-11-16T08:30:00Z', message: '8 时小时降雨提示' });
  console.log('\n=== 已发农户提示（固化依据，之后不可改写）===');
  console.log(JSON.stringify({ id: issued.id, value: issued.value, basis: issued.basis }));

  source.publish('revised');
  await stage('来源修订晚到：重新评估并标 late-arrival', '2026-11-16T08:40:00Z');

  source.publish('withdrawn');
  await stage('来源撤回：服务值 withdrawn/null，绝不补零，网页估值不顶替', '2026-11-16T09:10:00Z');

  source.publish('late-replacement');
  await stage('晚到替换观测：恢复服务值，按其引用的 c2 校准并保留不确定性', '2026-11-16T10:10:00Z');

  const verdicts = await ledger.verifyAgainst(store, catalog);
  console.log('\n=== 已发提示依据核对（只核对，账本一条未改）===');
  console.log(JSON.stringify(verdicts, null, 2));
  console.log(`\n状态目录（演示结束清理）：${directory}`);
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
