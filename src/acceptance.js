import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';
import { ObservationStore } from './observation-store.js';
import { ServiceValueStore } from './service-value-store.js';
import { ForecastLedger } from './forecast-ledger.js';
import { collectOnce } from './collector.js';
import { applyCalibration } from './calibration.js';
import { isCompatible, slotKey } from './compatibility.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const calibrations = JSON.parse(await readFile(new URL('../fixtures/calibrations.json', import.meta.url), 'utf8'));
const source = await startSource(scenarioPath);
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  // 既有结构化导入生命周期保持不变
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');

  // 多源可追溯服务值流水线
  const observationStore = new ObservationStore(join(directory, 'observations.json'));
  const serviceValueStore = new ServiceValueStore(join(directory, 'service-values.json'));
  const ledger = new ForecastLedger(join(directory, 'forecasts.json'));

  const opening = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
  const sensorSlotKey = slotKey(page.records[0].attributes);
  const openingSlot = opening.evaluation.values.find((value) => value.slot === sensorSlotKey);
  assert.equal(openingSlot.status, 'ok');
  assert.equal(openingSlot.serviceValue, 2, '传感器原值经 c1 校准成为服务值');
  assert.equal(openingSlot.selected.observationId, 's1-08', '同口径下传感器按来源优先级胜出');
  const webSlot = opening.evaluation.values.find((value) => value.metric === 'rainfall-estimate');
  assert.ok(webSlot, '网页估值保留在自己的指标槽，不覆盖传感器');
  const currentVersions = await observationStore.currentObservations();
  const webObservation = currentVersions.find((entry) => entry.observationId === 'p1-08').observation;
  assert.equal(isCompatible(page.records[0].attributes, webObservation), false, '指标不同即不兼容，时间相同也不合并');
  assert.notEqual(slotKey(page.records[0].attributes), slotKey(webObservation));

  // 已发提示冻结依据
  const issued = await ledger.issue({ observationId: 's1-08', observationStore, calibrations, calibrate: applyCalibration });
  assert.equal(issued.value, 2);
  assert.equal(issued.basis.calibrationVersion, 'c1');
  assert.equal(issued.immutable, true);

  // 来源撤回 + 校准升级：当前服务值转不确定，网页估值不得顶替，缺失不是零
  source.publish('updated');
  const updated = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
  const uncertainSlot = updated.evaluation.values.find((value) => value.slot === sensorSlotKey);
  assert.equal(uncertainSlot.status, 'uncertain');
  assert.equal(uncertainSlot.serviceValue, null, '撤回/置空不得解释为零降雨');
  assert.ok(uncertainSlot.uncertainty.includes('selected-observation-withdrawn'));
  assert.ok(uncertainSlot.uncertainty.includes('raw-value-null'));
  assert.equal(uncertainSlot.selected.observationId, 's1-08');
  const frozen = (await ledger.list())[0];
  assert.equal(frozen.value, 2, '已发提示不随撤回或 c2 升级改写');
  assert.equal(frozen.basis.calibrationVersion, 'c1');

  // 备用来源晚到：重新评估恢复服务值并采用 c2，修订历史记录切换
  source.publish('backup');
  const backup = await collectOnce({ baseUrl: source.url, observationStore, serviceValueStore, calibrations });
  const recoveredSlot = backup.evaluation.values.find((value) => value.slot === sensorSlotKey);
  assert.equal(recoveredSlot.status, 'ok');
  assert.equal(recoveredSlot.serviceValue, 2.75, '2.5 × c2(1.1) = 2.75');
  assert.equal(recoveredSlot.selected.observationId, 's2-08');
  assert.equal(recoveredSlot.basis.calibrationVersion, 'c2');
  const stillFrozen = (await ledger.list())[0];
  assert.equal(stillFrozen.value, 2);
  assert.equal(stillFrozen.basis.calibrationVersion, 'c1');
  assert.ok((await serviceValueStore.revisions()).length >= 2, '撤回与恢复都留下修订轨迹');
  assert.ok((await observationStore.allVersions()).some((entry) => entry.observation.state === 'withdrawn'), '撤回版本仍在档案中可追溯');

  // 业务读取入口看到一致状态
  const operations = await readOperations(reopened, serviceValueStore, ledger);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  assert.equal(operations.serviceValues.values.length, 2);
  assert.equal(operations.issuedForecasts.length, 1);

  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayStored: second.stored,
    openingValue: openingSlot.serviceValue, uncertainValue: uncertainSlot.serviceValue,
    recoveredValue: recoveredSlot.serviceValue, revisions: (await serviceValueStore.revisions()).length,
    operationRows: operations.rows.length, status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
