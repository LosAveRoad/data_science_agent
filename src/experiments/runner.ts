/**
 * 实验共享运行循环（src/experiments 公共代码）：
 *
 * - CLI 参数解析（--experiment-id / --tasks / --all / --limit / --mock /
 *   --token-budget / --max-steps / --overwriting / --concurrency）；
 * - 从 configs/benchmark.json 冻结子集读取任务（数据目录取 $AGENTIC_DATA_BENCH_DATA_DIR，
 *   入口启动时先 loadEnvFile 加载项目 .env）；
 * - 每个 task：准备工作区 → baseline（单次 PiAgentRunner）或 DAG（DagExecutor +
 *   defaultWorkflow + PiAgentRunner(mode='node')）→ collectTaskOutputs 收集产出 →
 *   复制到 `<runDir>/output-da-agent/<task_id>/`（目录名含 da-agent 子串，
 *   官方 Evaluator 按路径选解析分支）→ 写 dabench/result.json 与 summary/<task_id>.json；
 * - 断点续跑：同一 experiment-id 重跑时，已完成任务（输出目录存在且 summary 状态为
 *   succeeded）自动跳过；--overwriting 强制重跑；
 * - run 结束写 run-summary.json（全部任务状态 / token 汇总 + 模型与配置）。
 *
 * 入口文件：experiments/baseline-pi.ts、experiments/dag-prototype.ts（编译产物
 * dist/experiments/*.js），也可经 src/main.ts 分发调用。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../agent/pi-runtime.js';
import { MockAgentRunner } from '../agent/mock-agent.js';
import { PiAgentRunner } from '../agent/pi-runtime.js';
import { subsetFromConfig } from '../benchmark/task-loader.js';
import type { BenchmarkTask } from '../benchmark/task-loader.js';
import { collectTaskOutputs, prepareWorkspace } from '../benchmark/workspace.js';
import type { AgentRunner, NodeRunResult } from '../dag/executor.js';
import { DagExecutor } from '../dag/executor.js';
import { taskWorkflow } from '../dag/workflow.js';
import { addTokenUsage, emptyTokenUsage } from '../tracing/recorder.js';
import { RunRecorder } from '../tracing/recorder.js';
import type { TokenUsage } from '../tracing/recorder.js';
import { createTaskOutputGate } from '../validate/gate.js';
import { baselineMockScript, dagMockScripts, NodeScriptedMockRunner } from './mock-scripts.js';

/** 实验模式。 */
export type ExperimentMode = 'baseline' | 'dag';

/** 各模式对应的 system 名（写入 summary / result.json 的溯源信息）。 */
export const EXPERIMENT_SYSTEM: Record<ExperimentMode, string> = {
  baseline: 'baseline-pi',
  dag: 'dag-prototype',
};

/** experiment_id 字符集（CONTRIBUTING：字母、数字、`.`、`_`、`-`，首字符须为字母数字）。 */
const EXPERIMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 默认 run 级 token 预算（设计文档 §3.3 护栏）。 */
export const DEFAULT_TOKEN_BUDGET = 2_000_000;
/** 默认单节点 / 单次 ReAct 步数上限。 */
export const DEFAULT_MAX_STEPS = 40;

/** 解析后的 CLI 运行参数。 */
export interface ParsedExperimentArgs {
  experimentId: string;
  /** --tasks 指定的任务 ID 列表（空列表 = 不筛选）。 */
  taskIds: string[];
  /** --all：跑冻结子集全部任务。 */
  all: boolean;
  limit?: number;
  mock: boolean;
  tokenBudget: number;
  maxSteps: number;
  overwriting: boolean;
  /** 任务级并发数（任务相互独立、工作区隔离；1 = 串行）。 */
  concurrency: number;
}

