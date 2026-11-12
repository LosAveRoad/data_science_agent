import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DagExecutor } from '../src/dag/executor.js';
import type { AgentRunner, AgentRunnerInput, NodeRunResult } from '../src/dag/executor.js';
import { taskRepairWorkflow } from '../src/dag/workflow.js';
import { RunRecorder } from '../src/tracing/recorder.js';
import type { TokenUsage } from '../src/tracing/recorder.js';

/** mock runner 中每个节点固定上报的 token 用量。 */
const USAGE_PER_NODE: TokenUsage = { inputTokens: 60, outputTokens: 40, totalTokens: 100 };

/** 测试任务的期望输出文件。 */
const TASK_OUTPUT = 'result.json';

/** 结构化产物内容（与 src/artifacts/schemas.ts 的 schema 对齐）。 */
function artifactContent(nodeId: string, name: string, round: number): unknown {
  if (name === 'data_profile.json') {
    return {
      files: [
        {
          name: 'data.csv',
          rows: 10,
          columns: [
            { name: 'a', dtype: 'int' },
            { name: 'b', dtype: 'float' },
          ],
        },
      ],
    };
  }
  if (name === 'analysis_plan.json') {
    return { steps: [{ description: 'mock 分析步骤', tools: ['run_python'] }] };
  }
  if (name === 'challenge_list.json') {
    return { challenges: [] };
  }
  if (name === 'verdict.json') {
    return { decision: 'pass', reasons: [`第 ${round} 轮无挑战`] };
  }
  return { node: nodeId, round };
}

/**
 * 可编排的 mock AgentRunner：按 (nodeId, executionRound) 分发行为脚本。
 * 脚本返回 NodeRunResult 或抛出错误（等价 runner 异常）。
 */
class LoopMockRunner implements AgentRunner {
  readonly calls: AgentRunnerInput[] = [];

  constructor(
    private readonly behaviors: Record<
      string,
      (input: AgentRunnerInput) => Promise<NodeRunResult> | NodeRunResult
    >,
  ) {}

  async run(input: AgentRunnerInput): Promise<NodeRunResult> {
    this.calls.push(input);
    const behavior = this.behaviors[input.nodeId];
    if (!behavior) {
      throw new Error(`测试脚本未定义节点 ${input.nodeId} 的行为`);
    }
    return await behavior(input);
  }

  /** 某节点的执行次数（按 executionRound 去重）。 */
  roundCalls(nodeId: string): number[] {
    return this.calls.filter((call) => call.nodeId === nodeId).map((call) => call.executionRound ?? 1);
  }
}

/** 构造成功写出声明产物的节点行为。 */
function succeedWith(
  extraArtifacts: Record<string, unknown> = {},
): (input: AgentRunnerInput) => Promise<NodeRunResult> {
  return async (input) => {
    input.recorder.recordStep({
      kind: 'thought',
      name: 'think',
      content: `[${input.nodeId}] 第 ${input.executionRound ?? 1} 轮执行`,
      tokenUsage: USAGE_PER_NODE,
    });
    input.recorder.recordStep({ kind: 'observation', content: `[${input.nodeId}] 完成` });
    const declared = declaredArtifacts(input.nodeId);
    const artifacts: { name: string; path: string }[] = [];
    for (const name of declared) {
      const filePath = path.join(input.workspacePath, name);
      await mkdir(path.dirname(filePath), { recursive: true });
      const content = extraArtifacts[name] ?? artifactContent(input.nodeId, name, input.executionRound ?? 1);
      await writeFile(
        filePath,
        typeof content === 'string' ? content : JSON.stringify(content),
        'utf8',
      );
      artifacts.push({ name, path: filePath });
    }
    return { status: 'succeeded', artifacts, tokenUsage: USAGE_PER_NODE, steps: 3 };
  };
}

/** 修复回路工作流各节点的声明产物。 */
function declaredArtifacts(nodeId: string): string[] {
  switch (nodeId) {
    case 'inspect':
      return ['data_profile.json'];
    case 'plan':
      return ['analysis_plan.json'];
    case 'execute':
      return [TASK_OUTPUT, 'execute_summary.json'];
    case 'verify':
      return ['challenge_list.json'];
    case 'adjudicate':
      return ['verdict.json'];
    default:
      return [];
  }
}

