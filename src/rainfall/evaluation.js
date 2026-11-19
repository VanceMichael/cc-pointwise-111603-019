import { ObservationStore } from './observation-store.js';
import { isWithdrawn, seriesKey, sourcePriority } from './observations.js';

// 服务值选择引擎（纯领域逻辑，不直接读写文件）。
//
// 关键约束：
// 1. 只在明确兼容（同站点/同时段/同指标口径/同单位）的观测之间做来源优先级选择；
//    网页估值与传感器原值口径不同，永远不会进入同一候选集合，不能互相覆盖。
// 2. 校准只应用于观测引用版本存在且适用范围匹配的观测，未匹配时保留原值并标因。
// 3. 撤回、空值、迟到、来源不可用、多源冲突都显式标注不确定性；
//    任何缺失/撤回路径都输出 value=null，绝不输出 0。
export const UNCERTAINTY = Object.freeze({
  WEB_ESTIMATE: 'web-estimate',
  CONFLICTING_CANDIDATES: 'conflicting-candidates',
  LATE_ARRIVAL: 'late-arrival',
  NULL_OBSERVATION: 'null-observation',
  SOURCE_UNAVAILABLE: 'source-unavailable',
  STALE: 'stale',
  CALIBRATION_UNKNOWN: 'unknown-calibration-version',
  CALIBRATION_SCOPE_MISMATCH: 'calibration-scope-mismatch',
  CALIBRATION_SKIPPED: 'uncalibrated-source',
  ALL_WITHDRAWN: 'all-candidates-withdrawn',
  NO_OBSERVATION: 'no-observation',
});

export const STATUS = Object.freeze({
  OK: 'ok',
  UNCERTAIN: 'uncertain',
  WITHDRAWN: 'withdrawn',
  ABSENT: 'absent',
});

function pickWinner(activeVersions) {
  return [...activeVersions].sort((left, right) => {
    const priorityGap = sourcePriority(right.observation.source) - sourcePriority(left.observation.source);
    if (priorityGap !== 0) return priorityGap;
    const receivedGap = Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    if (receivedGap !== 0) return receivedGap;
    return left.observation.observationId.localeCompare(right.observation.observationId);
  })[0];
}

function buildBasis(store, versions, catalog, winnerId) {
  return versions.map((version) => {
    const calibration = catalog.apply(version.observation);
    return {
      observationId: version.observation.observationId,
      source: version.observation.source,
      state: version.observation.state,
      priority: sourcePriority(version.observation.source),
      rawValue: version.observation.value,
      unit: version.observation.unit,
      receivedAt: version.receivedAt,
      signature: version.signature,
      lateReason: version.lateReason,
      selected: version.observation.observationId === winnerId,
      calibration: {
        referenced: version.observation.calibration,
        applied: calibration.applied,
        reason: calibration.reason,
        version: calibration.calibrationVersion,
        multiplier: calibration.multiplier,
        calibratedValue: calibration.value,
      },
      historyLength: store.history(version.observation.observationId).length,
    };
  });
}

function isStale(store, version) {
  const events = store.availabilityEvents(version.observation.source);
  const receivedAt = Date.parse(version.receivedAt);
  return events.some((event) => Date.parse(event.at) > receivedAt);
}

