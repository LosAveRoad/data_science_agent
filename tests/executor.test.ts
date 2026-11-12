import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DagExecutor, ExecutorError } from '../src/dag/executor.js';
import type { AgentRunner, AgentRunnerInput, NodeOutputGateFn, NodeRunResult } from '../src/dag/executor.js';
import { defaultWorkflow, taskWorkflow } from '../src/dag/workflow.js';
import { executionOrder, validateWorkflow } from '../src/dag/graph.js';
import { RunRecorder } from '../src/tracing/recorder.js';
import type { TokenUsage } from '../src/tracing/recorder.js';

/** mock runner 中每个节点固定上报的 token 用量。 */
const USAGE_PER_NODE: TokenUsage = { inputTokens: 60, outputTokens: 40, totalTokens: 100 };

/** defaultWorkflow 各节点声明的输出产物。 */
const DECLARED: Record<string, string[]> = {
  inspect: ['data_profile.json'],
  plan: ['analysis_plan.json'],
  execute: ['result.json', 'execute_summary.json'],
  verify: ['verification.json'],
};

function declaredFor(nodeId: string): string[] {
  return DECLARED[nodeId] ?? [];
}

/** 结构化产物内容（与 src/artifacts/schemas.ts 的 schema 对齐；其余产物用通用占位）。 */
function artifactContent(nodeId: string, name: string): unknown {
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
  return { node: nodeId };
}

/** 成功脚本：模拟 ReAct 三步（thought / tool_call / observation）并在工作区写出产物文件。 */
function succeed(artifactNames: string[]): (input: AgentRunnerInput) => Promise<NodeRunResult> {
  return async (input) => {
    input.recorder.recordStep({
      kind: 'thought',
      name: 'think',
      content: `[${input.nodeId}] 分析任务`,
      tokenUsage: USAGE_PER_NODE,
    });
    input.recorder.recordStep({ kind: 'tool_call', name: 'python', content: 'print("step")' });
    input.recorder.recordStep({ kind: 'observation', content: `[${input.nodeId}] 工具执行完成` });

    const artifacts: { name: string; path: string }[] = [];
    for (const name of artifactNames) {
      const filePath = path.join(input.workspacePath, name);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(artifactContent(input.nodeId, name)), 'utf8');
      artifacts.push({ name, path: filePath });
    }
    return { status: 'succeeded', artifacts, tokenUsage: USAGE_PER_NODE, steps: 3 };
  };
}

/** 失败脚本：记录一步后直接返回失败结果。 */
function failWith(error: string): (input: AgentRunnerInput) => Promise<NodeRunResult> {
  return async (input) => {
    input.recorder.recordStep({ kind: 'thought', content: `[${input.nodeId}] 失败前思考`, tokenUsage: USAGE_PER_NODE });
    return { status: 'failed', artifacts: [], tokenUsage: USAGE_PER_NODE, steps: 1, error };
  };
}

/** 可编排的 mock AgentRunner：不调用 LLM，按脚本返回结果。 */
class MockRunner implements AgentRunner {
  readonly calls: AgentRunnerInput[] = [];

  constructor(private readonly scripts: Record<string, (input: AgentRunnerInput) => Promise<NodeRunResult>>) {}

  async run(input: AgentRunnerInput): Promise<NodeRunResult> {
    this.calls.push(input);
    const script = this.scripts[input.nodeId];
    if (!script) {
      throw new Error(`测试脚本未定义节点 ${input.nodeId} 的行为`);
    }
    return script(input);
  }

  get calledIds(): string[] {
    return this.calls.map((call) => call.nodeId);
  }
}

function allSucceed(): MockRunner {
  return new MockRunner({
    inspect: succeed(declaredFor('inspect')),
    plan: succeed(declaredFor('plan')),
    execute: succeed(declaredFor('execute')),
    verify: succeed(declaredFor('verify')),
  });
}

interface RunOptions {
  taskId?: string;
}

