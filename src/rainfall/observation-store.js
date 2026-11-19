import { JsonRepository } from './persistence.js';
import {
  isCompatibleObservation,
  isWithdrawn,
  seriesKey,
} from './observations.js';

// 观测版本库：每个 observationId 保存完整、只追加的版本历史，
// 撤回通过新版本表达，旧版本保留用于审计与已发依据核对。
// 另记录来源可用性事件：来源拉取失败是“缺失/不可用”，不是零值观测。
export class ObservationStore {
  constructor(path) {
    this.repository = new JsonRepository(path, 'observations');
    this.versions = new Map();
    this.availability = new Map();
    this.etags = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    const document = await this.repository.read();
    for (const row of document) {
      if (row.kind === 'version') {
        const list = this.versions.get(row.observationId) ?? [];
        list.push(row.version);
        this.versions.set(row.observationId, list);
      } else if (row.kind === 'availability') {
        const list = this.availability.get(row.source) ?? [];
        list.push(row.event);
        this.availability.set(row.source, list);
      } else if (row.kind === 'etag') {
        this.etags.set(row.route, row.etag);
      }
    }
    this.loaded = true;
    return this;
  }

  async #persist() {
    const rows = [];
    for (const [observationId, list] of this.versions) {
      for (const version of list) rows.push({ kind: 'version', observationId, version });
    }
    for (const [source, list] of this.availability) {
      for (const event of list) rows.push({ kind: 'availability', source, event });
    }
    for (const [route, etag] of this.etags) rows.push({ kind: 'etag', route, etag });
    await this.repository.replace(rows);
  }

  etagFor(route) {
    return this.etags.get(route) ?? null;
  }

  async rememberEtag(route, etag) {
    await this.load();
    if (!etag || this.etags.get(route) === etag) return;
    this.etags.set(route, etag);
    await this.#persist();
  }

  // 写入一个规范化观测版本；内容签名与最新版本相同则视为重拉重复，不产生新版本。
  // 返回版本以及是否为迟到（该 observationId 已有历史时收到内容不同的新版本，
  // 即首版已经进入过服务值评估之后的修订/撤回）。
  async recordVersion(normalized) {
    await this.load();
    const id = normalized.observation.observationId;
    const history = this.versions.get(id) ?? [];
    const latest = history[history.length - 1] ?? null;
    if (latest && latest.signature === normalized.signature) {
      return { version: latest, added: false, late: false };
    }
    const late = history.length > 0;
    const version = {
      sequence: history.length + 1,
      ...normalized,
      lateReason: late ? this.#describeLateReason(history, normalized) : null,
    };
    history.push(version);
    this.versions.set(id, history);
    await this.#persist();
    return { version, added: true, late };
  }

  #describeLateReason(history, normalized) {
    const previous = history[history.length - 1];
    if (isWithdrawn(normalized) && !isWithdrawn(previous)) return 'revision-after-withdrawal-flow';
    if (!isWithdrawn(normalized) && isWithdrawn(previous)) return 'replacement-after-withdrawal';
    return 'revision-after-first-publication';
  }

  // 来源不可用事件：status 为 http 状态码或 'disconnect'/'timeout' 等。
  async recordAvailability(source, { route, status, at = new Date().toISOString(), detail = null }) {
    await this.load();
    const event = { source, route: route ?? null, status: String(status), at, detail };
    const list = this.availability.get(source) ?? [];
    list.push(event);
    this.availability.set(source, list);
    await this.#persist();
    return event;
  }

  history(observationId) {
    return structuredClone(this.versions.get(observationId) ?? []);
  }

  latestVersion(observationId) {
    const history = this.versions.get(observationId) ?? [];
    return history[history.length - 1] ?? null;
  }

  availabilityEvents(source) {
    if (source === undefined) {
      return Object.fromEntries([...this.availability].map(([key, list]) => [key, structuredClone(list)]));
    }
    return structuredClone(this.availability.get(source) ?? []);
  }

  // 每个 observationId 的最新版本；同一口径序列内只比较明确兼容的观测。
  latestVersions() {
    const result = [];
    for (const list of this.versions.values()) {
      const latest = list[list.length - 1];
      if (latest) result.push(latest);
    }
    return result;
  }

  // 按口径序列分组最新版本；不兼容的观测（如 web 估值 vs 传感器原值）永远分到不同序列。
  series() {
    const groups = new Map();
    for (const version of this.latestVersions()) {
      const key = seriesKey(version.observation);
      const group = groups.get(key) ?? {
        key,
        descriptor: {
          station: version.observation.station,
          intervalEnd: version.observation.intervalEnd,
          durationMinutes: version.observation.durationMinutes,
          metric: version.observation.metric,
          unit: version.observation.unit,
        },
        versions: [],
      };
      group.versions.push(version);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  // 兼容性断言：只允许把明确同口径的版本放进同一个候选集合。
  static assertSameSeries(versions) {
    const first = versions[0]?.observation;
    for (const version of versions.slice(1)) {
      if (!isCompatibleObservation(first, version.observation)) {
        throw new Error(`incompatible observations grouped together: ${first.observationId} vs ${version.observation.observationId}`);
      }
    }
  }
}
