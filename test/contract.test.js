import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('issued weather advice freezes source and calibration references', async () => {
  const original = (await observe()).records[0].attributes;
  const withdrawn = (await observe('updated')).records[0].attributes;
  const publicObservation = (await observe('opening', '/weather/public')).records[0].attributes;
  assert.notEqual(original.metric, publicObservation.metric);
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.value, null);
  const forecasts = await fixture('forecasts');
  assert.equal(forecasts[0].calibration, original.calibration);
  assert.equal(forecasts[0].value, 2);
});
