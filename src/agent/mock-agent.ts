/**
 * 确定性 Mock AgentRunner：不调用 LLM、0 token，按构造时注入的行为剧本依次写出
 * 指定的 artifact 文件（JSON）后返回 succeeded；可注入失败与超步（超过 maxSteps）行为。
 * 用于 0-token 单元测试、DAG 管线联调与 --mock 实验运行。
 *
 * 类型与 PiAgentRunner 一致：AgentRunner 契约单一来源为 src/dag/executor.ts；
 * input.recorder 存在时把每步镜像进轨迹记录器（tool → tool_call + observation）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentRunner, AgentRunnerInput, NodeRunResult } from '../dag/executor.js';
import type { AgentStepRecord } from './pi-runtime.js';
import { resolveWithinWorkspace } from './tools.js';

/** Mock 产出的 artifact 类型（与 PiAgentRunner 对齐）。 */
type AgentArtifact = NodeRunResult['artifacts'][number];

/** 剧本中的一步：写出一个 artifact 文件。 */
export interface MockWriteStep {
  /** 相对工作区的 artifact 路径。 */
  path: string;
  /**
   * 文件内容：对象/数组会 JSON.stringify 美化写出，字符串原样写出，
   * Uint8Array 按二进制写出（如带文件头的 PNG 占位）。
   */
  content: unknown;
}

/** Mock 行为剧本。 */
export interface MockScript {
  /** 依次写出的 artifact 步骤。 */
  steps: MockWriteStep[];
  /** 在完成第 N 步（1 基）写出后失败；省略则按 steps 全部成功。 */
  failAfterStep?: number;
  /** 失败时的错误信息（默认 "Mock agent 注入失败"）。 */
  errorMessage?: string;
  /** 模拟模型空转直到超过 maxSteps（返回 failed + stopReason='step_limit'，与护栏语义一致）。 */
  exceedMaxSteps?: boolean;
  /** 每步回调（与 PiAgentRunner 对齐，便于 tracing 联调）。 */
  onStep?: (step: AgentStepRecord) => void;
}

/** 把未知内容序列化为文本：字符串原样，其余 JSON 美化。 */
function serializeContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content, null, 2);
}

export class MockAgentRunner implements AgentRunner {
  private readonly script: MockScript;
  private lastSteps: AgentStepRecord[] = [];

  constructor(script: MockScript) {
    this.script = script;
  }

  /** 最近一次运行的步骤缓冲（与 PiAgentRunner.getSteps 对齐）。 */
  getSteps(): readonly AgentStepRecord[] {
    return this.lastSteps;
  }

  async run(input: AgentRunnerInput): Promise<NodeRunResult> {
    this.lastSteps = [];
    const recorded: AgentStepRecord[] = [];
    const record = (step: AgentStepRecord): void => {
      recorded.push(step);
      this.lastSteps.push(step);
      this.script.onStep?.(step);
      // 镜像进轨迹记录器（与 PiAgentRunner 的 emit 对齐）
      if (step.kind === 'tool') {
        input.recorder.recordStep({
          kind: 'tool_call',
          ...(step.name !== undefined ? { name: step.name } : {}),
          content: step.summary,
        });
        input.recorder.recordStep({ kind: 'observation', content: step.summary });
      } else {
        input.recorder.recordStep({
          kind: 'thought',
          ...(step.name !== undefined ? { name: step.name } : {}),
          content: step.summary,
        });
      }
    };
    const artifacts: AgentArtifact[] = [];
    const makeResult = (
      status: 'succeeded' | 'failed',
      error?: string,
    ): NodeRunResult => ({
      status,
      artifacts: [...artifacts],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      steps: recorded.length,
      ...(error === undefined ? {} : { error }),
    });

    // —— 超步行为：空转 maxSteps 步后按护栏标记 failed（stopReason 供 executor 续跑判定） ——
    if (this.script.exceedMaxSteps) {
      for (let step = 1; step <= input.maxSteps; step++) {
        if (input.signal?.aborted) {
          return makeResult('failed', '运行被外部中止');
        }
        record({ index: step, kind: 'llm', name: 'mock', summary: 'mock 空转步骤', durationMs: 0 });
      }
      const result = makeResult('failed', `已达最大 ReAct 步数上限（${input.maxSteps} 步）`);
      return { ...result, stopReason: 'step_limit' };
    }

    // —— 正常剧本：依次写出 artifact；failAfterStep 在第 N 步写出后失败 ——
    const limit = this.script.failAfterStep ?? this.script.steps.length;
    if (limit < 0 || !Number.isInteger(limit)) {
      return makeResult('failed', `failAfterStep 必须为非负整数，实际为 ${this.script.failAfterStep}`);
    }
    for (let i = 0; i < Math.min(limit, this.script.steps.length); i++) {
      if (input.signal?.aborted) {
        return makeResult('failed', '运行被外部中止');
      }
      const step = this.script.steps[i] as MockWriteStep;
      const abs = resolveWithinWorkspace(input.workspacePath, step.path);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      if (step.content instanceof Uint8Array) {
        await fsp.writeFile(abs, step.content);
      } else {
        await fsp.writeFile(abs, serializeContent(step.content), 'utf-8');
      }
      artifacts.push({ name: path.basename(abs), path: abs });
      record({
        index: i + 1,
        kind: 'tool',
        name: 'mock_write',
        summary: `写出 ${step.path}`,
        durationMs: 0,
      });
    }

    if (this.script.failAfterStep !== undefined) {
      return makeResult('failed', this.script.errorMessage ?? 'Mock agent 注入失败');
    }
    return makeResult('succeeded');
  }
}