/** 全节点成功、裁决 pass 的标准 runner。 */
function allPassRunner(): LoopMockRunner {
  return new LoopMockRunner({
    inspect: succeedWith(),
    plan: succeedWith(),
    execute: succeedWith(),
    verify: succeedWith(),
    adjudicate: succeedWith(),
  });
}

interface RunOptions {
  taskId?: string;
  runner: AgentRunner;
  maxRepairRounds?: number;
  maxAttemptsPerNode?: number;
}

/** 构造并运行一次任务，返回 outcome 与运行目录。 */
async function runOnce(
  workspacePath: string,
  options: RunOptions,
): Promise<{ status: 'succeeded' | 'failed'; outcome: Awaited<ReturnType<DagExecutor['runTask']>>; runDir: string }> {
  const taskId = options.taskId ?? 'loop_task';
  const runDir = path.join(path.dirname(workspacePath), `run-${taskId}-${Math.random().toString(36).slice(2, 8)}`);
  const recorder = new RunRecorder();
  recorder.startRun('loop-test', 'dag-prototype', taskId);
  const executor = new DagExecutor(taskRepairWorkflow({ outputFileName: [TASK_OUTPUT] }, {
    ...(options.maxRepairRounds !== undefined ? { maxRepairRounds: options.maxRepairRounds } : {}),
  }), options.runner, {
    ...(options.maxAttemptsPerNode !== undefined ? { maxAttemptsPerNode: options.maxAttemptsPerNode } : {}),
  });
  const outcome = await executor.runTask({
    taskId,
    question: '测试问题：统计并输出 result.json',
    workspacePath,
    runDir,
    recorder,
  });
  return { status: outcome.status, outcome, runDir };
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsa-loop-test-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let workspacePath: string;

beforeEach(async () => {
  workspacePath = path.join(tmpRoot, `ws-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(workspacePath, { recursive: true });
});

describe('修复回路 / 裁决三分支', () => {
  it('裁决 pass：execute 单轮执行，回路不回炉，repair 记录 pass', async () => {
    const runner = allPassRunner();
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 0, forcedAccept: false, lastDecision: 'pass' });
    expect(runner.roundCalls('execute')).toEqual([1]);
    expect(runner.roundCalls('verify')).toEqual([1]);
    expect(runner.roundCalls('adjudicate')).toEqual([1]);
  });

  it('裁决 accept：保留现状，不回炉 execute', async () => {
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith(),
      adjudicate: succeedWith({ 'verdict.json': { decision: 'accept', reasons: ['仅剩 minor 瑕疵'] } }),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 0, forcedAccept: false, lastDecision: 'accept' });
    expect(runner.roundCalls('execute')).toEqual([1]);
  });

  it('裁决 fix：execute 带挑战清单单轮应答后重跑，第二轮 pass 收口', async () => {
    const challenge = {
      challenges: [
        {
          category: 'unit_conversion',
          description: '结果疑似把万元当元使用，量级差 1e4',
          severity: 'critical',
        },
      ],
    };
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith({ 'challenge_list.json': challenge }),
      adjudicate: (input) =>
        succeedWith({
          'verdict.json':
            (input.executionRound ?? 1) === 1
              ? { decision: 'fix', reasons: ['存在 critical 级单位换算挑战'] }
              : { decision: 'pass', reasons: ['挑战已应答'] },
        })(input),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 1, forcedAccept: false, lastDecision: 'pass' });
    expect(runner.roundCalls('execute')).toEqual([1, 2]);
    expect(runner.roundCalls('verify')).toEqual([1, 2]);
    expect(runner.roundCalls('adjudicate')).toEqual([1, 2]);

    // 修复轮的 execute 必须拿到 verify 产出的挑战清单（回路依赖）
    const executeRounds = runner.calls.filter((call) => call.nodeId === 'execute');
    expect(executeRounds[0]?.upstreamArtifacts.some((ref) => ref.name === 'analysis_plan.json')).toBe(true);
    expect(executeRounds[0]?.upstreamArtifacts.some((ref) => ref.name === 'challenge_list.json')).toBe(false);
    expect(executeRounds[1]?.upstreamArtifacts.some((ref) => ref.name === 'challenge_list.json')).toBe(true);
    expect(executeRounds[1]?.executionRound).toBe(2);
  });
});

describe('修复回路 / 有界终止', () => {
  it('裁决持续 fix：execute 达 2 轮修复上限后强制 accept 收口，run 成功', async () => {
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith(),
      adjudicate: succeedWith({ 'verdict.json': { decision: 'fix', reasons: ['仍有挑战'] } }),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 2, forcedAccept: true, lastDecision: 'fix' });
    expect(runner.roundCalls('execute')).toEqual([1, 2, 3]);
    expect(runner.roundCalls('verify')).toEqual([1, 2, 3]);
    expect(runner.roundCalls('adjudicate')).toEqual([1, 2, 3]);
  });

  it('maxRepairRounds=0：首轮 fix 也无法回炉，立即强制 accept', async () => {
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith(),
      adjudicate: succeedWith({ 'verdict.json': { decision: 'fix', reasons: ['希望修复'] } }),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner, maxRepairRounds: 0 });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 0, forcedAccept: true, lastDecision: 'fix' });
    expect(runner.roundCalls('execute')).toEqual([1]);
  });
});

describe('修复回路 / 结构化产物 schema 拦截', () => {
  it('verdict 决策值非法时 adjudicate 按失败处理并重试，仍非法则 run 失败', async () => {
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith(),
      adjudicate: succeedWith({ 'verdict.json': { decision: 'banana' } }),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('failed');
    expect(outcome.error).toContain('adjudicate');
    expect(outcome.error).toContain('decision');
    // 单回默认 2 次尝试都发生在第 1 轮
    expect(runner.calls.filter((call) => call.nodeId === 'adjudicate')).toHaveLength(2);
    expect(runner.calls.filter((call) => call.nodeId === 'adjudicate')[1]?.attempt).toBe(2);
  });

  it('挑战清单缺 challenges 数组时 verify 按失败处理', async () => {
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith({ 'challenge_list.json': { note: '没有挑战' } }),
      adjudicate: succeedWith(),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('failed');
    expect(outcome.error).toContain('verify');
    expect(outcome.error).toContain('challenges');
  });
});

describe('修复回路 / 含中间轮次的断点续跑', () => {
  it('fix 已裁决未消费时中断：续跑回炉 execute（不重复 inspect/plan），轮数上限跨进程成立', async () => {
    // 第一跑：adjudicate r1 裁决 fix，execute r2 永久失败 → run failed
    const firstRunner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: (input) => {
        if ((input.executionRound ?? 1) >= 2) {
          input.recorder.recordStep({ kind: 'observation', content: '[execute] 修复轮注入失败' });
          return {
            status: 'failed',
            artifacts: [],
            tokenUsage: USAGE_PER_NODE,
            steps: 1,
            error: '注入的 execute 修复轮失败',
          };
        }
        return succeedWith()(input);
      },
      verify: succeedWith(),
      adjudicate: (input) =>
        succeedWith({
          'verdict.json':
            (input.executionRound ?? 1) === 1
              ? { decision: 'fix', reasons: ['单位换算错误'] }
              : { decision: 'pass', reasons: ['已应答'] },
        })(input),
    });
    const taskId = 'resume_fix_pending';
    const runDir = path.join(tmpRoot, `run-${taskId}`);
    const recorder1 = new RunRecorder();
    recorder1.startRun('loop-resume', 'dag-prototype', taskId);
    const executor1 = new DagExecutor(taskRepairWorkflow({ outputFileName: [TASK_OUTPUT] }), firstRunner, {});
    const outcome1 = await executor1.runTask({
      taskId,
      question: '测试问题',
      workspacePath,
      runDir,
      recorder: recorder1,
    });
    expect(outcome1.status).toBe('failed');
    expect(outcome1.error).toContain('注入的 execute 修复轮失败');
    // execute r1 成功；r2 两次尝试（默认 2 次）都失败，r2 未产出成果
    expect(firstRunner.roundCalls('execute')).toEqual([1, 2, 2]);

    // 断点状态：v2 + 各节点执行轮数 + 待回炉集合 + 修复轮数
    const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'));
    expect(state.version).toBe(2);
    expect(state.nodeExecutions).toMatchObject({ inspect: 1, plan: 1, execute: 1, verify: 1, adjudicate: 1 });
    expect(state.pendingReset).toEqual(['execute', 'verify', 'adjudicate']);
    expect(state.lastDecision).toMatchObject({ nodeId: 'adjudicate', decision: 'fix' });
    expect(state.repairRounds).toBe(1);

    // 第二跑：execute r2 成功 → verify r2 → adjudicate r2 pass
    const secondRunner = allPassRunner();
    const recorder2 = new RunRecorder();
    recorder2.startRun('loop-resume', 'dag-prototype', taskId);
    const executor2 = new DagExecutor(taskRepairWorkflow({ outputFileName: [TASK_OUTPUT] }), secondRunner, {});
    const outcome2 = await executor2.runTask({
      taskId,
      question: '测试问题',
      workspacePath,
      runDir,
      recorder: recorder2,
    });
    expect(outcome2.status).toBe('succeeded');
    expect(outcome2.repair).toMatchObject({ rounds: 1, forcedAccept: false, lastDecision: 'pass' });
    // inspect / plan 不重跑；execute 从第 2 轮继续
    expect(secondRunner.calls.filter((call) => call.nodeId === 'inspect')).toHaveLength(0);
    expect(secondRunner.calls.filter((call) => call.nodeId === 'plan')).toHaveLength(0);
    expect(secondRunner.roundCalls('execute')).toEqual([2]);
    expect(secondRunner.roundCalls('verify')).toEqual([2]);
    expect(secondRunner.roundCalls('adjudicate')).toEqual([2]);
    // 修复轮 execute 拿到上一轮挑战清单
    const executeR2 = secondRunner.calls.find((call) => call.nodeId === 'execute');
    expect(executeR2?.upstreamArtifacts.some((ref) => ref.name === 'challenge_list.json')).toBe(true);
  });

  it('fix 已消费、verify 二轮失败时中断：续跑不再重复 execute，直接补完 verify/adjudicate', async () => {
    const verdicts = [
      { decision: 'fix', reasons: ['第一轮裁决 fix'] },
      { decision: 'pass', reasons: ['第二轮裁决 pass'] },
    ];
    const firstRunner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: (input) => {
        if ((input.executionRound ?? 1) === 2) {
          input.recorder.recordStep({ kind: 'observation', content: '[verify] 二轮失败' });
          return { status: 'failed', artifacts: [], tokenUsage: USAGE_PER_NODE, steps: 1, error: '注入的 verify 失败' };
        }
        return succeedWith()(input);
      },
      adjudicate: (input) => {
        const round = input.executionRound ?? 1;
        return succeedWith({ 'verdict.json': verdicts[round - 1] ?? verdicts[0] })(input);
      },
    });
    const taskId = 'resume_mid_round';
    const runDir = path.join(tmpRoot, `run-${taskId}`);
    const recorder1 = new RunRecorder();
    recorder1.startRun('loop-resume', 'dag-prototype', taskId);
    const executor1 = new DagExecutor(taskRepairWorkflow({ outputFileName: [TASK_OUTPUT] }), firstRunner, {});
    const outcome1 = await executor1.runTask({
      taskId,
      question: '测试问题',
      workspacePath,
      runDir,
      recorder: recorder1,
    });
    expect(outcome1.status).toBe('failed');
    expect(firstRunner.roundCalls('execute')).toEqual([1, 2]); // fix 已消费，execute r2 已完成
    // verify r2 失败（2 次尝试同属一轮，最后一次 attempt=2）
    expect(firstRunner.roundCalls('verify')).toEqual([1, 2, 2]);
    expect(firstRunner.calls.filter((call) => call.nodeId === 'verify').at(-1)?.attempt).toBe(2);

    const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'));
    expect(state.nodeExecutions).toMatchObject({ execute: 2, verify: 1 });
    expect(state.pendingReset).toEqual(['verify', 'adjudicate']);

    // 续跑：execute 不重跑（r2 成果已持久化），verify/adjudicate 补完
    const secondRunner = allPassRunner();
    const recorder2 = new RunRecorder();
    recorder2.startRun('loop-resume', 'dag-prototype', taskId);
    const executor2 = new DagExecutor(taskRepairWorkflow({ outputFileName: [TASK_OUTPUT] }), secondRunner, {});
    const outcome2 = await executor2.runTask({
      taskId,
      question: '测试问题',
      workspacePath,
      runDir,
      recorder: recorder2,
    });
    expect(outcome2.status).toBe('succeeded');
    expect(outcome2.repair).toMatchObject({ rounds: 1, lastDecision: 'pass' });
    expect(secondRunner.calls.filter((call) => call.nodeId === 'execute')).toHaveLength(0);
    expect(secondRunner.roundCalls('verify')).toEqual([2]);
    expect(secondRunner.roundCalls('adjudicate')).toEqual([2]);
  });

  it('回路中途修复轮数已用尽的断点：续跑不再超额回炉', async () => {
    // 第一跑：始终 fix；execute 3 轮全部成功 → 第 3 轮裁决 fix 时超限强制 accept，run 成功
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith(),
      adjudicate: succeedWith({ 'verdict.json': { decision: 'fix', reasons: ['仍有挑战'] } }),
    });
    const { status, outcome, runDir } = await runOnce(workspacePath, { runner, taskId: 'bound_cross_process' });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 2, forcedAccept: true });
    const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'));
    expect(state.nodeExecutions).toMatchObject({ execute: 3, verify: 3, adjudicate: 3 });
    expect(state.repairRounds).toBe(2);
    expect(state.pendingReset).toEqual([]);
  });
});

describe('修复回路 / nodeRuns 与产物', () => {
  it('回路成功后 nodeRuns 每节点一条最新记录，executions 反映重跑轮数', async () => {
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: succeedWith(),
      verify: succeedWith(),
      adjudicate: (input) =>
        succeedWith({
          'verdict.json':
            (input.executionRound ?? 1) === 1
              ? { decision: 'fix', reasons: ['需要修复'] }
              : { decision: 'pass', reasons: ['ok'] },
        })(input),
    });
    const { outcome } = await runOnce(workspacePath, { runner });
    const byNode = new Map(outcome.nodeRuns.map((run) => [run.nodeId, run]));
    expect(byNode.get('execute')).toMatchObject({ status: 'succeeded', executions: 2 });
    expect(byNode.get('verify')).toMatchObject({ status: 'succeeded', executions: 2 });
    expect(byNode.get('adjudicate')).toMatchObject({ status: 'succeeded', executions: 2 });
    expect(byNode.get('inspect')).toMatchObject({ status: 'succeeded' });
    expect(byNode.get('inspect')?.executions).toBeUndefined();
    // 全部登记产物可追溯（含挑战清单与裁决）
    const names = outcome.artifacts.map((ref) => ref.name);
    expect(names).toContain('challenge_list.json');
    expect(names).toContain('verdict.json');
  });

  it('修复轮的失败反馈回灌保留 Phase A 语义（attempt 递增）', async () => {
    let executeCalls = 0;
    const runner = new LoopMockRunner({
      inspect: succeedWith(),
      plan: succeedWith(),
      execute: (input) => {
        executeCalls += 1;
        if ((input.executionRound ?? 1) === 1 && executeCalls === 1) {
          return {
            status: 'failed',
            artifacts: [],
            tokenUsage: USAGE_PER_NODE,
            steps: 1,
            error: '注入的一次性失败',
          };
        }
        return succeedWith()(input);
      },
      verify: succeedWith(),
      adjudicate: succeedWith(),
    });
    const { status, outcome } = await runOnce(workspacePath, { runner });
    expect(status).toBe('succeeded');
    expect(outcome.repair).toMatchObject({ rounds: 0, lastDecision: 'pass' });
    const executeInputs = runner.calls.filter((call) => call.nodeId === 'execute');
    expect(executeInputs).toHaveLength(2);
    expect(executeInputs[0]?.attempt).toBe(1);
    expect(executeInputs[1]?.attempt).toBe(2);
    expect(executeInputs[1]?.previousFailure?.message).toContain('注入的一次性失败');
  });
});
