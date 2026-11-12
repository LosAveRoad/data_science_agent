import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgentRunner } from '../src/agent/mock-agent.js';
import type { AgentRunnerInput } from '../src/agent/pi-runtime.js';
import { buildModel, PiAgentRunner, resolveNodeModelConfig } from '../src/agent/pi-runtime.js';
import {
  adjudicatorSystemPrompt,
  challengerSystemPrompt,
  systemPromptForNode,
} from '../src/agent/prompts.js';
import { RunRecorder } from '../src/tracing/recorder.js';
import {
  executeWorkspaceTool,
  PathOutsideWorkspaceError,
  resolveWithinWorkspace,
  truncateToolOutput,
  type ToolContext,
} from '../src/agent/tools.js';

// 只测 mock 与工具层，不调真实 LLM API（真实连通性自检见 scripts/test-llm.ts）。

let workspace: string;

beforeEach(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsa-agent-test-'));
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

/** 构造 AgentRunnerInput（executor 契约：含 nodeId 与 recorder），workspacePath 指向当前临时工作区。 */
function makeInput(overrides: Partial<AgentRunnerInput> = {}): AgentRunnerInput {
  return {
    taskId: 'task-001',
    nodeId: 'test-node',
    question: '分析 data.csv 并输出 result.json',
    workspacePath: workspace,
    nodeTask: '检查数据文件、Schema 和样本，输出 data_profile.json',
    upstreamArtifacts: [],
    maxSteps: 8,
    runDir: workspace,
    recorder: new RunRecorder(),
    ...overrides,
  };
}

function toolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspacePath: workspace, ...overrides };
}

describe('MockAgentRunner', () => {
  it('成功剧本：按顺序写出 artifact JSON 并返回 succeeded', async () => {
    const runner = new MockAgentRunner({
      steps: [
        { path: 'data_profile.json', content: { rows: 100, columns: ['id', 'value'] } },
        { path: 'result.json', content: { answer: 42 } },
      ],
    });
    const result = await runner.run(makeInput());

    expect(result.status).toBe('succeeded');
    expect(result.steps).toBe(2);
    expect(result.artifacts).toHaveLength(2);
    expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(result.error).toBeUndefined();

    // artifact 是真实文件，内容为格式化 JSON
    const profile = JSON.parse(
      await fsp.readFile(path.join(workspace, 'data_profile.json'), 'utf-8'),
    ) as { rows: number };
    expect(profile.rows).toBe(100);
    expect(result.artifacts.map((a) => a.name)).toEqual(['data_profile.json', 'result.json']);

    // 步骤缓冲与 onStep 回调都可观测
    expect(runner.getSteps()).toHaveLength(2);
    const events: number[] = [];
    const runner2 = new MockAgentRunner({
      steps: [{ path: 'a.json', content: {} }],
      onStep: (step) => events.push(step.index),
    });
    await runner2.run(makeInput());
    expect(events).toEqual([1]);
  });

  it('失败剧本：failAfterStep 在第 N 步写出后返回 failed', async () => {
    const runner = new MockAgentRunner({
      steps: [
        { path: 'step1.json', content: { ok: true } },
        { path: 'step2.json', content: { ok: true } },
      ],
      failAfterStep: 1,
      errorMessage: '模拟执行失败',
    });
    const result = await runner.run(makeInput());

    expect(result.status).toBe('failed');
    expect(result.error).toBe('模拟执行失败');
    expect(result.steps).toBe(1);
    expect(result.artifacts).toHaveLength(1);
    await expect(fsp.readFile(path.join(workspace, 'step1.json'), 'utf-8')).resolves.toBeTruthy();
    await expect(fsp.stat(path.join(workspace, 'step2.json'))).rejects.toThrow();
  });

  it('超步剧本：exceedMaxSteps 空转后按护栏返回 failed（带 step_limit 信号）', async () => {
    const runner = new MockAgentRunner({ steps: [], exceedMaxSteps: true });
    const result = await runner.run(makeInput({ maxSteps: 3 }));

    expect(result.status).toBe('failed');
    expect(result.steps).toBe(3);
    expect(result.artifacts).toEqual([]);
    expect(result.tokenUsage.totalTokens).toBe(0);
    expect(result.error).toContain('已达最大 ReAct 步数上限');
    // stopReason 供 DagExecutor 判定「步数耗尽续跑」（#2 Phase A）
    expect(result.stopReason).toBe('step_limit');
  });

  it('Uint8Array 剧本内容按二进制写出（PNG 文件头占位）', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const runner = new MockAgentRunner({ steps: [{ path: 'output.png', content: new Uint8Array(pngHeader) }] });
    const result = await runner.run(makeInput());

    expect(result.status).toBe('succeeded');
    const written = await fsp.readFile(path.join(workspace, 'output.png'));
    expect(written.subarray(0, 8).equals(pngHeader)).toBe(true);
  });

  it('剧本内容为字符串时原样写出，不强制 JSON', async () => {
    const runner = new MockAgentRunner({
      steps: [{ path: 'notes.txt', content: 'plain text' }],
    });
    const result = await runner.run(makeInput());
    expect(result.status).toBe('succeeded');
    await expect(fsp.readFile(path.join(workspace, 'notes.txt'), 'utf-8')).resolves.toBe('plain text');
  });
});

