import type { DagNode, WorkflowDefinition } from './types.js';

/**
 * 设计文档 2.2 节定义的固定四阶段工作流：
 * Inspect → Plan → Execute → Verify。
 * 初版固定拓扑，Plan 产出的是分析计划而非新 DAG。
 * inspect / plan 的节点任务内嵌结构化 schema 要求（#2 Phase A 升级点 3），
 * 不合规产物由 executor 的 schema 校验拦截并触发重试。
 */
export function defaultWorkflow(): WorkflowDefinition {
  const nodes: DagNode[] = [
    {
      id: 'inspect',
      task:
        '检查任务涉及的数据文件、Schema 和样本，输出 data_profile.json。' +
        '结构要求：顶层对象含 files 数组，每个文件条目含 name（数据文件相对路径）、' +
        'rows（行数）、columns（数组，每列含 name 与 dtype），' +
        '并尽量给出每文件关键统计量（stats）与数据质量问题清单（quality_issues）',
      dependsOn: [],
      outputArtifacts: ['data_profile.json'],
    },
    {
      id: 'plan',
      task:
        '根据任务和数据结构制定分析计划，输出 analysis_plan.json。' +
        '结构要求：顶层对象含 steps 数组，每个步骤含 description（字符串），' +
        '可含 tools（使用的工具）与 expected_outputs（预期产出）',
      dependsOn: ['inspect'],
      outputArtifacts: ['analysis_plan.json'],
    },
    {
      id: 'execute',
      task: '使用 Python、SQL 等工具执行分析，产出分析结果与执行摘要',
      dependsOn: ['plan'],
      outputArtifacts: ['result.json', 'execute_summary.json'],
    },
    {
      id: 'verify',
      task: '检查输出文件、格式和基本结果完整性，输出 verification.json',
      dependsOn: ['execute'],
      outputArtifacts: ['verification.json'],
    },
  ];
  return { id: 'inspect-plan-execute-verify', nodes };
}

/**
 * 按具体任务构建四阶段工作流：execute 节点的声明产物与任务要求的输出文件对齐，
 * 避免固定占位产物（result.json）与真实任务输出脱节导致 verify 依赖检查失败。
 */
export function taskWorkflow(task: { outputFileName: string[] }): WorkflowDefinition {
  const outputs = [...new Set(task.outputFileName)];
  const outputsText = outputs.length > 0 ? outputs.join('、') : '任务要求的输出文件';
  const nodes: DagNode[] = [
    {
      id: 'inspect',
      task:
        '检查任务涉及的数据文件、Schema 和样本，输出 data_profile.json。' +
        '结构要求：顶层对象含 files 数组，每个文件条目含 name（数据文件相对路径）、' +
        'rows（行数）、columns（数组，每列含 name 与 dtype），' +
        '并尽量给出每文件关键统计量（stats）与数据质量问题清单（quality_issues）',
      dependsOn: [],
      outputArtifacts: ['data_profile.json'],
    },
    {
      id: 'plan',
      task:
        '根据任务和数据结构制定分析计划，输出 analysis_plan.json。' +
        '结构要求：顶层对象含 steps 数组，每个步骤含 description（字符串），' +
        '可含 tools（使用的工具）与 expected_outputs（预期产出）',
      dependsOn: ['inspect'],
      outputArtifacts: ['analysis_plan.json'],
    },
    {
      id: 'execute',
      task:
        `使用 Python 等工具执行分析：产出最终结果文件（${outputsText}，文件名必须与要求完全一致），` +
        '并把执行摘要（分析方法、关键中间结果、产出文件清单）写入 execute_summary.json',
      dependsOn: ['plan'],
      outputArtifacts: [...outputs, 'execute_summary.json'],
    },
    {
      id: 'verify',
      task: `检查输出文件（${outputsText}）是否存在、格式正确且结果完整，输出 verification.json`,
      dependsOn: ['execute'],
      outputArtifacts: ['verification.json'],
    },
  ];
  return { id: 'inspect-plan-execute-verify', nodes };
}

/** 修复回路工作流构建选项（#3 Phase B）。 */
export interface RepairWorkflowOptions {
  /**
   * 修复轮数上限（默认 2）：execute 最多执行 1 + maxRepairRounds 次。
   * 对齐 TradingAgents 默认 1 轮辩论的低轮数经验——多轮辩论性价比低。
   */
  maxRepairRounds?: number;
}

/** 默认修复轮数上限（#3 Phase B：有界修复回路）。 */
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/**
 * 按具体任务构建带验证-修复回路的五节点工作流（#3 Phase B）：
 *
 *   inspect → plan → execute ⇄ verify（挑战者）→ adjudicate（裁决）
 *
 * - verify 升级为 Bear 式挑战者：产出结构化挑战清单 challenge_list.json
 *   （单位换算 / 过滤条件 / 任务要求逐条覆盖度等维度），而非 pass/fail；
 * - execute 重跑时经回路依赖（loopDependencies）读取挑战清单，单轮应答并修复重写；
 * - adjudicate 裁决 pass / fix / accept 三选一：fix 回炉 execute（有界，上限
 *   maxRepairRounds 轮），pass / accept 结束；超限由 executor 强制 accept 收口；
 * - 第一道验证门仍是 Phase A 的程序化检查（0 token，executor outputGate），辩驳只处理语义层。
 */
