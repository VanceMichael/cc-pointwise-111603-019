// 带版本与适用范围的校准目录。
// 校准只能应用在来源、指标口径、单位全部匹配、且观测时间达到生效时间的观测上；
// 观测自己声明的 calibration 版本若在目录中不存在或范围不匹配，则不应用校准，
// 而不是猜测一个新版本，也不是静默升级到最新校准。

function round6(value) {
  return Number(value.toFixed(6));
}

export class CalibrationCatalog {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError('calibration entries must be an array');
    this.entries = entries.map((entry) => {
      for (const field of ['version', 'source', 'metric', 'unit', 'multiplier']) {
        if (entry[field] === undefined || entry[field] === null) {
          throw new Error(`calibration entry missing ${field}`);
        }
      }
      const multiplier = Number(entry.multiplier);
      if (!Number.isFinite(multiplier)) throw new Error(`invalid multiplier in calibration ${entry.version}`);
      if (entry.effectiveFrom !== undefined && entry.effectiveFrom !== null
        && !Number.isFinite(Date.parse(entry.effectiveFrom))) {
        throw new Error(`invalid effectiveFrom in calibration ${entry.version}`);
      }
      return {
        version: String(entry.version),
        source: String(entry.source),
        metric: String(entry.metric),
        unit: String(entry.unit),
        multiplier,
        effectiveFrom: entry.effectiveFrom ? String(entry.effectiveFrom) : null,
      };
    });
  }

  // 按版本号取校准，不做隐式版本选择。
  resolve(version) {
    if (version === null || version === undefined) return null;
    return this.entries.find((entry) => entry.version === String(version)) ?? null;
  }

  // 校准适用范围必须与观测明确兼容；effectiveFrom（若有）不得晚于观测时段结束时间。
  appliesTo(entry, observation) {
    if (!entry) return false;
    if (entry.source !== observation.source) return false;
    if (entry.metric !== observation.metric) return false;
    if (entry.unit !== observation.unit) return false;
    if (entry.effectiveFrom && Date.parse(entry.effectiveFrom) > Date.parse(observation.intervalEnd)) {
      return false;
    }
    return true;
  }

  // 返回应用结果与可追溯依据；不满足条件时 value 保持原值并给出原因。
  apply(observation) {
    const referenced = observation.calibration;
    if (referenced === null) {
      return {
        applied: false,
        reason: 'no-calibration-reference',
        calibrationVersion: null,
        multiplier: null,
        value: observation.value,
        unit: observation.unit,
      };
    }
    const entry = this.resolve(referenced);
    if (!entry) {
      return {
        applied: false,
        reason: 'unknown-calibration-version',
        calibrationVersion: referenced,
        multiplier: null,
        value: observation.value,
        unit: observation.unit,
      };
    }
    if (!this.appliesTo(entry, observation)) {
      return {
        applied: false,
        reason: 'calibration-scope-mismatch',
        calibrationVersion: entry.version,
        multiplier: entry.multiplier,
        value: observation.value,
        unit: observation.unit,
      };
    }
    if (observation.value === null) {
      return {
        applied: false,
        reason: 'null-observation-value',
        calibrationVersion: entry.version,
        multiplier: entry.multiplier,
        value: null,
        unit: entry.unit,
      };
    }
    return {
      applied: true,
      reason: null,
      calibrationVersion: entry.version,
      multiplier: entry.multiplier,
      value: round6(observation.value * entry.multiplier),
      unit: entry.unit,
    };
  }
}