/** runExperiment 的完整配置（CLI 参数 + 路径解析结果）。 */
export interface ExperimentRunConfig extends ParsedExperimentArgs {
  mode: ExperimentMode;
  /** AgenticDataBench testbed 目录（$AGENTIC_DATA_BENCH_DATA_DIR）。 */
  dataDir: string;
  /** configs/benchmark.json 绝对路径。 */
  configPath: string;
  /** runs 根目录（`<projectRoot>/runs`）。 */
  runRoot: string;
  /** 项目根目录（.env 所在处）。 */
  projectRoot: string;
}

/** 单个任务的运行结果记录（写入 run-summary.json 的 tasks 列表）。 */
export interface TaskRunRecord {
  taskId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  tokenUsage: TokenUsage;
  /** 收集到 output-da-agent/<task_id>/ 的产出文件名。 */
  outputs: string[];
  error?: string;
}

/** 一次实验运行的汇总。 */
export interface ExperimentRunResult {
  runDir: string;
  startedAt: string;
  finishedAt: string;
  records: TaskRunRecord[];
  totals: {
    tasks: number;
    succeeded: number;
    failed: number;
    skipped: number;
    tokenUsage: TokenUsage;
  };
}

/** CLI 用法说明（baseline / dag 入口共用）。 */
export function usageText(): string {
  return [
    '用法:',
    '  node dist/experiments/baseline-pi.js --experiment-id <id> [选项]',
    '  node dist/experiments/dag-prototype.js --experiment-id <id> [选项]',
    '  node dist/src/main.js baseline|dag --experiment-id <id> [选项]',
    '  （npm 亦可：npm run run:baseline -- [选项] / npm run run:dag -- [选项]）',
    '',
    '必填:',
    '  --experiment-id <id>   实验目录名（runs/<id>/），只能包含字母、数字、.、_、-',
    '任务选择（二选一）:',
    '  --tasks <id1,id2,...>  冻结子集（configs/benchmark.json）内的任务 ID，逗号分隔',
    '  --all                  跑 configs/benchmark.json 全部 30 个任务',
    '选项:',
    '  --limit <n>            只跑选出的前 n 个任务',
    '  --mock                 使用 MockAgentRunner（0 token 管线联调，不调用 LLM）',
    '  --token-budget <n>     run 级 token 预算（默认 2000000，超限中止并标记 failed）',
    '  --max-steps <n>        单节点 / 单次 ReAct 步数上限（默认 40）',
    '  --overwriting          忽略断点续跑记录，强制重跑已完成任务',
    '  --concurrency <n>      任务级并发数（默认 1 = 串行；任务相互独立，可安全并行）',
    '  -h, --help             打印本帮助',
  ].join('\n');
}

/**
 * 解析 CLI 参数；非法时抛出 Error（消息面向用户）。
 * argv 不含程序名与入口命令（调用方已切片）。
 */
