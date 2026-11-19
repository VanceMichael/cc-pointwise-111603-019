import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../src/rainfall/cli.js', import.meta.url));
const launcherPath = fileURLToPath(new URL('../../test-helpers/source-launcher.mjs', import.meta.url));
const calibrationPath = fileURLToPath(new URL('../../fixtures/calibrations.json', import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

async function startExternalSource() {
  const child = spawn(process.execPath, [launcherPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) resolve(buffer.trim());
    });
    child.on('exit', (code) => reject(new Error(`source launcher exited early: ${code}`)));
  });
  return { child, url };
}

test('新 CLI 帮助说明多源服务值选择入口与三条不变量', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  for (const command of ['collect', 'evaluate', 'issue', 'service-values', 'verify']) {
    assert.ok(help.commands[command], `缺少命令说明 ${command}`);
  }
  assert.ok(help.notes.join('|').includes('不能互相覆盖'));
  assert.ok(help.notes.join('|').includes('绝不'));
});

test('未知动作明确失败', () => {
  const result = run(['frobnicate']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /collect, evaluate, issue, service-values, verify/);
});

test('采集→服务值→下发→撤回→核对 的 CLI 全链路保持已发依据不可变', async () => {
  const external = await startExternalSource();
  const directory = await mkdtemp(join(tmpdir(), 'rainfall-cli-'));
  try {
    const seriesKey = 'S1|2026-11-16T08:00:00Z|60|rainfall-total|mm';
    const baseArgs = ['--state', directory, '--calibrations', calibrationPath];

    const collected = run(['collect', '--url', external.url, ...baseArgs]);
    assert.equal(collected.status, 0, collected.stderr);
    const collection = JSON.parse(collected.stdout);
    const sensorRow = collection.values.find((row) => row.metric === 'rainfall-total');
    assert.equal(sensorRow.value, 2);

    const issued = run(['issue', '--series', seriesKey, ...baseArgs]);
    assert.equal(issued.status, 0, issued.stderr);
    assert.equal(JSON.parse(issued.stdout).issued.basis.calibrationVersion, 'c1');

    // 撤回后当前服务值为 null，但已发记录保持 value=2/c1
    external.child.stdin.write(`${JSON.stringify({ publish: 'withdrawn' })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    const recollected = run(['collect', '--url', external.url, ...baseArgs]);
    assert.equal(recollected.status, 0, recollected.stderr);
    const afterWithdrawal = JSON.parse(recollected.stdout).values
      .find((row) => row.metric === 'rainfall-total');
    assert.equal(afterWithdrawal.value, null);

    const uncertainOnly = run(['service-values', '--uncertain-only', ...baseArgs]);
    assert.equal(uncertainOnly.status, 0, uncertainOnly.stderr);
    const uncertainRows = JSON.parse(uncertainOnly.stdout);
    assert.ok(uncertainRows.every((row) => row.status !== 'ok'));
    assert.ok(uncertainRows.some((row) => row.value === null));

    const verify = run(['verify', ...baseArgs]);
    assert.equal(verify.status, 0, verify.stderr);
    const verdicts = JSON.parse(verify.stdout);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0].value, 2);
    assert.equal(verdicts[0].basisStillHolds, false);

    const ledgerText = await readFile(join(directory, 'forecasts.jsonl'), 'utf8');
    assert.equal(ledgerText.split('\n').filter((line) => line).length, 1, '账本只追加且未被改写');
  } finally {
    external.child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