/** runTask 的任务上下文（测试用）。 */
interface TestContext {
  taskId: string;
  question: string;
  workspacePath: string;
  runDir: string;
  recorder: RunRecorder;
}

/** 为一次测试运行准备 recorder + runTask 上下文。 */
function buildContext(runDir: string, options: RunOptions = {}): { recorder: RunRecorder; ctx: TestContext } {
  const recorder = new RunRecorder();
  const taskId = options.taskId ?? 'task_01';
  recorder.startRun('exp-1', 'dag-prototype', taskId);
  const ctx: TestContext = {
    taskId,
    question: '分析销售数据并输出汇总表',
    workspacePath: path.join(runDir, 'workspace'),
    runDir,
    recorder,
  };
  return { recorder, ctx };
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsa-executor-test-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('DagExecutor / 正常四节点执行', () => {
  it('按 executionOrder 串行执行四个节点，传递上游产物并登记产物', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-ok-'));
    const runner = allSucceed();
    const { recorder, ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('succeeded');
    expect(runner.calledIds).toEqual(['inspect', 'plan', 'execute', 'verify']);
    expect(outcome.nodeRuns.map((node) => node.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    // token 汇总：4 个节点 × USAGE_PER_NODE
    expect(outcome.tokenUsage).toEqual({ inputTokens: 240, outputTokens: 160, totalTokens: 400 });
    // 产物按节点登记且文件在盘
    expect(outcome.artifacts.map((ref) => `${ref.nodeId}/${ref.name}`)).toEqual([
      'inspect/data_profile.json',
      'plan/analysis_plan.json',
      'execute/result.json',
      'execute/execute_summary.json',
      'verify/verification.json',
    ]);
    for (const ref of outcome.artifacts) {
      expect(existsSync(ref.path)).toBe(true);
    }
    // 上游产物逐级传递（inspect 无上游；verify 依赖 execute，其声明两个产物）
    expect(runner.calls.map((call) => call.upstreamArtifacts.length)).toEqual([0, 1, 1, 2]);
    // maxStepsPerNode 默认 40，workspacePath / runDir 透传
    expect(runner.calls.every((call) => call.maxSteps === 40)).toBe(true);
    expect(runner.calls[0]?.workspacePath).toBe(path.join(runDir, 'workspace'));
    expect(runner.calls[0]?.runDir).toBe(path.resolve(runDir));
    // 断点状态记录了全部 4 个已完成节点
    const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    expect(state['workflowId']).toBe('inspect-plan-execute-verify');
    expect((state['completedNodes'] as unknown[]).length).toBe(4);
    // recorder 记录了节点轨迹与 token
    expect(recorder.nodeRecord('verify')?.status).toBe('succeeded');
    expect(recorder.getTotalTokenUsage()).toEqual({ inputTokens: 240, outputTokens: 160, totalTokens: 400 });
  });

  it('自定义 maxStepsPerNode 透传给 runner', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-maxsteps-'));
    const runner = allSucceed();
    const { ctx } = buildContext(runDir);
    await new DagExecutor(defaultWorkflow(), runner, { maxStepsPerNode: 7 }).runTask(ctx);
    expect(runner.calls.every((call) => call.maxSteps === 7)).toBe(true);
  });
});

describe('DagExecutor / 失败传播', () => {
  it('单个节点失败即终止整个 run，后续节点保持 pending', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-fail-'));
    const runner = new MockRunner({
      inspect: succeed(declaredFor('inspect')),
      plan: failWith('LLM 超时'),
      execute: succeed(declaredFor('execute')),
      verify: succeed(declaredFor('verify')),
    });
    const { recorder, ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/plan 失败[\s\S]*LLM 超时/);
    // Phase A 失败策略：plan 第一次失败后带错误重试 1 次，仍失败才终止 run
    expect(runner.calledIds).toEqual(['inspect', 'plan', 'plan']);
    // 第二次尝试携带上一次的失败反馈
    expect(runner.calls[2]?.attempt).toBe(2);
    expect(runner.calls[2]?.previousFailure).toMatchObject({ kind: 'error', attempt: 1, message: 'LLM 超时' });
    expect(outcome.nodeRuns.map((node) => [node.nodeId, node.status])).toEqual([
      ['inspect', 'succeeded'],
      ['plan', 'failed'],
      ['execute', 'pending'],
      ['verify', 'pending'],
    ]);
    expect(outcome.nodeRuns[1]?.attempts).toBe(2);
    // 失败节点不进入断点状态
    const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    expect((state['completedNodes'] as Array<Record<string, unknown>>).map((node) => node['nodeId'])).toEqual([
      'inspect',
    ]);
    expect(recorder.nodeRecord('plan')?.status).toBe('failed');
  });

  it('runner 抛出异常时节点按失败处理并终止 run', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-throw-'));
    const runner = new MockRunner({
      inspect: async () => {
        throw new Error('runtime 崩溃');
      },
    });
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/inspect 失败[\s\S]*runtime 崩溃/);
    expect(outcome.nodeRuns[0]?.status).toBe('failed');
    expect(outcome.nodeRuns.map((node) => node.status)).toContain('pending');
  });

  it('runner 返回的产物文件不存在时，该节点按失败处理且下游不再执行', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-missing-'));
    const runner = new MockRunner({
      // inspect “成功”但产物文件没有写盘
      inspect: async (input) => ({
        status: 'succeeded' as const,
        artifacts: [{ name: 'data_profile.json', path: path.join(input.workspacePath, 'data_profile.json') }],
        tokenUsage: USAGE_PER_NODE,
        steps: 1,
      }),
      plan: succeed(declaredFor('plan')),
    });
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/inspect 失败[\s\S]*产物登记失败[\s\S]*data_profile\.json/);
    // 产物登记失败也属于可重试失败：inspect 共尝试 2 次
    expect(runner.calledIds).toEqual(['inspect', 'inspect']);
    expect(outcome.nodeRuns.map((node) => [node.nodeId, node.status])).toEqual([
      ['inspect', 'failed'],
      ['plan', 'pending'],
      ['execute', 'pending'],
      ['verify', 'pending'],
    ]);
  });

  it('上游成功但未产出声明产物时，该节点自身被判失败并重试（不再拖到下游依赖检查）', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-nodep-'));
    const runner = new MockRunner({
      // inspect “成功”但什么产物都没有：Phase A 会在 inspect 节点直接判失败并重试
      inspect: async () => ({ status: 'succeeded' as const, artifacts: [], tokenUsage: USAGE_PER_NODE, steps: 1 }),
      plan: succeed(declaredFor('plan')),
    });
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/inspect 失败[\s\S]*未产出声明产物[\s\S]*data_profile\.json/);
    expect(runner.calledIds).toEqual(['inspect', 'inspect']);
    // plan 未被执行（失败发生在 inspect 节点自身）
    expect(outcome.nodeRuns.map((node) => [node.nodeId, node.status])).toEqual([
      ['inspect', 'failed'],
      ['plan', 'pending'],
      ['execute', 'pending'],
      ['verify', 'pending'],
    ]);
    // inspect 未成功：断点状态文件不落盘（无任何已完成节点）
    expect(existsSync(path.join(runDir, 'state.json'))).toBe(false);
  });
});

