import { describeSlot, isCompatible, slotKey } from './compatibility.js';
import { applyCalibration } from './calibration.js';

/**
 * 服务值选择：把多源观测收敛为可追溯的“当前服务值”。
 *
 * 规则：
 * 1. 只有口径完全兼容（站点/时段/指标/单位一致）的观测才进入同一个选择槽，
 *    网页估值与传感器测量不同指标，永远分槽，互不覆盖。
 * 2. 槽内先应用观测自己声明的校准版本（适用范围必须匹配），再按来源优先级
 *    选择服务值；同优先级按 observationId 稳定决胜。
 * 3. 撤回、原值为空、校准不可用、来源拉取失败都显式产生不确定性，服务值为 null，
 *    绝不把“缺失/失败”解释成降雨量 0。
 */

export const DEFAULT_PRIORITY = Object.freeze({ sensor: 1, web: 2 });

export const UNCERTAINTY = Object.freeze({
  NONE: null,
  NO_CANDIDATE: 'no-compatible-observation',
  WITHDRAWN: 'selected-observation-withdrawn',
  RAW_NULL: 'raw-value-null',
  CALIBRATION: 'calibration-not-applied',
  SOURCE_UNAVAILABLE: 'source-route-unavailable',
});

function buildCandidate(entry, calibrations) {
  const observation = entry.observation;
  const calibrated = applyCalibration(calibrations, observation);
  const reasons = [];
  if (observation.state === 'withdrawn') reasons.push(UNCERTAINTY.WITHDRAWN);
  if (observation.value === null || observation.value === undefined) reasons.push(UNCERTAINTY.RAW_NULL);
  if (!calibrated.applied && calibrated.reason !== 'observation-declares-no-calibration') {
    reasons.push(UNCERTAINTY.CALIBRATION);
  }
  return {
    observationId: entry.observationId,
    source: observation.source,
    state: observation.state ?? 'active',
    fetchedAt: entry.fetchedAt,
    route: entry.route,
    etag: entry.etag,
    raw: {
      value: observation.value ?? null,
      unit: observation.unit,
      calibrationVersion: observation.calibration ?? null,
    },
    calibrated,
    uncertaintyReasons: reasons,
  };
}

function selectCandidate(candidates, priority) {
  const rank = (candidate) => priority[candidate.source] ?? Number.MAX_SAFE_INTEGER;
  const byRankAndId = (left, right) => {
    const gap = rank(left) - rank(right);
    if (gap !== 0) return gap;
    return left.observationId.localeCompare(right.observationId);
  };
  // 明确可服务（未撤回、原值存在、校准可用）的候选才有资格按优先级胜出；
  // 全部不可服务时回退到最高优先级候选，由它携带不确定性原因，服务值为 null。
  const eligible = candidates.filter((candidate) => candidate.uncertaintyReasons.length === 0);
  return [...(eligible.length > 0 ? eligible : candidates)].sort(byRankAndId)[0];
}

/**
 * @param currentVersions ObservationStore.currentObservations() 的结果
 * @param calibrations 校准版本表
 * @param options.routes 本次采集的路由状态 { [route]: { status: 'ok'|'error', error? } }
 * @param options.priority 来源优先级表（数字越小越优先）
 * @param options.evaluatedAt 评估时刻
 */
export function evaluateServiceValues(currentVersions, calibrations, {
  routes = {},
  priority = DEFAULT_PRIORITY,
  evaluatedAt = new Date().toISOString(),
} = {}) {
  const slots = new Map();
  for (const entry of currentVersions) {
    const key = slotKey(entry.observation);
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(buildCandidate(entry, calibrations));
  }

  const values = [...slots.entries()].map(([slot, candidates]) => {
    const selected = selectCandidate(candidates, priority);
    const uncertainty = selected.uncertaintyReasons.length > 0 ? selected.uncertaintyReasons : UNCERTAINTY.NONE;
    return {
      slot,
      ...describeSlot(slot),
      status: uncertainty ? 'uncertain' : 'ok',
      serviceValue: uncertainty ? null : selected.calibrated.value,
      unit: selected.calibrated.unit,
      uncertainty,
      selected: {
        observationId: selected.observationId,
        source: selected.source,
        state: selected.state,
        fetchedAt: selected.fetchedAt,
        route: selected.route,
        etag: selected.etag,
      },
      basis: {
        rawValue: selected.raw.value,
        rawUnit: selected.raw.unit,
        calibrationVersion: selected.calibrated.calibrationVersion,
        multiplier: selected.calibrated.multiplier,
        calibrationApplied: selected.calibrated.applied,
        calibrationReason: selected.calibrated.reason,
      },
      candidates: candidates.map((candidate) => ({
        observationId: candidate.observationId,
        source: candidate.source,
        state: candidate.state,
        priorityRank: priority[candidate.source] ?? null,
        rawValue: candidate.raw.value,
        calibratedValue: candidate.calibrated.value,
        unit: candidate.calibrated.unit,
        calibrationVersion: candidate.calibrated.calibrationVersion,
        uncertaintyReasons: candidate.uncertaintyReasons,
      })),
      evaluatedAt,
    };
  }).sort((left, right) => left.slot.localeCompare(right.slot));

  // 已配置但本轮没有任何观测落进来的路由：缺口必须显式标不确定性，而不是零降雨
  const sourceGaps = Object.entries(routes)
    .filter(([, state]) => state.status !== 'ok')
    .map(([route, state]) => ({ route, status: state.status, reason: state.error ?? UNCERTAINTY.SOURCE_UNAVAILABLE }));

  return {
    product: '农业气象采集台',
    metric: 'hourly-rainfall-service-value',
    evaluatedAt,
    priority: structuredClone(priority),
    values,
    sourceGaps,
  };
}

export function serviceValueSignature(value) {
  return JSON.stringify({
    slot: value.slot,
    status: value.status,
    serviceValue: value.serviceValue,
    uncertainty: value.uncertainty,
    selected: value.selected.observationId,
    calibrationVersion: value.basis.calibrationVersion,
  });
}

export { isCompatible };
