# AgenticDataBench DAG Agent — 设计文档（第一阶段）

## 1. 项目目标

基于 AgenticDataBench 构建一个使用 Pi Agent 作为底层 ReAct Runtime 的数据分析 Agent，并自主实现 DAG 编排层，探索任务分阶段执行与依赖管理对数据分析任务完成效果的影响。

第一阶段只实现两套系统：

- **Baseline：** Pi Agent 直接接收任务，通过 ReAct 和工具调用完成数据分析。
- **DAG Prototype：** Pi Agent 作为执行节点，由我们自主实现的 DAG Orchestrator 管理任务执行。

两套系统使用相同的模型、工具、数据集和执行环境，使用 AgenticDataBench 官方 Evaluator 评价结果。第一阶段评测固定使用 30 个任务的冻结子集（见 §3），不运行全量 344 个任务。

## 2. DAG 架构设计

### 2.1 初版设计原则

采用固定拓扑的 DAG Workflow，不允许 Agent 在执行过程中动态增加、删除或修改节点。

每个 DAG Node 由 Pi Agent 执行，节点之间通过文件形式传递中间结果（Artifact）。

初版只实现串行执行，不引入并行调度、自动重规划、Checkpoint 和复杂恢复机制。

### 2.2 工作流

固定包含四个阶段（Phase A 前的基线拓扑）：

| 节点 | 职责 | 输出 |
|---|---|---|
| Inspect | 检查任务涉及的数据文件、Schema 和样本 | data_profile.json |
| Plan | 根据任务和数据结构制定分析计划 | analysis_plan.json |
| Execute | 使用 Python、SQL 等工具执行分析 | 分析结果及执行摘要 |
| Verify | 检查输出文件、格式和基本结果完整性 | verification.json |

节点依赖关系：

Inspect → Plan → Execute → Verify

其中 Plan 节点生成的是数据分析执行计划，而不是新的 DAG 拓扑。

**#3 Phase B：验证-修复回路。** Verify 升级为 Bear 式挑战者并引入裁决节点，工作流扩展为五节点有界回路：

| 节点 | 职责 | 输出 |
|---|---|---|
| Inspect / Plan | 同上 | data_profile.json / analysis_plan.json |
| Execute | 执行分析；修复轮逐条应答挑战清单并重写受影响输出 | 任务输出文件 + execute_summary.json |
| Verify（挑战者） | 对抗式语义审查：单位换算、过滤条件、时间窗口、聚合口径、任务要求逐条覆盖度 | challenge_list.json（可为空数组） |
| Adjudicate（裁决） | pass / fix / accept 三选一，低轮数经验（宁可 accept） | verdict.json |

```text
Inspect → Plan → Execute ⇄ Verify（挑战） → Adjudicate（裁决）
                     ↑______fix______|
```

- 第一道验证门仍是 Phase A 的程序化检查（0 token）：输出文件存在、非空、格式成立；辩驳只处理语义层。
- Execute 重跑通过回路依赖（loopDependencies）读取上一轮挑战清单，单轮应答后重写输出。
- 修复上限默认 2 轮（`maxRepairRounds`，对齐 TradingAgents 默认 1 轮辩论的低轮数经验）；
  超限仍被裁决 fix 时由 executor 强制 accept 收口并记录（`repair.forcedAccept`）。
- 任务内教训回灌：每轮修复 prompt 带上一轮被驳回原因（挑战清单），不做跨任务反思记忆（benchmark 污染风险）。

### 2.3 节点执行机制

每个节点通过 Pi Agent Runtime 执行：

1. 接收当前任务和上游 Artifact。
2. 根据节点职责执行 ReAct 循环。
3. 使用工作区内的文件、Python、SQL 等工具。
4. 将执行结果保存为 Artifact。
5. Executor 确认节点成功后，启动下一个节点。
6. 节点失败时（runner 异常、产物缺失、schema 不合规、验证门未通过、步数耗尽），Executor 将失败原因回灌给节点重试；步数耗尽则从工作区断点续跑（单节点默认至多 2 次尝试）。

节点之间不直接依赖聊天历史，而是通过明确的文件产物传递信息。

### 2.4 DAG Executor

初版 Executor 实现以下能力：

