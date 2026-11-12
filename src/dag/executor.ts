import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactStore } from '../artifacts/store.js';
import type { ArtifactRef } from '../artifacts/store.js';
import { addTokenUsage, emptyTokenUsage } from '../tracing/recorder.js';
import type { RunRecorder, SerializedStep, TokenUsage } from '../tracing/recorder.js';
import { schemaForArtifact, validateArtifactFile } from '../artifacts/schemas.js';
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
  /** 失败终止原因：step_limit 表示达到 ReAct 步数上限（executor 据此做断点续跑而非普通重试）。 */
  stopReason?: 'step_limit';
  /** 本次执行实际使用的模型 ID（tracing 按节点记录模型与用量，#3 Phase B 模型分层）。 */
  model?: string;
}

/** 上一次尝试的失败反馈（executor 回灌给 runner，用于构造重试 / 续跑 prompt）。 */
export interface NodeAttemptFeedback {
  /** 失败类型：error = 一般失败（带错误重试）；step_limit = 步数耗尽（从断点续跑）。 */
  kind: 'error' | 'step_limit';
  /** 上一次尝试的错误信息（含产物 schema / 验证门问题清单）。 */
  message: string;
  /** 上一次尝试的序号（1 基）。 */
  attempt: number;
}

/**
 * 节点程序化验证门（契约单一来源）：节点 runner 成功且产物登记后调用，
 * 返回问题清单（空列表 = 通过）；非空时该节点按失败处理并触发重试。
 * 实现见 src/validate/gate.ts（execute 节点的任务输出文件确定性检查）。
 */
export type NodeOutputGateFn = (
  nodeId: string,
  declaredArtifacts: readonly string[],
  workspacePath: string,
) => Promise<string[]> | string[];

/** DagExecutor 传给 AgentRunner 的节点执行输入。 */
export interface AgentRunnerInput {
  taskId: string;
  /** 当前执行的节点 ID（如 inspect / plan / execute / verify / adjudicate）。 */
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
  /** 本次尝试序号（1 基）；节点重试 / 步数续跑时 >1。 */
  attempt?: number;
  /** 上一次尝试的失败反馈（重试 / 续跑时由 executor 回灌，runner 应据此调整行为）。 */
  previousFailure?: NodeAttemptFeedback;
  /** 本节点当前执行轮数（1 基，含本次；修复回路重跑时 >1，#3 Phase B）。 */
  executionRound?: number;
  /** 节点 prompt 风格（来自 workflow 定义；runner 据此选择 system prompt）。 */
  promptStyle?: 'baseline' | 'node' | 'challenger' | 'adjudicator';
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
  /**
   * 单节点单回最大尝试次数（首次 + 重试/续跑共用该预算，默认 2 = 至多重试或续跑 1 次）。
   * 触发条件：runner 异常、runner 返回失败（含步数耗尽）、产物登记失败、
   * 未产出声明产物、产物 schema 不合规、程序化验证门未通过。
   */
  maxAttemptsPerNode?: number;
  /** 节点成功后的程序化验证门（见 NodeOutputGateFn；未设置则不做门检查）。 */
  outputGate?: NodeOutputGateFn;
  /**
   * 跳过的节点集合（#4 Phase C 按路由跳过子图）：不执行、不要求产物，
   * 依赖透明传递——依赖跳过节点的节点改从跳过节点的上游取产物
   * （如 simple 路径跳过 plan 时，execute 直接读 inspect 的 data_profile.json）。
   */
  skipNodes?: readonly string[];
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

/** 修复回路收口信息（#3 Phase B）：写入 RunOutcome 与任务 summary，供归因与验收核查。 */
export interface RepairSummary {
  /** 实际执行的修复轮数（裁决 fix 且成功回炉 execute 的次数，跨断点续跑累计）。 */
  rounds: number;
  /** 修复轮次达到上限后仍被裁决 fix 时强制 accept 收口。 */
  forcedAccept: boolean;
  /** 裁决节点的最终决定（pass / fix / accept；无裁决节点时为 null）。 */
  lastDecision: string | null;
}

/** 一次任务运行的最终结果。 */
export interface RunOutcome {
  taskId: string;
  status: 'succeeded' | 'failed';
  /** 各节点执行记录（按 executionOrder 顺序；每节点一条最新状态，未执行为 pending）。 */
  nodeRuns: NodeRun[];
  /** 全部节点的 token 用量合计（断点续跑时包含历史用量）。 */
  tokenUsage: TokenUsage;
  /** 全部登记的节点产物。 */
  artifacts: ArtifactRef[];
  /** 修复回路收口信息（工作流无裁决节点时 rounds=0 / lastDecision=null）。 */
  repair: RepairSummary;
  error?: string;
}

/** Executor 层错误（断点状态非法、续跑校验失败等）。 */
export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorError';
  }
}

