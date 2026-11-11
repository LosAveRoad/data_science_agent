import type { DagNode, WorkflowDefinition } from './types.js';

/** 工作流定义非法（ID 重复、依赖缺失、自依赖、环）。 */
export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagValidationError';
  }
}

/** 校验工作流定义：节点 ID 唯一、依赖存在、无自依赖、无环。 */
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
  }
  topoSort(workflow.nodes);
}

/**
 * Kahn 拓扑排序，返回可执行顺序；保持无依赖节点之间的定义顺序（确定性）。
 * 存在环时抛出 DagValidationError。
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
