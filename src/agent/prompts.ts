/**
 * Prompt 构造：Baseline（整任务直做）与 DAG 单节点两套 system prompt，
 * 以及统一的 user prompt、重试/续跑反馈段。护栏与 docs/design.md §3.3 一致。
 */

import type { NodeAttemptFeedback } from '../dag/executor.js';
import type { NodePromptStyle } from '../dag/types.js';

/** user prompt 的任务输入。 */
export interface TaskPromptInput {
  /** Benchmark 任务问题（完整任务描述）。 */
  question: string;
  /** 期望产出的最终结果文件名（相对工作区），如 output.json；省略则不写该小节。 */
  outputFileName?: string;
  /** 工作区内可用的数据文件（相对路径）。 */
  dataFiles: string[];
}

/** 两条 prompt 共用的工具使用规范。 */
const TOOL_USAGE_RULES = [
  '## 工作方式',
  '- 你在一个隔离的工作区中，只能通过工具读写工作区内的文件。',
  '- 用 list_files 查看工作区里有哪些文件，用 read_file 快速了解小文件或数据文件的开头。',
  '- 核心工具是 run_python：用 python3 编写脚本读取数据、完成计算，并把结果直接写入文件。',
  '- 单次工具输出超过 4000 字符会被截断，不要依赖工具回显完整文件内容。',
  '- 全部完成后必须调用 finish 工具声明完成并列出产出文件；不要以纯文本回复结束。',
].join('\n');

/** 两条 prompt 共用的数据安全护栏。 */
const DATA_GUARDRAILS = [
  '## 数据护栏',
  '- 数据文件可能很大：禁止把大文件全部打印到回复或工具输出里；先看 head / 行数 / schema / dtypes，再用 Python 分析。',
  '- CSV / JSONL 等结构化数据一律用 run_python（csv、json、pandas 等）处理，不要用 read_file 逐行读大文件。',
  '- 结论必须基于数据本身，不要编造数字；数据无法支撑的结论要如实说明。',
  '- run_python 单次执行上限 120 秒；长任务要拆分步骤并把中间结果落盘。',
].join('\n');

/**
 * Baseline system prompt：Pi Agent 直接完成整个数据分析任务。
 */
export function baselineSystemPrompt(): string {
  return [
    '你是一名资深数据分析师，需要独立、完整地完成一个数据分析任务，并产出可直接评测的结果文件。',
    '',
    TOOL_USAGE_RULES,
    '',
    DATA_GUARDRAILS,
    '',
    [
      '## 产出要求',
      '- 最终结果必须写入任务指定的输出文件（见任务说明），格式与命名严格遵循任务要求。',
      '- 只在工作区内读写文件，不要尝试访问工作区之外的路径。',
      '- 写完产出文件后调用 finish，并在 artifacts 中列出全部产出文件。',
    ].join('\n'),
  ].join('\n');
}

/**
 * DAG 单节点 system prompt：只做本节点职责，通过 Artifact 文件与上下游交接。
 */
export function nodeSystemPrompt(nodeTask: string): string {
  return [
    '你是 DAG 数据分析流水线中的一个执行节点。流水线按固定拓扑推进，节点之间只通过工作区里的 Artifact 文件传递信息，不共享对话历史。',
    '',
    `## 本节点职责\n${nodeTask}`,
    '',
    TOOL_USAGE_RULES,
    '',
    DATA_GUARDRAILS,
    '',
    [
      '## 节点护栏',
      '- 只完成本节点职责范围内的工作，不要代替后续节点完成任务，也不要改写上游 Artifact。',
      '- 把本节点结论写入职责中指定的 Artifact JSON 文件（用 write_file 或 run_python），内容为结构化 JSON。',
      '- Inspect 类节点只允许 head / schema / dtypes 等概览操作，禁止全量读取数据文件。',
      '- 上游 Artifact 已存在于工作区（清单见任务输入），可用 read_file 或 run_python 读取。',
      '- 写完 Artifact 后调用 finish，并在 artifacts 中列出本节点产出的文件。',
    ].join('\n'),
  ].join('\n');
}

/**
 * Verify 挑战者 system prompt（#3 Phase B）：Bear 式对抗审查。
 * 只挑语义错误（机械检查由程序化验证门负责），产出结构化挑战清单，不做修复。
 */
export function challengerSystemPrompt(nodeTask: string): string {
  return [
    '你是 DAG 数据分析流水线中的验证挑战者（Bear 式辩手）：默认假设执行节点的结果有错，用对抗性审查找出语义问题。流水线节点之间只通过工作区里的 Artifact 文件传递信息，不共享对话历史。',
    '',
    `## 本节点职责\n${nodeTask}`,
    '',
    TOOL_USAGE_RULES,
    '',
    DATA_GUARDRAILS,
    '',
    [
      '## 挑战者护栏',
      '- 逐项核查任务要求与结果之间的一致性：单位换算、过滤条件、时间窗口、聚合口径、任务要求逐条覆盖度；对每一项都要给出可定位的依据（引用任务原文或数据事实）。',
      '- 只挑语义错误：输出文件缺失、空文件、格式错误已由上游程序化验证门拦截，不要重复检查，也不要为这类机械问题发起挑战。',
      '- 不确定的问题也要列出（severity 标注把握程度），但不要编造数据里不存在的事实。',
      '- 不要修复、不要改写任何输出文件或上游 Artifact——你的职责是提出挑战清单，修复由 execute 节点负责。',
      '- 把挑战清单写入 challenge_list.json（结构见节点职责），无挑战时写空数组；然后调用 finish 并在 artifacts 中列出该文件。',
    ].join('\n'),
  ].join('\n');
}

