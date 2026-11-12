import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { BenchmarkTask } from './task-loader.js';

/** 工作区准备或输出收集失败（数据源缺失、路径非法、工作区不存在等）时抛出。 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** prepareWorkspace 的返回信息。 */
export interface WorkspaceInfo {
  /** 任务隔离工作区的绝对路径：`<runDir>/workspaces/<task.id>/`。 */
  workspacePath: string;
  /** 已复制进工作区的文件绝对路径（目的地，按 data_sources 顺序）。 */
  copiedFiles: string[];
}

/** 任务数据源在 dataDir 下的根目录：`<dataDir>/datasets/`。 */
function datasetsDir(dataDir: string): string {
  return path.resolve(dataDir, 'datasets');
}

/** 目的地路径必须仍位于工作区内，防止 data_sources 中的 `..` 相对路径逃逸。 */
function assertInsideWorkspace(workspacePath: string, relPath: string, destPath: string): void {
  if (destPath !== workspacePath && !destPath.startsWith(workspacePath + path.sep)) {
    throw new WorkspaceError(`任务数据源相对路径非法（越出工作区）: ${relPath}`);
  }
}

/**
 * 为任务创建隔离工作区 `<runDir>/workspaces/<task.id>/`，并把 `data_sources`
 * 引用的文件从 `<dataDir>/datasets/` 复制进去（保留相对路径结构）。
 *
 * - 源目录先整体检查：任一源文件缺失时抛出 WorkspaceError，错误信息包含完整缺失清单（不产生半成品工作区）。
 * - 工作区目录已存在时不报错，直接覆盖复制（便于断点续跑与重复实验）。
 */
export async function prepareWorkspace(
  runDir: string,
  task: BenchmarkTask,
  dataDir: string,
): Promise<WorkspaceInfo> {
  const sourceRoot = datasetsDir(dataDir);
  const workspacePath = path.resolve(runDir, 'workspaces', task.id);

  // 相对路径归一化：去掉空白项
  const relSources = task.dataSources.map((rel) => rel.trim()).filter((rel) => rel.length > 0);

  // 先整体检查源文件是否齐全，避免复制到一半才失败
  const missing: string[] = [];
  for (const rel of relSources) {
    const sourcePath = path.resolve(sourceRoot, rel);
    try {
      const stats = await stat(sourcePath);
      if (!stats.isFile()) {
        missing.push(`${rel}（存在但不是常规文件）`);
      }
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    throw new WorkspaceError(
      `任务 ${task.id} 的数据源文件缺失，无法准备工作区（datasets 目录: ${sourceRoot}），缺失清单:\n` +
        missing.map((rel) => `  - ${rel}`).join('\n'),
    );
  }

  await mkdir(workspacePath, { recursive: true });
  const copiedFiles: string[] = [];
  for (const rel of relSources) {
    const destPath = path.resolve(workspacePath, rel);
    assertInsideWorkspace(workspacePath, rel, destPath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(path.resolve(sourceRoot, rel), destPath);
    copiedFiles.push(destPath);
  }

  return { workspacePath, copiedFiles };
}

/** 递归收集目录下的常规文件绝对路径。 */
async function walkFiles(dir: string, found: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(entryPath, found);
    } else if (entry.isFile()) {
      found.push(entryPath);
    }
  }
}

/**
 * 在任务工作区内递归查找与 `task.outputFileName` 文件名匹配的输出文件，
 * 返回绝对路径（按路径排序，保证结果确定性）。无匹配时返回空列表。
 */
export async function collectTaskOutputs(
  workspacePath: string,
  task: BenchmarkTask,
): Promise<string[]> {
  const root = path.resolve(workspacePath);
  try {
    const rootStats = await stat(root);
    if (!rootStats.isDirectory()) {
      throw new WorkspaceError(`工作区路径不是目录: ${root}`);
    }
  } catch (err) {
    if (err instanceof WorkspaceError) {
      throw err;
    }
    throw new WorkspaceError(`工作区不存在: ${root}（任务 ${task.id}）`);
  }

  const wanted = new Set(task.outputFileName);
  const allFiles: string[] = [];
  await walkFiles(root, allFiles);

  return allFiles
    .filter((filePath) => wanted.has(path.basename(filePath)))
    .sort();
}
