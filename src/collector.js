import { collectionRoutes, parseRoutePage } from './adapter.js';
import { SourceClient } from './source-client.js';
import { evaluateServiceValues } from './service-value.js';

/**
 * 一轮多源采集 + 服务值重评估。
 *
 * 每条路由独立处理：成功的页面追加进只追加观测档案，失败/不可达的路由记录为
 * sourceGaps——档案里不会凭空出现零值，已有观测也不会因一次失败被删除。
 * 无论本轮有无新条目，都会基于当前观测重新评估服务值，因此来源晚到或撤回后，
 * 当前服务值、不确定性标记与修订历史都会同步更新。
 */
export async function collectOnce({
  baseUrl,
  routes = collectionRoutes,
  client = new SourceClient(baseUrl),
  observationStore,
  serviceValueStore,
  calibrations,
  priority,
  clock = () => new Date().toISOString(),
}) {
  const fetchedAt = clock();
  const routeStates = {};
  const pages = [];

  for (const route of routes) {
    try {
      const response = await client.read(route);
      const page = parseRoutePage(response, route);
      routeStates[route] = { status: 'ok' };
      pages.push(page);
    } catch (error) {
      // 拉取失败只标记缺口：保留旧观测，服务值转不确定而非清零
      routeStates[route] = { status: 'error', error: String(error.message ?? error) };
    }
  }

  let appended = 0;
  let duplicate = 0;
  for (const page of pages) {
    const result = await observationStore.appendPage(page.records, {
      route: page.route,
      etag: page.etag,
      fetchedAt,
    });
    appended += result.appended;
    duplicate += result.duplicate;
  }

  const currentVersions = await observationStore.currentObservations();
  const evaluation = evaluateServiceValues(currentVersions, calibrations, {
    routes: routeStates,
    priority,
    evaluatedAt: fetchedAt,
  });
  await serviceValueStore.publish(evaluation);

  return {
    fetchedAt,
    routes: routeStates,
    appended,
    duplicate,
    slots: evaluation.values.length,
    sourceGaps: evaluation.sourceGaps,
    evaluation,
  };
}
