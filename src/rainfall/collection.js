import { parseWeatherItems, ROUTES } from './adapter.js';
import { evaluateServiceValues } from './evaluation.js';

// 一次多源采集：读取各路由 → 版本化入库 → 立即重新评估当前服务值。
// 来源拉取失败只记录可用性事件（缺失≠零值），不中断其他路由，也不写入任何零值观测。
// expectedSeries 声明接入应覆盖的口径；未到达的口径在服务值中显式标 absent。
export async function collectOnce({
  client,
  store,
  catalog,
  routes = ROUTES,
  expectedSeries = [],
  previousEvaluations = [],
  now = new Date().toISOString(),
}) {
  const routeResults = [];
  for (const route of routes) {
    const path = route.route;
    let response;
    try {
      response = await client.readTracked(path, { etag: store.etagFor(path) });
    } catch (error) {
      const event = await store.recordAvailability(route.source, {
        route: path,
        status: error.cause?.code ?? 'fetch-error',
        at: now,
        detail: error.message,
      });
      routeResults.push({ route: path, source: route.source, outcome: 'unavailable', event });
      continue;
    }
    if (response.notModified) {
      routeResults.push({ route: path, source: route.source, outcome: 'not-modified', etag: response.etag });
      continue;
    }
    await store.rememberEtag(path, response.etag);
    const normalizedItems = parseWeatherItems(
      { text: response.text },
      { route: path, etag: response.etag, receivedAt: now },
    );
    const recorded = [];
    for (const normalized of normalizedItems) {
      const result = await store.recordVersion(normalized);
      recorded.push({
        observationId: normalized.observation.observationId,
        added: result.added,
        late: result.late,
        signature: normalized.signature,
      });
    }
    routeResults.push({
      route: path,
      source: route.source,
      outcome: 'updated',
      etag: response.etag,
      observations: recorded,
    });
  }

  const { values, evaluation } = evaluateServiceValues(store, catalog, {
    now,
    expectedSeries,
    previousEvaluations,
  });
  return { collectedAt: now, routeResults, values, evaluation };
}
