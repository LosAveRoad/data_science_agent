import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ArtifactStore, ArtifactStoreError } from '../src/artifacts/store.js';
import { RecorderError, RunRecorder } from '../src/tracing/recorder.js';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsa-infra-test-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ArtifactStore / save 与 load', () => {
  it('save 写出 JSON 文件并返回引用，load 能读回原内容', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-1'));
    const content = { columns: ['a', 'b'], rows: 3 };
    const ref = await store.save('inspect', 'data_profile.json', content);

    expect(ref.nodeId).toBe('inspect');
    expect(ref.name).toBe('data_profile.json');
    expect(ref.path).toBe(path.resolve(store.rootPath, 'inspect', 'data_profile.json'));
    expect(ref.bytes).toBeGreaterThan(0);
    expect(typeof ref.savedAt).toBe('string');
    expect(existsSync(ref.path)).toBe(true);

    const loaded = await store.load<{ columns: string[]; rows: number }>(ref);
    expect(loaded).toEqual(content);
  });

  it('同名重复保存覆盖旧文件与旧引用', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-overwrite'));
    await store.save('inspect', 'a.json', { v: 1 });
    const second = await store.save('inspect', 'a.json', { v: 2 });

    expect(store.list('inspect')).toHaveLength(1);
    expect(await store.load<{ v: number }>(second)).toEqual({ v: 2 });
  });

  it('list 按 nodeId 过滤登记的产物', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-list'));
    await store.save('inspect', 'a.json', { v: 1 });
    await store.save('plan', 'b.json', { v: 2 });

    expect(store.list().map((ref) => `${ref.nodeId}/${ref.name}`).sort()).toEqual([
      'inspect/a.json',
      'plan/b.json',
    ]);
    expect(store.list('inspect').map((ref) => ref.name)).toEqual(['a.json']);
    expect(store.list('ghost')).toEqual([]);
  });

  it('register 登记根目录之外已存在的产物文件', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-register'));
    mkdirSync(path.join(tmpRoot, 'workspace-out'), { recursive: true });
    const outside = path.join(tmpRoot, 'workspace-out', 'result.json');
    writeFileSync(outside, '{"v":1}', 'utf8');

    const ref = await store.register('execute', 'result.json', outside);
    expect(ref.path).toBe(path.resolve(outside));
    expect(ref.bytes).toBeGreaterThan(0);
    expect(store.list('execute')).toHaveLength(1);

    await expect(store.register('execute', 'missing.json', path.join(tmpRoot, 'no-such-file.json'))).rejects.toThrow(
      ArtifactStoreError,
    );
  });
});

describe('ArtifactStore / 目录穿越防护', () => {
  it('save 拒绝 .. 逃逸与非法 nodeId，且不产生外部文件', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-guard'));
    await expect(store.save('inspect', '../escape.json', { v: 1 })).rejects.toThrow(ArtifactStoreError);
    await expect(store.save('..', 'a.json', { v: 1 })).rejects.toThrow(ArtifactStoreError);
    await expect(store.save('a/b', 'a.json', { v: 1 })).rejects.toThrow(ArtifactStoreError);
    await expect(store.save('inspect', '/tmp/absolute.json', { v: 1 })).rejects.toThrow(ArtifactStoreError);
    expect(existsSync(path.join(tmpRoot, 'escape.json'))).toBe(false);
  });

  it('load 拒绝根目录之外的路径与 .. 逃逸', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-load-guard'));
    const outside = path.join(tmpRoot, 'outside.json');
    writeFileSync(outside, '{"v":1}', 'utf8');

    const fakeRef = { nodeId: 'inspect', name: 'x.json', path: outside, bytes: 1, savedAt: '' };
    await expect(store.load(fakeRef)).rejects.toThrow(ArtifactStoreError);

    const escapeRef = {
      nodeId: 'inspect',
      name: 'x.json',
      path: path.join(store.rootPath, '..', 'outside.json'),
      bytes: 1,
      savedAt: '',
    };
    await expect(store.load(escapeRef)).rejects.toThrow(ArtifactStoreError);
  });

  it('load 对非法 JSON 与缺失文件抛出 ArtifactStoreError', async () => {
    const store = new ArtifactStore(path.join(tmpRoot, 'artifacts-json'));
    const ref = await store.save('inspect', 'bad.json', { v: 1 });
    writeFileSync(ref.path, '{not-json', 'utf8');
    await expect(store.load(ref)).rejects.toThrow(ArtifactStoreError);

    const ghostRef = { nodeId: 'inspect', name: 'ghost.json', path: path.join(store.rootPath, 'inspect', 'ghost.json'), bytes: 0, savedAt: '' };
    await expect(store.load(ghostRef)).rejects.toThrow(ArtifactStoreError);
  });
});

