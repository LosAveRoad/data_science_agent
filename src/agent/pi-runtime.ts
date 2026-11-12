/**
 * Pi Agent Runtime：基于 @mariozechner/pi-ai 的消息级 API 实现受控 ReAct 循环，
 * 实现 AgentRunner 契约（单一来源为 src/dag/executor.ts，本模块导入其类型并适配：
 * input.nodeId 用于日志，input.recorder 用于把 ReAct 步骤镜像进轨迹记录器）。
 *
 * 为什么不直接用 pi-agent-core 的 Agent/agentLoop：
 * - agentLoop 面向交互式 UI（steering / follow-up / 事件流），没有内置步数上限；
 * - benchmark 护栏（docs/design.md §3.3）要求「ReAct 步数上限、达上限标记 failed、
 *   每步 token 统计、工具输出截断」，直接用 pi-ai 的 complete() 消息级 API 自研循环更可控；
 *   OpenAI 兼容的工具调用协议（tools 参数、tool_calls 解析、toolResult 回填）由 pi-ai 完成。
 *
 * LLM 配置来自环境变量（构造参数优先）：
 * - PI_API_KEY：API Key
 * - PI_BASE_URL：OpenAI 兼容 baseURL（如 https://api.deepseek.com）
 * - MODEL_ID：模型 ID（如 deepseek-flash）
 * 通过 openai-completions provider 的自定义 Model（任意 baseURL）接入。
 */
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  complete,
  validateToolCall,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICompletionsCompat,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from '@mariozechner/pi-ai';
import type { AgentRunner, AgentRunnerInput, NodeRunResult } from '../dag/executor.js';
import { baselineSystemPrompt, nodeSystemPrompt, userPrompt } from './prompts.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  executeWorkspaceTool,
  listWorkspaceFiles,
  resolveWithinWorkspace,
  WORKSPACE_TOOLS,
  type ToolContext,
} from './tools.js';

/** LLM 单次调用超时（毫秒）。 */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
/** 默认 baseURL（DeepSeek 开放平台，OpenAI 兼容）。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
/** 默认模型 ID（可用 MODEL_ID 覆盖）。 */
const DEFAULT_MODEL_ID = 'deepseek-chat';

/**
 * AgentRunner 契约统一：单一来源为 src/dag/executor.ts（AgentRunnerInput 含必填 nodeId
 * 与 recorder）。这里原样再导出，既有从 pi-runtime 导入类型的调用方无需改动。
 */
export type { AgentRunner, AgentRunnerInput } from '../dag/executor.js';

/** AgentRunner 的产出 artifact（即 NodeRunResult.artifacts 的元素类型）。 */
export type AgentArtifact = NodeRunResult['artifacts'][number];

/** AgentRunner 的运行结果（统一后即 executor 的 NodeRunResult）。 */
export type AgentRunnerResult = NodeRunResult;

/** 单条步骤记录（供 tracing recorder 消费）。 */
export interface AgentStepRecord {
  /** 1 基的 ReAct 步号（一个 LLM 步可能带多个工具执行记录）。 */
  index: number;
  kind: 'llm' | 'tool';
  /** llm: stopReason；tool: 工具名。 */
  name?: string;
  /** 内容摘要（截断后的短文本）。 */
  summary: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  isError?: boolean;
}

export interface PiAgentRunnerOptions {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  /** 'baseline' = 整任务直做；'node' = DAG 节点模式（默认）。 */
  mode?: 'baseline' | 'node';
  /** 期望产出的最终文件名（写入 user prompt；baseline 实验建议提供）。 */
  outputFileName?: string;
  /** LLM 单次调用超时（毫秒），默认 120s。 */
  llmTimeoutMs?: number;
  /** 单次工具执行超时（毫秒），默认 120s。 */
  toolTimeoutMs?: number;
  /** 透传给 openai-completions Model 的兼容性覆盖（如自建网关需要 supportsStore: false）。 */
  compat?: OpenAICompletionsCompat;
  /** 每步回调（推送给上层 tracing recorder；与 getSteps() 二选一或并用）。 */
  onStep?: (step: AgentStepRecord) => void;
  /** 是否把每步进度写到 stderr（前缀含 input.nodeId，便于定位慢节点/失败节点）。 */
  logSteps?: boolean;
}

