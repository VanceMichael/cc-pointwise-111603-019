// 测试辅助：在独立进程中启动回环来源，首行 stdout 输出 url；
// 通过 stdin 写入 {"publish":"<stage>"} 切换来源阶段，便于 CLI 子进程并行访问。
import { createInterface } from 'node:readline/promises';
import { startSource } from '../source/server.js';

const scenarioArg = process.argv[2];
const scenario = scenarioArg ? new URL(scenarioArg, import.meta.url) : new URL('../fixtures/rainfall-scenario.json', import.meta.url);
const source = await startSource(scenario);
process.stdout.write(`${source.url}\n`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const command = JSON.parse(line);
  if (command.publish) source.publish(command.publish);
}