- 注册固定工作流。
- 检查节点 ID 和依赖关系。
- 按依赖顺序调度执行节点（#3 Phase B：静态拓扑序 + 有界条件回路的 worklist 调度）。
- 记录节点状态和执行耗时。
- 保存节点输出和错误信息。
- 节点失败重试与步数耗尽续跑（#2 Phase A）：单节点单回默认 2 次尝试，失败原因回灌 runner 供其修复。
- 产物确定性收口（#2 Phase A）：声明产物核对 → data_profile / analysis_plan / challenge_list / verdict 结构化 schema 校验 → execute 产出的程序化验证门（文件存在性 / 非空 / 格式检查，0 token），任一不通过按节点失败处理并触发重试。
- 有界条件回路（#3 Phase B）：裁决节点声明 `decisionArtifact` + `conditionalNext`；决策匹配条件边且目标节点未达 `maxExecutions` 时回炉目标及其传递下游，超限强制 accept 收口。回路体节点（execute / verify / adjudicate）`maxExecutions = 1 + maxRepairRounds`。
- 断点续跑 state.json v2（#3 Phase B）：除已完成节点外，持久化各节点执行轮数（`nodeExecutions`）、待回炉集合（`pendingReset`）、最近裁决（`lastDecision`）与累计修复轮数（`repairRounds`），支持含中间轮次的断点续跑；被回路取代的旧轮成功记录保留，用于恢复回路产物（挑战清单）与完整轨迹。

不实现通用动态 DAG 引擎。

### 2.5 模型分层（#3 Phase B）

- `src/agent/pi-runtime.ts` 支持按节点配置模型（`nodeModels`：nodeId → {modelId, baseUrl, apiKey} 字段级合并，未命中节点回落全局配置）。
- 分档策略：Plan / Verify（挑战者）/ Adjudicate（裁决）用强模型（`$MODEL_ID_STRONG`，需要推理与判断的节点）；Inspect / Execute 用默认档（deepseek-flash，重工具调用的节点）。
- 强模型未配置（`MODEL_ID_STRONG` 留空）时自动退化为单模型，不改变运行行为。
- tracing 按节点记录所用模型与用量（summary nodes[].model）；run-summary 汇总分档成本（`totals.usageByModel`）与分层配置（`config.strongModel`）。

### 2.6 难度路由（#4 Phase C）

入口 router 节点（`src/dag/router.ts`）按任务特征规则分档选择路径（零 LLM 成本；LLM 路由为非目标，效果不佳再升级）：

| 档位 | 路径 | token 预算系数 |
|---|---|---|
| full 完整路径 | Inspect → Plan → Execute ⇄ Verify → Adjudicate（含修复回路） | 1×（run 级预算） |
| simple 简单路径 | 同 full 但跳过 Plan（executor `skipNodes` 跳过子图，依赖透明传递） | 0.6× |
| minimal 极简路径 | 单节点直做（baseline 式 prompt + 重试护栏 + 程序化验证门） | 0.25× |

- 路由特征（全部可从任务定义确定性导出）：输出文件数量（`output_file_name`）、问题复杂度（问题文本长度）、数据集规模/文件数（`data_sources` 条目数）。
- 阈值（保守，优先保证得分不回退）：simple = 单输出 ∧ ≤3 数据源 ∧ ≤1200 字符；minimal = 单输出 ∧ ≤2 数据源 ∧ ≤500 字符；其余 full。逐档下沉判定（minimal ⊂ simple ⊂ full）。
- 表达方式：workflow 条件化构建（minimal 单节点工作流 vs full 回路工作流，`src/dag/workflow.ts`）+ executor 跳过子图（simple = full 工作流 + `skipNodes: ['plan']`，`src/dag/executor.ts`）；跳过节点的下游改从其上游取产物（如 execute 直接读 inspect 的 data_profile.json），修复回路保留。
- 可归因：路由决策（特征依据与选择结果）写入 tracing（轨迹首步）与任务 summary（`routing` 字段）；run-summary 记录路由模式与各档位任务数（`config.routing` / `config.routeCounts`）与每任务决策（`tasks[].route`）。
- CLI：`--routing auto|full|simple|minimal`（默认 auto；强制档位用于消融对照）。

