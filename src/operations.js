const fields = ["observationId", "source", "station", "intervalEnd", "durationMinutes", "metric", "value", "unit", "calibration", "state"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "农业气象采集台", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
