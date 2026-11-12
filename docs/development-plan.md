# Phase 1 开发计划

> 回答"怎么做、按什么顺序、每步怎么验收"。"做什么"见 [design.md](design.md)；PR 结构要求见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 1. 目标与完成标准（引用 design.md §6）

- [ ] Pi Agent Baseline 能够独立完成 30 任务冻结子集中的 Benchmark 任务
- [ ] DAG Prototype 完整执行四阶段（Inspect → Plan → Execute → Verify）
- [ ] 两套系统都生成官方要求的结果文件
- [ ] 官方 Evaluator 能正常评价两套系统
- [ ] 完整执行轨迹可保存、失败节点可定位

## 2. 省 token 开发策略（贯穿性约束，与 design.md §3 对齐）

1. **冻结 30 任务子集**：按 design.md §3.2 选样标准（数据集 < 50 MB、≥ 5 个 skill cluster、保留高难度任务、gold 齐全可评测）一次性选定 30 个任务，写入 `configs/benchmark.json`，连同任务 ID / 数据集 / 选择理由一起提交，之后不再增删替换。只下载子集所需数据集。
2. **mock agent 开发循环（0 token）**：DAG executor / artifacts / tracing 等 plumbing 全部先用"写死文件的假节点"打通；LLM 只在 M2 结束时用 1 个任务手测连通性。
3. **运行时护栏**（design.md §3.3，由 tracing 记录、事后可验证）：节点 ReAct 步数上限 40；单次工具输出超上限即截断；Inspect 只允许 head / schema / dtypes，禁止全量读取数据文件；run 级 token 预算超限中止并记录；已成功任务断点续跑跳过。
4. **模型分层**：开发与 bring-up 用 `deepseek-flash`（`.env` 已配）；正式对照跑（baseline vs DAG 各一次）时两系统切同一目标模型。
5. **成本基线先行**：先拿到 per-task token 基线（M4），再决定是否扩充样本；扩充按 §3.2 标准重新冻结子集版本。

执行顺序即下方里程碑顺序：冻结子集 → task-loader/workspace → mock 打通 DAG → baseline 实跑 → DAG 对比 → 扩量评估。

## 3. 里程碑

| 里程碑 | 内容 | 新增文件 | 验收标准 |
|---|---|---|---|
| M1 基准接入层 | 冻结 30 任务子集；读取官方任务配置；隔离工作区 | `configs/benchmark.json`、`src/benchmark/task-loader.ts`、`src/benchmark/workspace.ts` | 能加载子集全部任务（含选样理由元数据）；工作区可创建/隔离/清理；单测覆盖（含坏输入） |
| M2 Agent 运行时 | Pi Agent SDK 封装 + ReAct 循环 + 工具 + 分阶段 prompt | `src/agent/pi-runtime.ts`、`src/agent/tools.ts`、`src/agent/prompts.ts` | 读取 `.env`（DeepSeek）；max steps 与输出截断护栏生效；Inspect 工具白名单强制；1 个真实任务连通性手测通过 |
| M3 DAG plumbing（mock 打通） | 串行 Executor、Artifact 存取、轨迹记录 | `src/dag/executor.ts`、`src/artifacts/store.ts`、`src/tracing/recorder.ts`、`experiments/dag-prototype.ts` | mock agent 跑通四阶段；`runs/<id>/` 产物齐全；节点状态与耗时可查询；断点续跑生效；单测覆盖失败节点场景 |
| M4 Baseline 实跑 | Baseline 系统跑 30 任务子集 | `experiments/baseline-pi.ts`、`scripts/run-baseline.sh` | 子集任务全部完成或失败原因可定位；per-task token 基线落盘 `runs/` |
| M5 评测与对比 | 官方 Evaluator 对接；baseline vs DAG 对照 | `scripts/evaluate.sh`、`scripts/run-dag.sh` | 官方得分产出且能填入 PR 的 `benchmark-results` 块（`tasks: 30`）；两系统同任务同模型对照可复现 |
| M6 Phase A 失败策略（issue #2） | 节点重试 / 步数续跑 / 结构化 Artifact schema / 程序化验证门 | `src/artifacts/schemas.ts`、`src/validate/gate.ts` | 重试 / 续跑 / schema 校验失败路径单测覆盖；完成率与 token 对照实验待真实运行 |
| M7 Phase B 验证-修复回路（issue #3） | Verify 挑战者 + 裁决节点 + 有界回路（2 轮上限）+ state.json v2 + 按节点模型分层 | `tests/loop.test.ts`（executor/workflow/prompts/pi-runtime 扩展） | 单测覆盖回路终止条件、裁决三分支、含中间轮次断点续跑；`--mock` 管线联调通过；修复轮次 / 挑战清单 / 裁决结果在 summary 与 tracing 可查；真实 LLM 对照运行（0 分任务下降、均分 0.5+）待执行 |

模块与文件对应关系以 design.md §4 为准；M1–M3 严格串行（M3 依赖 M1 的任务输入结构），M4 可与 M3 后半并行。

## 4. Run 产物要求（M3 起）

`runs/<experiment_id>/` 必须包含：任务 ID、模型与配置、节点顺序/状态/耗时、tool calls、token usage、最终输出文件、官方得分（M5 起）。完整对照跑的成本目标：30 任务 × 双系统约 30–60M token（约 ¥10–30，见 design.md §3.4）；开发调试期控制在 5–20M。正式对照跑安排在 DeepSeek 非高峰时段（周末全天 + 工作日 18:00–9:00，半价）。

## 5. 每个 PR 的约定

- 标题用 Conventional Commits；功能更新（`feat`）PR 必须附 AgenticDataBench 评测结果，或用 `benchmark-waiver` 标签 + 原因。M1–M3 的 plumbing 类 feat 预期走豁免；M4/M5 起附真实结果（`tasks` 填本次实际评测任务数，完整子集为 30）。
- 代码/配置变更必须同步更新文档（本文件、README 或 design.md）。
- 检查必跑：`ci` / `title` / `docs` / `benchmark`（结果公示，不阻止合并——当前无分支保护）。

## 6. 待定项与风险

- **Pi Agent SDK 版本与接口**：M2 前需确认 SDK 的 provider 接入方式（DeepSeek 走 OpenAI 兼容接口，`/v1` 路径已验证可用）。
- **官方评测环境**：`evaluate.py` 本地打分不耗 token；`run_da_agent.sh` 是 Docker 全量跑——本项目用自研 runner + 官方 evaluator，子集控制权在自己手里。
- **数据集下载**：30 任务对应数据集的本地磁盘占用需在 M1 评估后再批量下载。
