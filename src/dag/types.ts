/** DAG 节点 ID（如 inspect / plan / execute / verify）。 */
export type NodeId = string;

/** 固定工作流中的一个节点，由 Pi Agent Runtime 执行。 */
export interface DagNode {
  id: NodeId;
  /** 节点职责描述，作为 Pi Agent 的任务输入。 */
  task: string;
  /** 上游节点 ID 列表，节点之间只通过文件 Artifact 传递信息。 */
  dependsOn: NodeId[];
  /** 节点需要产出的 Artifact 文件名。 */
  outputArtifacts: string[];
}

/** 固定拓扑的工作流定义（初版不允许运行时增删改节点）。 */
export interface WorkflowDefinition {
  id: string;
  nodes: DagNode[];
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Executor 记录的节点执行状态。 */
export interface NodeRun {
  nodeId: NodeId;
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** 实际执行的尝试次数（>1 表示发生过重试 / 步数续跑）。 */
  attempts?: number;
}
