import { randomUUID } from 'node:crypto';
import { JsonlAppendRepository } from './persistence.js';

// 已发农户提示的只追加账本。
// 每条记录固化发出时刻的服务值、观测内容签名与校准版本依据；
// 之后来源撤回、迟到或校准升级都只能重新评估“当前服务值”，
// 不能改写、替换或删除这里的历史依据。
export class ForecastLedger {
  constructor(path) {
    this.repository = new JsonlAppendRepository(path);
  }

  async list() {
    return this.repository.readAll();
  }

  // 只允许对状态确定且有数值的服务值发出提示；不确定/撤回/缺失不得当成确定值下发。
  async issue(serviceValue, { issuedAt = new Date().toISOString(), id = randomUUID(), message = null } = {}) {
    if (!serviceValue || typeof serviceValue !== 'object') {
      throw new TypeError('service value required');
    }
    if (serviceValue.value === null || serviceValue.value === undefined) {
      throw new Error('refuse to issue forecast without a numeric service value');
    }
    if (serviceValue.status !== 'ok' && serviceValue.status !== 'uncertain') {
      throw new Error(`refuse to issue forecast with status ${serviceValue.status}`);
    }
    const selectedBasis = serviceValue.basis?.find((candidate) => candidate.selected) ?? null;
    const entry = {
      id,
      issuedAt,
      seriesKey: serviceValue.seriesKey,
      station: serviceValue.station,
      intervalEnd: serviceValue.intervalEnd,
      durationMinutes: serviceValue.durationMinutes,
      metric: serviceValue.metric,
      unit: serviceValue.unit,
      value: serviceValue.value,
      statusAtIssue: serviceValue.status,
      uncertaintyAtIssue: [...(serviceValue.uncertainty ?? [])],
      basis: {
        observationId: serviceValue.selectedObservationId,
        source: serviceValue.selectedSource,
        rawValue: selectedBasis?.rawValue ?? null,
        observationSignature: selectedBasis?.signature ?? null,
        calibrationVersion: serviceValue.calibrationVersion,
        calibrationApplied: serviceValue.calibrationApplied,
        calibrationMultiplier: serviceValue.calibrationMultiplier ?? null,
      },
      message,
    };
    await this.repository.append(entry);
    return entry;
  }

  // 用当前观测版本库核对历史依据是否仍与发出时一致；
  // 不一致只产生核对结论，绝不修改账本记录。
  verifyAgainst(store, catalog) {
    return this.list().then((entries) => entries.map((entry) => {
      const version = store.latestVersion(entry.basis.observationId);
      const observation = version?.observation ?? null;
      const frozen = {
        id: entry.id,
        issuedAt: entry.issuedAt,
        value: entry.value,
        calibrationVersion: entry.basis.calibrationVersion,
        observationSignature: entry.basis.observationSignature,
      };
      if (!version) {
        return { ...frozen, current: 'observation-missing', basisStillHolds: false };
      }
      const signatureMatches = version.signature === entry.basis.observationSignature;
      const calibrationNow = observation ? catalog.apply(observation) : null;
      const calibrationMatches = calibrationNow?.applied
        ? calibrationNow.calibrationVersion === entry.basis.calibrationVersion
          && calibrationNow.value === entry.value
        : entry.basis.calibrationVersion === null && !entry.basis.calibrationApplied;
      return {
        ...frozen,
        current: signatureMatches ? 'unchanged' : 'superseded',
        basisStillHolds: signatureMatches && calibrationMatches,
        currentState: observation?.state ?? null,
        note: 'issued record is immutable; this verdict never rewrites the stored basis',
      };
    }));
  }
}
