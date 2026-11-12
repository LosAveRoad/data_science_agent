/**
 * --mock 模式的行为剧本：0 token 管线联调用，不调用 LLM。
 *
 * - baseline：一次写出任务的全部 output_file_name 占位文件；
 * - DAG：按 defaultWorkflow 的四个节点分别写各自声明的 Artifact，
 *   execute 节点额外写出任务的 output_file_name（供官方 Evaluator 收集）。
 *
 * 占位内容为结构化 JSON 占位符，官方 Evaluator 能正常解析 result.json 与
 * 输出文件收集流程，但内容对比得分为 0、finished=false（预期行为）。
 */
import { MockAgentRunner } from '../agent/mock-agent.js';
import type { MockScript } from '../agent/mock-agent.js';
import type { BenchmarkTask } from '../benchmark/task-loader.js';
import type { AgentRunner, AgentRunnerInput, NodeRunResult } from '../dag/executor.js';
import { emptyTokenUsage } from '../tracing/recorder.js';

/** 任务输出文件的占位内容（JSON 文本；Evaluator 按内容对比时得 0 分，管线不崩）。 */
function mockFileContent(task: BenchmarkTask, fileName: string): string {
  return JSON.stringify(
    {
      mock: true,
      task_id: task.id,
      output_file: fileName,
      note: 'MockAgentRunner 占位输出（--mock 管线联调，非真实分析结果）',
    },
    null,
    2,
  );
}

/** 节点 Artifact 的占位内容。 */
function mockArtifactContent(taskId: string, nodeId: string, fileName: string): string {
  return JSON.stringify(
    {
      mock: true,
      task_id: taskId,
      node_id: nodeId,
      artifact: fileName,
    },
    null,
    2,
  );
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
    content: mockArtifactContent(task.id, nodeId, fileName),
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
