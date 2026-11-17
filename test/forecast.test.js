import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationStore } from '../src/observation-store.js';
import { ForecastLedger } from '../src/forecast-ledger.js';
import { ServiceValueStore } from '../src/service-value-store.js';
import { collectOnce } from '../src/collector.js';
import { applyCalibration } from '../src/calibration.js';
import { startSource } from '../source/server.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const calibrations = [
  { version: 'c1', source: 'sensor', metric: 'rainfall-total', multiplier: 1, unit: 'mm' },
  { version: 'c2', source: 'sensor', metric: 'rainfall-total', multiplier: 1.1, unit: 'mm' },
];

test('issued forecast freezes the original observation and calibration basis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forecast-'));
  const source = await startSource(scenarioPath);
  try {
    const observationStore = new ObservationStore(join(directory, 'observations.json'));
    const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));
    const ledger = new ForecastLedger(join(directory, 'forecasts.json'));

    await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    const issued = await ledger.issue({
      observationId: 's1-08', observationStore, calibrations, calibrate: applyCalibration,
      id: 'issued-1', issuedAt: '2026-11-16T08:30:00Z',
    });
    assert.equal(issued.value, 2);
    assert.equal(issued.basis.rawValue, 2);
    assert.equal(issued.basis.calibrationVersion, 'c1');
    assert.equal(issued.immutable, true);

    // 撤回与 c2 上线后重评估
    source.publish('updated');
    await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
    source.publish('backup');
    await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });

    const frozen = (await ledger.list()).find((entry) => entry.id === 'issued-1');
    assert.equal(frozen.value, 2, '已发提示不随当前校准升级改写');
    assert.equal(frozen.basis.calibration, 'c1');
    assert.equal(frozen.basis.calibrationVersion, 'c1');
    assert.equal(frozen.basis.rawValue, 2);
    assert.equal(frozen.state, 'active', '冻结的是发出时刻的观测状态');

    const current = await serviceValueStore.current();
    const sensorSlot = current.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(sensorSlot.serviceValue, 2.75, '当前服务值已切换到 c2 与备用传感器');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('frozen baseline ledger is read-only and marked as legacy', async () => {
  const legacy = await ForecastLedger.readFrozen(new URL('../fixtures/forecasts.json', import.meta.url));
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].value, 2);
  assert.equal(legacy[0].calibration, 'c1');
  assert.equal(legacy[0].frozenLegacy, true);
  const missing = await ForecastLedger.readFrozen(new URL('../fixtures/does-not-exist.json', import.meta.url));
  assert.deepEqual(missing, []);
});

test('issuing for an unknown observation fails without writing anything', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forecast-err-'));
  try {
    const observationStore = new ObservationStore(join(directory, 'observations.json'));
    const ledger = new ForecastLedger(join(directory, 'forecasts.json'));
    await assert.rejects(
      ledger.issue({ observationId: 'nope', observationStore, calibrations, calibrate: applyCalibration }),
      /not in the archive/,
    );
    assert.deepEqual(await ledger.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
