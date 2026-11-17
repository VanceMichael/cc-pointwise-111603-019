/**
 * 观测口径兼容性判定。
 *
 * 合并多源观测的唯一依据是“同一观测口径”，而不是时间戳相同：
 * 站点、时段（intervalEnd + durationMinutes）、指标、单位全部一致才兼容。
 * 网页 rainfall-estimate 与传感器 rainfall-total 即使落在同一个小时也不兼容，
 * 因此网页估值永远不能参与传感器原值的优先级竞争，更不能覆盖原值。
 */

const requiredFields = ['station', 'intervalEnd', 'durationMinutes', 'metric', 'unit'];

export function slotKey(observation) {
  return [
    String(observation.station ?? ''),
    String(observation.intervalEnd ?? ''),
    String(observation.durationMinutes ?? ''),
    String(observation.metric ?? ''),
    String(observation.unit ?? ''),
  ].join('|');
}

export function isCompatible(left, right) {
  if (!left || !right) return false;
  return requiredFields.every((field) => Object.prototype.hasOwnProperty.call(left, field)
    && Object.prototype.hasOwnProperty.call(right, field)
    && String(left[field]) === String(right[field]));
}

export function describeSlot(slot) {
  const [station, intervalEnd, durationMinutes, metric, unit] = slot.split('|');
  return { station, intervalEnd, durationMinutes: Number(durationMinutes), metric, unit };
}
