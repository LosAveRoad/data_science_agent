import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** AgenticDataBench 官方任务文件相对 dataDir 的位置。 */
export function taskFilePath(dataDir: string): string {
  return path.join(dataDir, 'tasks', 'dev.jsonl');
}

/** 任务文件缺失、行非法 JSON 或字段类型不符时抛出。 */
export class TaskLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskLoadError';
  }
}

/** 官方 dev.jsonl 中的一条任务（字段已从 snake_case 归一化为 camelCase，列表字段已归一化）。 */
export interface BenchmarkTask {
  id: string;
  question: string;
  /** 任务依赖的原始数据文件，相对 `<dataDir>/datasets/` 的路径（可能包含子目录）。 */
  dataSources: string[];
  /** 官方标注的任务涉及的技能标签。 */
  skills: string[];
  /** 任务所属领域（如 agriculture / finance）。 */
  domain: string;
  /** Agent 需要产出的输出文件名。 */
  outputFileName: string[];
  /** 官方 gold 结果文件名。 */
  goldFileName: string[];
  /** 官方评测函数调用表达式。 */
  evalFunc: string[];
}

/** configs/benchmark.json 的格式约定（主控负责生成，本模块只读取）。 */
export interface BenchmarkSubsetConfig {
  /** 子集冻结版本（如 "2026-11-12"）。 */
  version?: string;
  /** 选样标准说明，保证子集可追溯。 */
  selection_criteria?: string;
  /** 冻结的任务 ID 列表（第一阶段固定 30 个）。 */
  task_ids: string[];
}

/**
 * 官方字段可能是 string 或 list，统一归一化为 string[]：
 * - string → 单元素列表
 * - null / undefined → 空列表
 * - list → 逐项校验为字符串
 */
function toStringList(value: unknown, fieldName: string, taskId: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (typeof item !== 'string') {
        throw new TaskLoadError(
          `任务 ${taskId} 的字段 ${fieldName}[${index}] 不是字符串: ${JSON.stringify(item)}`,
        );
      }
      return item;
    });
  }
  throw new TaskLoadError(
    `任务 ${taskId} 的字段 ${fieldName} 既不是字符串也不是列表: ${JSON.stringify(value)}`,
  );
}

/** 解析 dev.jsonl 中的一行（JSONL），映射为 BenchmarkTask。lineNumber 从 1 开始，用于报错定位。 */
function parseTaskLine(line: string, lineNumber: number): BenchmarkTask {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    throw new TaskLoadError(
      `dev.jsonl 第 ${lineNumber} 行不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TaskLoadError(`dev.jsonl 第 ${lineNumber} 行不是 JSON 对象`);
  }
  const record = raw as Record<string, unknown>;

  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new TaskLoadError(`dev.jsonl 第 ${lineNumber} 行缺少合法的 id 字段`);
  }
  const question = record['question'];
  if (typeof question !== 'string') {
    throw new TaskLoadError(`任务 ${id} 缺少合法的 question 字段`);
  }
  const domain = record['domain'];
  if (typeof domain !== 'string') {
    throw new TaskLoadError(`任务 ${id} 缺少合法的 domain 字段`);
  }

  return {
    id,
    question,
    domain,
    dataSources: toStringList(record['data_sources'], 'data_sources', id),
    skills: toStringList(record['skills'], 'skills', id),
    outputFileName: toStringList(record['output_file_name'], 'output_file_name', id),
    goldFileName: toStringList(record['gold_file_name'], 'gold_file_name', id),
    evalFunc: toStringList(record['eval_func'], 'eval_func', id),
  };
}

/** 读取 `$AGENTIC_DATA_BENCH_DATA_DIR/tasks/dev.jsonl`，返回全部任务（按文件顺序）。 */
export async function loadAllTasks(dataDir: string): Promise<BenchmarkTask[]> {
  const filePath = taskFilePath(dataDir);
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new TaskLoadError(
      `无法读取任务文件 ${filePath}: ${err instanceof Error ? err.message : String(err)}；` +
        '请确认 dataDir 指向 AgenticDataBench testbed 目录（即 $AGENTIC_DATA_BENCH_DATA_DIR）',
    );
  }

  const tasks: BenchmarkTask[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    tasks.push(parseTaskLine(trimmed, index + 1));
  }
  return tasks;
}

/**
 * 按 ID 列表加载任务子集，返回顺序与 subsetIds 一致。
 * 任一 ID 不存在时抛出 TaskLoadError，错误信息中列出全部缺失 ID。
 */
export async function loadTaskSubset(
  dataDir: string,
  subsetIds: readonly string[],
): Promise<BenchmarkTask[]> {
  const all = await loadAllTasks(dataDir);
  const byId = new Map(all.map((task) => [task.id, task]));

  const missing = subsetIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new TaskLoadError(
      `以下 ${missing.length}/${subsetIds.length} 个任务 ID 在 ${taskFilePath(dataDir)} 中不存在: ` +
        `${missing.join(', ')}（该文件实际包含 ${all.length} 个任务）`,
    );
  }

  return subsetIds.map((id) => byId.get(id) as BenchmarkTask);
}

/**
 * 从子集配置中提取任务 ID 列表。兼容两种格式：
 * - `task_ids`：字符串列表（约定格式，形如 ["agriculture_02", ...]）；
 * - `tasks`：字符串列表，或带 `id` 字段的任务对象列表（含数据集大小等附加信息）。
 * 两种字段同时存在时以 `task_ids` 为准。
 */
function extractTaskIds(config: Record<string, unknown>, configPath: string): string[] {
  const rawTaskIds = config['task_ids'];
  if (rawTaskIds !== undefined) {
    if (!Array.isArray(rawTaskIds) || rawTaskIds.length === 0 || rawTaskIds.some((id) => typeof id !== 'string')) {
      throw new TaskLoadError(
        `子集配置文件 ${configPath} 的 task_ids 必须是非空字符串列表（形如 ["task_id_1", ...]）`,
      );
    }
    return rawTaskIds as string[];
  }

  const rawTasks = config['tasks'];
  if (Array.isArray(rawTasks)) {
    const ids = rawTasks.map((entry, index) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>)['id'] === 'string') {
        return (entry as Record<string, unknown>)['id'] as string;
      }
      throw new TaskLoadError(
        `子集配置文件 ${configPath} 的 tasks[${index}] 既不是字符串也没有合法的 id 字段: ${JSON.stringify(entry).slice(0, 120)}`,
      );
    });
    if (ids.length > 0) {
      return ids;
    }
  }

  throw new TaskLoadError(
    `子集配置文件 ${configPath} 缺少 task_ids（或 tasks）字段：需要非空的字符串列表，或带 id 字段的任务对象列表`,
  );
}

/**
 * 读取 `configs/benchmark.json` 格式的子集配置，并按其中的任务 ID 列表加载任务。
 * 约定格式只需包含 `task_ids`（string 非空列表），`version` 与 `selection_criteria` 为可选说明字段；
 * 兼容 `tasks` 字段（字符串列表或带 id 字段的任务对象列表）。
 */
export async function subsetFromConfig(dataDir: string, configPath: string): Promise<BenchmarkTask[]> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new TaskLoadError(
      `无法读取子集配置文件 ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new TaskLoadError(
      `子集配置文件 ${configPath} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TaskLoadError(`子集配置文件 ${configPath} 顶层必须是 JSON 对象`);
  }

  return loadTaskSubset(dataDir, extractTaskIds(parsed as Record<string, unknown>, configPath));
}
