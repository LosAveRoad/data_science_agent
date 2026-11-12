import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  schemaForArtifact,
  validateAnalysisPlan,
  validateArtifactContent,
  validateArtifactFile,
  validateDataProfile,
} from '../src/artifacts/schemas.js';
import { createTaskOutputGate, verifyOutputGate } from '../src/validate/gate.js';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'dsa-validate-test-'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** 合法的 data_profile 样例。 */
function validProfile(): unknown {
  return {
    files: [
      {
        name: 'data/sales.csv',
        rows: 120,
        columns: [
          { name: 'id', dtype: 'int' },
          { name: 'amount', dtype: 'float' },
        ],
        stats: { amount_mean: 42.5 },
        quality_issues: ['amount 列有 3 个缺失值'],
      },
    ],
  };
}

/** 合法的 analysis_plan 样例。 */
function validPlan(): unknown {
  return {
    steps: [
      { description: '读取并清洗数据', tools: ['run_python'], expected_outputs: ['clean.csv'] },
      { description: '汇总并写出结果' },
    ],
  };
}

describe('artifact schema / 文件名映射', () => {
  it('data_profile.json 与 analysis_plan.json 映射到对应 schema，其他产物返回 null', () => {
    expect(schemaForArtifact('data_profile.json')).toBe('data_profile');
    expect(schemaForArtifact('analysis_plan.json')).toBe('analysis_plan');
    expect(schemaForArtifact('execute_summary.json')).toBeNull();
    expect(schemaForArtifact('verification.json')).toBeNull();
    expect(schemaForArtifact('output.csv')).toBeNull();
  });
});

describe('artifact schema / data_profile', () => {
  it('合法样例通过且允许额外字段', () => {
    expect(validateDataProfile(validProfile())).toEqual([]);
  });

  it('非对象顶层、缺 files、空 files 都被拦截', () => {
    expect(validateDataProfile(null)).toHaveLength(1);
    expect(validateDataProfile([1])).toHaveLength(1);
    expect(validateDataProfile({})).toMatchObject(['缺少 files 数组（须列出工作区全部数据文件的结构概览）']);
    expect(validateDataProfile({ files: [] })).toMatchObject(['files 数组为空：工作区存在数据文件时必须逐个列出']);
  });

  it('文件条目结构缺陷逐项报告', () => {
    const problems = validateDataProfile({
      files: [
        { rows: -1, columns: 'oops' },
        { name: 'b.csv', rows: 3, columns: [{ dtype: 'int' }] },
        'not-an-object',
      ],
    });
    const joined = problems.join('; ');
    expect(joined).toMatch(/files\[0\]\.name/);
    expect(joined).toMatch(/files\[0\]\.rows/);
    expect(joined).toMatch(/files\[0\]\.columns 必须是数组/);
    expect(joined).toMatch(/files\[1\]\.columns\[0\]\.name/);
    expect(joined).toMatch(/files\[2\] 必须是对象/);
  });

  it('rows 允许 null（无法统计行数时）', () => {
    const content = { files: [{ name: 'a.csv', rows: null, columns: [{ name: 'x', dtype: 'str' }] }] };
    expect(validateDataProfile(content)).toEqual([]);
  });
});

describe('artifact schema / analysis_plan', () => {
  it('合法样例通过', () => {
    expect(validateAnalysisPlan(validPlan())).toEqual([]);
  });

  it('缺 steps / 空 steps / 步骤缺 description 被拦截', () => {
    expect(validateAnalysisPlan({})).toMatchObject(['缺少 steps 数组（机器可读的分析步骤清单）']);
    expect(validateAnalysisPlan({ steps: [] })).toMatchObject(['steps 数组为空：分析计划必须包含至少一个步骤']);
    const problems = validateAnalysisPlan({ steps: [{ tools: ['run_python'] }, 'oops'] });
    expect(problems.join('; ')).toMatch(/steps\[0\]\.description/);
    expect(problems.join('; ')).toMatch(/steps\[1\] 必须是对象/);
  });

  it('validateArtifactContent 按 schema ID 分发', () => {
    expect(validateArtifactContent('analysis_plan', validPlan())).toEqual([]);
    expect(validateArtifactContent('data_profile', { steps: [] }).length).toBeGreaterThan(0);
  });
});

describe('artifact schema / validateArtifactFile', () => {
  it('文件缺失与非 JSON 内容都返回问题清单', async () => {
    const missing = await validateArtifactFile('data_profile', path.join(tmpRoot, 'no-such-file.json'));
    expect(missing).toHaveLength(1);

    const badPath = path.join(tmpRoot, 'bad.json');
    await writeFile(badPath, 'not json at all', 'utf8');
    const problems = await validateArtifactFile('analysis_plan', badPath);
    expect(problems.join('; ')).toMatch(/不是合法 JSON/);
  });

  it('合法文件通过', async () => {
    const goodPath = path.join(tmpRoot, 'good-plan.json');
    await writeFile(goodPath, JSON.stringify(validPlan()), 'utf8');
    expect(await validateArtifactFile('analysis_plan', goodPath)).toEqual([]);
  });
});

