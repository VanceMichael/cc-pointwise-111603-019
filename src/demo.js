import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startSource } from '../source/server.js';
import { ObservationStore } from './observation-store.js';
import { ServiceValueStore } from './service-value-store.js';
import { ForecastLedger } from './forecast-ledger.js';
import { collectOnce } from './collector.js';
import { applyCalibration } from './calibration.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const calibrations = JSON.parse(await readFile(new URL('../fixtures/calibrations.json', import.meta.url), 'utf8'));
const source = await startSource(scenarioPath);
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const observationStore = new ObservationStore(join(directory, 'observations.json'));
  const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));
  const ledger = new ForecastLedger(join(directory, 'forecasts.json'));

  // 1) 首批多源采集：传感器原值中选，网页估值因指标不同不参与竞争
  const opening = await collectOnce({
    baseUrl: source.url, observationStore, serviceValueStore, calibrations,
  });
  const sensorSlot = opening.evaluation.values.find((value) => value.metric === 'rainfall-total');
  console.log('opening service value:', JSON.stringify({
    slot: sensorSlot.slot,
    serviceValue: sensorSlot.serviceValue,
    selected: sensorSlot.selected.observationId,
    calibration: sensorSlot.basis.calibrationVersion,
    candidates: sensorSlot.candidates.map((candidate) => candidate.observationId),
  }));

  // 2) 向农户发出提示：冻结当时观测与 c1 校准依据
  const issued = await ledger.issue({
    observationId: 's1-08', observationStore, calibrations, calibrate: applyCalibration,
  });
  console.log('issued forecast:', JSON.stringify({ id: issued.id, value: issued.value, calibration: issued.basis.calibration }));

  // 3) 来源更新：s1-08 撤回且原值置空（c2 上线）；网页估值仍在，但不能顶替
  source.publish('updated');
  const updated = await collectOnce({
    baseUrl: source.url, observationStore, serviceValueStore, calibrations,
  });
  const withdrawnSlot = updated.evaluation.values.find((value) => value.slot === sensorSlot.slot);
  console.log('after withdrawal:', JSON.stringify({
    serviceValue: withdrawnSlot.serviceValue,
    status: withdrawnSlot.status,
    uncertainty: withdrawnSlot.uncertainty,
    selected: withdrawnSlot.selected.observationId,
    note: 'web rainfall-estimate stays in its own slot and never replaces the sensor value',
  }));

  // 4) 备用传感器晚到：重新评估恢复服务值，使用 c2；已发提示保持 c1 原值不变
  source.publish('backup');
  const backup = await collectOnce({
    baseUrl: source.url, observationStore, serviceValueStore, calibrations,
  });
  const recoveredSlot = backup.evaluation.values.find((value) => value.slot === sensorSlot.slot);
  const frozen = (await ledger.list())[0];
  console.log('after late backup:', JSON.stringify({
    serviceValue: recoveredSlot.serviceValue,
    selected: recoveredSlot.selected.observationId,
    calibration: recoveredSlot.basis.calibrationVersion,
    issuedForecastUnchanged: frozen.value === issued.value && frozen.basis.calibration === 'c1',
    revisions: (await serviceValueStore.revisions()).length,
  }));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
