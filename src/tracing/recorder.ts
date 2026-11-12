import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 单次 LLM 调用（或一个节点 / 整个 run）的 token 用量。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type StepKind = 'thought' | 'tool_call' | 'observation';

/** Agent 执行过程中的一步（ReAct 的 thought / tool_call / observation）。 */
export interface StepRecord {
  kind: StepKind;
  /** 工具名或动作名（可选）。 */
  name?: string;
  /** 步骤内容：thought 文本、工具调用代码或观察结果。 */
  content: string;
  /** 本步 LLM 调用的 token 用量（observation 步通常没有）。 */
  tokenUsage?: TokenUsage;
}

/** 序列化后的步骤快照（含时间戳），用于 state.json 持久化与断点续跑恢复。 */
export interface SerializedStep {
  kind: StepKind;
  name?: string;
  content: string;
  tokenUsage?: TokenUsage;
  /** 记录时间（ISO 8601）。 */
  at: string;
}

/** 节点轨迹快照：nodeRecord 的返回值，restoreNode 的输入格式。 */
export interface NodeTraceSnapshot {
  nodeId: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** 该节点执行使用的模型 ID（#3 Phase B 模型分层；runner 回报，endNode 时写入）。 */
  model?: string;
  tokenUsage: TokenUsage;
  steps: SerializedStep[];
}

/** endRun 的汇总信息（status / error 进入 writeSummary，result / resultFiles 进入 result.json 顶层）。 */
export interface RunEndInfo {
  status?: 'succeeded' | 'failed';
  error?: string;
  /** 最终结果描述（写入 result.json 顶层 result 字段）。 */
  result?: string;
  /** 产出 / 变更的文件清单（写入 result.json 顶层 result_files 字段）。 */
  resultFiles?: { added_files: string[]; changed_files: string[] };
  /**
   * 附加任务级信息（原样并入 writeSummary 输出顶层）：如 #3 Phase B 的修复回路收口
   * （repair）与 #4 Phase C 的路由决策（routing）。
   */
  extras?: Record<string, unknown>;
}

/** 轨迹记录器的调用顺序非法（未 startNode 就 endNode 等）时抛出。 */
export class RecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderError';
  }
}

/** 全零 token 用量。 */
export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/** 两个 token 用量相加。 */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** 内部步骤记录：SerializedStep + 归属节点。 */
interface RecordedStep extends SerializedStep {
  nodeId: string | null;
}

interface RunMeta {
  experimentId: string;
  system: string;
  taskId: string;
}

/** 校验 token 用量字段为非负有限数字，非法时抛出。 */
function assertValidUsage(usage: TokenUsage, context: string): void {
  const fields = ['inputTokens', 'outputTokens', 'totalTokens'] as const;
  for (const field of fields) {
    const value = usage[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RecorderError(`${context} 的 tokenUsage.${field} 不是合法的非负数字: ${String(value)}`);
    }
  }
}

function isStepKind(value: unknown): value is StepKind {
  return value === 'thought' || value === 'tool_call' || value === 'observation';
}

function serializeStep(step: StepRecord, at: string): SerializedStep {
  const serialized: SerializedStep = { kind: step.kind, content: step.content, at };
  if (step.name !== undefined) {
    serialized.name = step.name;
  }
  if (step.tokenUsage !== undefined) {
    serialized.tokenUsage = step.tokenUsage;
  }
  return serialized;
}

function snapshotNode(trace: NodeTraceSnapshot): NodeTraceSnapshot {
  const snapshot: NodeTraceSnapshot = {
    nodeId: trace.nodeId,
    status: trace.status,
    startedAt: trace.startedAt,
    tokenUsage: { ...trace.tokenUsage },
    steps: trace.steps.map((step) => ({ ...step })),
  };
  if (trace.finishedAt !== undefined) {
    snapshot.finishedAt = trace.finishedAt;
  }
  if (trace.error !== undefined) {
    snapshot.error = trace.error;
  }
  if (trace.model !== undefined) {
    snapshot.model = trace.model;
  }
  return snapshot;
}

/** 官方 result.json 的 usage 字段格式（snake_case）。 */
function toOfficialUsage(usage: TokenUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
}

/** 计算相对 startMs 的秒数，保留 3 位小数，时间异常时截断为 0。 */
function elapsedSeconds(startMs: number, at: string): number {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(startMs) || !Number.isFinite(timestamp)) {
    return 0;
  }
  const seconds = Math.max(0, (timestamp - startMs) / 1000);
  return Math.round(seconds * 1000) / 1000;
}

/** 两个 ISO 时间戳之间的毫秒数，结束时间缺失时返回 null。 */
function elapsedMsBetween(startedAt: string, finishedAt?: string): number | null {
  if (finishedAt === undefined) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.max(0, end - start);
}

