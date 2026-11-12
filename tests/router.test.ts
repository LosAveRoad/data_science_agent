import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DagExecutor, ExecutorError } from '../src/dag/executor.js';
import type { AgentRunner, AgentRunnerInput, NodeRunResult } from '../src/dag/executor.js';
import { ROUTE_BUDGET_FACTOR, routeBudget, routeFeatures, routeTask } from '../src/dag/router.js';
import { taskMinimalWorkflow, taskRepairWorkflow } from '../src/dag/workflow.js';
import { runExperiment } from '../src/experiments/runner.js';
import type { TokenUsage } from '../src/tracing/recorder.js';
import { RunRecorder } from '../src/tracing/recorder.js';

// —— 路由规则（#4 Phase C：规则分档，零 LLM 成本） ——

describe('routeTask / 规则路由', () => {
  it('单输出、少量数据源、短问题 → minimal', () => {
    const decision = routeTask({
      outputFileName: ['out.csv'],
      dataSources: ['a.csv', 'b.csv'],
      question: '统计各分组均值并输出', // 10 字符
    });
    expect(decision.route).toBe('minimal');
    expect(decision.features).toEqual({ outputFiles: 1, dataFiles: 2, questionChars: 10 });
    expect(decision.reason).toContain('→ minimal');
    expect(decision.reason).toContain('outputFiles=1<=1');
  });

  it('问题较长但其余特征简单 → simple', () => {
    const question = '统计各分组均值并输出。'.repeat(60); // 660 字符：超过 minimal(500)、低于 simple(1200)
    const decision = routeTask({ outputFileName: ['out.csv'], dataSources: ['a.csv'], question });
    expect(decision.route).toBe('simple');
    expect(decision.reason).toContain('→ simple');
  });

  it('多输出文件 → full', () => {
    const decision = routeTask({
      outputFileName: ['out.csv', 'chart.png'],
      dataSources: ['a.csv'],
      question: '统计并画图',
    });
    expect(decision.route).toBe('full');
    expect(decision.reason).toContain('→ full');
  });

  it('数据源过多或问题超长 → full', () => {
    expect(
      routeTask({ outputFileName: ['out.csv'], dataSources: ['a', 'b', 'c', 'd'], question: 'q' }).route,
    ).toBe('full');
    expect(
      routeTask({ outputFileName: ['out.csv'], dataSources: ['a.csv'], question: 'x'.repeat(1300) }).route,
    ).toBe('full');
  });

  it('routeFeatures 忽略空白 data_sources 条目', () => {
    expect(
      routeFeatures({ outputFileName: ['o.json'], dataSources: ['a.csv', '  '], question: 'q' }),
    ).toEqual({ outputFiles: 1, dataFiles: 1, questionChars: 1 });
  });
});

describe('routeBudget / 分档预算', () => {
  it('三档系数：full 1×、simple 0.6×、minimal 0.25×', () => {
    expect(ROUTE_BUDGET_FACTOR).toEqual({ full: 1, simple: 0.6, minimal: 0.25 });
    expect(routeBudget(2_000_000, 'full')).toBe(2_000_000);
    expect(routeBudget(2_000_000, 'simple')).toBe(1_200_000);
    expect(routeBudget(2_000_000, 'minimal')).toBe(500_000);
  });

  it('小预算四舍五入且保底 1', () => {
    expect(routeBudget(7, 'simple')).toBe(4); // 7 * 0.6 = 4.2 → 4
    expect(routeBudget(1, 'minimal')).toBe(1); // 0.25 → 0 → 保底 1
  });
});

// —— executor 跳过子图（#4 Phase C：依赖透明传递） ——

const USAGE: TokenUsage = { inputTokens: 10, outputTokens: 10, totalTokens: 20 };

/** 结构化产物内容（对齐 schema 校验）。 */
function artifactContent(name: string): unknown {
  if (name === 'data_profile.json') {
    return { files: [{ name: 'data.csv', rows: 3, columns: [{ name: 'a', dtype: 'int' }] }] };
  }
  if (name === 'analysis_plan.json') {
    return { steps: [{ description: '步骤' }] };
  }
  if (name === 'challenge_list.json') {
    return { challenges: [] };
  }
  if (name === 'verdict.json') {
    return { decision: 'pass', reasons: [] };
  }
  return { name };
}

class RecordingRunner implements AgentRunner {
  readonly calls: AgentRunnerInput[] = [];
  constructor(private readonly failNodes: ReadonlySet<string> = new Set()) {}

