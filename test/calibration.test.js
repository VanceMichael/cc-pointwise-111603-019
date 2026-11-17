import test from 'node:test';
import assert from 'node:assert/strict';
import { isCompatible, slotKey } from '../src/compatibility.js';
import { applyCalibration } from '../src/calibration.js';

const sensor = {
  station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60,
  metric: 'rainfall-total', unit: 'mm', source: 'sensor', value: 2, calibration: 'c1', state: 'active',
};
const web = {
  station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60,
  metric: 'rainfall-estimate', unit: 'mm', source: 'web', value: 3, calibration: null, state: 'active',
};
const calibrations = [
  { version: 'c1', source: 'sensor', metric: 'rainfall-total', multiplier: 1, unit: 'mm' },
  { version: 'c2', source: 'sensor', metric: 'rainfall-total', multiplier: 1.1, unit: 'mm' },
];

test('same hour does not make web estimate compatible with sensor measurement', () => {
  assert.equal(isCompatible(sensor, web), false);
  assert.notEqual(slotKey(sensor), slotKey(web));
});

test('compatibility requires identical station, interval, duration, metric and unit', () => {
  assert.equal(isCompatible(sensor, { ...sensor }), true);
  assert.equal(isCompatible(sensor, { ...sensor, unit: 'cm' }), false);
  assert.equal(isCompatible(sensor, { ...sensor, durationMinutes: 30 }), false);
  assert.equal(isCompatible(sensor, { ...sensor, station: 'S2' }), false);
});

test('declared calibration version is applied only inside its scope', () => {
  const result = applyCalibration(calibrations, { ...sensor, value: 2.5, calibration: 'c2' });
  assert.equal(result.applied, true);
  assert.equal(result.value, 2.75);
  assert.equal(result.calibrationVersion, 'c2');
});

test('unknown or mismatched calibration is flagged instead of silently converting', () => {
  const unknown = applyCalibration(calibrations, { ...sensor, calibration: 'c9' });
  assert.equal(unknown.applied, false);
  assert.match(unknown.reason, /calibration-version-unknown/);
  assert.equal(unknown.value, 2, '原值保留，不做换算');

  const mismatch = applyCalibration(calibrations, { ...sensor, metric: 'other-metric', calibration: 'c1' });
  assert.equal(mismatch.applied, false);
  assert.match(mismatch.reason, /calibration-scope-mismatch/);
});

test('observation without calibration keeps raw value and says so', () => {
  const result = applyCalibration(calibrations, web);
  assert.equal(result.applied, false);
  assert.equal(result.value, 3);
  assert.equal(result.calibrationVersion, null);
  assert.equal(result.reason, 'observation-declares-no-calibration');
});

test('null raw value calibrates to null, never to zero', () => {
  const result = applyCalibration(calibrations, { ...sensor, value: null, calibration: 'c2' });
  assert.equal(result.applied, true);
  assert.equal(result.value, null);
  assert.equal(result.reason, 'raw-value-not-numeric');
});
