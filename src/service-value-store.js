import { JsonStore } from './state-store.js';
import { serviceValueSignature } from './service-value.js';

/**
 * 当前服务值及其修订历史。
 *
 * 每次重新评估都产生一份新评估文档；只有选择结果、状态或校准依据真正变化时
 * 才追加 revision，保证“晚到/撤回触发重新评估”可追溯，而重放不制造噪声。
 */
export class ServiceValueStore {
  constructor(path, clock = () => new Date().toISOString()) {
    this.store = new JsonStore(path, { current: null, revisions: [] });
    this.clock = clock;
  }

  async load() {
    const document = await this.store.load();
    if (!Array.isArray(document.revisions)) throw new Error('service-value file has no revisions array');
    return document;
  }

  async publish(evaluation) {
    const document = await this.load();
    const previousBySlot = new Map((document.current?.values ?? []).map((value) => [value.slot, value]));
    const revisions = [...document.revisions];
    for (const value of evaluation.values) {
      const previous = previousBySlot.get(value.slot);
      if (!previous || serviceValueSignature(previous) !== serviceValueSignature(value)) {
        revisions.push({
          changedAt: evaluation.evaluatedAt,
          slot: value.slot,
          before: previous ? {
            status: previous.status,
            serviceValue: previous.serviceValue,
            uncertainty: previous.uncertainty,
            selected: previous.selected.observationId,
            calibrationVersion: previous.basis.calibrationVersion,
          } : null,
          after: {
            status: value.status,
            serviceValue: value.serviceValue,
            uncertainty: value.uncertainty,
            selected: value.selected.observationId,
            calibrationVersion: value.basis.calibrationVersion,
          },
        });
      }
    }
    const next = { current: evaluation, revisions };
    await this.store.save(next);
    return next;
  }

  async current() {
    return (await this.load()).current;
  }

  async revisions() {
    return (await this.load()).revisions;
  }
}