/** state.json 格式版本号（格式变更时递增；v2 起支持有界回路的断点续跑）。 */
const STATE_VERSION = 2;
/** 断点状态文件名。 */
const STATE_FILE_NAME = 'state.json';
/** 节点产物注册表根目录名。 */
const ARTIFACTS_DIR_NAME = 'artifacts';
/** 单节点 ReAct 步数默认上限（设计文档 3.3 护栏）。 */
const DEFAULT_MAX_STEPS_PER_NODE = 40;
/** 单节点默认最大尝试次数（首次 + 至多重试/续跑 1 次，#2 Phase A 失败策略）。 */
const DEFAULT_MAX_ATTEMPTS_PER_NODE = 2;

/** state.json 中单个已完成节点的记录（只持久化 succeeded 节点；回路重跑后可能是被取代的旧轮）。 */
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
  /** 该成功所属的执行轮数（1 基；回路重跑后旧轮记录保留以支撑回路产物恢复）。 */
  execution?: number;
}

/** runDir/state.json 的文件格式（v2：回路感知的断点状态）。 */
interface WorkflowStateFile {
  version: number;
  workflowId: string;
  /** 执行顺序中的节点 ID 列表（用于 workflow 一致性校验）。 */
  nodeIds: string[];
  taskId: string;
  updatedAt: string;
  totalTokenUsage: TokenUsage;
  completedNodes: SerializedNodeState[];
  /** 各节点累计成功执行轮数（回路感知；重跑在原轮数上累加，保证 2 轮上限跨进程成立）。 */
  nodeExecutions: Record<string, number>;
  /** 待回炉节点集合（裁决 fix 后待重跑的节点；逐个重跑成功后移除）。 */
  pendingReset: string[];
  /** 最近一次裁决（追溯用；回路机制状态以 pendingReset 为准）。 */
  lastDecision: { nodeId: string; decision: string } | null;
  /** 累计修复轮数（跨断点续跑累计）。 */
  repairRounds: number;
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
 * 串行 DAG Executor：按静态拓扑序调度节点，支持有界条件回路（#3 Phase B）。
 *
 * - 每个节点执行前检查依赖产物存在（静态依赖必须就绪；回路依赖 loopDependencies
 *   仅在重跑轮要求就绪——首轮执行时回路反馈产物尚不存在）；
 * - 节点结果产物注册进 ArtifactStore，并作为 downstream 的 upstreamArtifacts 传入；
 * - 裁决节点（声明 decisionArtifact + conditionalNext）成功后读取决策产物：
 *   decision 匹配某条条件边且目标节点未达执行上限时，回炉目标节点及其传递下游
 *   （有界回路）；目标已达上限时强制 accept 收口并记录；
 * - run 级 token 预算超限即中止并标记 failed（错误信息注明超预算）；
 * - 单个节点失败（重试后仍失败）即终止整个 run；
 * - 支持断点续跑：`<runDir>/state.json`（v2）记录已完成节点、各节点执行轮数、
 *   待回炉集合与修复轮数，重入时恢复现场并继续（含中间轮次的断点续跑）。
 */
export class DagExecutor {
  private readonly workflow: WorkflowDefinition;
  /** 校验并拓扑排序后的执行序列（静态边；回路依赖与条件回边不参与排序）。 */
  private readonly order: DagNode[];
  private readonly nodeById: Map<string, DagNode>;
  private readonly runner: AgentRunner;
  private readonly maxStepsPerNode: number;
  private readonly tokenBudgetPerRun: number | undefined;
  private readonly maxAttemptsPerNode: number;
  private readonly outputGate: NodeOutputGateFn | undefined;
  /** 跳过的节点集合（#4 Phase C）：不调度、依赖透明传递。 */
  private readonly skipNodes: ReadonlySet<string>;
  /** 各节点展开跳过节点后的有效静态依赖（跳过节点用其静态上游替换，传递展开）。 */
  private readonly effectiveStaticDeps: Map<string, string[]>;
  /** 各节点展开跳过节点后的有效回路依赖。 */
  private readonly effectiveLoopDeps: Map<string, string[]>;

