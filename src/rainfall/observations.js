// 观测口径与版本身份。
// 同一组 (station, intervalEnd, durationMinutes, metric, unit) 才是同一种观测；
// 网页 rainfall-estimate 与传感器 rainfall-total 即使时间相同也不是同一种观测，
// 因此不能互相覆盖。来源身份按 source 名称确定，不与业务来源产品名混用。

export const OBSERVATION_STATES = Object.freeze(['active', 'withdrawn']);

// 同口径内部的来源优先级：仅用于明确兼容的观测之间。
export const SOURCE_PRIORITY = Object.freeze({
  sensor: 100,
  web: 10,
});

const REQUIRED_FIELDS = [
  'observationId',
  'source',
  'station',
  'intervalEnd',
  'durationMinutes',
  'metric',
  'unit',
];

const FINGERPRINT_FIELDS = [
  'source',
  'station',
  'intervalEnd',
  'durationMinutes',
  'metric',
  'unit',
  'value',
  'state',
  'calibration',
];

export function seriesKey(observation) {
  return [
    observation.station,
    observation.intervalEnd,
    observation.durationMinutes,
    observation.metric,
    observation.unit,
  ].join('|');
}

// 两个观测只有在站点、观测时段、指标口径与单位全部一致时才兼容。
// 时间相同但指标口径不同（rainfall-total vs rainfall-estimate）返回 false。
export function isCompatibleObservation(left, right) {
  if (!left || !right) return false;
  return seriesKey(left) === seriesKey(right);
}

export function sourcePriority(source) {
  return SOURCE_PRIORITY[source] ?? 0;
}

export function normalizeObservation(item, { receivedAt, route = null, etag = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('observation item must be an object');
  }
  for (const field of REQUIRED_FIELDS) {
    const value = item[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`missing ${field} for observation`);
    }
  }
  const observation = {
    observationId: String(item.observationId),
    source: String(item.source),
    station: String(item.station),
    intervalEnd: String(item.intervalEnd),
    durationMinutes: Number(item.durationMinutes),
    metric: String(item.metric),
    unit: String(item.unit),
    value: item.value === null || item.value === undefined ? null : Number(item.value),
    state: item.state === undefined || item.state === null ? 'active' : String(item.state),
    calibration: item.calibration === undefined || item.calibration === null
      ? null
      : String(item.calibration),
  };
  if (!Number.isFinite(Date.parse(observation.intervalEnd))) {
    throw new Error(`invalid intervalEnd for observation ${observation.observationId}`);
  }
  if (!Number.isFinite(observation.durationMinutes) || observation.durationMinutes <= 0) {
    throw new Error(`invalid durationMinutes for observation ${observation.observationId}`);
  }
  if (!OBSERVATION_STATES.includes(observation.state)) {
    throw new Error(`invalid state ${observation.state} for observation ${observation.observationId}`);
  }
  if (observation.value !== null && !Number.isFinite(observation.value)) {
    throw new Error(`invalid value for observation ${observation.observationId}`);
  }
  const received = receivedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(received))) {
    throw new Error('invalid receivedAt for observation');
  }
  return {
    observation,
    receivedAt: received,
    origin: route ? { route, etag: etag ?? null } : null,
    signature: observationSignature(observation),
  };
}

export function observationSignature(observation) {
  return FINGERPRINT_FIELDS.map((field) => JSON.stringify(observation[field] ?? null)).join('|');
}

export function isWithdrawn(version) {
  return version.observation.state === 'withdrawn';
}
