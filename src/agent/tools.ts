/**
 * Agent 工作区工具集：OpenAI function-calling 格式的工具定义（TypeBox 生成 JSON Schema，
 * 由 pi-ai 转换为 OpenAI tools 参数）+ 确定性执行器。
 *
 * 所有携带路径参数的工具都通过 resolveWithinWorkspace 限制在工作区内，防止路径穿越。
 */
import { spawn } from 'node:child_process';
import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Type, type Tool } from '@mariozechner/pi-ai';

/** 单次工具输出上限（字符），超过即截断并注明 [截断]。 */
export const TOOL_OUTPUT_LIMIT = 4000;
/** 工具默认超时（毫秒）。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
/** 超过该字节数的文本文件按「大文件」处理（只做 head 并提示用 python）。 */
const LARGE_FILE_BYTES = 1_000_000;
/** 单行读取上限（字符），超长行截断。 */
const MAX_LINE_CHARS = 2000;
/** list_files 最多列出的文件条数。 */
const MAX_LIST_ENTRIES = 200;
/** write_file 内容上限（字节）。 */
const MAX_WRITE_BYTES = 5_000_000;

/** 路径越出工作区时抛出。 */
export class PathOutsideWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathOutsideWorkspaceError';
  }
}

/**
 * 把相对路径解析到工作区内；越界（相对路径上跳、绝对路径在工作区外）时抛出
 * PathOutsideWorkspaceError。
 */
export function resolveWithinWorkspace(workspacePath: string, relativePath: string): string {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw new PathOutsideWorkspaceError(`路径越界: ${relativePath} 不在工作区内`);
  }
  return resolved;
}

