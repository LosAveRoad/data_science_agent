# 贡献指南：PR 结构要求

本仓库所有改动一律通过 Pull Request 合入 `main`。CI 强制以下结构要求（`.github/workflows/pr-structure.yml` + `scripts/check-pr-structure.mjs`），未通过则无法合并（分支保护已配置为必过）。

## 必过检查

| 检查 | 内容 |
|---|---|
| `ci` | 类型检查 / 构建 / 单元测试 |
| `title` | PR 标题符合 Conventional Commits |
| `docs` | 文档同步检查 |
| `benchmark` | 功能更新的评测证据检查 |

## 1. PR 标题

格式：`type(scope): subject`，scope 可省略。

| type | 用途 | 是否需要 AgenticDataBench 测试结果 |
|---|---|---|
| `feat` | **功能更新** | ✅ 必须 |
| `fix` | 缺陷修复 | – |
| `docs` | 仅文档 | – |
| `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `style` / `revert` | 其他 | – |

示例：

- `feat(dag): 实现 Executor 串行调度`
- `fix(agent): 修复工具调用超时未重试`
- `docs: 更新实验记录格式`

> 功能更新还包括添加了 `feature` 标签的 PR（即使标题类型不是 feat）。

## 2. 文档同步（所有 PR）

1. 所有 PR 必须填写描述中的「## 文档更新说明」小节（使用 PR 模板，勾选其一）。
2. 只要改动以下路径，就必须同时更新至少一个 Markdown 文件（`README.md`、`CONTRIBUTING.md`、`docs/**`）：

   ```text
   src/**、experiments/**、configs/**、scripts/**、package.json、tsconfig.json
   ```

3. 确实无需更新文档的改动（如纯内部重构、无行为变化的重命名），添加 `no-docs-needed` 标签，并在「文档更新说明」中写明原因。

## 3. AgenticDataBench 测试结果（功能更新 PR）

「功能更新 PR」= 标题 type 为 `feat`，或添加了 `feature` 标签。

必须在 PR 描述中粘贴官方 Evaluator 结果，格式为固定围栏块：

````markdown
```benchmark-results
experiment_id: dag-proto-20261112-01
tasks: 10
score: 0.72
evaluator: AgenticDataBench official evaluator
```
````

要求：

- `experiment_id` 对应 `runs/<experiment_id>/`，只能包含字母、数字、`.`、`_`、`-`；
- `tasks`、`score` 非空（`score` 填官方 Evaluator 给出的得分）；
- **强烈建议**随 PR 附带 `runs/<experiment_id>/` 下的 JSON 评测产物（官方 Evaluator 输出）。若附带，CI 会校验其与描述中的 `experiment_id` 一致；后续阶段计划将其升级为强制项；
- 尚无法跑通评测的功能 PR（如纯脚手架、基础设施），添加 `benchmark-waiver` 标签并在 PR 中说明原因。

## 本地自检

```bash
npm install        # 安装依赖
npm run typecheck  # 类型检查
npm run build      # 构建
npm test           # 单元测试
```

CI 环境为 Node 22，本地请使用 Node ≥ 20。