  async run(input: AgentRunnerInput): Promise<NodeRunResult> {
    this.calls.push(input);
    if (this.failNodes.has(input.nodeId)) {
      return { status: 'failed', artifacts: [], tokenUsage: USAGE, steps: 1, error: '注入失败' };
    }
    const declared = DECLARED[input.nodeId] ?? [];
    const artifacts: { name: string; path: string }[] = [];
    for (const name of declared) {
      const filePath = path.join(input.workspacePath, name);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(artifactContent(name)), 'utf8');
      artifacts.push({ name, path: filePath });
    }
    return { status: 'succeeded', artifacts, tokenUsage: USAGE, steps: 2 };
  }

  callsOf(nodeId: string): AgentRunnerInput[] {
    return this.calls.filter((call) => call.nodeId === nodeId);
  }
}

const DECLARED: Record<string, string[]> = {
  inspect: ['data_profile.json'],
  plan: ['analysis_plan.json'],
  execute: ['result.json', 'execute_summary.json'],
  verify: ['challenge_list.json'],
  adjudicate: ['verdict.json'],
};

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsa-router-test-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  const ws = await mkdtemp(path.join(tmpRoot, 'ws-'));
  await mkdir(ws, { recursive: true });
  return ws;
}

function makeTask() {
  return { outputFileName: ['result.json'], question: '测试问题' };
}

async function runDag(
  workspacePath: string,
  runner: AgentRunner,
  opts: { skipNodes?: string[]; workflow?: 'repair' | 'minimal' } = {},
) {
  const taskId = 'route_task';
  const runDir = path.join(tmpRoot, `run-${Math.random().toString(36).slice(2, 8)}`);
  const recorder = new RunRecorder();
  recorder.startRun('router-test', 'dag-prototype', taskId);
  const workflow = opts.workflow === 'minimal' ? taskMinimalWorkflow(makeTask()) : taskRepairWorkflow(makeTask());
  const executor = new DagExecutor(workflow, runner, {
    ...(opts.skipNodes !== undefined ? { skipNodes: opts.skipNodes } : {}),
  });
  const outcome = await executor.runTask({
    taskId,
    question: '测试问题',
    workspacePath,
    runDir,
    recorder,
  });
  return outcome;
}

