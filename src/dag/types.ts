/** DAG 节点 ID（如 inspect / plan / execute / verify / adjudicate）。 */
export type NodeId = string;

/** 节点 prompt 风格（pi-runtime 据此选择 system prompt；缺省按 nodeId 推断）。 */
export type NodePromptStyle = 'baseline' | 'node' | 'challenger' | 'adjudicator';

/** 条件边（#3 Phase B 有界回路）：节点决策与 when 匹配时，调度器回跳到 goto 节点。 */
export interface ConditionalEdge {
  /** 决策值（来自决策产物 JSON 的 decision 字段，如 fix / pass / accept）。 */
  when: string;
  /** 匹配时回跳到的节点 ID（通常是回路体首节点，如 execute）。 */
  goto: NodeId;
}

/** 固定工作流中的一个节点，由 Pi Agent Runtime 执行。 */
export interface DagNode {
  id: NodeId;
  /** 节点职责描述，作为 Pi Agent 的任务输入。 */
  task: string;
  /** 上游节点 ID 列表（静态边，必须无环），节点之间只通过文件 Artifact 传递信息。 */
  dependsOn: NodeId[];
  /** 节点需要产出的 Artifact 文件名。 */
  outputArtifacts: string[];
  /**
   * 回路携带依赖（#3 Phase B）：只在节点重跑（第 2 次及以后执行）时要求就绪的依赖，
   * 用于把挑战清单等回路反馈产物送进重跑节点（如 execute 重跑时读取 verify 的
   * challenge_list.json）。不计入静态拓扑，允许指向前方节点形成有界回路。
   */
  loopDependencies?: NodeId[];
  /**
   * 本节点最大执行次数（含首次，默认 1）。回路体节点设为 1 + 修复轮数上限，
   * 与条件边配合构成有界回路；超出上限后调度器不再执行该节点（超限按 accept 收口）。
   */
  maxExecutions?: number;
  /**
   * 决策产物文件名（#3 Phase B 裁决节点）：节点成功后 executor 读取该 JSON 产物中的
   * decision 字段评估 conditionalNext。声明了 conditionalNext 时必填。
   */
  decisionArtifact?: string;
  /** 条件边集合：decision 匹配 when 时回跳 goto（有界回路的方向声明）。 */
  conditionalNext?: ConditionalEdge[];
  /** 节点 prompt 风格；缺省时 pi-runtime 按 nodeId 推断（verify → challenger 等）。 */
  promptStyle?: NodePromptStyle;
}

/** 固定拓扑的工作流定义（不允许运行时增删节点；回路为有界条件回路）。 */
export interface WorkflowDefinition {
  id: string;
  nodes: DagNode[];
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

/** Executor 记录的节点执行状态（一回合一跳，节点多条执行记录在 tracing 中展开）。 */
export interface NodeRun {
  nodeId: NodeId;
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** 实际执行的尝试次数（>1 表示单回内发生过重试 / 步数续跑）。 */
  attempts?: number;
  /** 实际执行的回路轮数（>1 表示修复回路让该节点重跑过，#3 Phase B）。 */
  executions?: number;
}
