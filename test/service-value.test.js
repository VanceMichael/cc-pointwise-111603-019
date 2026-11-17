import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationStore } from '../src/observation-store.js';
import { evaluateServiceValues, DEFAULT_PRIORITY } from '../src/service-value.js';

const calibrations = [
  { version: 'c1', source: 'sensor', metric: 'rainfall-total', multiplier: 1, unit: 'mm' },
  { version: 'c2', source: 'sensor', metric: 'rainfall-total', multiplier: 1.1, unit: 'mm' },
];

const sensorObservation = (overrides = {}) => ({
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
});

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'service-value-'));
  const store = new ObservationStore(join(directory, 'observations.json'));
  try {
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function evaluate(store, routes = {}, options = {}) {
  const versions = await store.currentObservations();
  return evaluateServiceValues(versions, calibrations, {
    routes,
    evaluatedAt: '2026-11-16T08:10:00Z',
    ...options,
  });
}

test('priority only applies within one compatible slot; web estimate never overrides sensor raw value', async () => {
  await withStore(async (store) => {
    await store.appendPage(
      [{ sourceId: 's1-08', attributes: sensorObservation() }],
      { route: '/weather/sensor-1', fetchedAt: '2026-11-16T08:05:00Z' },
    );
    await store.appendPage(
      [{ sourceId: 'p1-08', attributes: {
        observationId: 'p1-08', source: 'web', station: 'S1',
        intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60,
        metric: 'rainfall-estimate', value: 3, unit: 'mm', calibration: null, state: 'active',
      } }],
      { route: '/weather/public', fetchedAt: '2026-11-16T08:06:00Z' },
    );
    const result = await evaluate(store);
    assert.deepEqual(result.values.map((value) => value.metric).sort(), ['rainfall-estimate', 'rainfall-total']);
    const sensorSlot = result.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(sensorSlot.serviceValue, 2);
    assert.equal(sensorSlot.selected.observationId, 's1-08');
    assert.deepEqual(sensorSlot.uncertainty, null);
    const webSlot = result.values.find((value) => value.metric === 'rainfall-estimate');
    assert.equal(webSlot.selected.observationId, 'p1-08');
    assert.equal(webSlot.basis.calibrationApplied, false);
  });
});

test('compatible sensors compete on source priority, then stable observationId', async () => {
  await withStore(async (store) => {
    await store.appendPage(
      [
        { sourceId: 's1-08', attributes: sensorObservation() },
        { sourceId: 's2-08', attributes: sensorObservation({ observationId: 's2-08', value: 2.4 }) },
      ],
      { route: '/weather/sensor-1', fetchedAt: '2026-11-16T08:05:00Z' },
    );
    const result = await evaluate(store);
    const slot = result.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(slot.candidates.length, 2);
    assert.equal(slot.selected.observationId, 's1-08');
    assert.equal(DEFAULT_PRIORITY.sensor < DEFAULT_PRIORITY.web, true);
  });
});

test('withdrawal and null raw value re-evaluate the current service value as uncertain, not zero', async () => {
  await withStore(async (store) => {
    await store.appendPage(
      [{ sourceId: 's1-08', attributes: sensorObservation() }],
      { route: '/weather/sensor-1', fetchedAt: '2026-11-16T08:05:00Z' },
    );
    await store.appendPage(
      [{ sourceId: 's1-08', attributes: sensorObservation({ value: null, calibration: 'c2', state: 'withdrawn' }) }],
      { route: '/weather/sensor-1', fetchedAt: '2026-11-16T09:05:00Z' },
    );
    const result = await evaluate(store);
    const slot = result.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(slot.status, 'uncertain');
    assert.equal(slot.serviceValue, null);
    assert.deepEqual(slot.uncertainty.sort(), ['raw-value-null', 'selected-observation-withdrawn']);
    assert.equal(slot.basis.rawValue, null);
    assert.equal(slot.basis.calibrationVersion, 'c2');
    const versions = await store.allVersions();
    assert.equal(versions.length, 2, '撤回前的原值版本仍保留在档案中');
    assert.equal(versions[0].observation.value, 2);
  });
});

test('late compatible observation restores the service value with the new calibration version', async () => {
  await withStore(async (store) => {
    await store.appendPage(
      [{ sourceId: 's1-08', attributes: sensorObservation({ value: null, calibration: 'c2', state: 'withdrawn' }) }],
      { route: '/weather/sensor-1', fetchedAt: '2026-11-16T09:05:00Z' },
    );
    const before = await evaluate(store);
    assert.equal(before.values[0].status, 'uncertain');
    await store.appendPage(
      [{ sourceId: 's2-08', attributes: sensorObservation({ observationId: 's2-08', value: 2.5, calibration: 'c2' }) }],
      { route: '/weather/sensor-2', fetchedAt: '2026-11-16T09:20:00Z' },
    );
    const after = await evaluate(store);
    const slot = after.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(slot.status, 'ok');
    assert.equal(slot.serviceValue, 2.75);
    assert.equal(slot.selected.observationId, 's2-08');
    assert.equal(slot.basis.calibrationVersion, 'c2');
  });
});

test('a failed source route is reported as a gap and never synthesizes zero rainfall', async () => {
  await withStore(async (store) => {
    await store.appendPage(
      [{ sourceId: 's1-08', attributes: sensorObservation() }],
      { route: '/weather/sensor-1', fetchedAt: '2026-11-16T08:05:00Z' },
    );
    const result = await evaluate(store, {
      '/weather/sensor-2': { status: 'error', error: 'source 503: /weather/sensor-2' },
    });
    assert.equal(result.sourceGaps.length, 1);
    assert.equal(result.sourceGaps[0].route, '/weather/sensor-2');
    assert.match(result.sourceGaps[0].reason, /503/);
    const slot = result.values.find((value) => value.metric === 'rainfall-total');
    assert.equal(slot.serviceValue, 2, '已有观测保留，失败不清零、不删档');
  });
});

test('service values carry unit, interval, source identity and calibration basis', async () => {
  await withStore(async (store) => {
    await store.appendPage(
      [{ sourceId: 's1-08', attributes: sensorObservation() }],
      { route: '/weather/sensor-1', etag: '"opening"', fetchedAt: '2026-11-16T08:05:00Z' },
    );
    const result = await evaluate(store);
    const slot = result.values[0];
    assert.equal(slot.unit, 'mm');
    assert.equal(slot.durationMinutes, 60);
    assert.equal(slot.intervalEnd, '2026-11-16T08:00:00Z');
    assert.equal(slot.selected.source, 'sensor');
    assert.equal(slot.selected.route, '/weather/sensor-1');
    assert.equal(slot.selected.etag, '"opening"');
    assert.equal(slot.basis.multiplier, 1);
    assert.equal(slot.basis.calibrationApplied, true);
  });
});
