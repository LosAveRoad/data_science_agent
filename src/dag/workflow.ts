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