export function parseExperimentArgs(args: readonly string[]): ParsedExperimentArgs {
  let experimentId: string | undefined;
  let taskIds: string[] = [];
  let all = false;
  let limit: number | undefined;
  let mock = false;
  let tokenBudget = DEFAULT_TOKEN_BUDGET;
  let maxSteps = DEFAULT_MAX_STEPS;
  let overwriting = false;
  let concurrency = 1;

  const readValue = (flag: string, rest: readonly string[]): string => {
    if (rest.length === 0) {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    return rest[0] as string;
  };
  const readInt = (flag: string, rest: readonly string[]): number => {
    const raw = readValue(flag, rest);
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`参数 ${flag} 需要正整数，实际为 ${JSON.stringify(raw)}`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] as string;
    const rest = args.slice(i + 1);
    switch (flag) {
      case '--experiment-id':
        experimentId = readValue(flag, rest);
        i += 1;
        break;
      case '--tasks':
        for (const id of readValue(flag, rest).split(',')) {
          const trimmed = id.trim();
          if (trimmed.length > 0) {
            taskIds.push(trimmed);
          }
        }
        if (taskIds.length === 0) {
          throw new Error('参数 --tasks 需要至少一个任务 ID（逗号分隔）');
        }
        i += 1;
        break;
      case '--all':
        all = true;
        break;
      case '--limit':
        limit = readInt(flag, rest);
        i += 1;
        break;
      case '--mock':
        mock = true;
        break;
      case '--token-budget':
        tokenBudget = readInt(flag, rest);
        i += 1;
        break;
      case '--max-steps':
        maxSteps = readInt(flag, rest);
        i += 1;
        break;
      case '--overwriting':
        overwriting = true;
        break;
      case '--concurrency':
        concurrency = readInt(flag, rest);
        i += 1;
        break;
      default:
        throw new Error(`未知参数: ${flag}`);
    }
  }

  if (experimentId === undefined) {
    throw new Error('缺少必填参数 --experiment-id');
  }
  if (!EXPERIMENT_ID_RE.test(experimentId)) {
    throw new Error(
      `--experiment-id 只能包含字母、数字、.、_、-（且以字母或数字开头）: ${JSON.stringify(experimentId)}`,
    );
  }
  if (all && taskIds.length > 0) {
    throw new Error('参数 --tasks 与 --all 互斥，只能二选一');
  }
  if (!all && taskIds.length === 0) {
    throw new Error('缺少任务选择参数：--tasks <id1,id2,...> 或 --all（二选一）');
  }

  return { experimentId, taskIds, all, ...(limit !== undefined ? { limit } : {}), mock, tokenBudget, maxSteps, overwriting, concurrency };
}

/**
 * 从 startDir 向上查找包含 package.json 的目录作为项目根目录
 * （源码 experiments/*.ts 与构建产物 dist/experiments/*.js 深度不同，固定层级不可靠）。
 */
export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`无法定位项目根目录（向上 10 层未找到 package.json）: ${path.resolve(startDir)}`);
}

/** 从入口文件的 import.meta.url 解析项目根目录（入口所在目录向上查找 package.json）。 */
export function resolveProjectRootFromEntry(entryUrl: string): string {
  return findProjectRoot(path.dirname(fileURLToPath(entryUrl)));
}

/** 加载项目 .env 并返回数据目录（$AGENTIC_DATA_BENCH_DATA_DIR，缺失时抛错）。 */
export function resolveDataDir(projectRoot: string): string {
  loadEnvFile(path.join(projectRoot, '.env'));
  const dataDir = process.env['AGENTIC_DATA_BENCH_DATA_DIR']?.trim();
  if (!dataDir) {
    throw new Error(
      '未设置 AGENTIC_DATA_BENCH_DATA_DIR：请在项目根目录 .env 或环境中指定 AgenticDataBench testbed 目录',
    );
  }
  return dataDir;
}