## 3. Benchmark 任务子集

第一阶段不运行全量 344 个任务，**固定使用 30 个任务的冻结子集**作为两套系统的统一评测集。

### 3.1 子集约定

- 子集数量固定为 30，一次性选定后冻结，写入 `configs/benchmark.json`，后续实验不再增删或替换。
- Baseline 与 DAG Prototype 使用完全相同的 30 个任务，保证对比公平。
- 选样依据（任务 ID、对应数据集、选择理由）随子集配置一起提交，保证可追溯、可复现。

### 3.2 选样标准

1. **数据集规模**：优先选择原始数据文件较小（建议 < 50 MB）的任务，控制单任务上下文与运行时长。
2. **覆盖面**：覆盖不少于 5 个 skill cluster，兼顾 EDA、统计检验、建模、可视化等任务类型。
3. **难度分布**：保留部分高难度任务，不全部选择简单任务。
4. **可评测性**：只选择官方 `gold` 标签齐全、`evaluate.py` 可正常评测的任务。

### 3.3 运行护栏（Token 成本控制）

所有子集运行遵循以下约束，由 tracing 模块记录、事后可验证：

| 护栏 | 初版取值 |
|---|---|
| 节点 ReAct 步数上限 | 40 |
| 工具输出截断 | 单次工具结果超上限即截断，不整段进入上下文 |
| Inspect 类操作 | 只允许 head / schema / dtypes，禁止全量读取数据文件 |
| Run 级 token 预算 | 超限中止该任务并记录 |
| 断点续跑 | 已成功任务跳过，不重复执行 |
| 节点失败重试 / 步数续跑 | 单节点单回默认 2 次尝试（#2 Phase A）；重试带失败原因回灌，步数耗尽从工作区断点继续 |
| 程序化验证门 | execute 节点产出后确定性检查任务输出文件（存在 / 非空 / 格式，0 token，#2 Phase A） |
| 修复回路轮数上限 | 默认 2 轮（#3 Phase B）；超限强制 accept 收口并记录，回路不再无界膨胀 |
| 模型分层 | Plan / Verify / 裁决 = 强模型（$MODEL_ID_STRONG）；Inspect / Execute = 默认档（#3 Phase B） |
| 难度路由预算分档 | run 级预算按档位生效：full 1× / simple 0.6× / minimal 0.25×（#4 Phase C，超限中止并记录） |
| 路由可归因 | 每任务的路由决策（特征依据 + 选择结果）写入 tracing 与 summary；run-summary 汇总各档位任务数（#4 Phase C） |

### 3.4 成本预估

以 DeepSeek-Flash 牌价（输入未命中 ¥1–2/M、输出 ¥4–8/M，agent 负载下约每亿 token ¥25–50）估算：

- 30 任务 × 双系统单次完整运行：约 30–60M token，折合约 ¥10–30；
- 开发调试期（mock agent 优先 + 便宜模型）：约 5–20M token，折合约 ¥1–10。

全量 344 任务不在第一阶段预算内；若后续需要更大样本，按 §3.2 标准扩充并重新冻结子集版本。