  constructor(workflow: WorkflowDefinition, runner: AgentRunner, opts: DagExecutorOptions = {}) {
    this.workflow = workflow;
    // 非法工作流（重复 ID、未知依赖、静态环、回路字段非法）在构造期即抛 DagValidationError
    this.order = executionOrder(workflow);
    this.nodeById = new Map(this.order.map((node) => [node.id, node]));
    this.runner = runner;
    this.maxStepsPerNode = opts.maxStepsPerNode ?? DEFAULT_MAX_STEPS_PER_NODE;
    this.tokenBudgetPerRun = opts.tokenBudgetPerRun;
    this.maxAttemptsPerNode = Math.max(1, opts.maxAttemptsPerNode ?? DEFAULT_MAX_ATTEMPTS_PER_NODE);
    this.outputGate = opts.outputGate;
    this.skipNodes = new Set(opts.skipNodes ?? []);
    for (const nodeId of this.skipNodes) {
      if (!this.nodeById.has(nodeId)) {
        throw new ExecutorError(`skipNodes 引用了不存在的节点: ${nodeId}`);
      }
    }
    this.effectiveStaticDeps = new Map();
    this.effectiveLoopDeps = new Map();
    for (const node of this.order) {
      this.effectiveStaticDeps.set(node.id, this.expandDeps(node.dependsOn, new Set()));
      this.effectiveLoopDeps.set(node.id, this.expandDeps(node.loopDependencies ?? [], new Set()));
    }
  }

  /**
   * 依赖展开：被跳过的依赖节点用其静态上游替换（传递展开），实现子图跳过的依赖透明传递。
   * 跳过链（A 跳过、B 依赖 A 且 B 也跳过）逐层下沉到未跳过的上游；无上游时消解为空。
   */
  private expandDeps(depIds: readonly string[], visiting: Set<string>): string[] {
    const expanded: string[] = [];
    for (const depId of depIds) {
      if (!this.skipNodes.has(depId)) {
        expanded.push(depId);
        continue;
      }
      const depNode = this.nodeById.get(depId);
      if (depNode === undefined || visiting.has(depId)) {
        continue; // 防御：未知节点 / 跳过环（构造期已校验节点存在）
      }
      visiting.add(depId);
      expanded.push(...this.expandDeps(depNode.dependsOn, visiting));
      visiting.delete(depId);
    }
    return expanded;
  }

