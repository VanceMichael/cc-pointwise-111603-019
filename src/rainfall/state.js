import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CalibrationCatalog } from './calibrations.js';
import { ObservationStore } from './observation-store.js';
import { ForecastLedger } from './forecast-ledger.js';
import { JsonRepository } from './persistence.js';

// 把本地状态目录下的观测版本库、评估日志、已发账本与校准目录装配到一起。
export function createRainfallState(stateDir, { calibrationPath } = {}) {
  const store = new ObservationStore(join(stateDir, 'observations.json'));
  const evaluationLog = new JsonRepository(join(stateDir, 'evaluations.json'), 'evaluations');
  const ledger = new ForecastLedger(join(stateDir, 'forecasts.jsonl'));
  return {
    stateDir,
    store,
    evaluationLog,
    ledger,
    async loadCatalog() {
      const entries = JSON.parse(await readFile(calibrationPath, 'utf8'));
      return new CalibrationCatalog(entries);
    },
    async open() {
      await store.load();
      return this;
    },
  };
}