function evaluateSeries(store, group, catalog, previousEvaluationAt, evaluatedAt) {
  ObservationStore.assertSameSeries(group.versions);
  const descriptor = group.descriptor;
  const uncertainty = new Set();
  const versions = group.versions;
  const active = versions.filter((version) => !isWithdrawn(version));

  // 全部候选都被撤回：当前服务值不可用，保留每个候选的原值与撤回依据，value 必须为 null。
  if (active.length === 0) {
    uncertainty.add(UNCERTAINTY.ALL_WITHDRAWN);
    return {
      row: {
        seriesKey: group.key,
        ...descriptor,
        status: STATUS.WITHDRAWN,
        value: null,
        rawValue: null,
        calibrationVersion: null,
        calibrationApplied: false,
        selectedObservationId: null,
        selectedSource: null,
        zeroAssumed: false,
        uncertainty: [...uncertainty],
        basis: buildBasis(store, versions, catalog, null),
        evaluatedAt,
      },
    };
  }

  const winner = pickWinner(active);
  const winnerObservation = winner.observation;
  const basis = buildBasis(store, versions, catalog, winnerObservation.observationId);

  // 同口径存在多个有效候选（多源冲突）：按优先级选出服务值，但必须标出不确定性。
  if (active.length > 1) uncertainty.add(UNCERTAINTY.CONFLICTING_CANDIDATES);
  if (winnerObservation.source === 'web') uncertainty.add(UNCERTAINTY.WEB_ESTIMATE);
  // 序列内任何候选出现迟到修订/替换，或在上次评估之后才到达，当前服务值都需标不确定性。
  if (versions.some((version) => Boolean(version.lateReason))
    || (previousEvaluationAt && active.some(
      (version) => Date.parse(version.receivedAt) > Date.parse(previousEvaluationAt),
    ))) {
    uncertainty.add(UNCERTAINTY.LATE_ARRIVAL);
  }
  if (isStale(store, winner)) {
    uncertainty.add(UNCERTAINTY.SOURCE_UNAVAILABLE);
    uncertainty.add(UNCERTAINTY.STALE);
  }

  const calibration = catalog.apply(winnerObservation);
  if (!calibration.applied) {
    if (calibration.reason === 'no-calibration-reference') {
      uncertainty.add(UNCERTAINTY.CALIBRATION_SKIPPED);
    } else if (calibration.reason === 'unknown-calibration-version') {
      uncertainty.add(UNCERTAINTY.CALIBRATION_UNKNOWN);
    } else if (calibration.reason === 'calibration-scope-mismatch') {
      uncertainty.add(UNCERTAINTY.CALIBRATION_SCOPE_MISMATCH);
    }
  }

  // 有效但数值为 null 的观测：是“无数据”，不是零降雨。
  if (winnerObservation.value === null) {
    uncertainty.add(UNCERTAINTY.NULL_OBSERVATION);
    return {
      row: {
        seriesKey: group.key,
        ...descriptor,
        status: STATUS.UNCERTAIN,
        value: null,
        rawValue: null,
        calibrationVersion: calibration.calibrationVersion,
        calibrationApplied: false,
        selectedObservationId: winnerObservation.observationId,
        selectedSource: winnerObservation.source,
        zeroAssumed: false,
        uncertainty: [...uncertainty],
        basis,
        evaluatedAt,
      },
    };
  }

  return {
    row: {
      seriesKey: group.key,
      ...descriptor,
      status: uncertainty.size === 0 ? STATUS.OK : STATUS.UNCERTAIN,
      value: calibration.value,
      rawValue: winnerObservation.value,
      calibrationVersion: calibration.applied ? calibration.calibrationVersion : winnerObservation.calibration,
      calibrationApplied: calibration.applied,
      calibrationMultiplier: calibration.applied ? calibration.multiplier : null,
      selectedObservationId: winnerObservation.observationId,
      selectedSource: winnerObservation.source,
      zeroAssumed: false,
      uncertainty: [...uncertainty],
      basis,
      evaluatedAt,
    },
  };
}

function absentRow(descriptor, evaluatedAt) {
  return {
    seriesKey: seriesKey(descriptor),
    station: descriptor.station,
    intervalEnd: descriptor.intervalEnd,
    durationMinutes: descriptor.durationMinutes,
    metric: descriptor.metric,
    unit: descriptor.unit,
    status: STATUS.ABSENT,
    value: null,
    rawValue: null,
    calibrationVersion: null,
    calibrationApplied: false,
    selectedObservationId: null,
    selectedSource: null,
    zeroAssumed: false,
    uncertainty: [UNCERTAINTY.NO_OBSERVATION],
    basis: [],
    note: '来源缺失或尚未到达；不代表降雨为零',
    evaluatedAt,
  };
}

// expectedSeries：接入路由声明应出现的口径描述符列表；未到达的口径显式输出 absent 行。
// previousEvaluations：历史评估记录（可选），用于判定晚到。
export function evaluateServiceValues(store, catalog, {
  now = new Date().toISOString(),
  expectedSeries = [],
  previousEvaluations = [],
} = {}) {
  const groups = store.series();
  const rows = [];
  for (const group of groups) {
    const previous = previousEvaluations
      .filter((entry) => entry.seriesKey === group.key)
      .sort((left, right) => Date.parse(right.evaluatedAt) - Date.parse(left.evaluatedAt))[0];
    const { row } = evaluateSeries(store, group, catalog, previous?.evaluatedAt ?? null, now);
    rows.push(row);
  }

  const presentKeys = new Set(groups.map((group) => group.key));
  for (const descriptor of expectedSeries) {
    const key = seriesKey(descriptor);
    if (!presentKeys.has(key)) rows.push(absentRow(descriptor, now));
  }

  rows.sort((left, right) => left.seriesKey.localeCompare(right.seriesKey));

  const evaluation = {
    evaluatedAt: now,
    rows: rows.map((row) => ({
      seriesKey: row.seriesKey,
      status: row.status,
      value: row.value,
      selectedObservationId: row.selectedObservationId,
      calibrationVersion: row.calibrationVersion,
      uncertainty: [...row.uncertainty],
    })),
  };
  return { values: rows, evaluation };
}
