import { readFile } from 'node:fs/promises';
import { JsonStore } from './state-store.js';

/**
 * 已发农事提示台账（只追加、不可改写）。
 *
 * 发给农户的每条提示都冻结当时的观测原值、校准版本、乘子与服务值；
 * 之后来源撤回或校准升级只影响“当前服务值”，台账里的依据原样保留。
 * 基线台账 fixtures/forecasts.json 是既有外部记录，读取时标记 frozenLegacy，
 * 本系统不会回写该文件。
 */
export class ForecastLedger {
  constructor(path, clock = () => new Date().toISOString()) {
    this.path = path;
    this.clock = clock;
    this.store = new JsonStore(path, { forecasts: [] });
  }

  async load() {
    const document = await this.store.load();
    if (!Array.isArray(document.forecasts)) throw new Error('forecast file has no forecasts array');
    return document;
  }

  /** 读取只读基线台账（如 fixtures/forecasts.json），不存在时返回空数组。 */
  static async readFrozen(path) {
    try {
      const document = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(document)) throw new Error('frozen forecast ledger must be an array');
      return document.map((entry) => ({ ...structuredClone(entry), frozenLegacy: true }));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async issue({ observationId, observationStore, calibrations, calibrate, id, issuedAt = this.clock() }) {
    const versions = await observationStore.currentObservations();
    const entry = versions.find((candidate) => candidate.observationId === observationId);
    if (!entry) throw new Error(`cannot issue: observation ${observationId} is not in the archive`);
    const calibrated = calibrate(calibrations, entry.observation);
    const forecast = {
      id: id ?? `issued-${Date.parse(issuedAt)}-${observationId}`,
      issuedAt,
      observationId,
      slot: entry.slot,
      source: entry.observation.source,
      station: entry.observation.station,
      intervalEnd: entry.observation.intervalEnd,
      durationMinutes: entry.observation.durationMinutes,
      metric: entry.observation.metric,
      state: entry.observation.state,
      basis: {
        fetchedAt: entry.fetchedAt,
        route: entry.route,
        etag: entry.etag,
        rawValue: entry.observation.value ?? null,
        unit: entry.observation.unit,
        calibration: entry.observation.calibration ?? null,
        calibrationVersion: calibrated.calibrationVersion,
        multiplier: calibrated.multiplier,
        calibrationApplied: calibrated.applied,
        calibrationReason: calibrated.reason,
      },
      value: calibrated.value,
      unit: calibrated.unit,
      immutable: true,
    };
    const document = await this.load();
    document.forecasts.push(forecast);
    await this.store.save(document);
    return forecast;
  }

  async list() {
    return (await this.load()).forecasts;
  }
}