describe('DagExecutor / Phase A 失败策略', () => {
  it('节点第一次失败、重试成功后 run 正常继续', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-retry-ok-'));
    const runner = new MockRunner({
      inspect: succeed(declaredFor('inspect')),
      plan: async (input) => {
        if (input.attempt === 1) {
          return { status: 'failed' as const, artifacts: [], tokenUsage: USAGE_PER_NODE, steps: 1, error: 'LLM 调用异常' };
        }
        return succeed(declaredFor('plan'))(input);
      },
      execute: succeed(declaredFor('execute')),
      verify: succeed(declaredFor('verify')),
    });
    const { recorder, ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('succeeded');
    expect(runner.calledIds).toEqual(['inspect', 'plan', 'plan', 'execute', 'verify']);
    expect(outcome.nodeRuns[1]).toMatchObject({ nodeId: 'plan', status: 'succeeded', attempts: 2 });
    // 重试成功后 error 不再出现在最终 nodeRuns
    expect(outcome.nodeRuns[1]?.error).toBeUndefined();
    // token 汇总包含两次尝试：5 次成功执行 × 100
    expect(outcome.tokenUsage.totalTokens).toBe(500);
    // 断点状态包含全部 4 个节点
    const state = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    expect((state['completedNodes'] as unknown[]).length).toBe(4);
    // recorder 中 plan 记录了失败与成功两次轨迹
    expect(recorder.nodeRecord('plan')?.status).toBe('succeeded');
  });

  it('步数耗尽（stopReason=step_limit）触发续跑而非普通重试，续跑成功后继续', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-continue-'));
    const runner = new MockRunner({
      inspect: async (input) => {
        if (input.attempt === 1) {
          return {
            status: 'failed' as const,
            artifacts: [],
            tokenUsage: USAGE_PER_NODE,
            steps: 40,
            error: '已达最大 ReAct 步数上限（40 步），未收到 finish',
            stopReason: 'step_limit' as const,
          };
        }
        return succeed(declaredFor('inspect'))(input);
      },
      plan: succeed(declaredFor('plan')),
      execute: succeed(declaredFor('execute')),
      verify: succeed(declaredFor('verify')),
    });
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('succeeded');
    expect(runner.calledIds).toEqual(['inspect', 'inspect', 'plan', 'execute', 'verify']);
    // 第二次尝试的反馈是 step_limit 类型
    expect(runner.calls[1]?.previousFailure).toMatchObject({
      kind: 'step_limit',
      attempt: 1,
      message: '已达最大 ReAct 步数上限（40 步），未收到 finish',
    });
    expect(outcome.nodeRuns[0]).toMatchObject({ nodeId: 'inspect', status: 'succeeded', attempts: 2 });
  });

  it('重试次数耗尽后 run 终止，错误注明重试次数', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-retry-cap-'));
    const runner = new MockRunner({ inspect: failWith('持续失败') });
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner, { maxAttemptsPerNode: 3 }).runTask(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/inspect 失败（已重试 2 次）[\s\S]*持续失败/);
    expect(runner.calledIds).toEqual(['inspect', 'inspect', 'inspect']);
    // 每次尝试的反馈逐次递进
    expect(runner.calls[1]?.previousFailure?.attempt).toBe(1);
    expect(runner.calls[2]?.previousFailure?.attempt).toBe(2);
    expect(outcome.nodeRuns[0]?.attempts).toBe(3);
  });

  it('产物不符合结构化 schema 时触发重试，问题清单回灌给 runner', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-schema-'));
    const runner = new MockRunner({
      inspect: async (input) => {
        if (input.attempt === 1) {
          const filePath = path.join(input.workspacePath, 'data_profile.json');
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, JSON.stringify({ oops: true }), 'utf8');
          return {
            status: 'succeeded' as const,
            artifacts: [{ name: 'data_profile.json', path: filePath }],
            tokenUsage: USAGE_PER_NODE,
            steps: 1,
          };
        }
        return succeed(declaredFor('inspect'))(input);
      },
      plan: succeed(declaredFor('plan')),
      execute: succeed(declaredFor('execute')),
      verify: succeed(declaredFor('verify')),
    });
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner).runTask(ctx);

    expect(outcome.status).toBe('succeeded');
    expect(runner.calls[1]?.previousFailure?.kind).toBe('error');
    expect(runner.calls[1]?.previousFailure?.message).toMatch(/产物不符合结构化 schema[\s\S]*files/);
    expect(runner.calledIds).toEqual(['inspect', 'inspect', 'plan', 'execute', 'verify']);
  });

  it('程序化验证门未通过时 execute 重试；门只对挂接节点产生问题', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-gate-'));
    const gateCalls: string[] = [];
    const gate: NodeOutputGateFn = (nodeId) => {
      if (nodeId !== 'execute') {
        return [];
      }
      gateCalls.push(`attempt:${gateCalls.length + 1}`);
      return gateCalls.length === 1 ? ['output.csv: 文件为空'] : [];
    };
    const runner = allSucceed();
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner, { outputGate: gate }).runTask(ctx);

    expect(outcome.status).toBe('succeeded');
    // execute 第一次过门失败、重试后通过；其余节点过门直接放行
    expect(runner.calledIds).toEqual(['inspect', 'plan', 'execute', 'execute', 'verify']);
    expect(gateCalls).toEqual(['attempt:1', 'attempt:2']);
    expect(runner.calls[3]?.previousFailure?.message).toMatch(/程序化验证门未通过[\s\S]*output\.csv: 文件为空/);
    expect(outcome.nodeRuns[2]).toMatchObject({ nodeId: 'execute', status: 'succeeded', attempts: 2 });
  });
});