/**
 * 手工解析 .env 文件（KEY=VALUE 行），不引入 dotenv 依赖：
 * - 跳过空行与 # 注释，支持可选的 `export ` 前缀与成对引号；
 * - 已存在的环境变量优先，.env 不覆盖（与 dotenv 默认行为一致）；
 * - 文件不存在时静默跳过。
 */
export function loadEnvFile(filePath: string): void {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/** 从构造参数与环境变量解析 LLM 连接配置（构造参数优先）。 */
function resolveRunnerConfig(options: PiAgentRunnerOptions): {
  apiKey: string;
  baseUrl: string;
  modelId: string;
} {
  return {
    apiKey: options.apiKey ?? process.env.PI_API_KEY ?? '',
    baseUrl: options.baseUrl ?? process.env.PI_BASE_URL ?? DEFAULT_BASE_URL,
    modelId: options.modelId ?? process.env.MODEL_ID ?? DEFAULT_MODEL_ID,
  };
}

/**
 * 构造 openai-completions 自定义 Model：任意 OpenAI 兼容 baseURL 均可接入。
 * reasoning=false 避免发送 developer 角色 / reasoning_effort 等
 * 非 OpenAI 兼容端点不认识的参数；DeepSeek 等已知端点由 pi-ai 按 URL 自动检测 compat。
 */
function buildModel(
  config: { baseUrl: string; modelId: string },
  compat?: OpenAICompletionsCompat,
): Model<'openai-completions'> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: 'custom-openai-compatible',
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...(compat ? { compat } : {}),
  };
}

