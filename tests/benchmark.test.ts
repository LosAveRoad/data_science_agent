import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadAllTasks,
  loadTaskSubset,
  subsetFromConfig,
  type BenchmarkTask,
} from '../src/benchmark/task-loader.js';
import { WorkspaceError, collectTaskOutputs, prepareWorkspace } from '../src/benchmark/workspace.js';

/** mini dev.jsonl 的两条任务：task_01 全部字段为列表，task_02 关键字段为 string（测试归一化）。 */
const task01Raw = {
  id: 'task_01',
  question: '分析销售数据并输出汇总表',
  data_sources: ['data_a.csv', 'sub/nested.csv'],
  skills: ['eda', 'statistics'],
  domain: 'demo',
  output_file_name: ['output.csv'],
  gold_file_name: ['result.csv'],
  eval_func: ['compare_csv(output_file_name=\'output.csv\')'],
};
const task02Raw = {
  id: 'task_02',
  question: '对嵌套数据做可视化',
  data_sources: 'data_a.csv',
  skills: 'visualization',
  domain: 'demo',
  output_file_name: 'out2.json',
  gold_file_name: 'gold2.json',
  eval_func: 'compare_json()',
  // 官方文件中的多余字段，loader 应忽略
  post_process_func: ['noop'],
};

let dataDir: string;
let tmpRoot: string;

/** 在临时 dataDir 下准备 tasks/dev.jsonl 与 datasets 文件。 */
function buildMiniDataDir(root: string): void {
  mkdirSync(path.join(root, 'tasks'), { recursive: true });
  writeFileSync(
    path.join(root, 'tasks', 'dev.jsonl'),
    [
      JSON.stringify(task01Raw),
      '', // 空行应被跳过
      JSON.stringify(task02Raw),
    ].join('\n'),
    'utf8',
  );

  mkdirSync(path.join(root, 'datasets', 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'datasets', 'data_a.csv'), 'a,b\n1,2\n', 'utf8');
  writeFileSync(path.join(root, 'datasets', 'sub', 'nested.csv'), 'x\n9\n', 'utf8');
}

function findTask(tasks: BenchmarkTask[], id: string): BenchmarkTask {
  const task = tasks.find((item) => item.id === id);
  if (!task) {
    throw new Error(`测试数据中不存在任务 ${id}`);
  }
  return task;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'dsa-benchmark-test-'));
  dataDir = path.join(tmpRoot, 'data');
  buildMiniDataDir(dataDir);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('task-loader / loadAllTasks', () => {
  it('正常加载全部任务并映射为 camelCase 字段', async () => {
    const tasks = await loadAllTasks(dataDir);
    expect(tasks.map((task) => task.id)).toEqual(['task_01', 'task_02']);

    const first = findTask(tasks, 'task_01');
    expect(first.question).toBe('分析销售数据并输出汇总表');
    expect(first.domain).toBe('demo');
    expect(first.dataSources).toEqual(['data_a.csv', 'sub/nested.csv']);
    expect(first.skills).toEqual(['eda', 'statistics']);
    expect(first.outputFileName).toEqual(['output.csv']);
    expect(first.goldFileName).toEqual(['result.csv']);
    expect(first.evalFunc).toEqual(['compare_csv(output_file_name=\'output.csv\')']);
  });

  it('字段归一化：string 字段包装为单元素列表，多余字段被忽略', async () => {
    const tasks = await loadAllTasks(dataDir);
    const second = findTask(tasks, 'task_02');
    expect(second.dataSources).toEqual(['data_a.csv']);
    expect(second.skills).toEqual(['visualization']);
    expect(second.outputFileName).toEqual(['out2.json']);
    expect(second.goldFileName).toEqual(['gold2.json']);
    expect(second.evalFunc).toEqual(['compare_json()']);
    expect((second as unknown as Record<string, unknown>)['post_process_func']).toBeUndefined();
  });

  it('dev.jsonl 不存在时抛出含路径的错误', async () => {
    await expect(loadAllTasks(path.join(tmpRoot, 'no-such-dir'))).rejects.toThrow(/dev\.jsonl/);
  });

  it('非法 JSON 行抛出带行号的错误', async () => {
    const badDir = path.join(tmpRoot, 'bad-data');
    buildMiniDataDir(badDir);
    writeFileSync(path.join(badDir, 'tasks', 'dev.jsonl'), '{not-json}\n', 'utf8');
    await expect(loadAllTasks(badDir)).rejects.toThrow(/第 1 行/);
  });
});

describe('task-loader / loadTaskSubset', () => {
  it('按传入顺序返回子集', async () => {
    const tasks = await loadTaskSubset(dataDir, ['task_02', 'task_01']);
    expect(tasks.map((task) => task.id)).toEqual(['task_02', 'task_01']);
  });

  it('未知 ID 抛出并列出全部缺失 ID', async () => {
    await expect(loadTaskSubset(dataDir, ['task_01', 'ghost_a', 'ghost_b'])).rejects.toThrow(
      /ghost_a, ghost_b/,
    );
  });
});