describe('executor / skipNodes 按路由跳过子图', () => {
  it('simple 路由跳过 plan：plan 记 skipped，execute 直接读 inspect 的 data_profile', async () => {
    const workspacePath = await makeWorkspace();
    const runner = new RecordingRunner();
    const outcome = await runDag(workspacePath, runner, { skipNodes: ['plan'] });

    expect(outcome.status).toBe('succeeded');
    const byNode = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));
    expect(byNode.get('plan')).toMatchObject({ status: 'skipped' });
    expect(byNode.get('inspect')).toMatchObject({ status: 'succeeded' });
    expect(byNode.get('execute')).toMatchObject({ status: 'succeeded' });
    expect(byNode.get('verify')).toMatchObject({ status: 'succeeded' });
    expect(byNode.get('adjudicate')).toMatchObject({ status: 'succeeded' });
    expect(runner.callsOf('plan')).toHaveLength(0);
    // 依赖透明传递：execute 的上游产物包含 inspect 的 data_profile.json（plan 被替换）
    const executeInput = runner.callsOf('execute')[0];
    expect(executeInput?.upstreamArtifacts.map((ref) => ref.name)).toContain('data_profile.json');
    expect(executeInput?.upstreamArtifacts.map((ref) => ref.name)).not.toContain('analysis_plan.json');
  });

  it('传递跳过（inspect + plan 都跳过）：execute 无上游依赖也能执行', async () => {
    const workspacePath = await makeWorkspace();
    const runner = new RecordingRunner();
    const outcome = await runDag(workspacePath, runner, { skipNodes: ['inspect', 'plan'] });

    expect(outcome.status).toBe('succeeded');
    expect(runner.callsOf('inspect')).toHaveLength(0);
    expect(runner.callsOf('plan')).toHaveLength(0);
    const executeInput = runner.callsOf('execute')[0];
    expect(executeInput?.upstreamArtifacts).toHaveLength(0);
    const byNode = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));
    expect(byNode.get('inspect')).toMatchObject({ status: 'skipped' });
    expect(byNode.get('plan')).toMatchObject({ status: 'skipped' });
  });

  it('跳过节点不阻断修复回路：fix 后 execute 重跑仍能拿到挑战清单', async () => {
    const workspacePath = await makeWorkspace();
    // 复用 loop.test 的思路：verify r1 输出带挑战的清单，adjudicate r1 裁 fix，r2 裁 pass
    class FixOnceRunner extends RecordingRunner {
      async run(input: AgentRunnerInput): Promise<NodeRunResult> {
        this.calls.push(input);
        const declared = DECLARED[input.nodeId] ?? [];
        const artifacts: { name: string; path: string }[] = [];
        for (const name of declared) {
          const filePath = path.join(input.workspacePath, name);
          await mkdir(path.dirname(filePath), { recursive: true });
          let content: unknown = artifactContent(name);
          if (name === 'challenge_list.json' && (input.executionRound ?? 1) === 1) {
            content = {
              challenges: [{ category: 'unit_conversion', description: '量级存疑', severity: 'critical' }],
            };
          }
          if (name === 'verdict.json') {
            content =
              (input.executionRound ?? 1) === 1
                ? { decision: 'fix', reasons: ['有 critical 挑战'] }
                : { decision: 'pass', reasons: ['已应答'] };
          }
          await writeFile(filePath, JSON.stringify(content), 'utf8');
          artifacts.push({ name, path: filePath });
        }
        return { status: 'succeeded', artifacts, tokenUsage: USAGE, steps: 2 };
      }
    }
    const runner = new FixOnceRunner();
    const outcome = await runDag(workspacePath, runner, { skipNodes: ['plan'] });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 1, lastDecision: 'pass' });
    expect(runner.callsOf('plan')).toHaveLength(0);
    expect(runner.callsOf('execute')).toHaveLength(2);
    const executeR2 = runner.callsOf('execute')[1];
    expect(executeR2?.upstreamArtifacts.some((ref) => ref.name === 'challenge_list.json')).toBe(true);
  });

  it('skipNodes 引用不存在的节点时构造期抛错', () => {
    expect(() => new DagExecutor(taskRepairWorkflow(makeTask()), new RecordingRunner(), {
      skipNodes: ['nonexistent'],
    })).toThrow(ExecutorError);
  });

  it('minimal 工作流：单节点 baseline 式直做，不产出流水线中间产物', async () => {
    const workspacePath = await makeWorkspace();
    const runner = new RecordingRunner();
    const outcome = await runDag(workspacePath, runner, { workflow: 'minimal' });

    expect(outcome.status).toBe('succeeded');
    expect(outcome.nodeRuns).toHaveLength(1);
    expect(outcome.nodeRuns[0]).toMatchObject({ nodeId: 'execute', status: 'succeeded' });
    // 声明产物 = 任务输出（result.json）；无挑战清单 / 裁决 / 数据简报等流水线产物
    const names = outcome.artifacts.map((ref) => ref.name);
    expect(names).toContain('result.json');
    expect(names).not.toContain('challenge_list.json');
    expect(names).not.toContain('verdict.json');
    expect(names).not.toContain('data_profile.json');
  });
});

// —— runner 接线：路由决策写入 summary / run-summary（#4 Phase C 可归因） ——

/** mini testbed（与 benchmark.test.ts 同构）：1 个简单任务 + 1 个复杂任务。 */
function buildMiniDataDir(root: string): void {
  mkdirSync(path.join(root, 'tasks'), { recursive: true });
  writeFileSync(
    path.join(root, 'tasks', 'dev.jsonl'),
    [
      JSON.stringify({
        id: 'task_simple',
        question: '统计各分组均值并输出',
        data_sources: ['data_a.csv'],
        skills: ['eda'],
        domain: 'demo',
        output_file_name: ['output.csv'],
        gold_file_name: ['gold.csv'],
        eval_func: ['compare_csv()'],
      }),
      JSON.stringify({
        id: 'task_complex',
        question: '对比两组数据的多维度差异并建模预测。'.repeat(100),
        data_sources: ['data_a.csv'],
        skills: ['statistics'],
        domain: 'demo',
        output_file_name: ['report.csv', 'chart.png'],
        gold_file_name: ['gold.csv'],
        eval_func: ['compare_csv()'],
      }),
    ].join('\n'),
    'utf8',
  );
  mkdirSync(path.join(root, 'datasets'), { recursive: true });
  writeFileSync(path.join(root, 'datasets', 'data_a.csv'), 'a,b\n1,2\n', 'utf8');
  mkdirSync(path.join(root, 'configs'), { recursive: true });
  writeFileSync(path.join(root, 'configs', 'benchmark.json'), JSON.stringify({ version: 'router-e2e', task_ids: ['task_simple', 'task_complex'] }), 'utf8');
}

