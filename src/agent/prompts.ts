/**
 * Prompt 构造：Baseline（整任务直做）与 DAG 单节点两套 system prompt，
 * 以及统一的 user prompt。护栏与 docs/design.md §3.3 一致。
 */

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
