import type { DagNode, WorkflowDefinition } from './types.js';

/** 工作流定义非法（ID 重复、依赖缺失、自依赖、环）。 */
export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}

/** 校验工作流定义：节点 ID 唯一、依赖存在、无自依赖、静态边无环；回路字段（#3 Phase B）合法。 */
export function validateWorkflow(workflow: WorkflowDefinition): void {
  const ids = new Set<string>();
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) {
      throw new DagValidationError(`重复的节点 ID: ${node.id}`);
    }
    ids.add(node.id);
  }
  for (const node of workflow.nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) {
        throw new DagValidationError(`节点 ${node.id} 不能依赖自身`);
      }
      if (!ids.has(dep)) {
        throw new DagValidationError(`节点 ${node.id} 依赖了不存在的节点: ${dep}`);
      }
    }
    // 回路携带依赖：目标必须存在且不能是自身（允许指向前方节点，构成有界回路）
    for (const dep of node.loopDependencies ?? []) {
      if (dep === node.id) {
        throw new DagValidationError(`节点 ${node.id} 的回路依赖不能指向自身`);
      }
      if (!ids.has(dep)) {
        throw new DagValidationError(`节点 ${node.id} 的回路依赖指向不存在的节点: ${dep}`);
      }
    }
    if (node.maxExecutions !== undefined && (!Number.isInteger(node.maxExecutions) || node.maxExecutions < 1)) {
      throw new DagValidationError(`节点 ${node.id} 的 maxExecutions 必须是 >= 1 的整数`);
    }
    if (node.conditionalNext !== undefined && node.conditionalNext.length > 0) {
      if (!node.decisionArtifact) {
        throw new DagValidationError(`节点 ${node.id} 声明了条件边但缺少 decisionArtifact（决策产物文件名）`);
      }
      for (const edge of node.conditionalNext) {
        if (typeof edge.when !== 'string' || edge.when.trim().length === 0) {
          throw new DagValidationError(`节点 ${node.id} 的条件边缺少 when 决策值`);
        }
        if (!ids.has(edge.goto)) {
          throw new DagValidationError(`节点 ${node.id} 的条件边 goto 指向不存在的节点: ${edge.goto}`);
        }
      }
    }
    if (node.decisionArtifact !== undefined && node.decisionArtifact.trim().length === 0) {
      throw new DagValidationError(`节点 ${node.id} 的 decisionArtifact 不能为空字符串`);
    }
    if (
      node.promptStyle !== undefined &&
      !['baseline', 'node', 'challenger', 'adjudicator'].includes(node.promptStyle)
    ) {
      throw new DagValidationError(`节点 ${node.id} 的 promptStyle 非法: ${String(node.promptStyle)}`);
    }
  }
  // 静态拓扑（dependsOn）仍要求无环；回路依赖（loopDependencies）与条件回边不参与拓扑
  topoSort(workflow.nodes);
}

/**
 * Kahn 拓扑排序（只按静态 dependsOn 边），返回可执行顺序；保持无依赖节点之间的定义顺序
 * （确定性）。静态边存在环时抛出 DagValidationError；回路依赖（loopDependencies）不参与排序。
 */
export function topoSort(nodes: readonly DagNode[]): DagNode[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, node.dependsOn.length);
    for (const dep of node.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const sorted: DagNode[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (node) {
      sorted.push(node);
    }
    for (const next of dependents.get(id) ?? []) {
      const nextIn = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIn);
      if (nextIn === 0) {
        queue.push(next);
      }
    }
  }

  if (sorted.length !== nodes.length) {
    const blocked = nodes.map((node) => node.id).filter((id) => (indegree.get(id) ?? 0) > 0);
    throw new DagValidationError(`工作流存在环或不可达依赖，涉及节点: ${blocked.join(', ')}`);
  }
  return sorted;
}

/** 校验并返回按依赖顺序排列的执行序列。 */
export function executionOrder(workflow: WorkflowDefinition): DagNode[] {
  validateWorkflow(workflow);
  return topoSort(workflow.nodes);
}