describe('task-loader / subsetFromConfig', () => {
  it('从配置文件读取 task_ids 并加载子集', async () => {
    const configPath = path.join(tmpRoot, 'benchmark.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '2026-11-12',
        selection_criteria: '测试用选样标准',
        task_ids: ['task_01', 'task_02'],
      }),
      'utf8',
    );
    const tasks = await subsetFromConfig(dataDir, configPath);
    expect(tasks.map((task) => task.id)).toEqual(['task_01', 'task_02']);
  });

  it('兼容 tasks 字段：对象列表（带 id）与字符串列表均可', async () => {
    const objectListPath = path.join(tmpRoot, 'config-tasks-objects.json');
    writeFileSync(
      objectListPath,
      JSON.stringify({
        version: '2026-11-12',
        selection_criteria: ['数据集 < 50MB', '覆盖多 skill cluster'],
        tasks: [
          { id: 'task_01', domain: 'demo', data_size_mb: 0.1 },
          { id: 'task_02', domain: 'demo', data_size_mb: 0.2 },
        ],
      }),
      'utf8',
    );
    expect((await subsetFromConfig(dataDir, objectListPath)).map((task) => task.id)).toEqual([
      'task_01',
      'task_02',
    ]);

    const stringListPath = path.join(tmpRoot, 'config-tasks-strings.json');
    writeFileSync(
      stringListPath,
      JSON.stringify({ tasks: ['task_02', 'task_01'] }),
      'utf8',
    );
    expect((await subsetFromConfig(dataDir, stringListPath)).map((task) => task.id)).toEqual([
      'task_02',
      'task_01',
    ]);
  });

  it('配置中既无 task_ids 也无 tasks 时报错', async () => {
    const configPath = path.join(tmpRoot, 'bad-config.json');
    writeFileSync(configPath, JSON.stringify({ version: 'x' }), 'utf8');
    await expect(subsetFromConfig(dataDir, configPath)).rejects.toThrow(/task_ids/);
  });

  it('task_ids 类型非法时报错', async () => {
    const configPath = path.join(tmpRoot, 'bad-task-ids.json');
    writeFileSync(configPath, JSON.stringify({ task_ids: ['task_01', 42] }), 'utf8');
    await expect(subsetFromConfig(dataDir, configPath)).rejects.toThrow(/task_ids/);
  });
});

describe('workspace / prepareWorkspace', () => {
  it('在 workspaces/<task.id> 建立工作区并按相对路径结构复制数据源', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-'));
    const task = findTask(await loadAllTasks(dataDir), 'task_01');

    const info = await prepareWorkspace(runDir, task, dataDir);

    expect(path.resolve(info.workspacePath)).toBe(
      path.resolve(runDir, 'workspaces', 'task_01'),
    );
    expect(info.copiedFiles).toHaveLength(2);
    for (const copied of info.copiedFiles) {
      expect(path.isAbsolute(copied)).toBe(true);
    }
    expect(info.copiedFiles).toContain(path.join(info.workspacePath, 'data_a.csv'));
    // 保留 data_sources 中的子目录结构
    expect(existsSync(path.join(info.workspacePath, 'sub', 'nested.csv'))).toBe(true);
  });

  it('源文件缺失时抛错并列出完整缺失清单，且不创建工作区', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-'));
    const task: BenchmarkTask = {
      ...findTask(await loadAllTasks(dataDir), 'task_01'),
      dataSources: ['data_a.csv', 'missing_1.csv', 'missing_2.csv'],
    };

    await expect(prepareWorkspace(runDir, task, dataDir)).rejects.toThrow(
      /missing_1\.csv[\s\S]*missing_2\.csv/,
    );
    await expect(prepareWorkspace(runDir, task, dataDir)).rejects.toThrow(WorkspaceError);
    expect(existsSync(path.join(runDir, 'workspaces', task.id))).toBe(false);
  });

  it('工作区已存在时重复准备不报错（覆盖复制）', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-'));
    const task = findTask(await loadAllTasks(dataDir), 'task_01');

    const first = await prepareWorkspace(runDir, task, dataDir);
    const second = await prepareWorkspace(runDir, task, dataDir);
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(second.copiedFiles).toHaveLength(2);
  });
});

describe('workspace / collectTaskOutputs', () => {
  it('递归查找文件名匹配的输出文件，返回排序后的绝对路径', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-'));
    const task = findTask(await loadAllTasks(dataDir), 'task_01');
    const info = await prepareWorkspace(runDir, task, dataDir);

    // Agent 产出：根目录与子目录各有一个 output.csv，另有无关文件
    mkdirSync(path.join(info.workspacePath, 'outputs', 'deep'), { recursive: true });
    writeFileSync(path.join(info.workspacePath, 'output.csv'), 'col\n', 'utf8');
    writeFileSync(path.join(info.workspacePath, 'outputs', 'deep', 'output.csv'), 'col\n', 'utf8');
    writeFileSync(path.join(info.workspacePath, 'notes.txt'), 'unrelated\n', 'utf8');

    const outputs = await collectTaskOutputs(info.workspacePath, task);
    expect(outputs).toHaveLength(2);
    for (const filePath of outputs) {
      expect(path.isAbsolute(filePath)).toBe(true);
    }
    expect(outputs).toEqual([...outputs].sort());
    expect(outputs.some((filePath) => filePath.startsWith(info.workspacePath))).toBe(true);
    // task_02 的输出名不应被 task_01 收集到
    const task02 = findTask(await loadAllTasks(dataDir), 'task_02');
    expect(await collectTaskOutputs(info.workspacePath, task02)).toEqual([]);
  });

  it('无输出文件时返回空列表', async () => {
    const runDir = mkdtempSync(path.join(tmpRoot, 'run-'));
    const task = findTask(await loadAllTasks(dataDir), 'task_01');
    const info = await prepareWorkspace(runDir, task, dataDir);
    expect(await collectTaskOutputs(info.workspacePath, task)).toEqual([]);
  });

  it('工作区不存在时抛出 WorkspaceError', async () => {
    const task = findTask(await loadAllTasks(dataDir), 'task_01');
    await expect(collectTaskOutputs(path.join(tmpRoot, 'ghost-workspace'), task)).rejects.toThrow(
      WorkspaceError,
    );
  });
});