describe('路径校验', () => {
  it('允许工作区内的相对路径与绝对路径', () => {
    expect(resolveWithinWorkspace(workspace, 'a/b.txt')).toBe(path.join(workspace, 'a', 'b.txt'));
    expect(resolveWithinWorkspace(workspace, path.join(workspace, 'a.txt'))).toBe(
      path.join(workspace, 'a.txt'),
    );
  });

  it('拒绝相对路径穿越、绝对路径越界与嵌套上跳', () => {
    expect(() => resolveWithinWorkspace(workspace, '../outside.txt')).toThrow(PathOutsideWorkspaceError);
    expect(() => resolveWithinWorkspace(workspace, '/etc/passwd')).toThrow(PathOutsideWorkspaceError);
    expect(() => resolveWithinWorkspace(workspace, 'a/../../x')).toThrow(PathOutsideWorkspaceError);
    expect(() => resolveWithinWorkspace(workspace, '..')).toThrow(PathOutsideWorkspaceError);
  });
});

describe('工具执行', () => {
  it('list_files 列出文件与大小', async () => {
    await fsp.writeFile(path.join(workspace, 'a.csv'), '12345', 'utf-8');
    await fsp.mkdir(path.join(workspace, 'sub'));
    await fsp.writeFile(path.join(workspace, 'sub', 'b.json'), '{}', 'utf-8');

    const res = await executeWorkspaceTool('list_files', {}, toolCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('a.csv (5 B)');
    expect(res.output).toContain(`sub${path.sep}b.json (2 B)`);
  });

  it('write_file 写入工作区内文件并自动创建子目录', async () => {
    const res = await executeWorkspaceTool(
      'write_file',
      { path: 'out/sub/result.json', content: '{"ok":true}' },
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    await expect(fsp.readFile(path.join(workspace, 'out', 'sub', 'result.json'), 'utf-8'))
      .resolves.toBe('{"ok":true}');
  });

  it('write_file 拒绝越界路径且不产生文件', async () => {
    const res = await executeWorkspaceTool(
      'write_file',
      { path: '../evil.txt', content: 'x' },
      toolCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('越界');
    await expect(fsp.stat(path.join(path.dirname(workspace), 'evil.txt'))).rejects.toThrow();
  });

  it('read_file 默认读取前 100 行并注明 [截断]', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    await fsp.writeFile(path.join(workspace, 'notes.txt'), lines.join('\n'), 'utf-8');

    const res = await executeWorkspaceTool('read_file', { path: 'notes.txt' }, toolCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('共 250 行');
    expect(res.output).toContain('line-100');
    expect(res.output).not.toContain('line-101');
    expect(res.output).toContain('[截断]');
  });

  it('read_file 支持 offset 偏移读取', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    await fsp.writeFile(path.join(workspace, 'notes.txt'), lines.join('\n'), 'utf-8');

    const res = await executeWorkspaceTool(
      'read_file',
      { path: 'notes.txt', offset: 240 },
      toolCtx(),
    );
    expect(res.output).toContain('line-241');
    expect(res.output).toContain('line-250');
    expect(res.output).not.toContain('line-239');
  });

  it('read_file 对超长行做行级截断', async () => {
    await fsp.writeFile(path.join(workspace, 'wide.txt'), 'x'.repeat(6000), 'utf-8');
    const res = await executeWorkspaceTool('read_file', { path: 'wide.txt' }, toolCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('[行超长截断]');
  });

  it('read_file 对大 CSV 只读开头并提示用 run_python 分析', async () => {
    // 约 1.2 MB 的 CSV，触发大文件分支
    const row = `1,${'x'.repeat(4000)}\n`;
    await fsp.writeFile(path.join(workspace, 'big.csv'), `id,value\n${row.repeat(300)}`, 'utf-8');

    const res = await executeWorkspaceTool('read_file', { path: 'big.csv' }, toolCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('大文件');
    expect(res.output).toContain('run_python');
  });

  it('run_python 执行无害代码并回传 stdout', async () => {
    const res = await executeWorkspaceTool('run_python', { code: 'print(6 * 7)' }, toolCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('退出码: 0');
    expect(res.output).toContain('42');
  }, 30_000);

  it('run_python 捕获 Python 异常并标记失败', async () => {
    const res = await executeWorkspaceTool(
      'run_python',
      { code: "raise ValueError('boom')" },
      toolCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('ValueError');
  }, 30_000);

  it('run_python 超时终止进程', async () => {
    const start = Date.now();
    const res = await executeWorkspaceTool(
      'run_python',
      { code: 'import time; time.sleep(5)' },
      toolCtx({ timeoutMs: 300 }),
    );
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(res.output).toContain('超时');
    expect(elapsed).toBeLessThan(4000);
  }, 30_000);

  it('finish 接受完成声明并区分存在与缺失的产出文件', async () => {
    await fsp.writeFile(path.join(workspace, 'result.json'), '{}', 'utf-8');
    const res = await executeWorkspaceTool(
      'finish',
      { artifacts: ['result.json', 'missing.json'], summary: 'done' },
      toolCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('result.json');
    expect(res.output).toContain('missing.json');
  });

  it('未知工具返回失败结果', async () => {
    const res = await executeWorkspaceTool('no_such_tool', {}, toolCtx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain('未知工具');
  });
});

describe('truncateToolOutput', () => {
  it('超过 4000 字符截断并注明 [截断]', () => {
    const out = truncateToolOutput('a'.repeat(5000));
    expect(out).toContain('[截断]');
    expect(out.length).toBeLessThan(5000);
    expect(out.startsWith('a'.repeat(100))).toBe(true);
  });

  it('未超过上限时原样返回', () => {
    expect(truncateToolOutput('short')).toBe('short');
  });
});

describe('buildModel 兼容性默认值', () => {
  it('默认 supportsStore=false（Mistral 等严格端点会 422 拒绝 store 字段）', () => {
    const model = buildModel({ baseUrl: 'http://127.0.0.1:8788/v1', modelId: 'deepseek-v4-1-flash' });
    expect(model.compat?.supportsStore).toBe(false);
  });

  it('调用方显式传入的 compat 优先', () => {
    const model = buildModel(
      { baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o' },
      { supportsStore: true },
    );
    expect(model.compat?.supportsStore).toBe(true);
  });
});

describe('按节点模型分层（#3 Phase B）', () => {
  it('resolveNodeModelConfig：节点级覆盖 modelId，未命中节点回落全局配置', () => {
    const options = {
      apiKey: 'key-global',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-flash',
      nodeModels: {
        plan: { modelId: 'deepseek-r1' },
        verify: { modelId: 'deepseek-r1' },
        adjudicate: { modelId: 'deepseek-r1' },
      },
    };
    expect(resolveNodeModelConfig(options, 'plan').modelId).toBe('deepseek-r1');
    expect(resolveNodeModelConfig(options, 'adjudicate').modelId).toBe('deepseek-r1');
    // 未命中节点沿用全局（Inspect / Execute 用默认档）
    const execute = resolveNodeModelConfig(options, 'execute');
    expect(execute.modelId).toBe('deepseek-flash');
    expect(execute.apiKey).toBe('key-global');
    expect(execute.baseUrl).toBe('https://api.deepseek.com');
  });

  it('resolveNodeModelConfig：字段级合并（节点只覆盖 modelId 时沿用全局 key/baseUrl）', () => {
    const options = {
      apiKey: 'key-global',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-flash',
      nodeModels: { verify: { modelId: 'strong-model' } },
    };
    const verify = resolveNodeModelConfig(options, 'verify');
    expect(verify).toEqual({ apiKey: 'key-global', baseUrl: 'https://api.deepseek.com', modelId: 'strong-model' });
  });

  it('PiAgentRunner 结果回报所用模型（tracing 按节点记录）', async () => {
    const runner = new PiAgentRunner({
      apiKey: 'test-key',
      modelId: 'deepseek-flash',
      nodeModels: { verify: { modelId: 'deepseek-r1' } },
    });
    // 工作区不存在 → 在触网前返回失败结果，但失败结果同样回报按节点解析的 model
    const missingWorkspace = path.join(workspace, 'does-not-exist');
    const inspectResult = await runner.run(makeInput({ nodeId: 'inspect', workspacePath: missingWorkspace }));
    expect(inspectResult.status).toBe('failed');
    expect(inspectResult.model).toBe('deepseek-flash');
    const verifyResult = await runner.run(makeInput({ nodeId: 'verify', workspacePath: missingWorkspace }));
    expect(verifyResult.status).toBe('failed');
    expect(verifyResult.model).toBe('deepseek-r1');
  });
});

describe('节点 prompt 分发（#3 Phase B）', () => {
  it('verify 节点用挑战者 prompt，adjudicate 用裁决 prompt，其余用通用节点 prompt', () => {
    expect(systemPromptForNode('verify', '职责')).toContain('挑战者');
    expect(systemPromptForNode('adjudicate', '职责')).toContain('裁决节点');
    expect(systemPromptForNode('inspect', '职责')).toContain('执行节点');
    // 显式 promptStyle 覆盖（如极简路径的 execute 用 baseline 风格）
    expect(systemPromptForNode('execute', '职责', 'baseline')).toContain('资深数据分析师');
    expect(systemPromptForNode('execute', '职责', 'challenger')).toContain('挑战者');
  });

  it('challenger prompt 强调只挑语义错误、不修复；adjudicator prompt 强调三选一与低轮数', () => {
    const challenger = challengerSystemPrompt('职责');
    expect(challenger).toContain('程序化验证门');
    expect(challenger).toContain('不要修复');
    const adjudicator = adjudicatorSystemPrompt('职责');
    expect(adjudicator).toContain('三选一');
    expect(adjudicator).toContain('宁可 accept');
  });
});