export function taskRepairWorkflow(
  task: { outputFileName: string[] },
  options: RepairWorkflowOptions = {},
): WorkflowDefinition {
  const outputs = [...new Set(task.outputFileName)];
  const outputsText = outputs.length > 0 ? outputs.join('、') : '任务要求的输出文件';
  const maxRepairRounds = Math.max(0, Math.floor(options.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS));
  const maxExecutions = 1 + maxRepairRounds;
  const executeTask =
    `使用 Python 等工具执行分析：产出最终结果文件（${outputsText}，文件名必须与要求完全一致），` +
    '并把执行摘要（分析方法、关键中间结果、产出文件清单）写入 execute_summary.json。' +
    '若输入包含上游挑战清单 challenge_list.json（说明本轮为修复轮），必须逐条应答：' +
    '针对每条挑战修复分析（单位换算、过滤条件、时间窗口、聚合口径、任务要求覆盖等），' +
    '重写全部受影响的输出文件，并把每条挑战的应答（修复措施或保留理由）写入 ' +
    'execute_summary.json 的 challenge_responses 数组';
  const nodes: DagNode[] = [
    {
      id: 'inspect',
      task:
        '检查任务涉及的数据文件、Schema 和样本，输出 data_profile.json。' +
        '结构要求：顶层对象含 files 数组，每个文件条目含 name（数据文件相对路径）、' +
        'rows（行数）、columns（数组，每列含 name 与 dtype），' +
        '并尽量给出每文件关键统计量（stats）与数据质量问题清单（quality_issues）',
      dependsOn: [],
      outputArtifacts: ['data_profile.json'],
    },
    {
      id: 'plan',
      task:
        '根据任务和数据结构制定分析计划，输出 analysis_plan.json。' +
        '结构要求：顶层对象含 steps 数组，每个步骤含 description（字符串），' +
        '可含 tools（使用的工具）与 expected_outputs（预期产出）',
      dependsOn: ['inspect'],
      outputArtifacts: ['analysis_plan.json'],
    },
    {
      id: 'execute',
      task: executeTask,
      dependsOn: ['plan'],
      loopDependencies: ['verify'],
      maxExecutions,
      outputArtifacts: [...outputs, 'execute_summary.json'],
    },
    {
      id: 'verify',
      promptStyle: 'challenger',
      task:
        `以挑战者身份审查 execute 的分析结果（输出文件：${outputsText}），产出挑战清单 challenge_list.json。` +
        '像看空辩手一样假设结果有错，逐项核查：' +
        '（1）单位换算（金额/数量/百分比的量级与单位）；' +
        '（2）过滤条件（行筛选、分组口径、排序方向是否与任务要求一致）；' +
        '（3）时间窗口（起止日期、粒度）；' +
        '（4）聚合口径（均值/求和/计数、去重）；' +
        `（5）任务要求逐条覆盖度（把任务拆成具体要求，逐条核对结果是否满足，遗漏即挑战）。` +
        '结构要求：顶层对象含 challenges 数组（无挑战时为空数组），每条挑战含 ' +
        'category（unit_conversion / filter_condition / time_window / aggregation / ' +
        'requirement_coverage / other 之一）、description（具体质疑内容与依据）、' +
        '可选 severity（critical / major / minor）。' +
        '只挑语义错误：输出文件缺失/空文件/格式错误由程序化验证门负责，不要重复检查。' +
        '不要自己修复任何文件——你的职责是提出挑战，修复由 execute 负责。',
      dependsOn: ['execute'],
      maxExecutions,
      outputArtifacts: ['challenge_list.json'],
    },
    {
      id: 'adjudicate',
      promptStyle: 'adjudicator',
      task:
        '作为裁决节点，综合挑战清单（challenge_list.json）与 execute 的执行摘要与产出，' +
        '对当前分析结果做出最终裁决，输出 verdict.json。' +
        '结构要求：顶层对象含 decision（pass / fix / accept 三选一）与 reasons（字符串数组）。' +
        '裁决规则：挑战清单为空或挑战均不成立 → pass；' +
        '存在实质性错误（单位换算错误、过滤条件违背任务要求、任务要求遗漏，即 critical/major 级挑战）' +
        '且仍有修复预算 → fix；仅剩 minor 级瑕疵、主观口径分歧或挑战无法定位 → accept（保留现状）。' +
        '宁可 accept 也不要为锦上添花发起 fix：每轮修复都有真实成本。',
      dependsOn: ['execute', 'verify'],
      outputArtifacts: ['verdict.json'],
      decisionArtifact: 'verdict.json',
      conditionalNext: [{ when: 'fix', goto: 'execute' }],
      maxExecutions,
    },
  ];
  return { id: 'inspect-plan-execute-verify-adjudicate', nodes };
}
