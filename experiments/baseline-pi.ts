/**
 * Baseline 实验（Pi Agent 直做）入口。
 *
 * 源码运行:   npx tsx experiments/baseline-pi.ts --experiment-id <id> [--mock ...]
 * 构建后运行: npm run build && node dist/experiments/baseline-pi.js --experiment-id <id> [--mock ...]
 *
 * 共享运行循环见 src/experiments/runner.ts。
 */
import { resolveProjectRootFromEntry, runExperimentFromCli } from '../src/experiments/runner.js';

const projectRoot = resolveProjectRootFromEntry(import.meta.url);
await runExperimentFromCli('baseline', process.argv.slice(2), projectRoot);
