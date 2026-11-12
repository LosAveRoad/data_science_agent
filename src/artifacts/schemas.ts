/**
 * 结构化 Artifact schema 校验（#2 Phase A 升级点 3）：
 *
 * 节点间传递的关键 Artifact（data_profile.json / analysis_plan.json）按文件名映射到
 * 固定 schema，注册进 ArtifactStore 后做确定性校验——不合规的产物在产出节点本身
 * 被判失败并触发重试（错误清单回灌给 runner），避免下游节点拿到空洞简报后重新探索
 * 数据（DAG 实测 token 膨胀 ×3.3 的主要来源之一）。
 *
 * 校验原则：只强制「下游协作所需的最小字段集」，允许任意额外字段；宽松通过、
 * 严格拦截结构性缺失（缺 files / columns 为空 / 缺 dtype 等）。
 */
import { readFile } from 'node:fs/promises';

/** 已登记的结构化 Artifact schema ID。 */
export type ArtifactSchemaId = 'data_profile' | 'analysis_plan' | 'challenge_list' | 'verdict';

/** Artifact 文件名 → schema 映射（按文件名识别，workflow 定义无需额外声明）。 */
const SCHEMA_BY_ARTIFACT: Readonly<Record<string, ArtifactSchemaId>> = {
  'data_profile.json': 'data_profile',
  'analysis_plan.json': 'analysis_plan',
  'challenge_list.json': 'challenge_list',
  'verdict.json': 'verdict',
};

/** 按产物文件名返回 schema ID；无对应 schema 时返回 null（不校验）。 */
export function schemaForArtifact(name: string): ArtifactSchemaId | null {
  return SCHEMA_BY_ARTIFACT[name] ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 校验 data_profile.json 内容，返回问题清单（空列表 = 合法）。 */
export function validateDataProfile(content: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(content)) {
    return ['顶层必须是 JSON 对象（非数组、非标量）'];
  }
  const files = content['files'];
  if (!Array.isArray(files)) {
    return ['缺少 files 数组（须列出工作区全部数据文件的结构概览）'];
  }
  if (files.length === 0) {
    return ['files 数组为空：工作区存在数据文件时必须逐个列出'];
  }
  files.forEach((entry, fileIndex) => {
    const label = `files[${fileIndex}]`;
    if (!isPlainObject(entry)) {
      problems.push(`${label} 必须是对象`);
      return;
    }
    if (typeof entry['name'] !== 'string' || entry['name'].trim().length === 0) {
      problems.push(`${label}.name 必须是非空字符串（数据文件相对路径）`);
    }
    const rows = entry['rows'];
    if (rows !== null && rows !== undefined && (typeof rows !== 'number' || !Number.isFinite(rows) || rows < 0)) {
      problems.push(`${label}.rows 必须是非负数字或 null`);
    }
    const columns = entry['columns'];
    if (!Array.isArray(columns)) {
      problems.push(`${label}.columns 必须是数组（每列含 name 与 dtype）`);
      return;
    }
    columns.forEach((column, columnIndex) => {
      const columnLabel = `${label}.columns[${columnIndex}]`;
      if (!isPlainObject(column)) {
        problems.push(`${columnLabel} 必须是对象`);
        return;
      }
      if (typeof column['name'] !== 'string' || column['name'].trim().length === 0) {
        problems.push(`${columnLabel}.name 必须是非空字符串`);
      }
      if (typeof column['dtype'] !== 'string' || column['dtype'].trim().length === 0) {
        problems.push(`${columnLabel}.dtype 必须是非空字符串`);
      }
    });
  });
  return problems;
}

/** 校验 analysis_plan.json 内容，返回问题清单（空列表 = 合法）。 */
export function validateAnalysisPlan(content: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(content)) {
    return ['顶层必须是 JSON 对象（非数组、非标量）'];
  }
  const steps = content['steps'];
  if (!Array.isArray(steps)) {
    return ['缺少 steps 数组（机器可读的分析步骤清单）'];
  }
  if (steps.length === 0) {
    return ['steps 数组为空：分析计划必须包含至少一个步骤'];
  }
  steps.forEach((step, index) => {
    const label = `steps[${index}]`;
    if (!isPlainObject(step)) {
      problems.push(`${label} 必须是对象`);
      return;
    }
    if (typeof step['description'] !== 'string' || step['description'].trim().length === 0) {
      problems.push(`${label}.description 必须是非空字符串`);
    }
  });
  return problems;
}