  /** 按依赖顺序调度执行整个工作流，返回 run 结果。 */
  async runTask(ctx: ExecutorTaskContext): Promise<RunOutcome> {
    const runDir = path.resolve(ctx.runDir);
    await mkdir(runDir, { recursive: true });
    const store = new ArtifactStore(path.join(runDir, ARTIFACTS_DIR_NAME));

    // 1. 读取断点状态（校验 workflow / taskId 一致），恢复已完成节点（含被回路取代的旧轮）
    //    的产物注册与轨迹，恢复各节点执行轮数、待回炉集合与修复轮数。
    const state = await this.loadState(runDir, ctx.taskId);
    const counts = new Map<string, number>(Object.entries(state?.nodeExecutions ?? {}));
    const completed = new Map<string, SerializedNodeState>();
    let totalUsage = state?.totalTokenUsage ?? emptyTokenUsage();
    for (const entry of state?.completedNodes ?? []) {
      await this.restoreCarriedNode(entry.nodeId, entry, store, ctx.recorder);
      completed.set(entry.nodeId, entry);
    }
    const pendingReset = new Set<string>(state?.pendingReset ?? []);
    let lastDecision = state?.lastDecision ?? null;
    let repairRounds = state?.repairRounds ?? 0;

    // 2. 待回炉集合中的节点不继承成功状态（需要重跑）；其余断点节点直接继承
    const doneOk = new Set<string>();
    for (const nodeId of completed.keys()) {
      if (!pendingReset.has(nodeId)) {
        doneOk.add(nodeId);
      }
    }

    const nodeRunsByNode = new Map<string, NodeRun>();
    let failed = false;
    let budgetExceeded = false;
    let forcedAccept = false;
    let runError: string | undefined;
    let executedThisProcess = 0;

    // 3. 调度主循环：每轮取静态拓扑序中第一个可执行节点（未完成、未达执行上限、依赖就绪）。
    //    拓扑序保证「依赖缺失的节点一定先于依赖它的节点被扫到」，因此首个依赖缺失的
    //    待执行节点即真实失败（与 Phase A 失败语义一致）。
    scheduler: for (;;) {
      let candidate: DagNode | null = null;
      let stallNode: DagNode | null = null;
      let stallError = '';
      for (const node of this.order) {
        if (this.skipNodes.has(node.id)) {
          continue; // #4 Phase C 按路由跳过的子图节点：不调度（nodeRuns 记 skipped）
        }
        if (doneOk.has(node.id)) {
          continue;
        }
        const count = counts.get(node.id) ?? 0;
        if (count >= this.maxExecutionsOf(node)) {
          continue; // 已达执行上限（回路体节点）：不再调度，等待收口或终止
        }
        const missing = await this.findMissingDependencies(node, store, count);
        if (missing.length > 0) {
          stallNode = node;
          stallError = `节点 ${node.id} 的依赖产物缺失: ${missing.join('; ')}`;
          break;
        }
        candidate = node;
        break;
      }

      if (candidate === null) {
        if (stallNode !== null) {
          // 依赖无法满足且无其他可执行节点：按失败终止（与 Phase A 依赖检查失败语义一致）
          ctx.recorder.startNode(stallNode.id);
          ctx.recorder.endNode('failed', stallError);
          const now = new Date().toISOString();
          nodeRunsByNode.set(stallNode.id, {
            nodeId: stallNode.id,
            status: 'failed',
            startedAt: now,
            finishedAt: now,
            error: stallError,
            ...(counts.get(stallNode.id) !== undefined ? { executions: counts.get(stallNode.id) } : {}),
          });
          failed = true;
          runError = stallError;
        }
        break scheduler;
      }

      // 4. run 级 token 预算检查：超限即中止后续节点（错误信息注明超预算）
      if (this.isOverBudget(totalUsage)) {
        budgetExceeded = true;
        runError = this.budgetErrorMessage(totalUsage);
        break scheduler;
      }

      // 5. 执行节点（含失败重试与步数耗尽续跑：单回最多 maxAttempts 次尝试，
      //    每次尝试的错误反馈回灌给 runner；产物登记 / 声明产物 / schema / 验证门
      //    任一不通过都按本次尝试失败处理）
      const startedAt = new Date().toISOString();
      const round = (counts.get(candidate.id) ?? 0) + 1;
      let previousFailure: NodeAttemptFeedback | undefined;
      let attempts = 0;
      let attemptUsage = emptyTokenUsage();
      let lastResult: NodeRunResult | null = null;
      let lastFinishedAt = startedAt;
      while (attempts < this.maxAttemptsPerNode) {
        attempts += 1;
        ctx.recorder.startNode(candidate.id);
        const rawResult = await this.invokeRunner(candidate, ctx, store, runDir, attempts, round, previousFailure);
        const result = await this.finalizeSuccess(candidate, store, rawResult, ctx.workspacePath);
        lastFinishedAt = new Date().toISOString();
        ctx.recorder.endNode(result.status, result.error, result.model);
        lastResult = result;
        attemptUsage = addTokenUsage(attemptUsage, result.tokenUsage);
        if (result.status === 'succeeded') {
          break;
        }
        previousFailure = {
          kind: result.stopReason === 'step_limit' ? 'step_limit' : 'error',
          message: result.error ?? '未知错误',
          attempt: attempts,
        };
      }
      const result = lastResult as NodeRunResult;
      executedThisProcess += 1;
      totalUsage = addTokenUsage(totalUsage, attemptUsage);

      if (result.status !== 'succeeded') {
        // 6a. 本回重试后仍失败：终止整个 run（累计用量含失败尝试，便于成本归因）
        nodeRunsByNode.set(candidate.id, {
          nodeId: candidate.id,
          status: 'failed',
          startedAt,
          finishedAt: lastFinishedAt,
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(attempts > 1 ? { attempts } : {}),
          ...(round > 1 ? { executions: round } : {}),
        });
        failed = true;
        const retryNote = attempts > 1 ? `（已重试 ${attempts - 1} 次）` : '';
        runError = `节点 ${candidate.id} 失败${retryNote}: ${result.error ?? '未知错误'}`;
        break scheduler;
      }

      // 6b. 本回成功：更新轮数、完成状态与 nodeRuns 记录
      counts.set(candidate.id, round);
      doneOk.add(candidate.id);
      pendingReset.delete(candidate.id);
      nodeRunsByNode.set(candidate.id, {
        nodeId: candidate.id,
        status: 'succeeded',
        startedAt,
        finishedAt: lastFinishedAt,
        ...(attempts > 1 ? { attempts } : {}),
        ...(round > 1 ? { executions: round } : {}),
      });

      // 7. 裁决评估（#3 Phase B 有界回路）：决策产物匹配条件边时回炉目标子图
      if (candidate.decisionArtifact !== undefined) {
        const decision = await this.readDecisionArtifact(candidate, store);
        if (decision !== null) {
          lastDecision = { nodeId: candidate.id, decision };
          ctx.recorder.recordStep({
            kind: 'observation',
            name: 'decision',
            content: `[executor] 节点 ${candidate.id} 裁决结果: ${decision}（第 ${round} 轮）`,
          });
          const edge = candidate.conditionalNext?.find((item) => item.when === decision);
          const target = edge !== undefined ? this.nodeById.get(edge.goto) : undefined;
          if (edge !== undefined && target !== undefined) {
            if ((counts.get(target.id) ?? 0) < this.maxExecutionsOf(target)) {
              // 回炉：目标节点及其传递下游全部重跑（有界回路；旧轮成功记录保留以支撑产物恢复）
              const resetSet = this.resetSetFor(target.id);
              doneOk.clear();
              for (const [nodeId] of completed) {
                if (!resetSet.has(nodeId)) {
                  doneOk.add(nodeId);
                }
              }
              pendingReset.clear();
              for (const nodeId of resetSet) {
                pendingReset.add(nodeId);
              }
              repairRounds += 1;
            } else {
              // 修复轮次已达上限：强制 accept 收口并记录（保留当前产物，不再回炉）
              forcedAccept = true;
              ctx.recorder.recordStep({
                kind: 'observation',
                name: 'loop_bound',
                content:
                  `[executor] 节点 ${target.id} 已达修复轮次上限（${repairRounds} 轮），` +
                  '按 accept 保留当前结果并收口',
              });
            }
          }
        }
      }

      // 8. 持久化断点状态（产物已在 finalizeSuccess 登记；旧轮成功记录保留以支撑回路产物恢复）
      completed.set(candidate.id, {
        nodeId: candidate.id,
        status: 'succeeded',
        startedAt,
        finishedAt: lastFinishedAt,
        tokenUsage: attemptUsage,
        steps: result.steps,
        artifacts: store.list(candidate.id).map((ref) => ({ name: ref.name, path: ref.path })),
        stepRecords: ctx.recorder.nodeRecord(candidate.id)?.steps,
        execution: round,
      });
      await this.persistState(
        runDir,
        ctx.taskId,
        completed,
        totalUsage,
        counts,
        pendingReset,
        lastDecision,
        repairRounds,
      );
    }

    // 9. 最后一个节点执行完也可能已超预算（后面没有节点可以触发预算拦截）
    if (!budgetExceeded && !failed && executedThisProcess > 0 && this.isOverBudget(totalUsage)) {
      budgetExceeded = true;
      runError = this.budgetErrorMessage(totalUsage);
    }

    // 10. 汇总 nodeRuns（按执行序输出；未执行的节点补 pending 记录，保证覆盖整个 workflow）
    const nodeRuns: NodeRun[] = [];
    for (const node of this.order) {
      if (this.skipNodes.has(node.id)) {
        nodeRuns.push({ nodeId: node.id, status: 'skipped' });
        continue;
      }
      const run = nodeRunsByNode.get(node.id);
      if (run !== undefined) {
        nodeRuns.push(run);
        continue;
      }
      const carried = completed.get(node.id);
      if (doneOk.has(node.id) && carried !== undefined) {
        nodeRuns.push({
          nodeId: node.id,
          status: 'succeeded',
          ...(carried.startedAt !== undefined ? { startedAt: carried.startedAt } : {}),
          ...(carried.finishedAt !== undefined ? { finishedAt: carried.finishedAt } : {}),
          ...(this.nonZeroExecution(counts.get(node.id)) !== undefined
            ? { executions: this.nonZeroExecution(counts.get(node.id)) }
            : {}),
        });
        continue;
      }
      nodeRuns.push({
        nodeId: node.id,
        status: 'pending',
        ...(this.nonZeroExecution(counts.get(node.id)) !== undefined
          ? { executions: this.nonZeroExecution(counts.get(node.id)) }
          : {}),
      });
    }

    const status: 'succeeded' | 'failed' = !failed && !budgetExceeded ? 'succeeded' : 'failed';
    const outcome: RunOutcome = {
      taskId: ctx.taskId,
      status,
      nodeRuns,
      tokenUsage: totalUsage,
      artifacts: store.list(),
      repair: {
        rounds: repairRounds,
        forcedAccept,
        lastDecision: lastDecision?.decision ?? null,
      },
    };
    if (runError !== undefined) {
      outcome.error = runError;
    }
    return outcome;
  }

