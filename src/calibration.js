/**
 * 带版本与适用范围的校准。
 *
 * 校准只能应用到明确声明该版本、且 source/metric/unit 均在适用范围内的观测。
 * 找不到校准或适用范围不匹配时不做任何数值换算，并把原因作为不确定性标出，
 * 绝不静默换算，也不拿别的来源的校准顶替。
 * 已发出的农事提示保存的是当时的校准版本与结果，升级校准不会回溯改写。
 */

export function findCalibration(calibrations, observation) {
  if (!observation.calibration) return null;
  return calibrations.find((entry) => entry.version === observation.calibration) ?? null;
}

export function calibrationApplies(calibration, observation) {
  if (!calibration) return false;
  return calibration.source === observation.source
    && calibration.metric === observation.metric
    && calibration.unit === observation.unit
    && Number.isFinite(Number(calibration.multiplier));
}

function round(value) {
  // 毫米保留 3 位小数，避免二进制浮点尾巴进入服务值
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * @returns {{ value: number|null, unit: string, calibrationVersion: string|null,
 *            multiplier: number|null, applied: boolean, reason: string }}
 */
export function applyCalibration(calibrations, observation) {
  const version = observation.calibration ?? null;
  if (version === null) {
    return {
      value: observation.value,
      unit: observation.unit,
      calibrationVersion: null,
      multiplier: null,
      applied: false,
      reason: 'observation-declares-no-calibration',
    };
  }
  const calibration = findCalibration(calibrations, observation);
  if (!calibration) {
    return {
      value: observation.value,
      unit: observation.unit,
      calibrationVersion: version,
      multiplier: null,
      applied: false,
      reason: `calibration-version-unknown:${version}`,
    };
  }
  if (!calibrationApplies(calibration, observation)) {
    return {
      value: observation.value,
      unit: observation.unit,
      calibrationVersion: version,
      multiplier: null,
      applied: false,
      reason: `calibration-scope-mismatch:${version}`,
    };
  }
  const raw = observation.value;
  if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) {
    return {
      value: null,
      unit: calibration.unit,
      calibrationVersion: version,
      multiplier: calibration.multiplier,
      applied: true,
      reason: 'raw-value-not-numeric',
    };
  }
  return {
    value: round(raw * Number(calibration.multiplier)),
    unit: calibration.unit,
    calibrationVersion: version,
    multiplier: Number(calibration.multiplier),
    applied: true,
    reason: 'calibrated',
  };
}