describe('verifyOutputGate / 程序化验证门', () => {
  it('空期望列表直接通过', async () => {
    expect(await verifyOutputGate(tmpRoot, [])).toEqual([]);
  });

  it('缺失与非空检查', async () => {
    const ws = path.join(tmpRoot, 'gate-basic');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'a.txt'), 'hello', 'utf8');
    await writeFile(path.join(ws, 'empty.txt'), '', 'utf8');

    const problems = await verifyOutputGate(ws, ['a.txt', 'empty.txt', 'missing.txt']);
    expect(problems).toEqual(['empty.txt: 文件为空', 'missing.txt: 文件缺失']);
  });

  it('CSV：合法数据行通过；只有表头 / 全空值行被拦截', async () => {
    const ws = path.join(tmpRoot, 'gate-csv');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'good.csv'), 'id,value\n1,10\n2,20\n', 'utf8');
    await writeFile(path.join(ws, 'header-only.csv'), 'id,value\n', 'utf8');
    await writeFile(path.join(ws, 'all-nan.csv'), 'id,value\nNaN,None\nnull,\n', 'utf8');

    expect(await verifyOutputGate(ws, ['good.csv'])).toEqual([]);
    const problems = await verifyOutputGate(ws, ['header-only.csv', 'all-nan.csv']);
    expect(problems.join('; ')).toMatch(/header-only\.csv: 只有表头或内容为空/);
    expect(problems.join('; ')).toMatch(/all-nan\.csv: 采样 2 条数据行的全部单元格均为空值/);
  });

  it('JSON / JSONL：非法内容被拦截，合法内容通过', async () => {
    const ws = path.join(tmpRoot, 'gate-json');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'ok.json'), '{"a":1}', 'utf8');
    await writeFile(path.join(ws, 'bad.json'), '{a:1}', 'utf8');
    await writeFile(path.join(ws, 'ok.jsonl'), '{"a":1}\n{"a":2}\n', 'utf8');
    await writeFile(path.join(ws, 'bad.jsonl'), '{"a":1}\nnope\n', 'utf8');

    expect(await verifyOutputGate(ws, ['ok.json', 'ok.jsonl'])).toEqual([]);
    const problems = await verifyOutputGate(ws, ['bad.json', 'bad.jsonl']);
    expect(problems.join('; ')).toMatch(/bad\.json: 不是合法 JSON/);
    expect(problems.join('; ')).toMatch(/bad\.jsonl: 第 2 行不是合法 JSON/);
  });

  it('PNG：真实文件头通过，文本占位被拦截', async () => {
    const ws = path.join(tmpRoot, 'gate-png');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'real.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
    await writeFile(path.join(ws, 'fake.png'), 'pretend image', 'utf8');

    expect(await verifyOutputGate(ws, ['real.png'])).toEqual([]);
    const problems = await verifyOutputGate(ws, ['fake.png']);
    expect(problems).toEqual(['fake.png: 不是有效的 PNG 文件（缺少文件头，可能写入了文本占位内容）']);
  });

  it('输出文件可位于子目录（按 basename 匹配，与 collectTaskOutputs 口径一致）', async () => {
    const ws = path.join(tmpRoot, 'gate-subdir');
    await mkdir(path.join(ws, 'sub'), { recursive: true });
    await writeFile(path.join(ws, 'sub', 'out.csv'), 'id,v\n1,2\n', 'utf8');
    expect(await verifyOutputGate(ws, ['out.csv'])).toEqual([]);
  });

  it('工作区不存在时报告错误', async () => {
    const problems = await verifyOutputGate(path.join(tmpRoot, 'no-such-ws'), ['a.txt']);
    expect(problems).toHaveLength(1);
  });
});

describe('createTaskOutputGate / 按任务挂接', () => {
  it('只对 execute 节点生效，其他节点直接放行', async () => {
    const ws = path.join(tmpRoot, 'gate-task');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'output.csv'), 'id,v\n1,2\n', 'utf8');
    const gate = createTaskOutputGate({ id: 'task_01', outputFileName: ['output.csv'] });

    expect(await gate('inspect', ['data_profile.json'], ws)).toEqual([]);
    expect(await gate('verify', ['verification.json'], ws)).toEqual([]);
    expect(await gate('execute', ['output.csv', 'execute_summary.json'], ws)).toEqual([]);
  });

  it('execute 节点的输出缺失时返回问题清单', async () => {
    const ws = path.join(tmpRoot, 'gate-task-missing');
    await mkdir(ws, { recursive: true });
    const gate = createTaskOutputGate({ id: 'task_01', outputFileName: ['output.csv'] });
    const problems = await gate('execute', ['output.csv'], ws);
    expect(problems).toEqual(['output.csv: 文件缺失']);
  });
});
