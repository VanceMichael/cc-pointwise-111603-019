import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CalibrationCatalog } from '../../src/rainfall/calibrations.js';
import { normalizeObservation } from '../../src/rainfall/observations.js';

async function loadCatalog() {
  const entries = JSON.parse(await readFile(new URL('../../fixtures/calibrations.json', import.meta.url), 'utf8'));
  return new CalibrationCatalog(entries);
}

const sensorAt = (overrides = {}) => normalizeObservation({
  observationId: 's1-08',
  source: 'sensor',
  station: 'S1',
  intervalEnd: '2026-11-16T08:00:00Z',
  durationMinutes: 60,
  metric: 'rainfall-total',
  value: 2,
  unit: 'mm',
  calibration: 'c1',
  state: 'active',
  ...overrides,
}).observation;

test('校准版本与观测来源/指标/单位匹配时才应用，并保留乘数与版本依据', async () => {
  const catalog = await loadCatalog();
  const result = catalog.apply(sensorAt());
  assert.equal(result.applied, true);
  assert.equal(result.calibrationVersion, 'c1');
  assert.equal(result.multiplier, 1);
  assert.equal(result.value, 2);
});

test('c2 校准带生效时间，早于生效时间的观测不会被提前套用', async () => {
  const catalog = await loadCatalog();
  const before = catalog.apply(sensorAt({ calibration: 'c2', intervalEnd: '2026-11-15T08:00:00Z' }));
  assert.equal(before.applied, false);
  assert.equal(before.reason, 'calibration-scope-mismatch');
  assert.equal(before.value, 2, '不套用时保留原值');
  const after = catalog.apply(sensorAt({ calibration: 'c2' }));
  assert.equal(after.applied, true);
  assert.equal(after.value, 2.2);
});

test('观测引用目录中不存在的版本时不猜测、不升级，保留原值并标因', async () => {
  const catalog = await loadCatalog();
  const result = catalog.apply(sensorAt({ calibration: 'c99' }));
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'unknown-calibration-version');
  assert.equal(result.value, 2);
});

test('校准范围不匹配（网页估值引用传感器校准）时拒绝应用', async () => {
  const catalog = await loadCatalog();
  const web = normalizeObservation({
    observationId: 'p1-08',
    source: 'web',
    station: 'S1',
    intervalEnd: '2026-11-16T08:00:00Z',
    durationMinutes: 60,
    metric: 'rainfall-estimate',
    value: 3,
    unit: 'mm',
    calibration: 'c1',
    state: 'active',
  }).observation;
  const result = catalog.apply(web);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'calibration-scope-mismatch');
  assert.equal(result.value, 3);
});

test('没有校准引用的网页观测保持未校准，空值观测不产出校准数值', async () => {
  const catalog = await loadCatalog();
  const web = normalizeObservation({
    observationId: 'p1-08',
    source: 'web',
    station: 'S1',
    intervalEnd: '2026-11-16T08:00:00Z',
    durationMinutes: 60,
    metric: 'rainfall-estimate',
    value: 3,
    unit: 'mm',
    calibration: null,
    state: 'active',
  }).observation;
  const uncalibrated = catalog.apply(web);
  assert.equal(uncalibrated.applied, false);
  assert.equal(uncalibrated.reason, 'no-calibration-reference');
  const nullish = catalog.apply(sensorAt({ value: null, calibration: 'c1' }));
  assert.equal(nullish.applied, false);
  assert.equal(nullish.reason, 'null-observation-value');
  assert.equal(nullish.value, null);
});
