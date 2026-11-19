import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRainfallState } from './state.js';
import { TrackedSourceClient } from './source-client.js';
import { collectOnce } from './collection.js';
import { ROUTES } from './adapter.js';
import { evaluateServiceValues, STATUS } from './evaluation.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const defaultStateDir = resolve(projectRoot, 'var/rainfall');
const defaultCalibrationPath = resolve(projectRoot, 'fixtures/calibrations.json');

// 本地接入应覆盖的口径描述符；未到达的口径会得到 absent（value=null）而不是零。
const EXPECTED_SERIES = [
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-total', unit: 'mm' },
  { station: 'S1', intervalEnd: '2026-11-16T08:00:00Z', durationMinutes: 60, metric: 'rainfall-estimate', unit: 'mm' },
];

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    }
  }
  return options;
}

const HELP = {
  usage: 'node src/rainfall/cli.js <collect|evaluate|issue|service-values|verify> [选项]',
  commands: {
    collect: '从回环来源多路由采集，版本化入库并重新评估当前服务值 --url <回环来源> [--state 目录] [--calibrations 文件]',
    evaluate: '不重新采集，仅用本地观测版本库重新评估服务值（来源晚到/撤回后使用）',
    issue: '把指定口径的当前服务值固化为已发农户提示 --series <seriesKey> [--message 文本]',
    'service-values': '读取当前服务值；可加 --uncertain-only 只看不确定/撤回/缺失行',
    verify: '逐条核对已发提示的观测与校准依据是否仍成立（只核对，不改写）',
  },
  notes: [
    '网页 rainfall-estimate 与传感器 rainfall-total 口径不同，不能互相覆盖',
    '来源缺失、撤回、空值一律 value=null 并标注不确定性，绝不把来源缺失当成降雨为零',
    '已发提示只追加保存，校准升级或来源撤回都不会改写其原始依据',
  ],
};

async function main() {
  const [action = '--help', ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (action === '--help' || action === '-h') {
    console.log(JSON.stringify(HELP, null, 2));
    return;
  }
  const stateDir = options.state ? resolve(options.state) : defaultStateDir;
  await mkdir(stateDir, { recursive: true });
  const state = createRainfallState(stateDir, {
    calibrationPath: options.calibrations ? resolve(options.calibrations) : defaultCalibrationPath,
  });
  await state.open();
  const catalog = await state.loadCatalog();
  const previousEvaluations = await state.evaluationLog.read();

  if (action === 'collect') {
    if (!options.url) throw new Error('collect requires --url http://127.0.0.1:<port>');
    const result = await collectOnce({
      client: new TrackedSourceClient(options.url),
      store: state.store,
      catalog,
      routes: ROUTES,
      expectedSeries: EXPECTED_SERIES,
      previousEvaluations,
    });
    const nextLog = [...previousEvaluations, result.evaluation];
    await state.evaluationLog.replace(nextLog);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === 'evaluate') {
    const { values, evaluation } = evaluateServiceValues(state.store, catalog, {
      expectedSeries: EXPECTED_SERIES,
      previousEvaluations,
    });
    await state.evaluationLog.replace([...previousEvaluations, evaluation]);
    console.log(JSON.stringify({ evaluation, values }, null, 2));
    return;
  }

  if (action === 'service-values') {
    const { values } = evaluateServiceValues(state.store, catalog, {
      expectedSeries: EXPECTED_SERIES,
      previousEvaluations,
    });
    const visible = options['uncertain-only']
      ? values.filter((row) => row.status !== STATUS.OK)
      : values;
    console.log(JSON.stringify(visible, null, 2));
    return;
  }

  if (action === 'issue') {
    if (!options.series) throw new Error('issue requires --series <seriesKey>');
    const { values } = evaluateServiceValues(state.store, catalog, {
      expectedSeries: EXPECTED_SERIES,
      previousEvaluations,
    });
    const target = values.find((row) => row.seriesKey === options.series);
    if (!target) throw new Error(`unknown series: ${options.series}`);
    const entry = await state.ledger.issue(target, {
      message: options.message === true ? null : (options.message ?? null),
    });
    console.log(JSON.stringify({ issued: entry }, null, 2));
    return;
  }

  if (action === 'verify') {
    const verdicts = await state.ledger.verifyAgainst(state.store, catalog);
    console.log(JSON.stringify(verdicts, null, 2));
    return;
  }

  throw new Error('action must be one of collect, evaluate, issue, service-values, verify');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