## 4. 项目文件结构

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
│   ├── main.ts                # CLI 分发入口：node dist/src/main.js baseline|dag [--...]
│   │
│   ├── benchmark/
│   │   ├── task-loader.ts
│   │   └── workspace.ts
│   │
│   ├── agent/
│   │   ├── pi-runtime.ts
│   │   ├── tools.ts
│   │   ├── prompts.ts
│   │   └── mock-agent.ts
│   │
│   ├── dag/
│   │   ├── types.ts
│   │   ├── graph.ts
│   │   ├── executor.ts        # AgentRunner / AgentRunnerInput 契约单一来源
│   │   ├── workflow.ts
│   │   └── router.ts          # 难度路由：规则分档 + 分档预算（#4 Phase C）
│   │
│   ├── artifacts/
│   │   ├── store.ts
│   │   └── schemas.ts         # data_profile / analysis_plan 结构化 schema 校验（#2 Phase A）
│   │
│   ├── validate/
│   │   └── gate.ts            # 程序化验证门：任务输出文件存在性/非空/格式检查（#2 Phase A）
│   │
│   ├── tracing/
│   │   └── recorder.ts
│   │
│   └── experiments/           # 实验公共代码
│       ├── runner.ts          # 共享运行循环 + CLI 参数解析（--tasks/--all/--mock/...）
│       └── mock-scripts.ts    # --mock 模式的节点剧本
│
├── experiments/
│   ├── baseline-pi.ts         # Baseline 入口（编译产物 dist/experiments/baseline-pi.js）
│   └── dag-prototype.ts       # DAG 入口（编译产物 dist/experiments/dag-prototype.js）
│
├── scripts/
│   ├── evaluate.sh            # 官方 Evaluator 调用（runs/<id>/output-da-agent → evaluation/）
│   ├── check-pr-structure.mjs
│   └── test-llm.ts
│
├── tests/
│   ├── graph.test.ts
│   ├── executor.test.ts
│   ├── loop.test.ts           # 修复回路：裁决三分支 / 2 轮上限 / 含中间轮次断点续跑（#3 Phase B）
│   ├── router.test.ts         # 难度路由：规则分档 / 预算分档 / 跳过子图依赖检查（#4 Phase C）
│   ├── agent.test.ts
│   ├── benchmark.test.ts
│   ├── validate.test.ts
│   └── infra.test.ts
│
└── runs/
    └── {experiment_id}/       # output-da-agent/、summary/、run-summary.json、evaluation/
```

运行方式（`npm run build` 后，实验入口不依赖额外工具链）：

```bash
node dist/experiments/baseline-pi.js --experiment-id <id> [--tasks <ids> | --all] [--mock] [选项]
node dist/experiments/dag-prototype.js --experiment-id <id> [--tasks <ids> | --all] [--mock] [选项]
node dist/src/main.js baseline|dag --experiment-id <id> [...]     # 等价的分发入口
npm run evaluate -- <experiment_id>                               # 官方 Evaluator 评测
```

### 3.1 核心模块职责

- `benchmark/`：读取官方任务配置，准备隔离的数据工作区。
- `agent/`：封装 Pi Agent、工具和不同阶段的 Prompt；AgentRunner 契约以 `dag/executor.ts` 为单一来源（`AgentRunnerInput` 含必填 `nodeId` 与 `recorder`）。
- `dag/`：定义 DAG 节点、依赖关系、固定工作流和执行器。
- `artifacts/`：保存和读取节点之间的中间结果。
- `tracing/`：记录 Agent 调用、Token Usage、节点耗时和执行轨迹，并写出官方兼容的 `dabench/result.json` 与 run 级 summary。
- `src/experiments/`：baseline 与 DAG 共用的运行循环（任务子集选择、工作区准备、产出收集、断点续跑、run-summary）；`experiments/` 下为两个实验入口。
- `scripts/`：调用官方评价流程（evaluate.sh）等辅助脚本。

## 5. 实验输出

每次运行保存：

- Benchmark Task ID
- 使用的模型及实验配置
- 节点执行顺序和状态（修复回路重跑逐轮展开，含每轮所用模型，#3 Phase B）
- 每个节点的输入、输出及执行耗时
- Agent Tool Calls
- Token Usage（run-summary 按模型分层汇总，#3 Phase B）
- 修复回路收口信息（修复轮数 / 裁决结果 / 是否超限强制 accept，写入任务 summary 与 run-summary，#3 Phase B）
- 最终输出文件
- 官方 Benchmark Evaluation Score

所有实验使用独立的 Run Directory，保证结果可追溯。

## 6. 初版暂不实现的功能

- RAG 和向量数据库
- Dynamic DAG
- DAG 并行调度
- 自动重规划
- Checkpoint 和复杂故障恢复
- 复杂 Typed Artifact 系统
- 多 Agent 协作

这些功能不作为当前开发目标，是否需要引入由后续实验结果决定。

## 7. 第一阶段完成标准

1. Pi Agent Baseline 能够独立完成 30 任务子集中的 Benchmark 任务。
2. DAG Prototype 能够完整执行四个阶段。
3. 两套系统都能生成官方要求的结果文件。
4. 官方 Evaluator 能够正常评价两套系统。
5. 能够保存完整执行轨迹，定位具体失败节点。