/** schema ID → 校验函数。 */
const VALIDATORS: Readonly<Record<ArtifactSchemaId, (content: unknown) => string[]>> = {
  data_profile: validateDataProfile,
  analysis_plan: validateAnalysisPlan,
  challenge_list: validateChallengeList,
  verdict: validateVerdict,
};

/** challenge_list 挑战类别（#3 Phase B 挑战清单的固定检查维度）。 */
export const CHALLENGE_CATEGORIES = [
  'unit_conversion',
  'filter_condition',
  'time_window',
  'aggregation',
  'requirement_coverage',
  'other',
] as const;

export type ChallengeCategory = (typeof CHALLENGE_CATEGORIES)[number];

/**
 * 校验 challenge_list.json 内容（verify 挑战者节点产出，#3 Phase B），
 * 返回问题清单（空列表 = 合法）。
 *
 * 最小契约：顶层对象含 challenges 数组（可为空 = 无语义挑战）；
 * 每条挑战含 category（固定维度之一）与 description（具体质疑内容），
 * 可含 severity（critical / major / minor）与 evidence（依据）。
 */
export function validateChallengeList(content: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(content)) {
    return ['顶层必须是 JSON 对象（非数组、非标量）'];
  }
  const challenges = content['challenges'];
  if (!Array.isArray(challenges)) {
    return ['缺少 challenges 数组（无挑战时为空数组，不允许省略）'];
  }
  challenges.forEach((challenge, index) => {
    const label = `challenges[${index}]`;
    if (!isPlainObject(challenge)) {
      problems.push(`${label} 必须是对象`);
      return;
    }
    const category = challenge['category'];
    if (typeof category !== 'string' || !CHALLENGE_CATEGORIES.includes(category as ChallengeCategory)) {
      problems.push(
        `${label}.category 必须是 ${CHALLENGE_CATEGORIES.join(' / ')} 之一，实际为 ${JSON.stringify(category)}`,
      );
    }
    if (typeof challenge['description'] !== 'string' || challenge['description'].trim().length === 0) {
      problems.push(`${label}.description 必须是非空字符串（具体质疑内容）`);
    }
    const severity = challenge['severity'];
    if (
      severity !== undefined &&
      severity !== null &&
      !['critical', 'major', 'minor'].includes(severity as string)
    ) {
      problems.push(`${label}.severity 只允许 critical / major / minor，实际为 ${JSON.stringify(severity)}`);
    }
  });
  return problems;
}

/** 裁决决定（#3 Phase B 裁决节点的三选一）。 */
export const VERDICT_DECISIONS = ['pass', 'fix', 'accept'] as const;

export type VerdictDecision = (typeof VERDICT_DECISIONS)[number];

/**
 * 校验 verdict.json 内容（裁决节点产出，#3 Phase B），返回问题清单（空列表 = 合法）。
 * 最小契约：decision 必须是 pass / fix / accept 三选一；reasons 为字符串数组（可空）。
 */
export function validateVerdict(content: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(content)) {
    return ['顶层必须是 JSON 对象（非数组、非标量）'];
  }
  const decision = content['decision'];
  if (typeof decision !== 'string' || !VERDICT_DECISIONS.includes(decision as VerdictDecision)) {
    return [`decision 必须是 ${VERDICT_DECISIONS.join(' / ')} 之一，实际为 ${JSON.stringify(decision)}`];
  }
  const reasons = content['reasons'];
  if (reasons !== undefined && reasons !== null) {
    if (!Array.isArray(reasons)) {
      problems.push('reasons 必须是字符串数组');
    } else {
      reasons.forEach((reason, index) => {
        if (typeof reason !== 'string') {
          problems.push(`reasons[${index}] 必须是字符串`);
        }
      });
    }
  }
  return problems;
}

/** 校验一段已解析的 JSON 内容；返回问题清单（空列表 = 合法）。 */
export function validateArtifactContent(schemaId: ArtifactSchemaId, content: unknown): string[] {
  return VALIDATORS[schemaId](content);
}

/** 读取并校验一个产物文件；文件缺失 / 非法 JSON / schema 不合规都返回问题清单（空列表 = 合法）。 */
export async function validateArtifactFile(schemaId: ArtifactSchemaId, filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    return [`无法读取产物文件: ${err instanceof Error ? err.message : String(err)}`];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [`不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`];
  }
  return validateArtifactContent(schemaId, parsed);
}