describe('RunRecorder / 步骤记录与 token 用量', () => {
  it('按节点与整个 run 累计 token 用量', () => {
    const recorder = new RunRecorder();
    recorder.startRun('exp-1', 'dag-prototype', 'task_01');

    recorder.startNode('inspect');
    recorder.recordStep({ kind: 'thought', content: '先看数据', tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    recorder.recordStep({ kind: 'tool_call', name: 'python', content: 'df.head()' });
    recorder.recordStep({ kind: 'observation', content: '5 rows' });
    recorder.endNode('succeeded');

    recorder.startNode('plan');
    recorder.recordStep({ kind: 'thought', content: '制定计划', tokenUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } });
    recorder.endNode('succeeded');

    expect(recorder.getNodeTokenUsage('inspect')).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(recorder.getNodeTokenUsage('plan')).toEqual({ inputTokens: 50, outputTokens: 10, totalTokens: 60 });
    expect(recorder.getTotalTokenUsage()).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });
    expect(recorder.listNodes().map((node) => node.status)).toEqual(['succeeded', 'succeeded']);
    expect(recorder.nodeRecord('inspect')?.steps).toHaveLength(3);
  });

  it('未 startNode 就 endNode 时抛出 RecorderError', () => {
    const recorder = new RunRecorder();
    expect(() => recorder.endNode('succeeded')).toThrow(RecorderError);
  });

  it('非法 tokenUsage 与非法 kind 抛出 RecorderError', () => {
    const recorder = new RunRecorder();
    recorder.startNode('inspect');
    expect(() =>
      recorder.recordStep({ kind: 'thought', content: 'x', tokenUsage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } }),
    ).toThrow(RecorderError);
    expect(() => recorder.recordStep({ kind: 'invalid' as never, content: 'x' })).toThrow(RecorderError);
    expect(() => recorder.recordStep({ kind: 'thought', content: 42 as never })).toThrow(RecorderError);
    recorder.endNode('succeeded');
  });
});