describe('runner / 难度路由接线', () => {
  it('auto 路由：简单任务走 minimal、复杂任务走 full，决策写入 summary 与 run-summary', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'router-data-'));
    buildMiniDataDir(dataDir);
    try {
      const result = await runExperiment({
        experimentId: 'router-auto',
        taskIds: [],
        all: true,
        mock: true,
        tokenBudget: 1_000_000,
        maxSteps: 40,
        overwriting: true,
        concurrency: 1,
        routing: 'auto',
        mode: 'dag',
        dataDir,
        configPath: path.join(dataDir, 'configs', 'benchmark.json'),
        runRoot: path.join(dataDir, 'runs'),
        projectRoot: dataDir,
      });
      expect(result.totals.succeeded).toBe(2);

      const runSummary = JSON.parse(
        await readFile(path.join(dataDir, 'runs', 'router-auto', 'run-summary.json'), 'utf8'),
      );
      expect(runSummary.config.routing).toBe('auto');
      // task_simple → minimal；task_complex（双输出 + 长问题）→ full
      expect(runSummary.config.routeCounts).toEqual({ minimal: 1, simple: 0, full: 1 });
      const records = new Map(
        (runSummary.tasks as Array<{ taskId: string; route?: { route: string; reason: string } }>).map((t) => [t.taskId, t]),
      );
      expect(records.get('task_simple')?.route?.route).toBe('minimal');
      expect(records.get('task_complex')?.route?.route).toBe('full');

      // 任务 summary：路由决策（extras.routing）+ minimal 路径只有单节点
      const simpleSummary = JSON.parse(
        await readFile(path.join(dataDir, 'runs', 'router-auto', 'summary', 'task_simple.json'), 'utf8'),
      );
      expect(simpleSummary.routing.route).toBe('minimal');
      expect(simpleSummary.routing.reason).toContain('minimal');
      expect(simpleSummary.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual(['execute']);

      const complexSummary = JSON.parse(
        await readFile(path.join(dataDir, 'runs', 'router-auto', 'summary', 'task_complex.json'), 'utf8'),
      );
      expect(complexSummary.routing.route).toBe('full');
      expect(complexSummary.nodes.map((n: { nodeId: string }) => n.nodeId)).toEqual([
        'inspect',
        'plan',
        'execute',
        'verify',
        'adjudicate',
      ]);
      // 轨迹首步是路由决策（tracing 可查）
      const resultJson = JSON.parse(
        await readFile(
          path.join(dataDir, 'runs', 'router-auto', 'output-da-agent', 'task_complex', 'dabench', 'result.json'),
          'utf8',
        ),
      );
      expect(JSON.stringify(resultJson.trajectory[0])).toContain('路由决策');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('强制 simple 路由：跳过 plan 子图且预算按档位折算（0.6×）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'router-data-'));
    buildMiniDataDir(dataDir);
    try {
      const result = await runExperiment({
        experimentId: 'router-simple',
        taskIds: [],
        all: true,
        mock: true,
        tokenBudget: 1_000_000,
        maxSteps: 40,
        overwriting: true,
        concurrency: 1,
        routing: 'simple',
        mode: 'dag',
        dataDir,
        configPath: path.join(dataDir, 'configs', 'benchmark.json'),
        runRoot: path.join(dataDir, 'runs'),
        projectRoot: dataDir,
      });
      expect(result.totals.succeeded).toBe(2);

      const simpleSummary = JSON.parse(
        await readFile(path.join(dataDir, 'runs', 'router-simple', 'summary', 'task_simple.json'), 'utf8'),
      );
      expect(simpleSummary.routing.route).toBe('simple');
      // plan 被跳过（不出现在 recorder 节点里），修复回路保留
      const nodeIds = simpleSummary.nodes.map((n: { nodeId: string }) => n.nodeId);
      expect(nodeIds).not.toContain('plan');
      expect(nodeIds).toContain('inspect');
      expect(nodeIds).toContain('verify');
      expect(nodeIds).toContain('adjudicate');

      const runSummary = JSON.parse(
        await readFile(path.join(dataDir, 'runs', 'router-simple', 'run-summary.json'), 'utf8'),
      );
      expect(runSummary.config.routeCounts).toEqual({ minimal: 0, simple: 2, full: 0 });
      expect(runSummary.config.routing).toBe('simple');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('CLI 解析拒绝非法 --routing 值', async () => {
    const { parseExperimentArgs } = await import('../src/experiments/runner.js');
    expect(() =>
      parseExperimentArgs(['--experiment-id', 'x', '--all', '--routing', 'ultra']),
    ).toThrow(/--routing/);
    expect(parseExperimentArgs(['--experiment-id', 'x', '--all', '--routing', 'minimal']).routing).toBe('minimal');
    expect(parseExperimentArgs(['--experiment-id', 'x', '--all']).routing).toBe('auto');
  });
});
