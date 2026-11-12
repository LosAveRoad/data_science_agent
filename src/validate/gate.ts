/**
 * 程序化验证门（#2 Phase A 升级点 4）：
 *
 * execute 节点声明成功后、LLM verify 之前的确定性检查（0 token，100% 可靠）：
 * 任务要求的每个输出文件必须存在、非空，且按扩展名做格式真实性检查
 * （CSV 要有数据行且不能全空、JSON / JSONL 要可解析、PNG 要有文件头）。
 * 检查不过 → execute 节点按失败处理并触发重试（问题清单回灌给 runner）。
 *
 * 语义层验证（结果是否正确、任务要求是否被覆盖）不属于本模块——由 verify 节点 /
 * Phase B 的修复回路接管；本模块只拦截「产出文件本身不成立」这类机械错误。
 */
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { walkFiles } from '../benchmark/workspace.js';
import type { NodeOutputGateFn } from '../dag/executor.js';

/** 单次读取的最大字节数（格式检查只需头部样本）。 */
const MAX_SAMPLE_BYTES = 128 * 1024;
/** CSV 数据行采样上限。 */
const MAX_SAMPLE_ROWS = 50;
/** PNG 文件签名（8 字节）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** JPEG 文件签名（3 字节）。 */
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** 视为「空值」的单元格文本（CSV 全空值判定用）。 */
const EMPTY_CELL_VALUES = new Set(['', 'nan', 'none', 'null', 'na', 'n/a', '-', '--']);

/** 读取文件前 maxBytes 字节（格式检查只需头部样本，不整读大文件）。 */
async function readHead(filePath: string, maxBytes = MAX_SAMPLE_BYTES): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** CSV 文本检查：至少有表头 + 一条数据行，且采样数据行不能全为空值。 */
function checkCsvText(text: string, problems: string[]): void {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    problems.push('只有表头或内容为空，缺少数据行');
    return;
  }
  const dataRows = lines.slice(1, 1 + MAX_SAMPLE_ROWS);
  let totalCells = 0;
  let meaningfulCells = 0;
  for (const row of dataRows) {
    for (const cell of row.split(',')) {
      totalCells += 1;
      if (!EMPTY_CELL_VALUES.has(cell.trim().toLowerCase())) {
        meaningfulCells += 1;
      }
    }
  }
  if (totalCells > 0 && meaningfulCells === 0) {
    problems.push(`采样 ${dataRows.length} 条数据行的全部单元格均为空值（NaN/None/空串）`);
  }
}

/** 按扩展名检查单个文件，追加问题到 problems。 */
async function checkFileByExtension(filePath: string, problems: string[]): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const head = await readHead(filePath, 8);
    const signature = ext === '.png' ? PNG_SIGNATURE : JPEG_SIGNATURE;
    if (head.length < signature.length || !head.subarray(0, signature.length).equals(signature)) {
      problems.push(`不是有效的 ${ext.slice(1).toUpperCase()} 文件（缺少文件头，可能写入了文本占位内容）`);
    }
    return;
  }
  if (ext === '.csv' || ext === '.tsv') {
    const head = await readHead(filePath);
    checkCsvText(head.toString('utf8').replace(/^\uFEFF/, ''), problems);
    return;
  }
  if (ext === '.json') {
    const raw = await readFile(filePath, 'utf8');
    try {
      JSON.parse(raw);
    } catch (err) {
      problems.push(`不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (ext === '.jsonl') {
    const head = await readHead(filePath);
    const lines = head.toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      problems.push('内容为空（没有任何 JSON 行）');
      return;
    }
    lines.forEach((line, index) => {
      try {
        JSON.parse(line);
      } catch (err) {
        problems.push(`第 ${index + 1} 行不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return;
  }
  // 其余扩展名（.txt / .md / .db / 无扩展名等）：仅要求非空（前面已统一检查）
}

/**
 * 程序化验证门：检查任务要求的输出文件在工作区内是否存在、非空且格式成立。
 * 文件按 basename 递归匹配（与 collectTaskOutputs 的收集口径一致）。
 * 返回问题清单（空列表 = 通过）。
 */
export async function verifyOutputGate(workspacePath: string, expectedFiles: readonly string[]): Promise<string[]> {
  if (expectedFiles.length === 0) {
    return [];
  }
  const allFiles: string[] = [];
  try {
    await walkFiles(workspacePath, allFiles);
  } catch {
    return [`工作区不存在或不可读: ${workspacePath}`];
  }
  const byBasename = new Map<string, string[]>();
  for (const filePath of allFiles) {
    const base = path.basename(filePath);
    byBasename.set(base, [...(byBasename.get(base) ?? []), filePath]);
  }

  const problems: string[] = [];
  for (const expected of expectedFiles) {
    const label = expected;
    const base = path.basename(expected);
    const candidates = byBasename.get(base) ?? [];
    if (candidates.length === 0) {
      problems.push(`${label}: 文件缺失`);
      continue;
    }
    for (const filePath of candidates) {
      const stats = await stat(filePath).catch(() => null);
      if (!stats?.isFile()) {
        problems.push(`${label}: 路径不是常规文件`);
        continue;
      }
      if (stats.size === 0) {
        problems.push(`${label}: 文件为空`);
        continue;
      }
      const before = problems.length;
      await checkFileByExtension(filePath, problems);
      // 扩展名检查的问题补上文件名前缀，便于回灌给 runner 定位
      for (let i = before; i < problems.length; i += 1) {
        problems[i] = `${label}: ${problems[i]}`;
      }
    }
  }
  return problems;
}

/**
 * 按任务构建 DagExecutor.outputGate：只对 execute 节点生效，检查任务要求的
 * 输出文件（task.outputFileName）成立与否；其他节点直接放行。
 */
export function createTaskOutputGate(task: { id: string; outputFileName: readonly string[] }): NodeOutputGateFn {
  return (nodeId, _declaredArtifacts, workspacePath) => {
    if (nodeId !== 'execute') {
      return [];
    }
    return verifyOutputGate(workspacePath, task.outputFileName);
  };
}
