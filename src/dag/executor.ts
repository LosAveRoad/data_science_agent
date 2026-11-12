import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactStore } from '../artifacts/store.js';
import type { ArtifactRef } from '../artifacts/store.js';
import { addTokenUsage, emptyTokenUsage } from '../tracing/recorder.js';
import type { RunRecorder, SerializedStep, TokenUsage } from '../tracing/recorder.js';
import { executionOrder } from './graph.js';
import type { DagNode, NodeRun, WorkflowDefinition } from './types.js';

/** 单个节点一次执行的返回结果（由 AgentRunner 实现，如 src/agent 的 Pi Runtime）。 */
export interface NodeRunResult {
  status: 'succeeded' | 'failed';
  /** 节点产出物的 (name, path) 列表；文件必须已写盘。 */
  artifacts: { name: string; path: string }[];
  /** 本节点累计 token 用量。 */
  tokenUsage: TokenUsage;
  /** 本节点完成的 ReAct 步数。 */
  steps: number;
  error?: string;
}

/** DagExecutor 传给 AgentRunner 的节点执行输入。 */
export interface AgentRunnerInput {
  taskId: string;
  /** 当前执行的节点 ID（如 inspect / plan / execute / verify）。 */
  nodeId: string;
  /** Benchmark 任务原始问题。 */
  question: string;
  /** 任务隔离工作区（数据文件所在目录）。 */
  workspacePath: string;
  /** 当前节点的职责描述（来自 workflow 定义）。 */
  nodeTask: string;
  /** 上游节点的产物引用（节点之间只通过文件 Artifact 传递信息）。 */
  upstreamArtifacts: ArtifactRef[];
  /** 本节点允许的最大 ReAct 步数。 */
  maxSteps: number;
  /** 本次任务运行的根目录。 */
  runDir: string;
  /** 轨迹记录器：runner 通过 recordStep 上报每步内容与 LLM token 用量。 */
  recorder: RunRecorder;
  /** 取消信号（可选）。 */
  signal?: AbortSignal;
}

/** 节点执行器接口：由 src/agent 的 Pi Agent Runtime 实现，DagExecutor 只依赖此抽象。 */
export interface AgentRunner {
  run(input: AgentRunnerInput): Promise<NodeRunResult>;
}

/** DagExecutor 可选项。 */
export interface DagExecutorOptions {
  /** 单节点 ReAct 步数上限（设计文档 3.3 护栏，默认 40）。 */
  maxStepsPerNode?: number;
  /** run 级 token 预算（所有节点用量合计），超限即中止并标记 failed。 */
  tokenBudgetPerRun?: number;
}

/** runTask 的任务上下文。 */
export interface ExecutorTaskContext {
  taskId: string;
  /** Benchmark 任务原始问题。 */
  question: string;
  /** 任务隔离工作区路径。 */
  workspacePath: string;
  /**
   * 本次任务运行根目录（一个任务一个 runDir）。断点状态写入 `<runDir>/state.json`，
   * 节点产物注册表根目录为 `<runDir>/artifacts`。
   */
  runDir: string;
  /** 轨迹记录器；startRun / endRun 由上层实验脚本负责，executor 只管理节点生命周期。 */
  recorder: RunRecorder;
}

/** 一次任务运行的最终结果。 */
export interface RunOutcome {
  taskId: string;
  status: 'succeeded' | 'failed';
  /** 各节点执行记录（按 executionOrder 顺序，未执行的节点为 pending）。 */
  nodeRuns: NodeRun[];
  /** 全部节点的 token 用量合计（断点续跑时包含历史用量）。 */
  tokenUsage: TokenUsage;
  /** 全部登记的节点产物。 */
  artifacts: ArtifactRef[];
  error?: string;
}

/** Executor 层错误（断点状态非法、续跑校验失败等）。 */
export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

/** state.json 格式版本号（格式变更时递增）。 */
const STATE_VERSION = 1;
/** 断点状态文件名。 */
const STATE_FILE_NAME = 'state.json';
/** 节点产物注册表根目录名。 */
const ARTIFACTS_DIR_NAME = 'artifacts';
/** 单节点 ReAct 步数默认上限（设计文档 3.3 护栏）。 */
const DEFAULT_MAX_STEPS_PER_NODE = 40;

