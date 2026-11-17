import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { ObservationStore } from './observation-store.js';
import { ServiceValueStore } from './service-value-store.js';
import { ForecastLedger } from './forecast-ledger.js';
import { collectOnce } from './collector.js';
import { applyCalibration } from './calibration.js';
import { readOperations } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const stateDir = resolve(root, 'var');
const repository = new RecordRepository(resolve(stateDir, 'records.json'));
const service = new CollectionService(repository);
const observationStore = new ObservationStore(resolve(stateDir, 'observations.json'));
const serviceValueStore = new ServiceValueStore(resolve(stateDir, 'service-values.json'));
const forecastLedger = new ForecastLedger(resolve(stateDir, 'forecasts.json'));
const defaultCalibrations = resolve(root, 'fixtures/calibrations.json');
const frozenForecasts = resolve(root, 'fixtures/forecasts.json');

const usage = {
  usage: 'npm start -- ingest|query|collect|values|forecasts|issue [参数]',
  commands: ['ingest', 'query', 'collect', 'values', 'forecasts', 'issue'],
  detail: {
    ingest: 'ingest [文件]：结构化导入业务记录（默认 fixtures/records.json）',
    query: 'query [来源]：查询本地业务集合',
    collect: 'collect <回环来源URL> [校准文件]：多源采集并重评估当前服务值',
    values: 'values：查看当前服务值、不确定性与修订历史',
    forecasts: 'forecasts [台账文件]：查看已发农事提示（默认只读基线 fixtures/forecasts.json）',
    issue: 'issue <observationId> [校准文件]：按当前档案冻结依据并发出提示（只追加）',
  },
};

const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify(usage, null, 2));
  process.exit(0);
}

async function loadCalibrations(path = defaultCalibrations) {
  const calibrations = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(calibrations)) throw new Error('calibration file must contain an array');
  return calibrations;
}

if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(root, 'fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'collect') {
  const baseUrl = process.argv[3];
  if (!baseUrl) throw new Error('collect requires a loopback source URL');
  const calibrations = await loadCalibrations(process.argv[4]);
  const result = await collectOnce({
    baseUrl,
    observationStore,
    serviceValueStore,
    calibrations,
  });
  console.log(JSON.stringify({
    fetchedAt: result.fetchedAt,
    routes: result.routes,
    appended: result.appended,
    duplicate: result.duplicate,
    slots: result.slots,
    sourceGaps: result.sourceGaps,
  }, null, 2));
} else if (action === 'values') {
  const document = await serviceValueStore.load();
  console.log(JSON.stringify({ current: document.current, revisions: document.revisions }, null, 2));
} else if (action === 'forecasts') {
  const ledger = await forecastLedger.list();
  const legacy = await ForecastLedger.readFrozen(process.argv[3] ?? frozenForecasts);
  console.log(JSON.stringify({ issued: ledger, frozenBaseline: legacy }, null, 2));
} else if (action === 'issue') {
  const observationId = process.argv[3];
  if (!observationId) throw new Error('issue requires an observationId');
  const calibrations = await loadCalibrations(process.argv[4]);
  const forecast = await forecastLedger.issue({
    observationId,
    observationStore,
    calibrations,
    calibrate: applyCalibration,
  });
  console.log(JSON.stringify(forecast, null, 2));
} else {
  throw new Error('action must be one of: ingest, query, collect, values, forecasts, issue');
}
