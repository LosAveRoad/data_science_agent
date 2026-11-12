import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 单个 Artifact 的引用信息（节点之间只通过文件 Artifact 传递信息）。 */
export interface ArtifactRef {
  /** 产出该 Artifact 的节点 ID。 */
  nodeId: string;
  /** Artifact 名称（save 时的文件名，可含相对子目录）。 */
  name: string;
  /** 文件绝对路径。 */
  path: string;
  /** 文件字节数。 */
  bytes: number;
  /** 保存 / 注册时间（ISO 8601）。 */
  savedAt: string;
}

/** Artifact 存取失败（非法名称、目录穿越、JSON 序列化 / 解析失败、文件缺失等）时抛出。 */
export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

/** 基础校验：非空字符串且不含空字符。 */
function assertValidSegment(kind: 'nodeId' | 'name', value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArtifactStoreError(`Artifact ${kind} 不能为空`);
  }
  if (value.includes('\0')) {
    throw new ArtifactStoreError(`Artifact ${kind} 不能包含空字符: ${JSON.stringify(value)}`);
  }
}

/** nodeId 必须是单一路径段（不允许路径分隔符与点段），非法时抛出。 */
function assertValidNodeId(nodeId: string): void {
  assertValidSegment('nodeId', nodeId);
  if (nodeId === '.' || nodeId === '..' || nodeId.includes('/') || nodeId.includes('\\')) {
    throw new ArtifactStoreError(
      `Artifact nodeId 必须是单一路径段，不允许包含分隔符或点段: ${JSON.stringify(nodeId)}`,
    );
  }
}

/** 名称中不允许出现 `..` 路径段（防穿越，先于解析直接拒绝）。 */
function assertNoDotDotSegment(kind: 'name', value: string): void {
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === '..')) {
    throw new ArtifactStoreError(`Artifact ${kind} 不允许包含 ".." 路径段: ${JSON.stringify(value)}`);
  }
}

/**
 * 目录穿越防护：解析后的目标路径必须位于 root 内部
 *（不允许 .. 逃逸到根目录之外，也不允许恰好指向根目录本身）。
 */
function assertInsideRoot(root: string, target: string, label: string): void {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new ArtifactStoreError(`${label} 越出 ArtifactStore 根目录，拒绝访问: ${target}`);
  }
  if (target === root) {
    throw new ArtifactStoreError(`${label} 不能指向 ArtifactStore 根目录本身: ${target}`);
  }
}

/**
 * Artifact 存取器，根目录为一个 run 的 artifacts 目录（`<runDir>/artifacts`）。
 *
 * - `save`：把内容 JSON 序列化后写入 `<root>/<nodeId>/<name>` 并登记引用。
 * - `load`：按引用读回 JSON 内容（读取路径强制做目录穿越防护）。
 * - `register`：登记 Agent 节点直接写盘产生的外部产物文件（如任务工作区内的文件）。
 * - `list`：列出本次进程内登记的产物引用。
 */
export class ArtifactStore {
  /** 根目录（构造时归一化为绝对路径）。 */
  private readonly rootDir: string;
  /** 产物注册表：nodeId → (name → ref)。同一 (nodeId, name) 重复保存时覆盖。 */
  private readonly registry = new Map<string, Map<string, ArtifactRef>>();

  constructor(root: string) {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new ArtifactStoreError('ArtifactStore 根目录不能为空');
    }
    this.rootDir = path.resolve(root);
  }

  /** 根目录绝对路径。 */
  get rootPath(): string {
    return this.rootDir;
  }

  /**
   * 将内容 JSON 序列化后写入 `<root>/<nodeId>/<name>`，返回产物引用。
   * nodeId / name 中的 `..`、绝对路径等越界写法会被目录穿越防护拒绝。
   */
  async save(nodeId: string, name: string, content: unknown): Promise<ArtifactRef> {
    assertValidNodeId(nodeId);
    assertValidSegment('name', name);
    assertNoDotDotSegment('name', name);
    const target = path.resolve(this.rootDir, nodeId, name);
    assertInsideRoot(
      this.rootDir,
      target,
      `Artifact 写入路径 ${JSON.stringify(nodeId)}/${JSON.stringify(name)}`,
    );

    let json: string | undefined;
    try {
      json = JSON.stringify(content, null, 2);
    } catch (err) {
      throw new ArtifactStoreError(
        `Artifact ${nodeId}/${name} 内容无法序列化为 JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof json !== 'string') {
      throw new ArtifactStoreError(`Artifact ${nodeId}/${name} 内容无法序列化为 JSON（结果为空）`);
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, json, 'utf8');

    const ref: ArtifactRef = {
      nodeId,
      name,
      path: target,
      bytes: Buffer.byteLength(json, 'utf8'),
      savedAt: new Date().toISOString(),
    };
    this.putRef(ref);
    return ref;
  }

  /**
   * 按 ArtifactRef 读回 JSON 内容。
   * 读取路径重新做目录穿越防护：ref.path 解析后必须仍位于根目录内，
   * 拒绝 `..` 逃逸与指向根目录之外的路径。
   */
  async load<T>(ref: ArtifactRef): Promise<T> {
    if (ref === null || typeof ref !== 'object' || typeof ref.path !== 'string') {
      throw new ArtifactStoreError('ArtifactRef 缺少合法的 path 字段');
    }
    const target = path.resolve(this.rootDir, ref.path);
    assertInsideRoot(this.rootDir, target, 'Artifact 读取路径');

    let raw: string;
    try {
      raw = await readFile(target, 'utf8');
    } catch (err) {
      throw new ArtifactStoreError(
        `无法读取产物文件 ${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new ArtifactStoreError(`产物文件不是合法 JSON: ${target}`);
    }
  }

  /**
   * 登记一个由外部（如 Agent 节点）直接写盘产生的产物文件。
   *
   * 与 save 不同：不写文件，且不要求路径位于根目录内（产物通常位于任务工作区），
   * 但要求文件已存在且是常规文件。供 DagExecutor 把节点结果产物登记进注册表。
   */
  async register(nodeId: string, name: string, filePath: string): Promise<ArtifactRef> {
    assertValidNodeId(nodeId);
    assertValidSegment('name', name);
    assertNoDotDotSegment('name', name);
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new ArtifactStoreError(`Artifact ${nodeId}/${name} 的文件路径不能为空`);
    }
    const target = path.resolve(filePath);
    let stats;
    try {
      stats = await stat(target);
    } catch {
      throw new ArtifactStoreError(`注册产物失败，文件不存在: ${target}（${nodeId}/${name}）`);
    }
    if (!stats.isFile()) {
      throw new ArtifactStoreError(`注册产物失败，路径不是常规文件: ${target}（${nodeId}/${name}）`);
    }
    const ref: ArtifactRef = {
      nodeId,
      name,
      path: target,
      bytes: stats.size,
      savedAt: new Date().toISOString(),
    };
    this.putRef(ref);
    return ref;
  }

  /** 列出注册表中的产物引用；传入 nodeId 时只返回该节点的产物。 */
  list(nodeId?: string): ArtifactRef[] {
    if (nodeId !== undefined) {
      return [...(this.registry.get(nodeId)?.values() ?? [])];
    }
    const all: ArtifactRef[] = [];
    for (const byName of this.registry.values()) {
      all.push(...byName.values());
    }
    return all;
  }

  private putRef(ref: ArtifactRef): void {
    let byName = this.registry.get(ref.nodeId);
    if (!byName) {
      byName = new Map<string, ArtifactRef>();
      this.registry.set(ref.nodeId, byName);
    }
    byName.set(ref.name, ref);
  }
}