describe('DagExecutor / token 预算', () => {
  it('run 级 token 预算超限时中止并标记 failed（错误注明超预算）', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-budget-'));
    const runner = allSucceed();
    const { ctx } = buildContext(runDir);

    // 每节点 100 tokens：inspect(100) → plan(200) → execute(300) 超过 250，verify 不再执行
    const outcome = await new DagExecutor(defaultWorkflow(), runner, { tokenBudgetPerRun: 250 }).runTask(ctx);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/token 预算超限/);
    expect(outcome.error).toMatch(/300[\s\S]*250/);
    expect(runner.calledIds).toEqual(['inspect', 'plan', 'execute']);
    expect(outcome.nodeRuns.map((node) => [node.nodeId, node.status])).toEqual([
      ['inspect', 'succeeded'],
      ['plan', 'succeeded'],
      ['execute', 'succeeded'],
      ['verify', 'pending'],
    ]);
    expect(outcome.tokenUsage.totalTokens).toBe(300);
  });

  it('预算恰好未超限时正常完成', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-budget-ok-'));
    const runner = allSucceed();
    const { ctx } = buildContext(runDir);

    const outcome = await new DagExecutor(defaultWorkflow(), runner, { tokenBudgetPerRun: 400 }).runTask(ctx);
    expect(outcome.status).toBe('succeeded');
    expect(runner.calledIds).toEqual(['inspect', 'plan', 'execute', 'verify']);
  });
});

