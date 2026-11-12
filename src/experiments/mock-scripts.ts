/**
 * --mock 模式的行为剧本：0 token 管线联调用，不调用 LLM。
 *
 * - baseline：一次写出任务的全部 output_file_name 占位文件；
 * - DAG：按 defaultWorkflow 的四个节点分别写各自声明的 Artifact，
 *   execute 节点额外写出任务的 output_file_name（供官方 Evaluator 收集）。
 *
 * #2 Phase A：inspect / plan 的占位内容改为符合结构化 schema（files / steps），
 * 输出文件占位按扩展名生成（CSV 表头+数据行、JSON 对象、PNG 文件头等），
 * 保证 mock 运行能通过 executor 的 schema 校验与程序化验证门。
 *
 * 占位内容为结构化占位符，官方 Evaluator 能正常解析 result.json 与
 * 输出文件收集流程，但内容对比得分为 0、finished=false（预期行为）。
 */
import { MockAgentRunner } from '../agent/mock-agent.js';
import type { MockScript } from '../agent/mock-agent.js';
import type { BenchmarkTask } from '../benchmark/task-loader.js';
import type { AgentRunner, AgentRunnerInput, NodeRunResult } from '../dag/executor.js';
import { emptyTokenUsage } from '../tracing/recorder.js';

/** PNG 文件签名（8 字节）：mock 的 .png 占位输出需带真实文件头以通过验证门。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 任务输出文件的占位内容（按扩展名区分，确保通过程序化验证门；
 * Evaluator 按内容对比时得 0 分，管线不崩）。
 */
function mockFileContent(task: BenchmarkTask, fileName: string): unknown {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'csv':
    case 'tsv':
      // 表头 + 一条数据行（验证门要求非空数据行）
      return ext === 'csv' ? 'mock_col_a,mock_col_b\nmock_1,mock_2\n' : 'mock_col_a\tmock_col_b\nmock_1\tmock_2\n';
    case 'jsonl':
      return `${JSON.stringify({ mock: true, task_id: task.id, note: 'Mock 占位输出' })}\n`;
    case 'png':
      // PNG 文件头 + 少量占位字节（验证门检查签名）
      return new Uint8Array([...PNG_SIGNATURE, 0x00, 0x0d, 0x0a, 0x1a]);
    case 'json':
      return {
        mock: true,
        task_id: task.id,
        output_file: fileName,
        note: 'MockAgentRunner 占位输出（--mock 管线联调，非真实分析结果）',
      };
    default:
      return `MockAgentRunner 占位输出（--mock 管线联调，非真实分析结果）：${fileName} / 任务 ${task.id}\n`;
  }
}

/** 节点 Artifact 的占位内容（data_profile / analysis_plan 用专门的结构化占位）。 */
function mockArtifactContent(task: BenchmarkTask, nodeId: string, fileName: string): unknown {
  if (fileName === 'data_profile.json') {
    // 符合 schemas.ts 的 data_profile schema：files 数组逐文件列出（数据源为空时给占位条目）
    const sources = task.dataSources.filter((rel) => rel.trim().length > 0);
    const files = (sources.length > 0 ? sources : ['mock_data.csv']).map((name) => ({
      name,
      rows: null,
      columns: [
        { name: 'mock_col_a', dtype: 'string' },
        { name: 'mock_col_b', dtype: 'string' },
      ],
      stats: {},
      quality_issues: [],
    }));
    return { mock: true, task_id: task.id, node_id: nodeId, files, note: 'Mock 结构化占位 data_profile' };
  }
  if (fileName === 'analysis_plan.json') {
    // 符合 schemas.ts 的 analysis_plan schema：steps 数组（含 description）
    return {
      mock: true,
      task_id: task.id,
      node_id: nodeId,
      steps: [
        {
          description: 'Mock 占位分析步骤：读取数据并完成计算',
          tools: ['run_python'],
          expected_outputs: task.outputFileName,
        },
      ],
      note: 'Mock 结构化占位 analysis_plan',
    };
  }
  return {
    mock: true,
    task_id: task.id,
    node_id: nodeId,
    artifact: fileName,
    note: 'MockAgentRunner 占位输出（--mock 管线联调，非真实分析结果）',
  };
}

/** MockScript 中的一个写出步骤（从 mock-agent 的类型收窄为构造用别名）。 */
interface MockWriteStep {
  path: string;
  content: unknown;
}

/** baseline mock 剧本：单次运行写出任务的全部期望输出文件。 */
export function baselineMockScript(task: BenchmarkTask): MockScript {
  return {
    steps: task.outputFileName.map((name) => ({
      path: name,
      content: mockFileContent(task, name),
    })),
  };
}

/** DAG mock 剧本：defaultWorkflow 四节点各自的写出步骤。 */
export function dagMockScripts(task: BenchmarkTask): Record<string, MockScript> {
  const artifact = (nodeId: string, fileName: string): MockWriteStep => ({
    path: fileName,
    content: mockArtifactContent(task, nodeId, fileName),
  });
  return {
    inspect: { steps: [artifact('inspect', 'data_profile.json')] },
    plan: { steps: [artifact('plan', 'analysis_plan.json')] },
    execute: {
      steps: [
        artifact('execute', 'result.json'),
        artifact('execute', 'execute_summary.json'),
        ...task.outputFileName.map(
          (name): MockWriteStep => ({ path: name, content: mockFileContent(task, name) }),
        ),
      ],
    },
    verify: { steps: [artifact('verify', 'verification.json')] },
  };
}

/**
 * 按节点 ID 选择剧本的 Mock runner（DAG 联调用）：
 * DagExecutor 对所有节点复用同一个 AgentRunner 实例，这里在 run 时按 input.nodeId
 * 分发到对应的 MockAgentRunner；未定义剧本的节点按失败处理。
 */
export class NodeScriptedMockRunner implements AgentRunner {
  private readonly scripts: Record<string, MockScript>;

  constructor(scripts: Record<string, MockScript>) {
    this.scripts = scripts;
  }

  async run(input: AgentRunnerInput): Promise<NodeRunResult> {
    const script = this.scripts[input.nodeId];
    if (!script) {
      return {
        status: 'failed',
        artifacts: [],
        tokenUsage: emptyTokenUsage(),
        steps: 0,
        error: `mock 剧本未定义节点 ${input.nodeId} 的行为`,
      };
    }
    return new MockAgentRunner(script).run(input);
  }
}