/** state.json 中单个已完成节点的记录（只持久化 succeeded 节点）。 */
interface SerializedNodeState {
  nodeId: string;
  status: 'succeeded';
  startedAt?: string;
  finishedAt?: string;
  tokenUsage: TokenUsage;
  /** 节点完成的步数。 */
  steps: number;
  artifacts: { name: string; path: string }[];
  /** 原始步骤记录（含时间戳），续跑时恢复进 recorder 以保证轨迹完整。 */
  stepRecords?: SerializedStep[];
}

/** runDir/state.json 的文件格式。 */
interface WorkflowStateFile {
  version: number;
  workflowId: string;
  /** 执行顺序中的节点 ID 列表（用于 workflow 一致性校验）。 */
  nodeIds: string[];
  taskId: string;
  updatedAt: string;
  totalTokenUsage: TokenUsage;
  completedNodes: SerializedNodeState[];
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (['inputTokens', 'outputTokens', 'totalTokens'] as const).every((field) => {
    const v = record[field];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  });
}

/**
 * 串行 DAG Executor（初版）：按 executionOrder 串行执行节点，不做并行调度与自动重试。
 *
 * - 每个节点执行前检查依赖产物存在（上游声明产物已产出且文件在盘）；
 * - 节点结果产物注册进 ArtifactStore，并作为 downstream 的 upstreamArtifacts 传入；
 * - run 级 token 预算超限即中止并标记 failed（错误信息注明超预算）；
 * - 单个节点失败即终止整个 run；
 * - 支持断点续跑：`<runDir>/state.json` 记录已完成节点，重入时跳过已 succeeded 节点
 *   （读取时校验 workflow 定义与 taskId 一致）。
 */
export class DagExecutor {
  private readonly workflow: WorkflowDefinition;
  /** 校验并拓扑排序后的执行序列。 */
  private readonly order: DagNode[];
  private readonly nodeById: Map<string, DagNode>;
  private readonly runner: AgentRunner;
  private readonly maxStepsPerNode: number;
  private readonly tokenBudgetPerRun: number | undefined;

  constructor(workflow: WorkflowDefinition, runner: AgentRunner, opts: DagExecutorOptions = {}) {
    this.workflow = workflow;
    // 非法工作流（重复 ID、未知依赖、环）在构造期即抛 DagValidationError
    this.order = executionOrder(workflow);
    this.nodeById = new Map(this.order.map((node) => [node.id, node]));
    this.runner = runner;
    this.maxStepsPerNode = opts.maxStepsPerNode ?? DEFAULT_MAX_STEPS_PER_NODE;
    this.tokenBudgetPerRun = opts.tokenBudgetPerRun;
  }

