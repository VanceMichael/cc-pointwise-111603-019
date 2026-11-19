import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalibrationCatalog } from '../../src/rainfall/calibrations.js';
import { ObservationStore } from '../../src/rainfall/observation-store.js';
import { normalizeObservation } from '../../src/rainfall/observations.js';
import { evaluateServiceValues, STATUS, UNCERTAINTY } from '../../src/rainfall/evaluation.js';

const catalog = new CalibrationCatalog([
  { version: 'c1', source: 'sensor', metric: 'rainfall-total', multiplier: 1, unit: 'mm' },
  { version: 'c2', source: 'sensor', metric: 'rainfall-total', multiplier: 1.1, unit: 'mm', effectiveFrom: '2026-11-16T00:00:00Z' },
]);

const sensor = (overrides = {}) => normalizeObservation({
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
}, { receivedAt: '2026-11-16T08:05:00Z' });

const web = () => normalizeObservation({
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
}, { receivedAt: '2026-11-16T08:05:00Z' });

async function newStore() {
  const directory = await mkdtemp(join(tmpdir(), 'rainfall-eval-'));
  const store = new ObservationStore(join(directory, 'observations.json'));
  await store.load();
  return { store, directory };
}

test('同小时的网页估值与传感器原值分成两个口径序列，网页不能覆盖传感器', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor());
    await store.recordVersion(web());
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:10:00Z' });
    assert.equal(values.length, 2);
    const sensorValue = values.find((row) => row.metric === 'rainfall-total');
    const webValue = values.find((row) => row.metric === 'rainfall-estimate');
    assert.equal(sensorValue.selectedObservationId, 's1-08');
    assert.equal(sensorValue.value, 2);
    assert.equal(webValue.selectedObservationId, 'p1-08');
    assert.equal(webValue.value, 3);
    assert.ok(webValue.uncertainty.includes(UNCERTAINTY.WEB_ESTIMATE));
    assert.equal(webValue.calibrationApplied, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('只对明确兼容的观测应用优先级：同口径第二来源不会挤掉高优先级传感器', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor());
    await store.recordVersion(normalizeObservation({
      observationId: 's2-08',
      source: 'sensor-backup',
      station: 'S1',
      intervalEnd: '2026-11-16T08:00:00Z',
      durationMinutes: 60,
      metric: 'rainfall-total',
      value: 4,
      unit: 'mm',
      calibration: 'c1',
      state: 'active',
    }, { receivedAt: '2026-11-16T08:06:00Z' }));
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:10:00Z' });
    const row = values.find((candidate) => candidate.metric === 'rainfall-total');
    assert.equal(row.selectedObservationId, 's1-08');
    assert.ok(row.uncertainty.includes(UNCERTAINTY.CONFLICTING_CANDIDATES), '多源同口径冲突需标不确定性');
    assert.ok(row.basis.find((candidate) => candidate.observationId === 's2-08' && candidate.selected === false));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('来源撤回触发重新评估：服务值变为 withdrawn、value 为 null，绝不输出零，且网页不顶替', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor());
    await store.recordVersion(web());
    const before = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:10:00Z' });
    assert.equal(before.values.find((row) => row.metric === 'rainfall-total').value, 2);

    await store.recordVersion(sensor({ value: null, calibration: 'c2', state: 'withdrawn' }));
    const after = evaluateServiceValues(store, catalog, { now: '2026-11-16T09:10:00Z' });
    const sensorRow = after.values.find((row) => row.metric === 'rainfall-total');
    assert.equal(sensorRow.status, STATUS.WITHDRAWN);
    assert.equal(sensorRow.value, null);
    assert.equal(sensorRow.zeroAssumed, false);
    assert.ok(sensorRow.uncertainty.includes(UNCERTAINTY.ALL_WITHDRAWN));
    // 网页估值仍然独立存在，没有因为传感器撤回而被拿来顶替
    const webRow = after.values.find((row) => row.metric === 'rainfall-estimate');
    assert.equal(webRow.selectedObservationId, 'p1-08');
    // 旧版本仍保留在版本历史中可追溯
    assert.equal(store.history('s1-08').length, 2);
    assert.equal(store.history('s1-08')[0].observation.value, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('迟到的替换版本重新评估当前服务值并标注 late-arrival 不确定性', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor());
    const firstEvaluation = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:10:00Z' }).evaluation;
    // 撤回后又来一个新 observationId 的同口径替换观测（晚到）
    await store.recordVersion(sensor({ value: null, calibration: 'c2', state: 'withdrawn' }));
    await store.recordVersion(normalizeObservation({
      observationId: 's1-08b',
      source: 'sensor',
      station: 'S1',
      intervalEnd: '2026-11-16T08:00:00Z',
      durationMinutes: 60,
      metric: 'rainfall-total',
      value: 1.8,
      unit: 'mm',
      calibration: 'c2',
      state: 'active',
    }, { receivedAt: '2026-11-16T10:00:00Z' }));
    const { values } = evaluateServiceValues(store, catalog, {
      now: '2026-11-16T10:05:00Z',
      previousEvaluations: [firstEvaluation],
    });
    const row = values.find((candidate) => candidate.metric === 'rainfall-total');
    assert.equal(row.selectedObservationId, 's1-08b');
    assert.equal(row.value, 1.98, '按观测自己引用的 c2 版本校准（1.8 × 1.1）');
    assert.equal(row.calibrationVersion, 'c2');
    assert.ok(row.uncertainty.includes(UNCERTAINTY.LATE_ARRIVAL));
    assert.equal(row.status, STATUS.UNCERTAIN);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('校准升级不会反向改写：旧观测继续按其引用的 c1 出值，只有显式引用 c2 的新版本才用 c2', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor({ calibration: 'c1' }));
    const first = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:10:00Z' });
    const firstRow = first.values[0];
    assert.equal(firstRow.value, 2);
    assert.equal(firstRow.calibrationVersion, 'c1');
    // 再次评估（目录中已存在 c2）结果保持一致，不隐式升级
    const again = evaluateServiceValues(store, catalog, { now: '2026-11-16T11:00:00Z' });
    assert.equal(again.values[0].value, 2);
    assert.equal(again.values[0].calibrationVersion, 'c1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('预期口径没有任何观测到达时输出 absent 与 null，而不是零降雨', async () => {
  const { store, directory } = await newStore();
  try {
    const expected = [{
      station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60,
      metric: 'rainfall-total', unit: 'mm',
    }];
    const { values } = evaluateServiceValues(store, catalog, {
      now: '2026-11-16T08:10:00Z',
      expectedSeries: expected,
    });
    assert.equal(values.length, 1);
    assert.equal(values[0].status, STATUS.ABSENT);
    assert.equal(values[0].value, null);
    assert.equal(values[0].zeroAssumed, false);
    assert.ok(values[0].uncertainty.includes(UNCERTAINTY.NO_OBSERVATION));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('有效观测但数值为 null 时是不确定而不是零', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor({ value: null }));
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:10:00Z' });
    assert.equal(values[0].status, STATUS.UNCERTAIN);
    assert.equal(values[0].value, null);
    assert.ok(values[0].uncertainty.includes(UNCERTAINTY.NULL_OBSERVATION));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('来源在观测到达后出现不可用事件，当前值保留但标记 stale 不确定性', async () => {
  const { store, directory } = await newStore();
  try {
    await store.recordVersion(sensor());
    await store.recordAvailability('sensor', {
      route: '/weather/sensor-1', status: 503, at: '2026-11-16T09:00:00Z',
    });
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T09:05:00Z' });
    const row = values.find((candidate) => candidate.metric === 'rainfall-total');
    assert.equal(row.value, 2, '上次观测值保留，不被清零');
    assert.ok(row.uncertainty.includes(UNCERTAINTY.SOURCE_UNAVAILABLE));
    assert.ok(row.uncertainty.includes(UNCERTAINTY.STALE));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('相同内容重复入库不产生新版本', async () => {
  const { store, directory } = await newStore();
  try {
    const first = await store.recordVersion(sensor());
    const second = await store.recordVersion(sensor());
    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.equal(store.history('s1-08').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
