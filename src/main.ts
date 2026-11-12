/**
 * CLI 分发入口：node dist/src/main.js baseline|dag [--...] 转调 experiments 入口，
 * 无参数 / 未知命令时打印用法。
 */
import { runExperimentFromCli, usageText } from './experiments/runner.js';

const USAGE_HEADER = [
  'agentic-data-dag — AgenticDataBench 实验入口（Pi Baseline / DAG Prototype）',
  '',
].join('\n');

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'baseline' || command === 'dag') {
    await runExperimentFromCli(command, rest);
    return;
  }
  console.log(`${USAGE_HEADER}${usageText()}`);
  if (command !== undefined && command !== '-h' && command !== '--help') {
    console.error(`\n未知命令: ${command}（应为 baseline 或 dag）`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`运行失败: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
