# AgenticDataBench DAG Agent — 设计文档（第一阶段）

## 1. 项目目标

基于 AgenticDataBench 构建一个使用 Pi Agent 作为底层 ReAct Runtime 的数据分析 Agent，并自主实现 DAG 编排层，探索任务分阶段执行与依赖管理对数据分析任务完成效果的影响。

第一阶段只实现两套系统：

- **Baseline：** Pi Agent 直接接收任务，通过 ReAct 和工具调用完成数据分析。
- **DAG Prototype：** Pi Agent 作为执行节点，由我们自主实现的 DAG Orchestrator 管理任务执行。

两套系统使用相同的模型、工具、数据集和执行环境，使用 AgenticDataBench 官方 Evaluator 评价结果。

## 2. DAG 架构设计

### 2.1 初版设计原则

采用固定拓扑的 DAG Workflow，不允许 Agent 在执行过程中动态增加、删除或修改节点。

每个 DAG Node 由 Pi Agent 执行，节点之间通过文件形式传递中间结果（Artifact）。

初版只实现串行执行，不引入并行调度、自动重规划、Checkpoint 和复杂恢复机制。

### 2.2 工作流

固定包含四个阶段：

| 节点 | 职责 | 输出 |
|---|---|---|
| Inspect | 检查任务涉及的数据文件、Schema 和样本 | data_profile.json |
| Plan | 根据任务和数据结构制定分析计划 | analysis_plan.json |
| Execute | 使用 Python、SQL 等工具执行分析 | 分析结果及执行摘要 |
| Verify | 检查输出文件、格式和基本结果完整性 | verification.json |

节点依赖关系：

Inspect → Plan → Execute → Verify

其中 Plan 节点生成的是数据分析执行计划，而不是新的 DAG 拓扑。

### 2.3 节点执行机制

每个节点通过 Pi Agent Runtime 执行：

1. 接收当前任务和上游 Artifact。
2. 根据节点职责执行 ReAct 循环。
3. 使用工作区内的文件、Python、SQL 等工具。
4. 将执行结果保存为 Artifact。
5. Executor 确认节点成功后，启动下一个节点。

节点之间不直接依赖聊天历史，而是通过明确的文件产物传递信息。

### 2.4 DAG Executor

初版 Executor 只需要实现：

- 注册固定工作流。
- 检查节点 ID 和依赖关系。
- 按依赖顺序执行节点。
- 记录节点状态和执行耗时。
- 保存节点输出和错误信息。

不实现通用动态 DAG 引擎。

## 3. 项目文件结构

采用 TypeScript 作为核心编排层语言，以便直接使用 Pi Agent SDK；Benchmark 原有 Python 数据和评价环境尽量保持不变。

```text
agentic-data-dag/
│
├── package.json
├── tsconfig.json
├── .env.example
│
├── configs/
│   └── benchmark.json
│
├── src/
│   ├── main.ts
│   │
│   ├── benchmark/
│   │   ├── task-loader.ts
│   │   └── workspace.ts
│   │
│   ├── agent/
│   │   ├── pi-runtime.ts
│   │   ├── tools.ts
│   │   └── prompts.ts
│   │
│   ├── dag/
│   │   ├── types.ts
│   │   ├── graph.ts
│   │   ├── executor.ts
│   │   └── workflow.ts
│   │
│   ├── artifacts/
│   │   └── store.ts
│   │
│   └── tracing/
│       └── recorder.ts
│
├── experiments/
│   ├── baseline-pi.ts
│   └── dag-prototype.ts
│
├── scripts/
│   ├── run-baseline.sh
│   ├── run-dag.sh
│   └── evaluate.sh
│
├── tests/
│   ├── graph.test.ts
│   └── executor.test.ts
│
└── runs/
    └── {experiment_id}/
```

### 3.1 核心模块职责

- `benchmark/`：读取官方任务配置，准备隔离的数据工作区。
- `agent/`：封装 Pi Agent、工具和不同阶段的 Prompt。
- `dag/`：定义 DAG 节点、依赖关系、固定工作流和执行器。
- `artifacts/`：保存和读取节点之间的中间结果。
- `tracing/`：记录 Agent 调用、Token Usage、节点耗时和执行轨迹。
- `experiments/`：分别运行 Pi Baseline 和 DAG Prototype。
- `scripts/`：调用 Benchmark 官方运行和评价流程。

## 4. 实验输出

每次运行保存：

- Benchmark Task ID
- 使用的模型及实验配置
- 节点执行顺序和状态
- 每个节点的输入、输出及执行耗时
- Agent Tool Calls
- Token Usage
- 最终输出文件
- 官方 Benchmark Evaluation Score

所有实验使用独立的 Run Directory，保证结果可追溯。

## 5. 初版暂不实现的功能

- RAG 和向量数据库
- Dynamic DAG
- DAG 并行调度
- 自动重规划
- Checkpoint 和复杂故障恢复
- 复杂 Typed Artifact 系统
- 多 Agent 协作

这些功能不作为当前开发目标，是否需要引入由后续实验结果决定。

## 6. 第一阶段完成标准

1. Pi Agent Baseline 能够独立完成 Benchmark 任务。
2. DAG Prototype 能够完整执行四个阶段。
3. 两套系统都能生成官方要求的结果文件。
4. 官方 Evaluator 能够正常评价两套系统。
5. 能够保存完整执行轨迹，定位具体失败节点。