describe('RunRecorder / writeResultJson', () => {
  it('写出可被 JSON 解析且含 trajectory 数组的官方兼容 result.json', async () => {
    const recorder = new RunRecorder();
    recorder.startRun('exp-1', 'dag-prototype', 'task_01');
    recorder.startNode('inspect');
    recorder.recordStep({ kind: 'thought', content: '思考一', tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    recorder.recordStep({ kind: 'tool_call', name: 'python', content: 'df.head()\ndf.describe()' });
    recorder.recordStep({ kind: 'observation', content: '观察到 5 行样本' });
    recorder.endNode('succeeded');
    recorder.endRun({ status: 'succeeded', result: '完成' });

    const outDir = path.join(tmpRoot, 'task-output-1');
    await recorder.writeResultJson(outDir);

    const raw = await readFile(path.join(outDir, 'dabench', 'result.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const trajectory = parsed['trajectory'] as Array<Record<string, unknown>>;
    expect(Array.isArray(trajectory)).toBe(true);
    // 官方解析器对每项直接索引 action / observation，两项字段必须都是字符串
    for (const entry of trajectory) {
      expect(typeof entry['action']).toBe('string');
      expect(typeof entry['observation']).toBe('string');
    }

    // Think 步
    expect(trajectory[0]?.['action']).toBe('Think');
    expect(trajectory[0]?.['content']).toBe('思考一');
    const usage0 = trajectory[0]?.['usage'] as Record<string, number>;
    expect(usage0).toEqual({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
    const timing0 = trajectory[0]?.['timing'] as Record<string, number>;
    expect(typeof timing0['elapsed']).toBe('number');

    // 工具步：code 为调用内容，观察结果直接写进该步 observation 字段
    expect(trajectory[1]?.['action']).toBe('Python');
    expect(trajectory[1]?.['code']).toBe('df.head()\ndf.describe()');
    expect(trajectory[1]?.['observation']).toBe('观察到 5 行样本');

    // Observation 独立项
    expect(trajectory[2]?.['action']).toBe('Observation');
    expect(trajectory[2]?.['content']).toBe('观察到 5 行样本');

    // 官方解析器直接访问的顶层字段 + 额外的 token_usage 汇总
    expect(parsed['finished']).toBe(true);
    expect(parsed['steps']).toBe(3);
    expect(parsed['result']).toBe('完成');
    expect(parsed['result_files']).toEqual({ added_files: [], changed_files: [] });
    expect(parsed['token_usage']).toEqual({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  });
});

describe('RunRecorder / writeSummary', () => {
  it('写出 run 级汇总 JSON（节点状态 / 耗时 / token / 错误信息）', async () => {
    const recorder = new RunRecorder();
    recorder.startRun('exp-1', 'dag-prototype', 'task_01');
    recorder.startNode('inspect');
    recorder.recordStep({ kind: 'thought', content: 'x', tokenUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    recorder.endNode('succeeded');
    recorder.startNode('plan');
    recorder.endNode('failed', '模型超时');
    recorder.endRun({ status: 'failed', error: '节点 plan 失败: 模型超时' });

    const summaryPath = path.join(tmpRoot, 'summary-1.json');
    await recorder.writeSummary(summaryPath);

    const parsed = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['experimentId']).toBe('exp-1');
    expect(parsed['system']).toBe('dag-prototype');
    expect(parsed['taskId']).toBe('task_01');
    expect(parsed['status']).toBe('failed');
    expect(parsed['error']).toBe('节点 plan 失败: 模型超时');
    expect(parsed['tokenUsage']).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(typeof parsed['startedAt']).toBe('string');

    const nodes = parsed['nodes'] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node['nodeId'])).toEqual(['inspect', 'plan']);
    expect(nodes[0]?.['status']).toBe('succeeded');
    expect(nodes[0]?.['steps']).toBe(1);
    expect(typeof nodes[0]?.['elapsedMs']).toBe('number');
    expect(nodes[1]?.['status']).toBe('failed');
    expect(nodes[1]?.['error']).toBe('模型超时');
  });
});

describe('RunRecorder / restoreNode（断点续跑恢复轨迹）', () => {
  it('恢复历史节点后，用量汇总与轨迹输出包含历史内容', async () => {
    const recorder = new RunRecorder();
    recorder.startRun('exp-1', 'dag-prototype', 'task_01');
    recorder.restoreNode({
      nodeId: 'inspect',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      tokenUsage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
      steps: [{ kind: 'thought', content: '历史思考', at: '2026-01-01T00:00:01.000Z' }],
    });
    recorder.startNode('plan');
    recorder.recordStep({ kind: 'thought', content: '新思考', tokenUsage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } });
    recorder.endNode('succeeded');

    expect(recorder.getNodeTokenUsage('inspect')).toEqual({ inputTokens: 11, outputTokens: 5, totalTokens: 16 });
    expect(recorder.getTotalTokenUsage()).toEqual({ inputTokens: 15, outputTokens: 6, totalTokens: 21 });

    const outDir = path.join(tmpRoot, 'task-output-restore');
    await recorder.writeResultJson(outDir);
    const parsed = JSON.parse(await readFile(path.join(outDir, 'dabench', 'result.json'), 'utf8')) as Record<string, unknown>;
    const trajectory = parsed['trajectory'] as Array<Record<string, unknown>>;
    expect(trajectory.some((entry) => entry['action'] === 'Think' && entry['content'] === '历史思考')).toBe(true);
    expect(trajectory.some((entry) => entry['action'] === 'Think' && entry['content'] === '新思考')).toBe(true);
  });

  it('status 为 running 或 nodeId 为空时抛出 RecorderError', () => {
    const recorder = new RunRecorder();
    expect(() => recorder.restoreNode({ nodeId: 'inspect', status: 'running' as never })).toThrow(RecorderError);
    expect(() => recorder.restoreNode({ nodeId: '', status: 'succeeded' })).toThrow(RecorderError);
  });
});