/** CLI 入口：解析参数 → 运行实验；参数错误打印用法（exitCode=1）。 */
export async function runExperimentFromCli(
  mode: ExperimentMode,
  args: readonly string[],
  projectRoot?: string,
): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(usageText());
    return;
  }
  const root = projectRoot ?? findProjectRoot(process.cwd());
  let parsed: ParsedExperimentArgs;
  try {
    parsed = parseExperimentArgs(args);
  } catch (err) {
    console.error(`参数错误: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\n${usageText()}`);
    process.exitCode = 1;
    return;
  }
  try {
    const dataDir = resolveDataDir(root);
    await runExperiment({
      ...parsed,
      mode,
      dataDir,
      configPath: path.join(root, 'configs', 'benchmark.json'),
      runRoot: path.join(root, 'runs'),
      projectRoot: root,
    });
  } catch (err) {
    console.error(`实验运行失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

/**
 * 官方 dev.jsonl 的 data_sources 相对 `datasets/<domain>/` 而非 `datasets/`
 * （官方 runtime 直接把整个 domain 目录拷进任务工作区）。这里在实验层把每条
 * data_sources 归位到实际文件，查找顺序：
 *  1. `<datasets>/<rel>`（个别任务自带域名前缀）；
 *  2. `<datasets>/<domain>/<rel>`；
 *  3. `<datasets>/<domain>/` 下按 basename 递归查找（文件在 domain 子目录中，如
 *     agriculture_30 的 Crop Yield Prediction Dataset/、ecommerce 的 Brazilian E-Commerce/）。
 * 返回调整后的任务对象（dataSources 指向 datasets/ 下真实存在的路径，保持原 rel 的
 * 顺序；无法定位的条目保持原样，由调用方给出缺失清单）。
 */
async function resolveTaskDataSources(task: BenchmarkTask, dataDir: string): Promise<BenchmarkTask> {
  const datasetsRoot = path.join(dataDir, 'datasets');
  const domain = task.domain.split('/')[0] ?? '';
  const domainRoot = domain.length > 0 ? path.join(datasetsRoot, domain) : '';
  const resolved: string[] = [];
  for (const rel of task.dataSources) {
    const trimmed = rel.trim();
    if (trimmed.length === 0 || existsSync(path.join(datasetsRoot, trimmed))) {
      resolved.push(trimmed);
      continue;
    }
    if (domainRoot.length > 0 && existsSync(path.join(datasetsRoot, domain, trimmed))) {
      resolved.push(path.join(domain, trimmed));
      continue;
    }
    const base = path.basename(trimmed);
    const found = domainRoot.length > 0 ? await findFileByBasename(domainRoot, base) : null;
    resolved.push(found !== null ? path.relative(datasetsRoot, found) : trimmed);
  }
  return { ...task, dataSources: resolved };
}

/** 在目录树中按文件名查找第一个常规文件（深度优先，路径排序保证确定性）。 */
async function findFileByBasename(root: string, base: string): Promise<string | null> {
  let entries;
  try {
    entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === base) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const hit = await findFileByBasename(fullPath, base);
      if (hit !== null) {
        return hit;
      }
    }
  }
  return null;
}

/**
 * 把归位后的数据源文件按任务原始 data_sources 布局复制到临时 staging 目录
 * `<runDir>/staging/<task_id>/datasets/`，返回该 staging 数据目录。
 * prepareWorkspace 契约要求 data_sources 相对 `<dataDir>/datasets/`，staging 使
 * 工作区布局与任务描述一致（文件位于工作区根，与官方 runtime 行为相同），
 * 同时不改动 src/benchmark 的既有逻辑。
 */
async function stageTaskDataSources(
  runDir: string,
  task: BenchmarkTask,
  resolved: BenchmarkTask,
  dataDir: string,
): Promise<string> {
  const stagingDataDir = path.join(runDir, 'staging', task.id);
  const stagingDatasets = path.join(stagingDataDir, 'datasets');
  await mkdir(stagingDatasets, { recursive: true });
  const missing: string[] = [];
  for (const [index, originalRel] of task.dataSources.entries()) {
    const trimmed = originalRel.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const resolvedRel = resolved.dataSources[index];
    const sourcePath = path.join(dataDir, 'datasets', resolvedRel ?? trimmed);
    if (!existsSync(sourcePath)) {
      missing.push(trimmed);
      continue;
    }
    const destPath = path.join(stagingDatasets, trimmed);
    if (!destPath.startsWith(stagingDatasets + path.sep)) {
      throw new Error(`任务 ${task.id} 的 data_sources 相对路径非法（越出 staging 目录）: ${trimmed}`);
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
  }
  if (missing.length > 0) {
    throw new Error(
      `任务 ${task.id} 的数据源文件在 datasets 目录中无法定位（datasets: ${path.join(dataDir, 'datasets')}），` +
        `缺失清单:\n${missing.map((rel) => `  - ${rel}`).join('\n')}`,
    );
  }
  return stagingDataDir;
}

/** 判断任务是否已完成（断点续跑跳过条件）：输出目录存在且 summary 状态为 succeeded。 */
async function isTaskCompleted(runDir: string, taskId: string): Promise<boolean> {
  const outputDir = path.join(runDir, 'output-da-agent', taskId);
  try {
    const outputStat = await stat(outputDir);
    if (!outputStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const raw = await readFile(path.join(runDir, 'summary', `${taskId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as { status?: unknown };
    return parsed.status === 'succeeded';
  } catch {
    return false;
  }
}

/** 读取冻结子集配置的 version 字段（仅用于 run-summary 溯源，缺失时为 null）。 */
async function readConfigVersion(configPath: string): Promise<string | null> {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 汇总一批任务记录的 token 用量。 */
function sumUsage(records: readonly TaskRunRecord[]): TokenUsage {
  let usage = emptyTokenUsage();
  for (const record of records) {
    usage = addTokenUsage(usage, record.tokenUsage);
  }
  return usage;
}

/**
 * 运行一次实验（共享运行循环）。
 * 真实 LLM 运行不在此处做任何 API mock：--mock 时全部使用 MockAgentRunner（0 token）。
 */
export async function runExperiment(config: ExperimentRunConfig): Promise<ExperimentRunResult> {
  const startedAt = new Date().toISOString();
  const runDir = path.join(config.runRoot, config.experimentId);
  const outputRoot = path.join(runDir, 'output-da-agent');
  const summaryDir = path.join(runDir, 'summary');

  // 1. 任务选择：冻结子集（configs/benchmark.json）内 --tasks 筛选或 --all 全跑
  const subset = await subsetFromConfig(config.dataDir, config.configPath);
  let tasks: BenchmarkTask[] = subset;
  if (config.taskIds.length > 0) {
    const wanted = new Set(config.taskIds);
    const missing = config.taskIds.filter((id) => !subset.some((task) => task.id === id));
    if (missing.length > 0) {
      throw new Error(
        `以下任务 ID 不在冻结子集 ${config.configPath} 中: ${missing.join(', ')}；` +
          `--tasks 只能选择子集内的任务（子集共 ${subset.length} 个）`,
      );
    }
    tasks = subset.filter((task) => wanted.has(task.id));
  }
  if (config.limit !== undefined && config.limit < tasks.length) {
    tasks = tasks.slice(0, config.limit);
  }

  await mkdir(outputRoot, { recursive: true });
  await mkdir(summaryDir, { recursive: true });

  console.log(
    `[experiment] ${config.experimentId} mode=${EXPERIMENT_SYSTEM[config.mode]} mock=${config.mock} ` +
      `tasks=${tasks.length}/${subset.length} maxSteps=${config.maxSteps} tokenBudget=${config.tokenBudget}`,
  );
  console.log(`[experiment] runDir=${runDir}`);

  // 2. 任务执行（断点续跑：已完成任务跳过；--overwriting 强制重跑并清理现场）。
  //    任务相互独立且目录按 task.id 隔离，--concurrency N 时用 worker pool 并行（1 = 串行）。
  const records: TaskRunRecord[] = [];
  const total = tasks.length;
  let done = 0;
  const runOne = async (task: BenchmarkTask): Promise<TaskRunRecord> => {
    if (!config.overwriting && (await isTaskCompleted(runDir, task.id))) {
      done += 1;
      console.log(`[${done}/${total}] ${task.id}: skipped（已完成，--overwriting 可强制重跑）`);
      return { taskId: task.id, status: 'skipped', tokenUsage: emptyTokenUsage(), outputs: [] };
    }
    if (config.overwriting) {
      await resetTaskArtifacts(runDir, task.id);
    }
    const record = await runSingleTask(config, runDir, task);
    done += 1;
    const suffix = record.error !== undefined ? ` error=${record.error}` : '';
    console.log(
      `[${done}/${total}] ${task.id}: ${record.status} tokens=${record.tokenUsage.totalTokens}` +
        ` outputs=[${record.outputs.join(', ')}]${suffix}`,
    );
    return record;
  };
  const queue = [...tasks];
  const workerCount = Math.min(Math.max(config.concurrency, 1), tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const task = queue.shift();
      if (task === undefined) {
        return;
      }
      records.push(await runOne(task));
    }
  });
  await Promise.all(workers);

  // 3. run-summary.json
  const finishedAt = new Date().toISOString();
  const result: ExperimentRunResult = {
    runDir,
    startedAt,
    finishedAt,
    records,
    totals: {
      tasks: records.length,
      succeeded: records.filter((record) => record.status === 'succeeded').length,
      failed: records.filter((record) => record.status === 'failed').length,
      skipped: records.filter((record) => record.status === 'skipped').length,
      tokenUsage: sumUsage(records),
    },
  };
  const modelConfig = {
    mock: config.mock,
    ...(config.mock
      ? {}
      : {
          model: process.env['MODEL_ID'] ?? null,
          baseUrl: process.env['PI_BASE_URL'] ?? null,
        }),
  };
  const runSummary = {
    experimentId: config.experimentId,
    system: EXPERIMENT_SYSTEM[config.mode],
    startedAt,
    finishedAt,
    subset: {
      configPath: config.configPath,
      version: await readConfigVersion(config.configPath),
      dataDir: config.dataDir,
    },
    config: {
      ...modelConfig,
      maxSteps: config.maxSteps,
      tokenBudget: config.tokenBudget,
      overwriting: config.overwriting,
      concurrency: config.concurrency,
    },
    totals: result.totals,
    tasks: result.records,
  };
  await writeFile(path.join(runDir, 'run-summary.json'), JSON.stringify(runSummary, null, 2), 'utf8');
  console.log(
    `[experiment] 完成: succeeded=${result.totals.succeeded} failed=${result.totals.failed} ` +
      `skipped=${result.totals.skipped} tokens=${result.totals.tokenUsage.totalTokens}`,
  );
  return result;
}

