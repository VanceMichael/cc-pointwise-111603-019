// 多来源页面适配：保留来源原始属性，并把路由与 ETag 作为来源身份依据。
// 与既有 adapter.js 的单页 parsePage 并存，互不影响旧导入流程。
import { normalizeObservation } from './observations.js';

export const ROUTES = Object.freeze([
  { route: '/weather/sensor-1', source: 'sensor' },
  { route: '/weather/public', source: 'web' },
]);

export function parseWeatherItems(response, { route, etag, receivedAt }) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error(`source items missing: ${route}`);
  return payload.items.map((item) => normalizeObservation(item, {
    receivedAt,
    route,
    etag: etag ?? response.etag ?? null,
  }));
}
