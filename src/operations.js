const fields = ["observationId", "source", "station", "intervalEnd", "durationMinutes", "metric", "value", "unit", "calibration", "state"];

export async function readOperations(repository, serviceValueStore = null, forecastLedger = null) {
  const records = await repository.read();
  const operations = { product: "农业气象采集台", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
  if (serviceValueStore) {
    operations.serviceValues = await serviceValueStore.current();
  }
  if (forecastLedger) {
    operations.issuedForecasts = await forecastLedger.list();
  }
  return operations;
}