/**
 * Run 级轨迹与用量记录器。
 *
 * 职责（设计文档 5 节）：
 * - 记录 Agent 的 ReAct 步骤（thought / tool_call / observation）；
 * - 每次记录步骤时累计 LLM token 用量（按节点与整个 run 汇总）；
 * - 写出 AgenticDataBench 官方 Evaluator 兼容的 `dabench/result.json`；
 * - 写出 run 级汇总 JSON（各节点状态 / 耗时 / token、总 token、错误信息）。
 *
 * 生命周期：startRun → (startNode → recordStep... → endNode)* → endRun。
 */
export class RunRecorder {
  private runMeta: RunMeta | null = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private endInfo: RunEndInfo | null = null;
  /** 节点轨迹（按发生顺序，含续跑恢复的历史节点）。 */
  private readonly nodes: NodeTraceSnapshot[] = [];
  private current: NodeTraceSnapshot | null = null;
  /** 全部步骤（按发生顺序，跨节点）。 */
  private readonly steps: RecordedStep[] = [];
  private totalUsage: TokenUsage = emptyTokenUsage();

  /** 标记一次 run 开始（experimentId / system / taskId 用于汇总输出）。 */
  startRun(experimentId: string, system: string, taskId: string): void {
    if (typeof experimentId !== 'string' || typeof system !== 'string' || typeof taskId !== 'string') {
      throw new RecorderError('startRun 的 experimentId / system / taskId 必须是字符串');
    }
    this.runMeta = { experimentId, system, taskId };
    // 首次调用记录 run 开始时间，保证 elapsed 单调
    this.startedAt ??= new Date().toISOString();
  }

