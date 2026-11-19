import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalibrationCatalog } from '../../src/rainfall/calibrations.js';
import { ObservationStore } from '../../src/rainfall/observation-store.js';
import { ForecastLedger } from '../../src/rainfall/forecast-ledger.js';
import { normalizeObservation } from '../../src/rainfall/observations.js';
import { evaluateServiceValues } from '../../src/rainfall/evaluation.js';

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

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'rainfall-ledger-'));
  const store = new ObservationStore(join(directory, 'observations.json'));
  const ledger = new ForecastLedger(join(directory, 'forecasts.jsonl'));
  await store.load();
  return { directory, store, ledger };
}

test('已发提示固化观测签名、原值与校准版本依据', async () => {
  const { directory, store, ledger } = await harness();
  try {
    await store.recordVersion(sensor());
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:30:00Z' });
    const entry = await ledger.issue(values[0], { id: 'issued-1', issuedAt: '2026-11-16T08:30:00Z' });
    assert.equal(entry.value, 2);
    assert.equal(entry.basis.observationId, 's1-08');
    assert.equal(entry.basis.calibrationVersion, 'c1');
    assert.equal(entry.basis.rawValue, 2);
    assert.ok(entry.basis.observationSignature);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('撤回与校准升级后已发记录保持原值原依据，只追加不改写', async () => {
  const { directory, store, ledger } = await harness();
  try {
    await store.recordVersion(sensor());
    const firstValues = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:30:00Z' }).values;
    await ledger.issue(firstValues[0], { id: 'issued-1', issuedAt: '2026-11-16T08:30:00Z' });

    // 来源撤回 + 新版本引用 c2
    await store.recordVersion(sensor({ value: null, calibration: 'c2', state: 'withdrawn' }));
    const reevaluated = evaluateServiceValues(store, catalog, { now: '2026-11-16T09:30:00Z' }).values;
    assert.equal(reevaluated[0].value, null);

    const entries = await ledger.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, 2, '已发数值不被后续撤回/升级改写');
    assert.equal(entries[0].basis.calibrationVersion, 'c1');
    assert.equal(entries[0].basis.observationSignature, store.history('s1-08')[0].signature);

    const verdicts = await ledger.verifyAgainst(store, catalog);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].current, 'superseded');
    assert.equal(verdicts[0].basisStillHolds, false);
    assert.equal(verdicts[0].value, 2, '核对结果也不能改动账本内容');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('撤回（null）或缺失的服务值不允许下发给农户', async () => {
  const { directory, store, ledger } = await harness();
  try {
    await store.recordVersion(sensor({ value: null, state: 'withdrawn' }));
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T09:30:00Z' });
    await assert.rejects(ledger.issue(values[0]), /refuse to issue/);
    assert.deepEqual(await ledger.list(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('账本是只追加 JSONL，重放得到完全相同的记录序列', async () => {
  const { directory, store, ledger } = await harness();
  try {
    await store.recordVersion(sensor());
    const { values } = evaluateServiceValues(store, catalog, { now: '2026-11-16T08:30:00Z' });
    await ledger.issue(values[0], { id: 'issued-1' });
    const text = await readFile(join(directory, 'forecasts.jsonl'), 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1);
    const reopened = new ForecastLedger(join(directory, 'forecasts.jsonl'));
    const replayed = await reopened.list();
    assert.equal(replayed[0].id, 'issued-1');
    assert.equal(replayed[0].basis.observationSignature, JSON.parse(lines[0]).basis.observationSignature);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
