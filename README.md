# Data Science Agent — AgenticDataBench × Pi Agent（DAG 编排）

![CI](https://github.com/LosAveRoad/data_science_agent/actions/workflows/ci.yml/badge.svg)
![PR Structure](https://github.com/LosAveRoad/data_science_agent/actions/workflows/pr-structure.yml/badge.svg)

基于 AgenticDataBench 基准，使用 Pi Agent 作为底层 ReAct Runtime 的数据分析 Agent，并自主实现 DAG 编排层，探索任务分阶段执行与依赖管理对数据分析任务完成效果的影响。

- **Baseline**：Pi Agent 直接接收任务，通过 ReAct 与工具调用完成数据分析。
- **DAG Prototype**：Pi Agent 作为执行节点，由自研 DAG Orchestrator 管理固定四阶段工作流 `Inspect → Plan → Execute → Verify`，节点之间通过文件 Artifact 传递信息。

两套系统使用相同的模型、工具、数据集和执行环境，统一由 AgenticDataBench 官方 Evaluator 评价。完整设计见 [docs/design.md](docs/design.md)。

## 当前状态（Phase 0）

- [x] 项目脚手架与 CI / PR 结构检查
- [ ] Pi Agent Baseline 跑通 Benchmark 任务
- [ ] DAG Prototype（四阶段 + Executor）
- [ ] 官方 Evaluator 接入与 Run 记录
- [ ] 执行轨迹（Tool Calls / Token Usage / 节点耗时）与失败定位

## 目录结构

```text
├── configs/          # Benchmark 运行配置（待实现）
├── docs/             # 设计文档等
├── src/
│   ├── benchmark/    # 任务读取、隔离工作区准备（待实现）
│   ├── agent/        # Pi Agent 封装、工具、分阶段 Prompt（待实现）
│   ├── dag/          # 节点/依赖/固定工作流/执行器（types 与图校验已就绪）
│   ├── artifacts/    # Artifact 存取（待实现）
│   ├── tracing/      # 轨迹与 Token 统计（待实现）
│   └── main.ts
├── experiments/      # baseline-pi / dag-prototype 入口（待实现）
├── scripts/          # PR 结构检查等脚本
├── tests/            # 单元测试（vitest）
└── runs/             # 实验产物；JSON 评测证据随 PR 提交
```

## 快速开始

```bash
npm install
npm run typecheck
npm run build
npm test
```

## CI 与 PR 规则

所有改动通过 PR 合入 `main`，以下检查为合并必过项（详见 [CONTRIBUTING.md](CONTRIBUTING.md)）：

1. **PR 标题**符合 Conventional Commits：`type(scope): subject`。
2. **文档同步**：改动 `src/`、`experiments/`、`configs/`、`scripts/`、`package.json`、`tsconfig.json` 的 PR 必须同步更新 Markdown 文档，并在 PR 描述中填写「文档更新说明」。
3. **评测证据**：功能更新 PR（`feat` 或 `feature` 标签）必须在描述中提供 AgenticDataBench 官方 Evaluator 结果（`benchmark-results` 代码块，含 `experiment_id` / `tasks` / `score`）。
4. 豁免标签：`no-docs-needed`（确无文档可更新）、`benchmark-waiver`（暂无法跑评测）。