/** 摘要：压平空白并截断到 max 字符。 */
function summarize(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 登记一个产出文件（绝对路径，按路径去重；越界路径在工具层已报错，这里静默忽略）。 */
function registerArtifact(produced: Map<string, AgentArtifact>, workspacePath: string, rel: string): void {
  try {
    const abs = resolveWithinWorkspace(workspacePath, rel);
    if (!produced.has(abs)) {
      produced.set(abs, { name: path.basename(abs), path: abs });
    }
  } catch {
    // 越界路径不计入产出
  }
}

/**
 * Pi Agent Runner：受控 ReAct 循环。
 *
 * 终止条件与结果判定：
 * - 模型调用 finish → 结束；按 finish 声明 + write_file 实际写出的文件确定 artifacts，
 *   一个产出文件都没有则标记 failed；
 * - 模型以纯文本结束（未调用 finish）→ failed（不符合完成协议）；
 * - 达到 maxSteps 上限 → failed（护栏要求）；
 * - 外部中止 / LLM 超时 / LLM 错误 → failed。
 *
 * 轨迹对接：input.recorder（executor 契约必填）会在每步把 ReAct 步骤镜像进去
 * （llm → thought，tool → tool_call + observation），DAG 模式下由 DagExecutor 负责
 * startNode / endNode，baseline 模式由实验运行循环负责。
 */
export class PiAgentRunner implements AgentRunner {
  private readonly options: PiAgentRunnerOptions;
  private stepBuffer: AgentStepRecord[] = [];

  constructor(options: PiAgentRunnerOptions = {}) {
    this.options = options;
  }

  /** 最近一次运行的步骤缓冲（供上层 tracing recorder 读取）。 */
  getSteps(): readonly AgentStepRecord[] {
    return this.stepBuffer;
  }

  async run(input: AgentRunnerInput): Promise<AgentRunnerResult> {
    this.stepBuffer = [];
    let steps = 0;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const makeResult = (
      status: 'succeeded' | 'failed',
      artifacts: AgentArtifact[],
      error?: string,
    ): AgentRunnerResult => ({
      status,
      artifacts,
      tokenUsage: { ...usage },
      steps,
      ...(error === undefined ? {} : { error }),
    });

    // —— 步骤出口：缓冲 + 回调 + 镜像进轨迹记录器 ——
    const log = (message: string): void => {
      if (this.options.logSteps) {
        console.error(`[pi-agent:${input.nodeId}/${input.taskId}] ${message}`);
      }
    };
    const emit = (record: AgentStepRecord): void => {
      this.stepBuffer.push(record);
      this.options.onStep?.(record);
      if (record.kind === 'llm') {
        input.recorder.recordStep({
          kind: 'thought',
          ...(record.name !== undefined ? { name: record.name } : {}),
          content: record.summary,
          ...(record.usage !== undefined ? { tokenUsage: { ...record.usage } } : {}),
        });
      } else {
        input.recorder.recordStep({
          kind: 'tool_call',
          ...(record.name !== undefined ? { name: record.name } : {}),
          content: record.summary,
        });
        input.recorder.recordStep({ kind: 'observation', content: record.summary });
      }
    };

    // —— 前置校验 ——
    const config = resolveRunnerConfig(this.options);
    if (!config.apiKey) {
      return makeResult('failed', [], '缺少 LLM API Key：请设置 PI_API_KEY 环境变量或通过构造参数传入');
    }
    if (!Number.isInteger(input.maxSteps) || input.maxSteps <= 0) {
      return makeResult('failed', [], `maxSteps 必须为正整数，实际为 ${input.maxSteps}`);
    }
    const wsStat = await fsp.stat(input.workspacePath).catch(() => null);
    if (!wsStat?.isDirectory()) {
      return makeResult('failed', [], `工作区不存在或不是目录: ${input.workspacePath}`);
    }

    // —— 组装 prompt ——
    const mode = this.options.mode ?? 'node';
    const nodeTask = input.nodeTask.trim() || input.question;
    const systemPrompt = mode === 'baseline' ? baselineSystemPrompt() : nodeSystemPrompt(nodeTask);
    const dataFiles = await listWorkspaceFiles(input.workspacePath);
    const upstreamSummary = input.upstreamArtifacts.length > 0
      ? input.upstreamArtifacts.map((a) => `- ${a.name}: ${a.path}`).join('\n')
      : undefined;
    const userText = userPrompt(
      {
        question: input.question,
        outputFileName: this.options.outputFileName,
        dataFiles,
      },
      upstreamSummary,
    );

    const tools: Tool[] = WORKSPACE_TOOLS;
    const context: Context = {
      systemPrompt,
      messages: [{ role: 'user', content: userText, timestamp: Date.now() }],
      tools,
    };
    const model = buildModel(config, this.options.compat);
    const toolCtx: ToolContext = {
      workspacePath: input.workspacePath,
      timeoutMs: this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    };
    const llmTimeoutMs = this.options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

    const produced = new Map<string, AgentArtifact>();
    let finishDeclared: string[] | null = null;

    for (let step = 1; step <= input.maxSteps; step++) {
      if (input.signal?.aborted) {
        return makeResult('failed', [...produced.values()], '运行被外部中止');
      }

      // —— LLM 调用（外部 signal + 单次超时，120s） ——
      const timeoutSignal = AbortSignal.timeout(llmTimeoutMs);
      const llmSignal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      const llmStart = Date.now();
      let message: AssistantMessage;
      try {
        message = await complete(model, context, {
          apiKey: config.apiKey,
          signal: llmSignal,
          timeoutMs: llmTimeoutMs,
          maxRetries: 1,
        });
      } catch (err) {
        return makeResult(
          'failed',
          [...produced.values()],
          `LLM 调用异常: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      steps = step;
      const stepUsage = {
        inputTokens: message.usage?.input ?? 0,
        outputTokens: message.usage?.output ?? 0,
        totalTokens: (message.usage?.input ?? 0) + (message.usage?.output ?? 0),
      };
      usage.inputTokens += stepUsage.inputTokens;
      usage.outputTokens += stepUsage.outputTokens;
      usage.totalTokens += stepUsage.totalTokens;

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      log(`第 ${step}/${input.maxSteps} 步 stopReason=${message.stopReason} tokens=${stepUsage.totalTokens}`);
      emit({
        index: step,
        kind: 'llm',
        name: message.stopReason,
        summary: summarize(text),
        usage: stepUsage,
        durationMs: Date.now() - llmStart,
        isError: message.stopReason === 'error' || message.stopReason === 'aborted',
      });

      if (message.stopReason === 'aborted') {
        const reason = input.signal?.aborted
          ? '收到外部中止信号'
          : `LLM 调用超时（${llmTimeoutMs}ms）`;
        return makeResult('failed', [...produced.values()], `运行中止: ${reason}`);
      }
      if (message.stopReason === 'error') {
        return makeResult(
          'failed',
          [...produced.values()],
          `LLM 返回错误: ${message.errorMessage ?? '未知错误'}`,
        );
      }

      context.messages.push(message);
      const toolCalls = message.content.filter(
        (block): block is ToolCall => block.type === 'toolCall',
      );

      // —— 无工具调用：纯文本结束视为未按协议完成 ——
      if (toolCalls.length === 0) {
        const error = message.stopReason === 'length'
          ? 'LLM 输出达到长度上限（length）且未调用 finish'
          : '模型未调用 finish 即结束回复，不符合完成协议';
        return makeResult('failed', [...produced.values()], error);
      }

      // —— 顺序执行工具并回填观察（toolResult） ——
      let finished = false;
      const toolResults: ToolResultMessage[] = [];
      for (const call of toolCalls) {
        const toolStart = Date.now();
        let ok = false;
        let output = '';
        let validated: Record<string, unknown> = {};
        try {
          validated = validateToolCall(tools, call) ?? {};
          const result = await executeWorkspaceTool(call.name, validated, toolCtx, input.signal);
          ok = result.ok;
          output = result.output;
        } catch (err) {
          output = `工具调用失败: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (ok && call.name === 'write_file') {
          const rel = typeof validated.path === 'string' ? validated.path : '';
          if (rel) {
            registerArtifact(produced, input.workspacePath, rel);
          }
        }
        if (ok && call.name === 'finish') {
          finished = true;
          finishDeclared = Array.isArray(validated.artifacts)
            ? validated.artifacts.filter((a): a is string => typeof a === 'string')
            : [];
        }
        emit({
          index: step,
          kind: 'tool',
          name: call.name,
          summary: summarize(output),
          durationMs: Date.now() - toolStart,
          isError: !ok,
        });
        toolResults.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: output }],
          isError: !ok,
          timestamp: Date.now(),
        });
      }
      context.messages.push(...toolResults);

      // —— finish：校验产出文件并结束本轮 ——
      if (finished) {
        const missing: string[] = [];
        for (const rel of finishDeclared ?? []) {
          const abs = resolveWithinWorkspace(input.workspacePath, rel);
          const stat = await fsp.stat(abs).catch(() => null);
          if (stat?.isFile()) {
            registerArtifact(produced, input.workspacePath, rel);
          } else {
            missing.push(rel);
          }
        }
        const artifacts = [...produced.values()];
        if (artifacts.length === 0) {
          const hint = missing.length > 0 ? `（缺失: ${missing.join(', ')}）` : '';
          return makeResult('failed', [], `finish 声明中没有任何存在于工作区的产出文件${hint}`);
        }
        const warning = missing.length > 0
          ? `以下声明的产出文件不存在: ${missing.join(', ')}`
          : undefined;
        return makeResult('succeeded', artifacts, warning);
      }
    }

    return makeResult(
      'failed',
      [...produced.values()],
      `已达最大 ReAct 步数上限（${input.maxSteps} 步），未收到 finish`,
    );
  }
}