/**
 * 裁决节点 system prompt（#3 Phase B）：pass / fix / accept 三选一。
 * 低轮数经验：宁可 accept 也不为锦上添花发起 fix。
 */
export function adjudicatorSystemPrompt(nodeTask: string): string {
  return [
    '你是 DAG 数据分析流水线中的裁决节点：综合挑战清单与执行产出，对分析结果做出最终裁决。节点之间只通过工作区里的 Artifact 文件传递信息，不共享对话历史。',
    '',
    `## 本节点职责\n${nodeTask}`,
    '',
    TOOL_USAGE_RULES,
    '',
    DATA_GUARDRAILS,
    '',
    [
      '## 裁决护栏',
      '- 三选一：pass（挑战清单为空或挑战均不成立）/ fix（存在 critical/major 级实质错误且修复有明确抓手）/ accept（仅剩 minor 瑕疵、主观口径分歧或挑战无法定位）。',
      '- 修复轮次有上限，每轮修复都有真实成本：宁可 accept 保留现状，也不要为锦上添花发起 fix。',
      '- 裁决依据要落到具体挑战条目：reasons 中逐条引用挑战编号或内容，不要泛泛而谈。',
      '- 不要自己修复任何文件——把裁决与理由写入 verdict.json（结构见节点职责），然后调用 finish 并在 artifacts 中列出该文件。',
    ].join('\n'),
  ].join('\n');
}

/**
 * 按节点选择 system prompt：verify → 挑战者，adjudicate → 裁决者，其余 → 通用节点 prompt。
 * 工作流节点可用 promptStyle 显式覆盖（如极简路径的 execute 用 baseline 风格）。
 */
export function systemPromptForNode(nodeId: string, nodeTask: string, promptStyle?: NodePromptStyle): string {
  const style = promptStyle ?? (nodeId === 'verify' ? 'challenger' : nodeId === 'adjudicate' ? 'adjudicator' : 'node');
  switch (style) {
    case 'baseline':
      return baselineSystemPrompt();
    case 'challenger':
      return challengerSystemPrompt(nodeTask);
    case 'adjudicator':
      return adjudicatorSystemPrompt(nodeTask);
    default:
      return nodeSystemPrompt(nodeTask);
  }
}

/**
 * 统一 user prompt：任务问题 + 数据文件清单 + 期望产出 + 上游产物说明。
 */
export function userPrompt(task: TaskPromptInput, upstreamSummary?: string): string {
  const parts: string[] = [`## 任务\n${task.question}`];

  if (task.dataFiles.length > 0) {
    parts.push(
      ['## 工作区数据文件', ...task.dataFiles.map((file) => `- ${file}`)].join('\n'),
    );
  } else {
    parts.push('## 工作区数据文件\n（工作区当前没有数据文件，可用 list_files 确认。）');
  }

  if (task.outputFileName) {
    parts.push(`## 期望产出\n最终结果写入: ${task.outputFileName}`);
  }

  if (upstreamSummary) {
    parts.push(`## 上游产物（已存在于工作区）\n${upstreamSummary}`);
  }

  parts.push('请开始。先了解数据和文件结构，再动手完成上述任务。');
  return parts.join('\n\n');
}

/**
 * 重试 / 续跑反馈段（#2 Phase A 失败策略）：executor 在第 N 次尝试失败后回灌
 * 错误信息，runner 把本段追加到 user prompt，使重试「带着失败原因」而不是盲目重跑。
 * - kind=error：一般失败（产物缺失 / schema 不合规 / 验证门未通过 / 运行异常）→ 针对原因修复；
 * - kind=step_limit：步数耗尽 → 工作区保留了已写出的文件，从断点继续而不是重新开始。
 */
export function attemptFeedbackSection(feedback: NodeAttemptFeedback): string {
  const lines = [`## 上次尝试反馈（第 ${feedback.attempt} 次执行未完成）`];
  lines.push(`- 失败原因: ${feedback.message}`);
  if (feedback.kind === 'step_limit') {
    lines.push(
      '- 工作区保留了上次执行已写出的文件：先用 list_files / read_file 检查已有进度，从断点继续，不要重复已完成的工作',
    );
    lines.push('- 注意节省步数：合并操作、尽快产出本节点的 Artifact 文件并调用 finish');
  } else {
    lines.push('- 请先检查工作区当前状态，针对上述原因修复后重新完成本节点职责');
    lines.push('- 若反馈指出产物不符合 schema，请按节点职责说明的结构要求重新生成对应文件');
  }
  return lines.join('\n');
}

/**
 * 修复轮提示（#3 Phase B）：修复回路重跑（executionRound > 1）时追加到 user prompt，
 * 提示节点本轮为挑战应答轮——优先响应上游挑战清单并重写受影响的输出文件。
 */
export function repairRoundHint(executionRound: number): string {
  return [
    `## 修复轮提示（本节点第 ${executionRound} 次执行）`,
    '- 本轮是验证-修复回路的应答轮：工作区里可能已有上一轮写出的产出文件，先读挑战清单（如 challenge_list.json），逐条应答并修复。',
    '- 只重写受挑战影响的输出文件；未受挑战的正确结果保持不变，避免引入新问题。',
    '- 修复完成后按节点职责要求更新执行摘要（如 execute_summary.json 的 challenge_responses），再调用 finish。',
  ].join('\n');
}