  /** 按依赖顺序串行执行整个工作流，返回 run 结果。 */
  async runTask(ctx: ExecutorTaskContext): Promise<RunOutcome> {
    const runDir = path.resolve(ctx.runDir);
    await mkdir(runDir, { recursive: true });
    const store = new ArtifactStore(path.join(runDir, ARTIFACTS_DIR_NAME));

    // 1. 读取断点状态（校验 workflow / taskId 一致），恢复已完成节点与历史用量
    const state = await this.loadState(runDir, ctx.taskId);
    const completed = new Map<string, SerializedNodeState>();
    let totalUsage = emptyTokenUsage();
    for (const entry of state?.completedNodes ?? []) {
      completed.set(entry.nodeId, entry);
      totalUsage = addTokenUsage(totalUsage, entry.tokenUsage);
    }

    const nodeRuns: NodeRun[] = [];
    const recorded = new Set<string>();
    let failed = false;
    let budgetExceeded = false;
    let runError: string | undefined;
    let executedThisProcess = 0;

    for (const node of this.order) {
      // 2. 断点续跑：跳过已 succeeded 的节点，恢复轨迹与产物注册
      const carried = completed.get(node.id);
      if (carried) {
        await this.restoreCarriedNode(node.id, carried, store, ctx.recorder);
        nodeRuns.push({
          nodeId: node.id,
          status: 'succeeded',
          ...(carried.startedAt !== undefined ? { startedAt: carried.startedAt } : {}),
          ...(carried.finishedAt !== undefined ? { finishedAt: carried.finishedAt } : {}),
        });
        recorded.add(node.id);
        continue;
      }

      // 3. run 级 token 预算检查：超限即中止后续节点（错误信息注明超预算）
      if (this.isOverBudget(totalUsage)) {
        budgetExceeded = true;
        runError = this.budgetErrorMessage(totalUsage);
        break;
      }

      // 4. 依赖产物检查：上游声明产物已产出且文件在盘
      const missing = await this.findMissingDependencies(node, store);
      if (missing.length > 0) {
        const error = `节点 ${node.id} 的依赖产物缺失: ${missing.join('; ')}`;
        ctx.recorder.startNode(node.id);
        ctx.recorder.endNode('failed', error);
        const now = new Date().toISOString();
        nodeRuns.push({ nodeId: node.id, status: 'failed', startedAt: now, finishedAt: now, error });
        recorded.add(node.id);
        failed = true;
        runError = error;
        break;
      }

      // 5. 执行节点（runner 抛出的异常视作节点失败）
      ctx.recorder.startNode(node.id);
      const startedAt = new Date().toISOString();
      let result: NodeRunResult;
      try {
        result = await this.runner.run({
          taskId: ctx.taskId,
          nodeId: node.id,
          question: ctx.question,
          workspacePath: ctx.workspacePath,
          nodeTask: node.task,
          upstreamArtifacts: node.dependsOn.flatMap((dep) => store.list(dep)),
          maxSteps: this.maxStepsPerNode,
          runDir,
          recorder: ctx.recorder,
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
      const finishedAt = new Date().toISOString();
      // 产物登记：runner 声称成功但产物文件不可用时，按节点失败处理（不让坏引用进入注册表）
      if (result.status === 'succeeded') {
        try {
          for (const artifact of result.artifacts) {
            await store.register(node.id, artifact.name, artifact.path);
          }
        } catch (err) {
          result = {
            status: 'failed',
            artifacts: [],
            tokenUsage: result.tokenUsage,
            steps: result.steps,
            error: `产物登记失败: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      ctx.recorder.endNode(result.status, result.error);
      nodeRuns.push({
        nodeId: node.id,
        status: result.status,
        startedAt,
        finishedAt,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
      recorded.add(node.id);
      executedThisProcess += 1;

      if (result.status !== 'succeeded') {
        failed = true;
        runError = `节点 ${node.id} 失败: ${result.error ?? '未知错误'}`;
        break;
      }

      // 6. 节点成功：累计 token、持久化断点状态（产物已在上方登记）
      totalUsage = addTokenUsage(totalUsage, result.tokenUsage);
      completed.set(node.id, {
        nodeId: node.id,
        status: 'succeeded',
        startedAt,
        finishedAt,
        tokenUsage: result.tokenUsage,
        steps: result.steps,
        artifacts: result.artifacts.map((artifact) => ({ name: artifact.name, path: artifact.path })),
        stepRecords: ctx.recorder.nodeRecord(node.id)?.steps,
      });
      await this.persistState(runDir, ctx.taskId, completed, totalUsage);
    }

    // 7. 最后一个节点执行完也可能已超预算（后面没有节点可以触发预算拦截）
    if (!budgetExceeded && !failed && executedThisProcess > 0 && this.isOverBudget(totalUsage)) {
      budgetExceeded = true;
      runError = this.budgetErrorMessage(totalUsage);
    }

    // 8. 未执行的节点补 pending 记录，保证 nodeRuns 覆盖整个 workflow
    for (const node of this.order) {
      if (!recorded.has(node.id)) {
        nodeRuns.push({ nodeId: node.id, status: 'pending' });
      }
    }

    const status: 'succeeded' | 'failed' = !failed && !budgetExceeded ? 'succeeded' : 'failed';
    const outcome: RunOutcome = {
      taskId: ctx.taskId,
      status,
      nodeRuns,
      tokenUsage: totalUsage,
      artifacts: store.list(),
    };
    if (runError !== undefined) {
      outcome.error = runError;
    }
    return outcome;
  }

  /** run 级 token 预算是否已超限（严格大于）。 */
  private isOverBudget(usage: TokenUsage): boolean {
    return this.tokenBudgetPerRun !== undefined && usage.totalTokens > this.tokenBudgetPerRun;
  }

  private budgetErrorMessage(usage: TokenUsage): string {
    const budget = this.tokenBudgetPerRun === undefined ? '未设置' : String(this.tokenBudgetPerRun);
    return `Run 级 token 预算超限: 已使用 ${usage.totalTokens} tokens（预算 ${budget} tokens），中止后续节点执行`;
  }

  /** 检查节点的依赖产物是否就绪（上游声明产物已产出、已登记产物文件都在盘上）。 */
  private async findMissingDependencies(node: DagNode, store: ArtifactStore): Promise<string[]> {
    const problems = new Set<string>();
    for (const depId of node.dependsOn) {
      const depNode = this.nodeById.get(depId);
      if (!depNode) {
        continue; // executionOrder 已校验依赖存在，防御性跳过
      }
      const refs = store.list(depId);
      const produced = new Set(refs.map((ref) => ref.name));
      for (const name of depNode.outputArtifacts) {
        if (!produced.has(name)) {
          problems.add(`上游节点 ${depId} 未产出声明的产物 ${name}`);
        }
      }
      for (const ref of refs) {
        const exists = await access(ref.path).then(
          () => true,
          () => false,
        );
        if (!exists) {
          problems.add(`上游节点 ${depId} 的产物文件缺失: ${ref.path}`);
        }
      }
    }
    return [...problems];
  }

  /** 断点续跑：把已成功节点的产物注册回 ArtifactStore，并把轨迹恢复进 recorder。 */
  private async restoreCarriedNode(
    nodeId: string,
    entry: SerializedNodeState,
    store: ArtifactStore,
    recorder: RunRecorder,
  ): Promise<void> {
    for (const artifact of entry.artifacts) {
      try {
        await store.register(nodeId, artifact.name, artifact.path);
      } catch (err) {
        throw new ExecutorError(
          `断点续跑失败：节点 ${nodeId} 的产物 ${artifact.name} 无法恢复（${artifact.path}）: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      recorder.restoreNode({
        nodeId,
        status: 'succeeded',
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        tokenUsage: entry.tokenUsage,
        steps: entry.stepRecords,
      });
    } catch (err) {
      throw new ExecutorError(
        `断点续跑失败：节点 ${nodeId} 的轨迹记录无法恢复: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 读取并校验 state.json；不存在时返回 null（全新执行）。 */
  private async loadState(runDir: string, taskId: string): Promise<WorkflowStateFile | null> {
    const statePath = path.join(runDir, STATE_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(statePath, 'utf8');
    } catch {
      return null;
    }

    const state = this.parseStateFile(raw);
    if (state.workflowId !== this.workflow.id) {
      throw new ExecutorError(
        `断点续跑校验失败：state.json 属于 workflow「${state.workflowId}」，` +
          `与当前 workflow「${this.workflow.id}」不一致，拒绝续跑`,
      );
    }
    const currentIds = this.order.map((node) => node.id);
    if (state.nodeIds.length !== currentIds.length || state.nodeIds.some((id, i) => id !== currentIds[i])) {
      throw new ExecutorError(
        `断点续跑校验失败：state.json 的节点列表 [${state.nodeIds.join(', ')}] ` +
          `与当前 workflow [${currentIds.join(', ')}] 不一致，拒绝续跑`,
      );
    }
    if (state.taskId !== taskId) {
      throw new ExecutorError(
        `断点续跑校验失败：state.json 属于任务「${state.taskId}」，` +
          `与当前任务「${taskId}」不一致，拒绝续跑`,
      );
    }
    return state;
  }

  /** 解析并校验 state.json 内容，格式非法时抛出 ExecutorError。 */
  private parseStateFile(raw: string): WorkflowStateFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ExecutorError(
        `state.json 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new ExecutorError('state.json 顶层必须是 JSON 对象');
    }
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== STATE_VERSION) {
      throw new ExecutorError(
        `state.json 版本不支持: ${JSON.stringify(record['version'])}（期望 ${STATE_VERSION}）`,
      );
    }
    if (typeof record['workflowId'] !== 'string') {
      throw new ExecutorError('state.json 缺少合法的 workflowId 字段');
    }
    if (
      !Array.isArray(record['nodeIds']) ||
      record['nodeIds'].some((id) => typeof id !== 'string')
    ) {
      throw new ExecutorError('state.json 缺少合法的 nodeIds 字段（字符串列表）');
    }
    if (typeof record['taskId'] !== 'string') {
      throw new ExecutorError('state.json 缺少合法的 taskId 字段');
    }
    if (!Array.isArray(record['completedNodes'])) {
      throw new ExecutorError('state.json 缺少合法的 completedNodes 字段（列表）');
    }

    const completedNodes = record['completedNodes'].map((entry, index): SerializedNodeState => {
      if (entry === null || typeof entry !== 'object') {
        throw new ExecutorError(`state.json completedNodes[${index}] 不是对象`);
      }
      const node = entry as Record<string, unknown>;
      if (typeof node['nodeId'] !== 'string') {
        throw new ExecutorError(`state.json completedNodes[${index}] 缺少合法的 nodeId 字段`);
      }
      if (node['status'] !== 'succeeded') {
        throw new ExecutorError(
          `state.json completedNodes[${index}]（${node['nodeId']}）的 status 只允许 succeeded`,
        );
      }
      if (!isTokenUsage(node['tokenUsage'])) {
        throw new ExecutorError(
          `state.json completedNodes[${index}]（${node['nodeId']}）缺少合法的 tokenUsage 字段`,
        );
      }
      if (!Array.isArray(node['artifacts'])) {
        throw new ExecutorError(
          `state.json completedNodes[${index}]（${node['nodeId']}）缺少合法的 artifacts 字段（列表）`,
        );
      }
      const artifacts = node['artifacts'].map((artifact, artifactIndex) => {
        if (artifact === null || typeof artifact !== 'object') {
          throw new ExecutorError(
            `state.json completedNodes[${index}].artifacts[${artifactIndex}] 不是对象`,
          );
        }
        const item = artifact as Record<string, unknown>;
        if (typeof item['name'] !== 'string' || typeof item['path'] !== 'string') {
          throw new ExecutorError(
            `state.json completedNodes[${index}].artifacts[${artifactIndex}] 缺少 name / path 字段`,
          );
        }
        return { name: item['name'], path: item['path'] };
      });

      const serialized: SerializedNodeState = {
        nodeId: node['nodeId'],
        status: 'succeeded',
        tokenUsage: { ...node['tokenUsage'] },
        steps: typeof node['steps'] === 'number' ? node['steps'] : 0,
        artifacts,
      };
      if (typeof node['startedAt'] === 'string') {
        serialized.startedAt = node['startedAt'];
      }
      if (typeof node['finishedAt'] === 'string') {
        serialized.finishedAt = node['finishedAt'];
      }
      if (Array.isArray(node['stepRecords'])) {
        serialized.stepRecords = node['stepRecords'] as SerializedStep[];
      }
      return serialized;
    });

    return {
      version: STATE_VERSION,
      workflowId: record['workflowId'],
      nodeIds: record['nodeIds'] as string[],
      taskId: record['taskId'],
      updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
      totalTokenUsage: isTokenUsage(record['totalTokenUsage'])
        ? { ...record['totalTokenUsage'] }
        : emptyTokenUsage(),
      completedNodes,
    };
  }

  /** 每个节点成功后把断点状态写入 `<runDir>/state.json`。 */
  private async persistState(
    runDir: string,
    taskId: string,
    completed: Map<string, SerializedNodeState>,
    totalUsage: TokenUsage,
  ): Promise<void> {
    const file: WorkflowStateFile = {
      version: STATE_VERSION,
      workflowId: this.workflow.id,
      nodeIds: this.order.map((node) => node.id),
      taskId,
      updatedAt: new Date().toISOString(),
      totalTokenUsage: totalUsage,
      completedNodes: [...completed.values()],
    };
    await writeFile(path.join(runDir, STATE_FILE_NAME), JSON.stringify(file, null, 2), 'utf8');
  }
}
