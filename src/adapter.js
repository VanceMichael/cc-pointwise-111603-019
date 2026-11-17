export const entryPath = "/weather/sensor-1";

/**
 * 多源采集路由：网页估值与传感器测量走不同入口，
 * 口径差异在指标层保留，适配器不做任何跨源合并。
 */
export const collectionRoutes = Object.freeze([
  "/weather/sensor-1",
  "/weather/sensor-2",
  "/weather/public",
]);

function toRecords(payload, route) {
  if (!Array.isArray(payload.items)) throw new Error(`source items missing: ${route}`);
  return payload.items.map((item) => ({
    sourceId: String(item["observationId"]),
    source: "农业气象采集台",
    observedAt: item["intervalEnd"],
    label: String(item["station"]),
    attributes: structuredClone(item),
  }));
}

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  const next = payload.next ?? null;
  return { next, records: toRecords(payload, entryPath) };
}

export function parseRoutePage(response, route) {
  const payload = JSON.parse(response.text);
  const next = payload.next ?? null;
  const etag = response.etag ?? null;
  return { next, etag, route, records: toRecords(payload, route) };
}