describe('DagExecutor / 断点续跑', () => {
  it('重入时跳过已 succeeded 节点，恢复轨迹与用量', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-resume-'));

    // 第一次：inspect 成功、plan 失败
    const firstRunner = new MockRunner({
      inspect: succeed(declaredFor('inspect')),
      plan: failWith('LLM 超时'),
    });
    const firstRun = buildContext(runDir);
    const firstOutcome = await new DagExecutor(defaultWorkflow(), firstRunner).runTask(firstRun.ctx);
    expect(firstOutcome.status).toBe('failed');

    const statePath = path.join(runDir, 'state.json');
    const state1 = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    const inspectStartedAt = (state1['completedNodes'] as Array<Record<string, unknown>>)[0]?.['startedAt'];

    // 第二次：全部成功（新 runner / 新 recorder）
    const secondRunner = allSucceed();
    const secondRecorder = new RunRecorder();
    secondRecorder.startRun('exp-1', 'dag-prototype', 'task_01');
    const secondOutcome = await new DagExecutor(defaultWorkflow(), secondRunner).runTask({
      taskId: 'task_01',
      question: '分析销售数据并输出汇总表',
      workspacePath: path.join(runDir, 'workspace'),
      runDir,
      recorder: secondRecorder,
    });

    expect(secondOutcome.status).toBe('succeeded');
    // inspect 被跳过，只执行剩余三个节点
    expect(secondRunner.calledIds).toEqual(['plan', 'execute', 'verify']);
    expect(secondOutcome.nodeRuns[0]).toMatchObject({ nodeId: 'inspect', status: 'succeeded', startedAt: inspectStartedAt });
    expect(secondOutcome.nodeRuns.map((node) => node.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    // 用量 = 续跑携带的 100 + 新执行 300
    expect(secondOutcome.tokenUsage.totalTokens).toBe(400);
    // 恢复的轨迹完整：inspect 的历史步骤也在 result.json 中
    await secondRecorder.writeResultJson(runDir);
    const result = JSON.parse(await readFile(path.join(runDir, 'dabench', 'result.json'), 'utf8')) as Record<string, unknown>;
    const trajectory = result['trajectory'] as Array<Record<string, unknown>>;
    expect(trajectory.some((entry) => entry['action'] === 'Think' && entry['content'] === '[inspect] 分析任务')).toBe(true);
    expect(trajectory.some((entry) => entry['action'] === 'Think' && entry['content'] === '[verify] 分析任务')).toBe(true);
    // result.json 顶层 token_usage 为完整 run 汇总
    expect(result['token_usage']).toEqual({ input_tokens: 240, output_tokens: 160, total_tokens: 400 });
  });

  it('state.json 的 workflow 与当前不一致时拒绝续跑', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-mismatch-'));
    const firstRunner = new MockRunner({ inspect: succeed(declaredFor('inspect')) });
    const { ctx } = buildContext(runDir);
    await new DagExecutor(defaultWorkflow(), firstRunner).runTask(ctx);

    const statePath = path.join(runDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    state['workflowId'] = 'another-workflow';
    await writeFile(statePath, JSON.stringify(state), 'utf8');

    const executor = new DagExecutor(defaultWorkflow(), allSucceed());
    await expect(executor.runTask(ctx)).rejects.toThrow(ExecutorError);
    await expect(executor.runTask(ctx)).rejects.toThrow(/不一致/);
  });

  it('state.json 的 taskId 与当前不一致时拒绝续跑', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-taskid-'));
    const firstRunner = new MockRunner({ inspect: succeed(declaredFor('inspect')) });
    const firstRun = buildContext(runDir);
    await new DagExecutor(defaultWorkflow(), firstRunner).runTask(firstRun.ctx);

    const executor = new DagExecutor(defaultWorkflow(), allSucceed());
    const secondRecorder = new RunRecorder();
    secondRecorder.startRun('exp-1', 'dag-prototype', 'task_02');
    await expect(
      executor.runTask({
        taskId: 'task_02',
        question: '另一个任务',
        workspacePath: path.join(runDir, 'workspace'),
        runDir,
        recorder: secondRecorder,
      }),
    ).rejects.toThrow(/task_02[\s\S]*不一致/);
  });
});

describe('taskWorkflow', () => {
  it('execute 节点声明产物与任务输出文件对齐，且工作流校验通过', () => {
    const wf = taskWorkflow({ outputFileName: ['output.csv', 'output.png'] });
    expect(() => validateWorkflow(wf)).not.toThrow();
    const execute = wf.nodes.find((n) => n.id === 'execute');
    expect(execute?.outputArtifacts).toEqual(['output.csv', 'output.png', 'execute_summary.json']);
    const verify = wf.nodes.find((n) => n.id === 'verify');
    expect(verify?.dependsOn).toEqual(['execute']);
    // 执行顺序仍为固定四阶段
    expect(executionOrder(wf).map((n) => n.id)).toEqual(['inspect', 'plan', 'execute', 'verify']);
  });

  it('任务无输出文件声明时 execute 仍产出 execute_summary.json', () => {
    const wf = taskWorkflow({ outputFileName: [] });
    const execute = wf.nodes.find((n) => n.id === 'execute');
    expect(execute?.outputArtifacts).toEqual(['execute_summary.json']);
  });
});