/** 截断工具输出：超过 maxChars 时保留前缀并注明 [截断]。 */
export function truncateToolOutput(text: string, maxChars: number = TOOL_OUTPUT_LIMIT): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[截断] 输出过长，已省略 ${omitted} 个字符（原始 ${text.length} 个字符）。`;
}

/** 工具执行上下文：工作区根目录 + 可选超时覆盖。 */
export interface ToolContext {
  workspacePath: string;
  /** 单次工具执行超时（毫秒），默认 120s。 */
  timeoutMs?: number;
}

/** 工具执行结果：ok=false 时 output 为给模型看的错误说明。 */
export interface ToolRunResult {
  ok: boolean;
  output: string;
}

/**
 * 工具规格：name/description/parameters 直接满足 pi-ai 的 Tool 结构
 * （parameters 为 TypeBox schema，序列化后即 OpenAI function-calling 的 JSON Schema），
 * execute 由 executeWorkspaceTool 统一调度（超时 + 截断 + 错误兜底）。
 */
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Tool['parameters'];
  /** 执行工具并返回给模型的文本；失败时抛错（由调度器转为 isError 的工具结果）。 */
  execute(args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<string>;
}

/** 把整数参数收敛到 [min, max]，缺省/非法时用 fallback。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (Number.isNaN(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  return `${(size / 1024).toFixed(1)} KB`;
}

/** 递归收集工作区内文件（相对路径），跳过 .git 与符号链接，限制深度与数量。 */
async function walkWorkspace(root: string, dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 6 || out.length >= MAX_LIST_ENTRIES) {
    return;
  }
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkWorkspace(root, full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full));
      if (out.length >= MAX_LIST_ENTRIES) {
        return;
      }
    }
  }
}

/** 列出工作区内全部文件（相对路径，排序后返回）。供 list_files 与 runtime 使用。 */
export async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const root = path.resolve(workspacePath);
  const files: string[] = [];
  await walkWorkspace(root, root, files, 0);
  return files.sort();
}

/** 流式读取大文件的指定行区间（offset 起 maxLines 行），避免整文件载入内存。 */
async function readHeadLines(absPath: string, offset: number, maxLines: number): Promise<string[]> {
  const out: string[] = [];
  const stream = createReadStream(absPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let index = 0;
    for await (const line of rl) {
      if (index >= offset) {
        out.push(line);
        if (out.length >= maxLines) {
          break;
        }
      }
      index++;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

/** 运行 python3 子进程执行代码：cwd 为工作区、隔离模式（-I）、超时终止、捕获 stdout/stderr。 */
export async function runPython(code: string, ctx: ToolContext, signal?: AbortSignal): Promise<string> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', code], {
      cwd: path.resolve(ctx.workspacePath),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    // 输出各封顶 200KB，防止超长输出拖垮内存；最终还会过 truncateToolOutput。
    const OUTPUT_CAP = 200_000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_CAP) {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_CAP) {
        stderr += chunk;
      }
    });

    const kill = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', (err) => {
      settle(() => reject(new Error(`无法启动 python3: ${err.message}`)));
    });
    child.on('close', (codeNum, signalName) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`run_python 超时（>${timeoutMs}ms），进程已终止。请拆小任务或优化代码后重试。`));
          return;
        }
        if (signal?.aborted) {
          reject(new Error('run_python 被外部中止。'));
          return;
        }
        const parts = [`退出码: ${codeNum ?? (signalName ? `信号 ${signalName}` : '未知')}`];
        if (stdout.trim().length > 0) {
          parts.push(`stdout:\n${stdout.trimEnd()}`);
        }
        if (stderr.trim().length > 0) {
          parts.push(`stderr:\n${stderr.trimEnd()}`);
        }
        const output = parts.join('\n');
        // 非零退出码视为执行失败（isError=true），但 stdout/stderr 原样给模型用于修正代码。
        if (codeNum !== 0) {
          reject(new Error(output));
          return;
        }
        resolve(output);
      });
    });
  });
}

const listFilesSpec: AgentToolSpec = {
  name: 'list_files',
  description: '列出工作区内的所有文件（相对路径 + 字节大小），用于了解工作区里有哪些数据与产出文件。',
  parameters: Type.Object({}),
  async execute(_args, ctx) {
    const root = path.resolve(ctx.workspacePath);
    const files = await listWorkspaceFiles(root);
    if (files.length === 0) {
      return '工作区为空，没有任何文件。';
    }
    const lines: string[] = [];
    const shown = files.slice(0, MAX_LIST_ENTRIES);
    for (const rel of shown) {
      const stat = await fsp.stat(path.join(root, rel));
      lines.push(`${rel} (${formatBytes(stat.size)})`);
    }
    let output = lines.join('\n');
    if (files.length > MAX_LIST_ENTRIES) {
      output += `\n[截断] 仅显示前 ${MAX_LIST_ENTRIES} 个文件（共 ${files.length} 个）。`;
    }
    return output;
  },
};

const readFileSpec: AgentToolSpec = {
  name: 'read_file',
  description:
    '按行读取工作区内的文本文件，默认返回前 100 行；支持 offset/maxLines 偏移。' +
    'CSV/JSON 等大文件自动只读开头并提示改用 run_python 分析，禁止全量读取。',
  parameters: Type.Object({
    path: Type.String({ description: '工作区内的相对路径' }),
    offset: Type.Optional(Type.Number({ description: '起始行号（0 基），默认 0' })),
    maxLines: Type.Optional(Type.Number({ description: '最多读取行数（1-500），默认 100' })),
  }),
  async execute(args, ctx) {
    const rel = typeof args.path === 'string' ? args.path : '';
    if (!rel) {
      throw new Error('缺少 path 参数');
    }
    const abs = resolveWithinWorkspace(ctx.workspacePath, rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) {
      throw new Error(`文件不存在: ${rel}`);
    }
    if (stat.isDirectory()) {
      throw new Error(`路径是目录而不是文件: ${rel}（列目录请用 list_files）`);
    }
    const offset = clampInt(args.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const maxLines = clampInt(args.maxLines, 1, 500, 100);

    // 二进制嗅探：前 8KB 出现 NUL 字节即拒绝按文本读取。
    const sniffLength = Math.min(8192, stat.size);
    const sniff = Buffer.alloc(sniffLength);
    const fh = await fsp.open(abs, 'r');
    try {
      await fh.read(sniff, 0, sniffLength, 0);
    } finally {
      await fh.close();
    }
    if (sniff.includes(0)) {
      throw new Error(`疑似二进制文件，无法按文本读取: ${rel}。请用 run_python 分析。`);
    }

    const isLarge = stat.size > LARGE_FILE_BYTES;
    let lines: string[];
    let totalLines: number | null;
    if (stat.size <= LARGE_FILE_BYTES) {
      const content = await fsp.readFile(abs, 'utf-8');
      const all = content.split('\n');
      if (all.length > 0 && all[all.length - 1] === '') {
        all.pop();
      }
      totalLines = all.length;
      lines = all.slice(offset, offset + maxLines);
    } else {
      // 大文件：只流式读取所需行区间，不统计总行数。
      lines = await readHeadLines(abs, offset, maxLines);
      totalLines = null;
    }

    const header = totalLines === null
      ? `文件: ${rel}（${formatBytes(stat.size)}，大文件，显示自第 ${offset} 行起的 ${lines.length} 行）`
      : `文件: ${rel}（共 ${totalLines} 行，${formatBytes(stat.size)}）`;
    const parts: string[] = [header];
    if (isLarge) {
      parts.push('提示: 这是较大的数据文件，建议用 run_python（如 pandas）做 head/schema/dtypes 概览与统计，不要逐行读取。');
    }
    for (const line of lines) {
      parts.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…[行超长截断]` : line);
    }

    const hasMore = totalLines === null
      ? lines.length === maxLines
      : offset + lines.length < totalLines;
    if (hasMore) {
      const totalText = totalLines === null ? '总行数未统计' : `共 ${totalLines} 行`;
      parts.push(
        `[截断] 仅显示第 ${offset}–${offset + lines.length - 1} 行（${totalText}）。` +
        '可用 offset/maxLines 继续读取；CSV/JSON 等大文件建议直接用 run_python（如 pandas）分析，不要全量读取。',
      );
    }
    return parts.join('\n');
  },
};