/** 执行单个任务：准备工作区 → baseline / DAG → 收集产出 → 写 result.json 与 summary。 */
async function runSingleTask(
  config: ExperimentRunConfig,
  runDir: string,
  task: BenchmarkTask,
): Promise<TaskRunRecord> {
  const taskOutputDir = path.join(runDir, 'output-da-agent', task.id);
  const taskRunDir = path.join(runDir, 'tasks', task.id);
  const summaryPath = path.join(runDir, 'summary', `${task.id}.json`);
  const recorder = new RunRecorder();
  recorder.startRun(config.experimentId, EXPERIMENT_SYSTEM[config.mode], task.id);

  let status: 'succeeded' | 'failed' = 'failed';
  let error: string | undefined;
  let outputs: string[] = [];
  let resultText: string;
  let workspacePath = '';

  try {
    // 1. 任务隔离工作区：先归位 data_sources（官方 dev.jsonl 相对 datasets/<domain>/），
    //    staging 后交给 prepareWorkspace（数据源缺失时抛错，不产生半成品工作区）
    const resolvedTask = await resolveTaskDataSources(task, config.dataDir);
    const stagingDataDir = await stageTaskDataSources(runDir, task, resolvedTask, config.dataDir);
    const workspace = await prepareWorkspace(runDir, task, stagingDataDir);
    workspacePath = workspace.workspacePath;
    await rm(path.join(runDir, 'staging', task.id), { recursive: true, force: true });

    // 2. baseline：单次 ReAct 直做；DAG：DagExecutor + 按任务构建的四节点工作流
    if (config.mode === 'baseline') {
      recorder.startNode('baseline');
      const runner: AgentRunner = config.mock
        ? new MockAgentRunner(baselineMockScript(task))
        : new PiAgentRunner({
            mode: 'baseline',
            outputFileName: task.outputFileName.join(', '),
          });
      let result: NodeRunResult;
      try {
        result = await runner.run({
          taskId: task.id,
          nodeId: 'baseline',
          question: task.question,
          workspacePath,
          nodeTask: task.question,
          upstreamArtifacts: [],
          maxSteps: config.maxSteps,
          runDir: taskRunDir,
          recorder,
        });
      } catch (err) {
        result = {
          status: 'failed',
          artifacts: [],
          tokenUsage: emptyTokenUsage(),
          steps: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      recorder.endNode(result.status, result.error);
      status = result.status;
      error = result.error;
      // baseline 无中途预算拦截（PiAgentRunner 无预算钩子），run 后核对 run 级预算
      if (result.tokenUsage.totalTokens > config.tokenBudget) {
        status = 'failed';
        error =
          `Run 级 token 预算超限: 已使用 ${result.tokenUsage.totalTokens} tokens` +
          `（预算 ${config.tokenBudget} tokens）`;
      }
    } else {
      const runner: AgentRunner = config.mock
        ? new NodeScriptedMockRunner(dagMockScripts(task))
        : new PiAgentRunner({ mode: 'node' });
      const executor = new DagExecutor(taskWorkflow(task), runner, {
        maxStepsPerNode: config.maxSteps,
        tokenBudgetPerRun: config.tokenBudget,
        // #2 Phase A：单节点失败重试 / 步数耗尽续跑（默认 2 次尝试）+
        // execute 节点成功后的程序化验证门（任务输出文件存在性 / 非空 / 格式）
        outputGate: createTaskOutputGate(task),
      });
      const outcome = await executor.runTask({
        taskId: task.id,
        question: task.question,
        workspacePath,
        runDir: taskRunDir,
        recorder,
      });
      status = outcome.status;
      error = outcome.error;
    }

    // 3. 产物收集：工作区内按 outputFileName 递归匹配，复制到官方评测目录（扁平）
    const collected = await collectTaskOutputs(workspacePath, task);
    await mkdir(taskOutputDir, { recursive: true });
    for (const filePath of collected) {
      await copyFile(filePath, path.join(taskOutputDir, path.basename(filePath)));
    }
    outputs = collected.map((filePath) => path.basename(filePath));
    if (collected.length === 0 && status === 'succeeded') {
      status = 'failed';
      error =
        `工作区中没有找到 output_file_name 匹配的产出文件` +
        `（期望: ${task.outputFileName.join(', ') || '无'}）`;
    }
    resultText =
      status === 'succeeded'
        ? `任务完成，产出 ${outputs.length} 个文件: ${outputs.join(', ')}`
        : (error ?? '任务失败');
  } catch (err) {
    // recorder 节点由本函数负责开关（DAG 模式的节点开关由 executor 负责，已闭环）
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
    resultText = `任务异常失败: ${error}`;
  }

  // 4. 官方评测产物 + run 级汇总
  recorder.endRun({
    status,
    ...(error !== undefined ? { error } : {}),
    result: resultText,
    resultFiles: { added_files: outputs, changed_files: [] },
  });
  await recorder.writeResultJson(taskOutputDir);
  await recorder.writeSummary(summaryPath);

  const record: TaskRunRecord = {
    taskId: task.id,
    status,
    tokenUsage: recorder.getTotalTokenUsage(),
    outputs,
    ...(error !== undefined ? { error } : {}),
  };
  return record;
}

/** --overwriting 重跑前清理任务现场：官方评测目录、执行现场、工作区与 staging。 */
export async function resetTaskArtifacts(runDir: string, taskId: string): Promise<void> {
  await rm(path.join(runDir, 'output-da-agent', taskId), { recursive: true, force: true });
  await rm(path.join(runDir, 'tasks', taskId), { recursive: true, force: true });
  await rm(path.join(runDir, 'workspaces', taskId), { recursive: true, force: true });
  await rm(path.join(runDir, 'staging', taskId), { recursive: true, force: true });
}
