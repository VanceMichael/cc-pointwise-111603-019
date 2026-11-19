import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCompatibleObservation,
  normalizeObservation,
  observationSignature,
  seriesKey,
  sourcePriority,
} from '../../src/rainfall/observations.js';

const sensorItem = {
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
};

const webItem = {
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
};

test('观测规范化保留单位、时段、来源与校准引用并记录接收时刻与来源路由', () => {
  const normalized = normalizeObservation(sensorItem, {
    receivedAt: '2026-11-16T08:05:00Z',
    route: '/weather/sensor-1',
    etag: '"opening"',
  });
  assert.equal(normalized.observation.metric, 'rainfall-total');
  assert.equal(normalized.observation.unit, 'mm');
  assert.equal(normalized.observation.durationMinutes, 60);
  assert.equal(normalized.observation.calibration, 'c1');
  assert.equal(normalized.receivedAt, '2026-11-16T08:05:00Z');
  assert.deepEqual(normalized.origin, { route: '/weather/sensor-1', etag: '"opening"' });
});

test('同小时但指标口径不同的网页估值与传感器原值不兼容', () => {
  const sensor = normalizeObservation(sensorItem).observation;
  const web = normalizeObservation(webItem).observation;
  assert.equal(sensor.intervalEnd, web.intervalEnd);
  assert.equal(isCompatibleObservation(sensor, web), false);
  assert.notEqual(seriesKey(sensor), seriesKey(web));
});

test('同站点同时段同口径同单位的两个传感器观测才兼容', () => {
  const first = normalizeObservation(sensorItem).observation;
  const second = normalizeObservation({ ...sensorItem, observationId: 's1-08-copy', value: 2.5 }).observation;
  assert.equal(isCompatibleObservation(first, second), true);
  assert.notEqual(
    isCompatibleObservation(first, normalizeObservation({ ...sensorItem, unit: 'cm' }).observation),
    true,
  );
  assert.notEqual(
    isCompatibleObservation(first, normalizeObservation({ ...sensorItem, durationMinutes: 30 }).observation),
    true,
  );
});

test('来源优先级只在同口径候选之间使用，传感器高于网页', () => {
  assert.ok(sourcePriority('sensor') > sourcePriority('web'));
  assert.equal(sourcePriority('unknown-source'), 0);
});

test('内容签名随值、状态或校准引用变化，重拉相同内容得到相同签名', () => {
  const opening = normalizeObservation(sensorItem).observation;
  const withdrawn = normalizeObservation({ ...sensorItem, value: null, calibration: 'c2', state: 'withdrawn' }).observation;
  assert.notEqual(observationSignature(opening), observationSignature(withdrawn));
  assert.equal(observationSignature(opening), observationSignature(normalizeObservation(sensorItem).observation));
});

test('非法观测被拒绝：缺字段、坏时间、坏状态、坏数值', () => {
  assert.throws(() => normalizeObservation({ ...sensorItem, observationId: '' }), /missing observationId/);
  assert.throws(() => normalizeObservation({ ...sensorItem, intervalEnd: 'not-a-date' }), /invalid intervalEnd/);
  assert.throws(() => normalizeObservation({ ...sensorItem, state: 'deleted' }), /invalid state/);
  assert.throws(() => normalizeObservation({ ...sensorItem, value: 'wet' }), /invalid value/);
  assert.doesNotThrow(() => normalizeObservation({ ...sensorItem, value: null }));
});