const runPythonSpec: AgentToolSpec = {
  name: 'run_python',
  description:
    '核心工具：执行一段 Python 代码（python3 -I -c <code>），工作目录为工作区，单次上限 120 秒。' +
    '用 pandas/csv/json 读取数据、完成计算，并把结果文件直接写入工作区。返回退出码与 stdout/stderr。',
  parameters: Type.Object({
    code: Type.String({ description: '要执行的 Python 代码' }),
  }),
  async execute(args, ctx, signal) {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) {
      throw new Error('缺少 code 参数');
    }
    if (code.length > 100_000) {
      throw new Error('code 过长（>100000 字符），请拆分执行或写成脚本文件后运行。');
    }
    return runPython(code, ctx, signal);
  },
};

const writeFileSpec: AgentToolSpec = {
  name: 'write_file',
  description: '在工作区内写文本文件（UTF-8，自动创建子目录），用于写结果 JSON、脚本或最终产出文件。',
  parameters: Type.Object({
    path: Type.String({ description: '工作区内的相对路径' }),
    content: Type.String({ description: '要写入的文本内容' }),
  }),
  async execute(args, ctx) {
    const rel = typeof args.path === 'string' ? args.path : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (!rel) {
      throw new Error('缺少 path 参数');
    }
    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > MAX_WRITE_BYTES) {
      throw new Error(`写入内容过大（${byteLength} 字节 > ${MAX_WRITE_BYTES}），请用 run_python 分块写文件。`);
    }
    const abs = resolveWithinWorkspace(ctx.workspacePath, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf-8');
    return `已写入 ${rel}（${byteLength} 字节）`;
  },
};

const finishSpec: AgentToolSpec = {
  name: 'finish',
  description: '声明任务完成：列出本轮产出的文件清单（相对工作区路径）与一句话总结。调用后本轮结束。',
  parameters: Type.Object({
    artifacts: Type.Optional(
      Type.Array(Type.String(), { description: '本轮产出的文件路径（相对工作区）' }),
    ),
    summary: Type.Optional(Type.String({ description: '一两句话总结完成情况' })),
  }),
  async execute(args, ctx) {
    const declared = Array.isArray(args.artifacts)
      ? args.artifacts.filter((a): a is string => typeof a === 'string')
      : [];
    const summary = typeof args.summary === 'string' ? args.summary : '';
    const existing: string[] = [];
    const missing: string[] = [];
    for (const rel of declared) {
      const abs = resolveWithinWorkspace(ctx.workspacePath, rel);
      const stat = await fsp.stat(abs).catch(() => null);
      if (stat?.isFile()) {
        existing.push(rel);
      } else {
        missing.push(rel);
      }
    }
    const parts: string[] = ['finish 已接受。'];
    if (summary) {
      parts.push(`总结: ${summary}`);
    }
    if (existing.length > 0) {
      parts.push(`已确认产出文件:\n- ${existing.join('\n- ')}`);
    } else {
      parts.push('未列出任何产出文件。');
    }
    if (missing.length > 0) {
      parts.push(`[警告] 以下声明的产出文件不存在: ${missing.join(', ')}`);
    }
    return parts.join('\n');
  },
};

/** 工作区工具集（顺序即建议的使用顺序，run_python 为核心工具）。 */
export const WORKSPACE_TOOLS: AgentToolSpec[] = [
  listFilesSpec,
  readFileSpec,
  runPythonSpec,
  writeFileSpec,
  finishSpec,
];

/** 带 timeout 的 Promise 包装（竞速输方由 Promise.race 内部消化，无悬挂句柄）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/**
 * 工具统一入口：按名称调度、兜底超时（工具自身超时 +5s 硬上限）、
 * 截断输出（4000 字符）、把异常转为 ok=false 的文本结果。
 */
export async function executeWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolRunResult> {
  const spec = WORKSPACE_TOOLS.find((tool) => tool.name === name);
  if (!spec) {
    return { ok: false, output: `未知工具: ${name}` };
  }
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  try {
    const output = await withTimeout(
      spec.execute(args, ctx, signal),
      timeoutMs + 5000,
      `工具 ${name} 整体超时`,
    );
    return { ok: true, output: truncateToolOutput(output) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: truncateToolOutput(`工具 ${name} 执行失败: ${message}`) };
  }
}