  /** 标记一个节点开始执行；上一节点未结束时抛错。 */
  startNode(nodeId: string): void {
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new RecorderError('startNode 的 nodeId 不能为空');
    }
    if (this.current) {
      throw new RecorderError(`节点 ${this.current.nodeId} 尚未结束，不能开始节点 ${nodeId}`);
    }
    const trace: NodeTraceSnapshot = {
      nodeId,
      status: 'running',
      startedAt: new Date().toISOString(),
      tokenUsage: emptyTokenUsage(),
      steps: [],
    };
    this.nodes.push(trace);
    this.current = trace;
  }

  /** 记录一步 Agent 行为；带 tokenUsage 时同时累计到当前节点与整个 run。 */
  recordStep(step: StepRecord): void {
    if (step === null || typeof step !== 'object') {
      throw new RecorderError('recordStep 需要一个步骤对象');
    }
    if (!isStepKind(step.kind)) {
      throw new RecorderError(
        `recordStep 的 kind 必须是 thought / tool_call / observation: ${JSON.stringify(step.kind)}`,
      );
    }
    if (typeof step.content !== 'string') {
      throw new RecorderError(`recordStep 的 content 必须是字符串（kind=${step.kind}）`);
    }
    if (step.name !== undefined && typeof step.name !== 'string') {
      throw new RecorderError('recordStep 的 name 必须是字符串');
    }
    if (step.tokenUsage !== undefined) {
      assertValidUsage(step.tokenUsage, `步骤（kind=${step.kind}）`);
    }

    const serialized = serializeStep(step, new Date().toISOString());
    this.steps.push({ ...serialized, nodeId: this.current ? this.current.nodeId : null });
    if (this.current) {
      this.current.steps.push(serialized);
      if (step.tokenUsage !== undefined) {
        this.current.tokenUsage = addTokenUsage(this.current.tokenUsage, step.tokenUsage);
      }
    }
    if (step.tokenUsage !== undefined) {
      this.totalUsage = addTokenUsage(this.totalUsage, step.tokenUsage);
    }
  }

  /** 标记当前节点结束；status 为 succeeded / failed，失败时传入 error；meta.model 记录该节点使用的模型。 */
  endNode(status: 'succeeded' | 'failed', error?: string, model?: string): void {
    if (status !== 'succeeded' && status !== 'failed') {
      throw new RecorderError(`endNode 的 status 必须是 succeeded / failed: ${JSON.stringify(status)}`);
    }
    if (!this.current) {
      throw new RecorderError('endNode 前必须先 startNode');
    }
    if (error !== undefined && typeof error !== 'string') {
      throw new RecorderError('endNode 的 error 必须是字符串');
    }
    if (model !== undefined && typeof model !== 'string') {
      throw new RecorderError('endNode 的 model 必须是字符串');
    }
    this.current.status = status;
    this.current.finishedAt = new Date().toISOString();
    if (error !== undefined) {
      this.current.error = error;
    }
    if (model !== undefined) {
      this.current.model = model;
    }
    this.current = null;
  }

  /** 标记整个 run 结束，记录最终状态与错误信息。 */
  endRun(summary: RunEndInfo = {}): void {
    if (summary === null || typeof summary !== 'object') {
      throw new RecorderError('endRun 的 summary 必须是对象');
    }
    if (summary.status !== undefined && summary.status !== 'succeeded' && summary.status !== 'failed') {
      throw new RecorderError(`endRun 的 status 必须是 succeeded / failed: ${JSON.stringify(summary.status)}`);
    }
    if (summary.error !== undefined && typeof summary.error !== 'string') {
      throw new RecorderError('endRun 的 error 必须是字符串');
    }
    if (summary.result !== undefined && typeof summary.result !== 'string') {
      throw new RecorderError('endRun 的 result 必须是字符串');
    }
    if (
      summary.extras !== undefined &&
      (summary.extras === null || typeof summary.extras !== 'object' || Array.isArray(summary.extras))
    ) {
      throw new RecorderError('endRun 的 extras 必须是对象');
    }
    this.endInfo = { ...summary };
    this.finishedAt = new Date().toISOString();
  }

  /** 整个 run 累计 token 用量（含断点续跑恢复的历史用量）。 */
  getTotalTokenUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  /** 指定节点的累计 token 用量（同一节点多次执行时求和）。 */
  getNodeTokenUsage(nodeId: string): TokenUsage {
    let usage = emptyTokenUsage();
    for (const trace of this.nodes) {
      if (trace.nodeId === nodeId) {
        usage = addTokenUsage(usage, trace.tokenUsage);
      }
    }
    return usage;
  }

  /** 全部节点轨迹快照（按发生顺序）。 */
  listNodes(): NodeTraceSnapshot[] {
    return this.nodes.map(snapshotNode);
  }

  /** 指定节点的轨迹快照；同一节点多次执行时返回最后一次，不存在时返回 null。 */
  nodeRecord(nodeId: string): NodeTraceSnapshot | null {
    for (let i = this.nodes.length - 1; i >= 0; i -= 1) {
      const trace = this.nodes[i];
      if (trace && trace.nodeId === nodeId) {
        return snapshotNode(trace);
      }
    }
    return null;
  }

  /**
   * 断点续跑：把上个进程持久化的节点记录恢复进当前轨迹（含步骤与 token 用量），
   * 使 writeResultJson / writeSummary 能输出跨进程的完整信息。
   * 不改变当前执行节点，恢复的节点状态只能是 succeeded / failed。
   */
  restoreNode(snapshot: {
    nodeId: string;
    status: 'succeeded' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    tokenUsage?: TokenUsage;
    steps?: SerializedStep[];
  }): void {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new RecorderError('restoreNode 需要一个节点记录对象');
    }
    if (typeof snapshot.nodeId !== 'string' || snapshot.nodeId.length === 0) {
      throw new RecorderError('restoreNode 的 nodeId 不能为空');
    }
    if (snapshot.status !== 'succeeded' && snapshot.status !== 'failed') {
      throw new RecorderError(`restoreNode 的 status 必须是 succeeded / failed: ${JSON.stringify(snapshot.status)}`);
    }

    const now = new Date().toISOString();
    const trace: NodeTraceSnapshot = {
      nodeId: snapshot.nodeId,
      status: snapshot.status,
      startedAt: snapshot.startedAt ?? now,
      tokenUsage: emptyTokenUsage(),
      steps: [],
    };
    if (snapshot.finishedAt !== undefined) {
      trace.finishedAt = snapshot.finishedAt;
    }
    if (snapshot.error !== undefined) {
      trace.error = snapshot.error;
    }

    for (const step of snapshot.steps ?? []) {
      if (step === null || typeof step !== 'object' || !isStepKind(step.kind)) {
        throw new RecorderError(
          `节点 ${snapshot.nodeId} 的恢复步骤 kind 非法: ${JSON.stringify(step)}`,
        );
      }
      if (typeof step.content !== 'string') {
        throw new RecorderError(`节点 ${snapshot.nodeId} 的恢复步骤 content 必须是字符串`);
      }
      const serialized = serializeStep(step, typeof step.at === 'string' && step.at.length > 0 ? step.at : now);
      trace.steps.push(serialized);
      this.steps.push({ ...serialized, nodeId: snapshot.nodeId });
    }

    trace.tokenUsage = snapshot.tokenUsage ?? sumStepUsage(trace.steps);
    this.nodes.push(trace);
    this.totalUsage = addTokenUsage(this.totalUsage, trace.tokenUsage);
  }

  /**
   * 写出 AgenticDataBench 官方 Evaluator 兼容的 `<outputTaskDir>/dabench/result.json`。
   *
   * 官方解析约定（testbed/da_agent/evaluators/evaluation.py 的 da-agent 分支）：
   * - 顶层必须有 trajectory 数组，每一项必须有 action（字符串）字段；
   * - 官方解析用「下一项的 observation」填充当前步的观察结果，且为直接索引访问，
   *   因此每一项都必须带 observation 字符串字段；
   *   本 recorder 直接把每个工具步的观察结果写进该步的 observation 字段（解析器兼容）；
   * - usage / timing 为可选透传字段；顶层额外字段（如 token_usage）不影响解析；
   * - 另写出官方解析器直接访问的顶层字段 finished / steps / result / result_files。
   * 注意：官方解析器按 result.json 所在路径中的系统名选择解析分支，
   * outputTaskDir 路径需包含 `da-agent` 才会命中 da-agent 分支。
   */
  async writeResultJson(outputTaskDir: string): Promise<void> {
    const dir = path.join(path.resolve(outputTaskDir), 'dabench');
    await mkdir(dir, { recursive: true });
    const payload = this.buildResultJson();
    await writeFile(path.join(dir, 'result.json'), JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * 写出 run 级汇总 JSON：experimentId、system、taskId、各节点状态 / 耗时 / token、
   * 总 token 与错误信息。字段为本项目自研格式（camelCase），与官方 result.json 无关。
   */
  async writeSummary(filePath: string): Promise<void> {
    const target = path.resolve(filePath);
    await mkdir(path.dirname(target), { recursive: true });
    const summary = {
      experimentId: this.runMeta?.experimentId ?? null,
      system: this.runMeta?.system ?? null,
      taskId: this.runMeta?.taskId ?? null,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      status: this.endInfo?.status ?? 'running',
      error: this.endInfo?.error ?? null,
      result: this.endInfo?.result ?? null,
      totalSteps: this.steps.length,
      tokenUsage: { ...this.totalUsage },
      nodes: this.listNodes().map((node) => ({
        nodeId: node.nodeId,
        status: node.status,
        startedAt: node.startedAt,
        finishedAt: node.finishedAt ?? null,
        elapsedMs: elapsedMsBetween(node.startedAt, node.finishedAt),
        model: node.model ?? null,
        error: node.error ?? null,
        steps: node.steps.length,
        tokenUsage: { ...node.tokenUsage },
      })),
      // 附加任务级信息（#3 Phase B 修复回路 / #4 Phase C 路由决策等），原样并入顶层
      ...(this.endInfo?.extras ?? {}),
    };
    await writeFile(target, JSON.stringify(summary, null, 2), 'utf8');
  }

  /** 构建官方兼容的 result.json 顶层内容。 */
  private buildResultJson(): Record<string, unknown> {
    const trajectory = this.buildTrajectory();
    return {
      finished: this.endInfo?.status === 'succeeded',
      steps: trajectory.length,
      result: this.endInfo?.result ?? '',
      result_files: this.endInfo?.resultFiles ?? { added_files: [], changed_files: [] },
      trajectory,
      token_usage: toOfficialUsage(this.totalUsage),
    };
  }

  /** 把记录的步骤映射为官方 trajectory 数组（Think / Python / Observation）。 */
  private buildTrajectory(): Record<string, unknown>[] {
    const runStartMs = this.startedAt !== null ? Date.parse(this.startedAt) : Number.NaN;
    const firstAt = this.steps[0]?.at;
    const startMs = Number.isFinite(runStartMs)
      ? runStartMs
      : firstAt !== undefined && Number.isFinite(Date.parse(firstAt))
        ? Date.parse(firstAt)
        : Number.NaN;

    return this.steps.map((step, index) => {
      const entry: Record<string, unknown> = {};
      if (step.kind === 'thought') {
        entry['action'] = 'Think';
        entry['content'] = step.content;
        entry['observation'] = '';
      } else if (step.kind === 'tool_call') {
        const next = this.steps[index + 1];
        entry['action'] = 'Python';
        entry['code'] = step.content;
        // 官方格式：直接把该工具步的观察结果放进本步的 observation 字段
        entry['observation'] = next !== undefined && next.kind === 'observation' ? next.content : '';
      } else {
        entry['action'] = 'Observation';
        entry['content'] = step.content;
        entry['observation'] = '';
      }
      if (step.name !== undefined) {
        entry['name'] = step.name;
      }
      if (step.tokenUsage !== undefined) {
        entry['usage'] = toOfficialUsage(step.tokenUsage);
      }
      entry['timing'] = { elapsed: elapsedSeconds(startMs, step.at) };
      return entry;
    });
  }
}

/** 求一组步骤快照的 token 用量之和。 */
function sumStepUsage(steps: SerializedStep[]): TokenUsage {
  let usage = emptyTokenUsage();
  for (const step of steps) {
    if (step.tokenUsage !== undefined) {
      usage = addTokenUsage(usage, step.tokenUsage);
    }
  }
  return usage;
}
