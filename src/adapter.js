export const entryPath = "/weather/sensor-1";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["observationId"]),
    source: "农业气象采集台",
    observedAt: item["intervalEnd"],
    label: String(item["station"]),
    attributes: structuredClone(item),
  })) };
}
