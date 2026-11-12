# Data Science Agent — AgenticDataBench × Pi Agent（DAG 编排）

![CI](https://github.com/LosAveRoad/data_science_agent/actions/workflows/ci.yml/badge.svg)
![PR Structure](https://github.com/LosAveRoad/data_science_agent/actions/workflows/pr-structure.yml/badge.svg)

基于 AgenticDataBench 基准，使用 Pi Agent 作为底层 ReAct Runtime 的数据分析 Agent，并自主实现 DAG 编排层，探索任务分阶段执行与依赖管理对数据分析任务完成效果的影响。

- **Baseline**：Pi Agent 直接接收任务，通过 ReAct 与工具调用完成数据分析。
- **DAG Prototype**：Pi Agent 作为执行节点，由自研 DAG Orchestrator 管理四阶段工作流并带验证-修复回路：`Inspect → Plan → Execute ⇄ Verify(挑战者) → Adjudicate(裁决)`，节点之间通过文件 Artifact 传递信息；节点失败自动重试 / 步数耗尽续跑，关键 Artifact 做结构化 schema 校验，execute 产出过程序化验证门（Phase A，[issue #2](https://github.com/LosAveRoad/data_science_agent/issues/2)）；验证-修复回路与模型分层（Phase B，[issue #3](https://github.com/LosAveRoad/data_science_agent/issues/3)）。

两套系统使用相同的模型、工具、数据集和执行环境，统一由 AgenticDataBench 官方 Evaluator 评价。第一阶段固定评测 **30 个任务的冻结子集**，不跑全量 344 任务（选样标准与成本预估见 [docs/design.md](docs/design.md) §3）。完整设计见 [docs/design.md](docs/design.md)，Phase 1 开发计划与里程碑见 [docs/development-plan.md](docs/development-plan.md)。

## 当前状态（Phase 1）

- [x] 项目脚手架与 CI / PR 结构检查
- [ ] Pi Agent Baseline 跑通 Benchmark 子集任务（30 个）——实验入口与运行管线已就绪（`--mock` 0 token 联调通过），真实 LLM 运行待执行
- [x] DAG Prototype（四阶段 + Executor + 实验入口，mock 联调通过）
- [x] 官方 Evaluator 接入与 Run 记录（`scripts/evaluate.sh`，mock 输出已验证解析管线）
- [x] 执行轨迹（Tool Calls / Token Usage / 节点耗时）与失败定位
- [x] Phase A 失败策略与产物契约（[issue #2](https://github.com/LosAveRoad/data_science_agent/issues/2)）：节点失败重试 / 步数耗尽续跑 / Artifact 结构化 schema / 程序化验证门——单测与 `--mock` 管线验证通过，真实 LLM 对照运行待执行
- [x] Phase B 验证-修复回路与模型分层（[issue #3](https://github.com/LosAveRoad/data_science_agent/issues/3)）：Verify 挑战者 + 裁决节点 + 有界修复回路（2 轮上限）+ 按节点模型分层——单测与 `--mock` 管线验证通过，真实 LLM 对照运行待执行

## 目录结构

```text
├── configs/          # Benchmark 运行配置（30 任务冻结子集，configs/benchmark.json）
├── docs/             # 设计文档、开发计划
├── src/
│   ├── benchmark/    # 任务读取（dev.jsonl）、隔离工作区准备
│   ├── agent/        # Pi Agent Runtime、工作区工具、Baseline/节点/挑战者/裁决者 Prompt、按节点模型分层、MockAgentRunner
│   ├── dag/          # 节点/依赖/工作流（含修复回路拓扑）/有界回路 Executor（AgentRunner 契约单一来源）
│   ├── artifacts/    # Artifact 存取（产物注册表 + data_profile/analysis_plan/challenge_list/verdict 结构化 schema 校验）
│   ├── validate/     # 程序化验证门（任务输出文件存在性/非空/格式检查，0 token）
│   ├── tracing/      # RunRecorder：轨迹、Token 统计（按节点记录模型）、官方 result.json / run 级 summary
│   ├── experiments/  # 实验公共代码：runner.ts（共享运行循环 + CLI 解析 + 强模型分层接线）、mock-scripts.ts
│   └── main.ts       # CLI 分发入口：node dist/src/main.js baseline|dag [--...]
├── experiments/      # 实验入口：baseline-pi.ts / dag-prototype.ts（编译产物 dist/experiments/*.js）
├── scripts/          # evaluate.sh（官方 Evaluator）、check-pr-structure.mjs、test-llm.ts
├── tests/            # 单元测试（vitest；loop.test.ts 覆盖修复回路）
└── runs/             # 实验产物：runs/<experiment_id>/（output-da-agent、summary、run-summary.json、evaluation）；JSON 评测证据随 PR 提交
```

## 快速开始

```bash
npm install
npm run typecheck
npm run build
npm test
```

### 模型接入

两套系统通过 `PI_BASE_URL` / `MODEL_ID` 接入任意 OpenAI 兼容端点，`.env.example` 给出两条路径：

| 路径 | 端点 | 模型 ID | 计费 |
|---|---|---|---|
| 直连 DeepSeek | `https://api.deepseek.com` | `deepseek-flash` | 按 token |
| 本地代理 mistral-gateway | `http://127.0.0.1:8788/v1` | `deepseek-v4-1-flash` | Mistral Vibe 订阅额度 |

两者背后是同一模型（DeepSeek V4.1 Flash-1017），实验分数可比。经代理时链路多一跳、延迟约 3–4s/次往返，全量跑建议配 `--concurrency` 抵消。

**mistral-gateway 本地配置**（可选，仅走订阅额度时需要）：

```bash
git clone https://github.com/Classic298/mistral-gateway
cd mistral-gateway
cp gateway.env.example gateway.env   # VIBE_KEY=<Vibe 订阅 key>
python3 gateway.py                   # 监听 127.0.0.1:8788
curl -s localhost:8788/health        # {"ok": true, ...}
curl -s localhost:8788/quota         # 订阅计划与剩余额度
```

注意：该仓库为非官方代理（PolyForm Noncommercial 许可），仅适合个人研究用途；Mistral API 对未知字段严格校验，运行时的 `buildModel` 已默认 `supportsStore: false` 适配。

### Benchmark 运行

前置条件：项目根目录 `.env` 提供 `PI_API_KEY` / `PI_BASE_URL` / `MODEL_ID` 与
`AGENTIC_DATA_BENCH_DATA_DIR`（AgenticDataBench testbed 目录，任务与数据集来源；见 `.env.example`）。

```bash
# 0 token 管线联调（--mock：MockAgentRunner 写占位产出，不调用 LLM）
npm run run:baseline -- --experiment-id mock-001 --tasks healthcare_05 --mock
npm run run:dag      -- --experiment-id mock-dag-001 --tasks healthcare_05 --mock

# 真实运行（默认 token 预算 2M / 任务、ReAct 步数上限 40；断点续跑：已完成任务自动跳过）
npm run run:baseline -- --experiment-id baseline-20261112 --all
npm run run:dag      -- --experiment-id dag-proto-20261112  --all

# 官方 Evaluator 评测（结果写 runs/<experiment_id>/evaluation/）
npm run evaluate -- baseline-20261112
```

CLI 参数（两个实验入口一致，也可用 `node dist/src/main.js baseline|dag [--...]` 分发调用）：

| 参数 | 说明 |
|---|---|
| `--experiment-id <id>` | 必填，`runs/<id>/` 目录名，只能含字母、数字、`.`、`_`、`-` |
| `--tasks <id1,id2,...>` | 冻结子集（`configs/benchmark.json`）内的任务 ID，逗号分隔 |
| `--all` | 跑冻结子集全部 30 个任务（与 `--tasks` 互斥） |
| `--limit <n>` | 只跑选出的前 n 个任务 |
| `--mock` | 用 MockAgentRunner（0 token，管线联调） |
| `--token-budget <n>` | run 级 token 预算，默认 2000000，超限中止并标记 failed |
| `--max-steps <n>` | 单节点 / 单次 ReAct 步数上限，默认 40 |
| `--overwriting` | 忽略断点续跑记录，强制重跑已完成任务 |
| `--concurrency <n>` | 任务级并发数，默认 1（串行）；任务相互独立、工作区按 task.id 隔离，可安全并行 |

环境变量 `MODEL_ID_STRONG`（可选，Phase B 模型分层）：配置后 Plan / Verify（挑战者）/ Adjudicate（裁决）节点使用强模型，Inspect / Execute 保持 `MODEL_ID` 默认档；留空则全部节点用默认档。每次运行的分层用量在 `run-summary.json` 的 `totals.usageByModel` 汇总。

每次运行产出（`runs/<experiment_id>/`）：

- `output-da-agent/<task_id>/`：官方 Evaluator 输入——任务产出文件（按 `output_file_name` 从工作区收集）与 `dabench/result.json`（trajectory / finished / steps / result / result_files / token_usage）；
- `summary/<task_id>.json`：任务级汇总（节点状态 / 耗时 / 每节点模型 / token / 错误，及 DAG 模式的修复回路收口信息 `repair`：修复轮数 / 最终裁决 / 是否超限强制 accept）；
- `run-summary.json`：全部任务状态与 token 汇总、模型与运行配置、按模型分层的成本汇总（`totals.usageByModel`）；
- `evaluation/`：`scripts/evaluate.sh` 写出的官方评测结果 JSON。

## CI 与 PR 规则

所有改动通过 PR 合入 `main`，以下检查为合并必过项（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）：

1. **PR 标题**符合 Conventional Commits：`type(scope): subject`。
2. **文档同步**：改动 `src/`、`experiments/`、`configs/`、`scripts/`、`package.json`、`tsconfig.json` 的 PR 必须同步更新 Markdown 文档，并在 PR 描述中填写「文档更新说明」。
3. **评测证据**：功能更新 PR（`feat` 或 `feature` 标签）必须在描述中提供 AgenticDataBench 官方 Evaluator 结果（`benchmark-results` 代码块，含 `experiment_id` / `tasks` / `score`）。
4. 豁免标签：`no-docs-needed`（确无文档可更新）、`benchmark-waiver`（暂无法跑评测）。
