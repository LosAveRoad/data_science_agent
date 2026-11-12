import type { DagNode, WorkflowDefinition } from './types.js';

/**
 * 设计文档 2.2 节定义的固定四阶段工作流：
 * Inspect → Plan → Execute → Verify。
 * 初版固定拓扑，Plan 产出的是分析计划而非新 DAG。
 */
export function defaultWorkflow(): WorkflowDefinition {
  const nodes: DagNode[] = [
    {
      id: 'inspect',
      task: '检查任务涉及的数据文件、Schema 和样本，输出 data_profile.json',
      dependsOn: [],
      outputArtifacts: ['data_profile.json'],
    },
    {
      id: 'plan',
      task: '根据任务和数据结构制定分析计划，输出 analysis_plan.json',
      dependsOn: ['inspect'],
      outputArtifacts: ['analysis_plan.json'],
    },
    {
      id: 'execute',
      task: '使用 Python、SQL 等工具执行分析，产出分析结果与执行摘要',
      dependsOn: ['plan'],
      outputArtifacts: ['result.json', 'execute_summary.json'],
    },
    {
      id: 'verify',
      task: '检查输出文件、格式和基本结果完整性，输出 verification.json',
      dependsOn: ['execute'],
      outputArtifacts: ['verification.json'],
    },
  ];
  return { id: 'inspect-plan-execute-verify', nodes };
}

/**
 * 按具体任务构建四阶段工作流：execute 节点的声明产物与任务要求的输出文件对齐，
 * 避免固定占位产物（result.json）与真实任务输出脱节导致 verify 依赖检查失败。
 */
export function taskWorkflow(task: { outputFileName: string[] }): WorkflowDefinition {
  const outputs = [...new Set(task.outputFileName)];
  const outputsText = outputs.length > 0 ? outputs.join('、') : '任务要求的输出文件';
  const nodes: DagNode[] = [
    {
      id: 'inspect',
      task: '检查任务涉及的数据文件、Schema 和样本，输出 data_profile.json',
      dependsOn: [],
      outputArtifacts: ['data_profile.json'],
    },
    {
      id: 'plan',
      task: '根据任务和数据结构制定分析计划，输出 analysis_plan.json',
      dependsOn: ['inspect'],
      outputArtifacts: ['analysis_plan.json'],
    },
    {
      id: 'execute',
      task:
        `使用 Python 等工具执行分析：产出最终结果文件（${outputsText}，文件名必须与要求完全一致），` +
        '并把执行摘要（分析方法、关键中间结果、产出文件清单）写入 execute_summary.json',
      dependsOn: ['plan'],
      outputArtifacts: [...outputs, 'execute_summary.json'],
    },
    {
      id: 'verify',
      task: `检查输出文件（${outputsText}）是否存在、格式正确且结果完整，输出 verification.json`,
      dependsOn: ['execute'],
      outputArtifacts: ['verification.json'],
    },
  ];
  return { id: 'inspect-plan-execute-verify', nodes };
}
