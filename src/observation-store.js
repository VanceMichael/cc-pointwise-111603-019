import { JsonStore } from './state-store.js';
import { slotKey } from './compatibility.js';

/**
 * 只追加的观测档案。
 *
 * 同一个 observationId 的每次来源更新（包括撤回、置空、换校准版本）都追加为
 * 一个新版本，历史原值与参数永不覆盖；当前视图取每个 observationId 的最新版本。
 * 来源“没有数据”在档案里没有任何记录，不会被写成 value=0 的观测。
 */
export class ObservationStore {
  constructor(path, clock = () => new Date().toISOString()) {
    this.store = new JsonStore(path, { observations: [] });
    this.clock = clock;
  }

  async load() {
    const document = await this.store.load();
    if (!Array.isArray(document.observations)) throw new Error('observation file has no observations array');
    return document;
  }

  /**
   * 追加一个来源页面的全部条目。
   * @returns 本次追加的版本数与去重跳过数
   */
  async appendPage(records, { route, etag = null, fetchedAt = this.clock() } = {}) {
    const document = await this.load();
    let appended = 0;
    let duplicate = 0;
    for (const record of records) {
      const attributes = record.attributes ?? {};
      const observationId = String(attributes.observationId ?? record.sourceId ?? '').trim();
      if (!observationId) throw new Error('observation missing observationId');
      const version = {
        observationId,
        route,
        etag,
        fetchedAt,
        slot: slotKey(attributes),
        observation: structuredClone(attributes),
      };
      const last = [...document.observations].reverse().find((entry) => entry.observationId === observationId);
      if (last && JSON.stringify(last.observation) === JSON.stringify(version.observation)) {
        duplicate += 1;
        continue;
      }
      document.observations.push(version);
      appended += 1;
    }
    await this.store.save(document);
    return { appended, duplicate, stored: document.observations.length };
  }

  /** 每个 observationId 的最新版本（来源撤回也保留为最新状态，不删除）。 */
  async currentObservations() {
    const document = await this.load();
    const latest = new Map();
    for (const entry of document.observations) {
      const previous = latest.get(entry.observationId);
      if (!previous || Date.parse(entry.fetchedAt) >= Date.parse(previous.fetchedAt)) {
        latest.set(entry.observationId, entry);
      }
    }
    return [...latest.values()];
  }

  /** 取某个 observationId 在指定时刻已知的最新版本快照，供“已发提示”冻结依据。 */
  async versionAt(observationId, at) {
    const document = await this.load();
    const known = document.observations
      .filter((entry) => entry.observationId === observationId && Date.parse(entry.fetchedAt) <= Date.parse(at))
      .sort((left, right) => Date.parse(left.fetchedAt) - Date.parse(right.fetchedAt));
    return known.at(-1) ?? null;
  }

  async allVersions() {
    return (await this.load()).observations;
  }
}
