/**
 * DAG Prototype 实验（Inspect → Plan → Execute → Verify 四节点）入口。
 *
 * 源码运行:   npx tsx experiments/dag-prototype.ts --experiment-id <id> [--mock ...]
 * 构建后运行: npm run build && node dist/experiments/dag-prototype.js --experiment-id <id> [--mock ...]
 *
 * 共享运行循环见 src/experiments/runner.ts。
 */
import { resolveProjectRootFromEntry, runExperimentFromCli } from '../src/experiments/runner.js';

const projectRoot = resolveProjectRootFromEntry(import.meta.url);
await runExperimentFromCli('dag', process.argv.slice(2), projectRoot);