  /** 节点最大执行次数（未声明时为 1）。 */
  private maxExecutionsOf(node: DagNode): number {
    return node.maxExecutions ?? 1;
  }

  /** executionCount 的非空非零视图（0 视为未执行，不写入记录）。 */
  private nonZeroExecution(count: number | undefined): number | undefined {
    return count !== undefined && count > 0 ? count : undefined;
  }

  /**
   * 回炉重置集合：目标节点 + 经有效静态/回路依赖可传递到达它的全部下游节点
   * （它们的输入随目标节点重跑而失效，需要一并重跑）。
   */
  private resetSetFor(targetId: string): Set<string> {
    const set = new Set<string>([targetId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of this.order) {
        if (set.has(node.id)) {
          continue;
        }
        const deps = [
          ...(this.effectiveStaticDeps.get(node.id) ?? []),
          ...(this.effectiveLoopDeps.get(node.id) ?? []),
        ];
        if (deps.some((dep) => set.has(dep))) {
          set.add(node.id);
          grew = true;
        }
      }
    }
    return set;
  }

  /** 读取裁决节点的决策产物 JSON 中的 decision 字段；缺失或非法时返回 null（不触发条件边）。 */
  private async readDecisionArtifact(node: DagNode, store: ArtifactStore): Promise<string | null> {
    const name = node.decisionArtifact;
    if (name === undefined) {
      return null;
    }
    const ref = store.list(node.id).find((item) => item.name === name);
    if (ref === undefined) {
      return null;
    }
    let raw: string;
    try {
      raw = await readFile(ref.path, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { decision?: unknown };
      return typeof parsed.decision === 'string' ? parsed.decision : null;
    } catch {
      return null;
    }
  }

  /** run 级 token 预算是否已超限（严格大于）。 */
  private isOverBudget(usage: TokenUsage): boolean {
    return this.tokenBudgetPerRun !== undefined && usage.totalTokens > this.tokenBudgetPerRun;
  }

  private budgetErrorMessage(usage: TokenUsage): string {
    const budget = this.tokenBudgetPerRun === undefined ? '未设置' : String(this.tokenBudgetPerRun);
    return `Run 级 token 预算超限: 已使用 ${usage.totalTokens} tokens（预算 ${budget} tokens），中止后续节点执行`;
  }

  /**
   * 调用 AgentRunner 执行一次节点尝试；runner 抛出的异常按失败结果处理。
   * attempt > 1 时透传上一次尝试的失败反馈（runner 据此构造重试 / 续跑 prompt）；
   * executionRound > 1 表示修复回路重跑轮（runner 可据此切换修复应答行为）。
   */
  private async invokeRunner(
    node: DagNode,
    ctx: ExecutorTaskContext,
    store: ArtifactStore,
    runDir: string,
    attempt: number,
    executionRound: number,
    previousFailure: NodeAttemptFeedback | undefined,
  ): Promise<NodeRunResult> {
    try {
      return await this.runner.run({
        taskId: ctx.taskId,
        nodeId: node.id,
        question: ctx.question,
        workspacePath: ctx.workspacePath,
        nodeTask: node.task,
        upstreamArtifacts: this.upstreamArtifactsFor(node, store, executionRound),
        maxSteps: this.maxStepsPerNode,
        runDir,
        recorder: ctx.recorder,
        attempt,
        executionRound,
        ...(node.promptStyle !== undefined ? { promptStyle: node.promptStyle } : {}),
        ...(previousFailure !== undefined ? { previousFailure } : {}),
      });
    } catch (err) {
      return {
        status: 'failed',
        artifacts: [],
        tokenUsage: emptyTokenUsage(),
        steps: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 节点的上游产物：有效静态依赖（dependsOn 展开跳过节点）始终计入；有效回路依赖
   * （loopDependencies 展开跳过节点）仅从第 2 轮执行起计入（首轮执行时回路反馈产物
   * 尚不存在，依赖检查同样放行）。
   */
  private upstreamArtifactsFor(node: DagNode, store: ArtifactStore, executionRound: number): ArtifactRef[] {
    const depIds = executionRound > 1
      ? [...(this.effectiveStaticDeps.get(node.id) ?? []), ...(this.effectiveLoopDeps.get(node.id) ?? [])]
      : (this.effectiveStaticDeps.get(node.id) ?? []);
    return depIds.flatMap((dep) => store.list(dep));
  }

  /**
   * 节点成功结果的确定性收口：产物登记 → 声明产物核对 → 结构化 schema 校验 →
   * 程序化验证门。任一环节不通过都把成功结果改写为失败结果（触发重试），
   * 不让坏产物进入注册表、也不把机械错误留给 LLM verify 或下游节点。
   */
  private async finalizeSuccess(
    node: DagNode,
    store: ArtifactStore,
    result: NodeRunResult,
    workspacePath: string,
  ): Promise<NodeRunResult> {
    if (result.status !== 'succeeded') {
      return result;
    }
    const asFailure = (error: string): NodeRunResult => ({
      status: 'failed',
      artifacts: [],
      tokenUsage: result.tokenUsage,
      steps: result.steps,
      ...(result.model !== undefined ? { model: result.model } : {}),
      error,
    });

    // a) 产物登记：runner 声称成功但产物文件不可用时按失败处理（不让坏引用进入注册表）
    try {
      for (const artifact of result.artifacts) {
        await store.register(node.id, artifact.name, artifact.path);
      }
    } catch (err) {
      return asFailure(`产物登记失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // b) 声明产物核对：节点必须产出 workflow 声明的全部产物（strategy_3 类失败的根因修复）
    const produced = new Set(store.list(node.id).map((ref) => ref.name));
    const missingDeclared = node.outputArtifacts.filter((name) => !produced.has(name));
    if (missingDeclared.length > 0) {
      return asFailure(`节点未产出声明产物: ${missingDeclared.join('; ')}`);
    }

    // c) 结构化 schema 校验：关键 Artifact（data_profile / analysis_plan / challenge_list /
    //    verdict）必须有下游可消费的结构
    const schemaProblems: string[] = [];
    for (const ref of store.list(node.id)) {
      const schemaId = schemaForArtifact(ref.name);
      if (schemaId === null) {
        continue;
      }
      for (const problem of await validateArtifactFile(schemaId, ref.path)) {
        schemaProblems.push(`${ref.name}: ${problem}`);
      }
    }
    if (schemaProblems.length > 0) {
      return asFailure(`产物不符合结构化 schema: ${schemaProblems.join('; ')}`);
    }

    // d) 程序化验证门：任务输出文件的存在性 / 非空 / 格式检查（0 token）
    if (this.outputGate !== undefined) {
      const gateProblems = await this.outputGate(node.id, node.outputArtifacts, workspacePath);
      if (gateProblems.length > 0) {
        return asFailure(`程序化验证门未通过: ${gateProblems.join('; ')}`);
      }
    }

    return result;
  }

  /**
   * 检查节点的依赖产物是否就绪。有效静态依赖始终检查；有效回路依赖
   * （loopDependencies 展开跳过节点）仅在重跑轮（executionCount >= 1）检查。
   * 检查内容：上游声明产物已产出、已登记产物文件都在盘上。
   */
  private async findMissingDependencies(
    node: DagNode,
    store: ArtifactStore,
    executionCount: number,
  ): Promise<string[]> {
    const depIds = executionCount >= 1
      ? [...(this.effectiveStaticDeps.get(node.id) ?? []), ...(this.effectiveLoopDeps.get(node.id) ?? [])]
      : (this.effectiveStaticDeps.get(node.id) ?? []);
    const problems = new Set<string>();
    for (const depId of depIds) {
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

  /** 断点续跑：把已成功节点（含被回路取代的旧轮）的产物注册回 ArtifactStore，并恢复轨迹。 */
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
        `state.json 版本不支持: ${JSON.stringify(record['version'])}（期望 ${STATE_VERSION}，` +
          '旧版本断点状态与回路语义不兼容，请重跑该任务）',
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
    if (
      record['nodeExecutions'] !== undefined &&
      (record['nodeExecutions'] === null ||
        typeof record['nodeExecutions'] !== 'object' ||
        Array.isArray(record['nodeExecutions']) ||
        Object.values(record['nodeExecutions'] as Record<string, unknown>).some(
          (v) => typeof v !== 'number' || !Number.isInteger(v) || v < 0,
        ))
    ) {
      throw new ExecutorError('state.json 的 nodeExecutions 字段非法（须为 nodeId → 非负整数映射）');
    }
    if (
      record['pendingReset'] !== undefined &&
      (!Array.isArray(record['pendingReset']) || record['pendingReset'].some((id) => typeof id !== 'string'))
    ) {
      throw new ExecutorError('state.json 的 pendingReset 字段非法（须为字符串列表）');
    }
    if (
      record['lastDecision'] !== undefined &&
      record['lastDecision'] !== null &&
      (typeof record['lastDecision'] !== 'object' ||
        typeof (record['lastDecision'] as Record<string, unknown>)['nodeId'] !== 'string' ||
        typeof (record['lastDecision'] as Record<string, unknown>)['decision'] !== 'string')
    ) {
      throw new ExecutorError('state.json 的 lastDecision 字段非法（须含 nodeId 与 decision 字符串）');
    }
    if (
      record['repairRounds'] !== undefined &&
      (typeof record['repairRounds'] !== 'number' || !Number.isInteger(record['repairRounds']) || record['repairRounds'] < 0)
    ) {
      throw new ExecutorError('state.json 的 repairRounds 字段非法（须为非负整数）');
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
      if (typeof node['execution'] === 'number' && Number.isInteger(node['execution']) && node['execution'] > 0) {
        serialized.execution = node['execution'];
      }
      return serialized;
    });

    const nodeExecutions: Record<string, number> = {};
    for (const [key, value] of Object.entries((record['nodeExecutions'] as Record<string, number>) ?? {})) {
      nodeExecutions[key] = value;
    }

    const lastDecisionRecord = record['lastDecision'] as Record<string, unknown> | null | undefined;
    const lastDecision =
      lastDecisionRecord !== undefined && lastDecisionRecord !== null
        ? {
            nodeId: lastDecisionRecord['nodeId'] as string,
            decision: lastDecisionRecord['decision'] as string,
          }
        : null;

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
      nodeExecutions,
      pendingReset: Array.isArray(record['pendingReset']) ? (record['pendingReset'] as string[]) : [],
      lastDecision,
      repairRounds: typeof record['repairRounds'] === 'number' ? record['repairRounds'] : 0,
    };
  }

  /** 每个节点成功后把断点状态写入 `<runDir>/state.json`（v2：含回路状态）。 */
  private async persistState(
    runDir: string,
    taskId: string,
    completed: Map<string, SerializedNodeState>,
    totalUsage: TokenUsage,
    counts: Map<string, number>,
    pendingReset: ReadonlySet<string>,
    lastDecision: { nodeId: string; decision: string } | null,
    repairRounds: number,
  ): Promise<void> {
    const nodeExecutions: Record<string, number> = {};
    for (const [nodeId, count] of counts) {
      if (count > 0) {
        nodeExecutions[nodeId] = count;
      }
    }
    const file: WorkflowStateFile = {
      version: STATE_VERSION,
      workflowId: this.workflow.id,
      nodeIds: this.order.map((node) => node.id),
      taskId,
      updatedAt: new Date().toISOString(),
      totalTokenUsage: totalUsage,
      completedNodes: [...completed.values()],
      nodeExecutions,
      pendingReset: [...pendingReset],
      lastDecision,
      repairRounds,
    };
    await writeFile(path.join(runDir, STATE_FILE_NAME), JSON.stringify(file, null, 2), 'utf8');
  }
}
