/**
 * 难度路由（#4 Phase C）：入口按任务特征选择执行路径，规则分档、零 LLM 成本。
 *
 * 参照 TradingAgents 的条件化分析师激活（--analysts 按任务裁剪图结构）：
 * 大量任务 Baseline 直做即可满分，不需要完整四阶段流水线（3.3 倍 token 的主要来源
 * 之一就是「所有任务都跑满四阶段」）。
 *
 * 三档路径：
 * - full   完整路径：Inspect → Plan → Execute ⇄ Verify → Adjudicate（含修复回路）
 * - simple 简单路径：跳过 Plan（executor 跳过子图，依赖透明传递），保留修复回路
 * - minimal 极简路径：单节点直做（baseline 式 prompt + 程序化验证门 + 重试护栏）
 *
 * 设计约束（issue #4 非目标）：不做 LLM 路由（先规则，效果不佳再升级）；
 * 不动态增删节点（full 拓扑静态可校验，simple 通过 executor 跳过子图表达）。
 */
import type { BenchmarkTask } from '../benchmark/task-loader.js';

/** 路由档位。 */
export type RouteId = 'minimal' | 'simple' | 'full';

/** 路由决策依据的任务特征（全部可从任务定义确定性导出）。 */
export interface RouteFeatures {
  /** 任务要求产出的输出文件数量（output_file_name）。 */
  outputFiles: number;
  /** 任务依赖的数据源文件数量（data_sources）。 */
  dataFiles: number;
  /** 任务问题文本长度（字符数，近似问题复杂度）。 */
  questionChars: number;
}

/** 一次路由决策（特征依据 + 选择结果 + 人类可读理由），写入 tracing 与 summary 可归因。 */
export interface RouteDecision {
  route: RouteId;
  features: RouteFeatures;
  /** 决策理由（逐条列出特征与阈值对比），写入 summary / tracing。 */
  reason: string;
}

/**
 * 各档位的 token 预算系数（相对 run 级预算，#4 Phase C：原 run 级预算改为按档位生效）。
 * - full：完整流水线，用满 run 级预算；
 * - simple：跳过 Plan，且预计少一轮修复，0.6；
 * - minimal：单节点直做（≈ baseline 量级），0.25。
 */
export const ROUTE_BUDGET_FACTOR: Readonly<Record<RouteId, number>> = {
  full: 1,
  simple: 0.6,
  minimal: 0.25,
};

/** simple 路径阈值：输出文件少、数据源少、问题不长（保守，优先保证得分不回退）。 */
const SIMPLE_MAX_OUTPUTS = 1;
const SIMPLE_MAX_DATA_FILES = 3;
const SIMPLE_MAX_QUESTION_CHARS = 1200;

/** minimal 路径阈值：单输出、极少量数据源、问题很短（baseline 式直做即可覆盖）。 */
const MINIMAL_MAX_OUTPUTS = 1;
const MINIMAL_MAX_DATA_FILES = 2;
const MINIMAL_MAX_QUESTION_CHARS = 500;

/** 从任务定义导出路由特征。 */
export function routeFeatures(task: Pick<BenchmarkTask, 'outputFileName' | 'dataSources' | 'question'>): RouteFeatures {
  return {
    outputFiles: task.outputFileName.length,
    dataFiles: task.dataSources.filter((rel) => rel.trim().length > 0).length,
    questionChars: task.question.length,
  };
}

/**
 * 规则路由：minimal ⊂ simple ⊂ full，逐档下沉（先判最小档，保证保守任务走重路径）。
 * 决策理由逐条列出特征值与阈值对比，保证可归因。
 */
export function routeTask(
  task: Pick<BenchmarkTask, 'outputFileName' | 'dataSources' | 'question'>,
): RouteDecision {
  const features = routeFeatures(task);

  if (
    features.outputFiles <= MINIMAL_MAX_OUTPUTS &&
    features.dataFiles <= MINIMAL_MAX_DATA_FILES &&
    features.questionChars <= MINIMAL_MAX_QUESTION_CHARS
  ) {
    return {
      route: 'minimal',
      features,
      reason:
        `outputFiles=${features.outputFiles}<=${MINIMAL_MAX_OUTPUTS}, ` +
        `dataFiles=${features.dataFiles}<=${MINIMAL_MAX_DATA_FILES}, ` +
        `questionChars=${features.questionChars}<=${MINIMAL_MAX_QUESTION_CHARS} → minimal（单节点直做）`,
    };
  }
  if (
    features.outputFiles <= SIMPLE_MAX_OUTPUTS &&
    features.dataFiles <= SIMPLE_MAX_DATA_FILES &&
    features.questionChars <= SIMPLE_MAX_QUESTION_CHARS
  ) {
    return {
      route: 'simple',
      features,
      reason:
        `outputFiles=${features.outputFiles}<=${SIMPLE_MAX_OUTPUTS}, ` +
        `dataFiles=${features.dataFiles}<=${SIMPLE_MAX_DATA_FILES}, ` +
        `questionChars=${features.questionChars}<=${SIMPLE_MAX_QUESTION_CHARS} → simple（跳过 Plan，保留修复回路）`,
    };
  }
  return {
    route: 'full',
    features,
    reason:
      `outputFiles=${features.outputFiles}, dataFiles=${features.dataFiles}, ` +
      `questionChars=${features.questionChars}（超出 simple 阈值：` +
      `outputs<=${SIMPLE_MAX_OUTPUTS} / dataFiles<=${SIMPLE_MAX_DATA_FILES} / chars<=${SIMPLE_MAX_QUESTION_CHARS}）→ full（完整流水线）`,
  };
}

/** 按档位折算 token 预算（四舍五入取整；向上保底 1，避免 0 预算直接判死）。 */
export function routeBudget(baseBudget: number, route: RouteId): number {
  return Math.max(1, Math.round(baseBudget * ROUTE_BUDGET_FACTOR[route]));
}
