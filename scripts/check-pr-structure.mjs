#!/usr/bin/env node
/**
 * PR 结构检查（配合 .github/workflows/pr-structure.yml 使用）。
 *
 * 三条规则，对应三个独立 CI 门槛（分别以 title / docs / benchmark 模式调用）：
 *   title     — PR 标题必须符合 Conventional Commits（feat/fix/docs/...）。
 *   docs      — 所有 PR 必须填写「文档更新说明」；代码/配置变更必须同步更新 Markdown 文档。
 *   benchmark — 功能更新 PR（feat 或 feature 标签）必须提供 AgenticDataBench 官方评测结果。
 *
 * 用法：node scripts/check-pr-structure.mjs <title|docs|benchmark>
 * 环境变量：GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_EVENT_PATH（GitHub Actions 自动注入）。
 */

import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * feat PR 是否必须附带 runs/<experiment_id>/ 评测产物文件（如官方 Evaluator 输出 JSON）。
 * Phase 0 先只做交叉校验：附带则校验一致性，未附带仅提示；基准链路跑通后可改为 true。
 */
const REQUIRE_RUN_ARTIFACT = false;

const VALID_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'];
const TITLE_RE = new RegExp(`^(${VALID_TYPES.join('|')})(\\(([\\w./-]+)\\))?(!)?:\\s+\\S`);
const CODE_PATH_RE = /^(?:src|experiments|configs|scripts)\//;
const CODE_FILE_RE = /^(?:package|tsconfig)\.json$/;
const DOCS_PATH_RE = /\.(?:md|mdx)$/i;
const RUNS_PATH_RE = /^runs\/([^/]+)\//;
const DOCS_SECTION_RE = /^#{1,3}\s*(?:文档更新说明|documentation updates?)\s*$/im;
const BENCH_BLOCK_RE = /```benchmark-results[ \t]*\n([\s\S]*?)```/g;
const CHECKED_BOX_RE = /\[[xX]\]/;
const EXPERIMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const LABELS = {
  feature: 'feature',
  docsWaiver: 'no-docs-needed',
  benchmarkWaiver: 'benchmark-waiver',
};

/** 解析 PR 标题；不符合 Conventional Commits 时返回 null。 */
export function parseTitle(title) {
  const m = TITLE_RE.exec((title ?? '').trim());
  if (!m) return null;
  return { type: m[1], scope: m[3] ?? null, breaking: Boolean(m[4]) };
}

/** 提取 body 中某个二级/三级标题小节的内容（到下一个标题为止）。 */
export function extractSection(body, headerRe) {
  const text = (body ?? '').replace(/\r\n?/g, '\n');
  const match = headerRe.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const nextHeader = rest.search(/^#{1,3}\s+\S/m);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
}

/** 解析 PR 描述中的 ```benchmark-results 围栏块。 */
export function parseBenchmarkBlocks(body) {
  const blocks = [];
  for (const m of (body ?? '').matchAll(BENCH_BLOCK_RE)) {
    const fields = {};
    for (const line of m[1].split('\n')) {
      const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
      if (kv) fields[kv[1].toLowerCase()] = kv[2];
    }
    blocks.push({
      experimentId: fields['experiment_id'] ?? '',
      tasks: fields['tasks'] ?? '',
      score: fields['score'] ?? '',
      evaluator: fields['evaluator'] ?? '',
    });
  }
  return blocks;
}

/**
 * 纯函数规则评估（便于本地测试）。
 * @returns {{results: Array<{check: string, ok: boolean, detail: string, warnings: string[]}>, isFeature: boolean}}
 */
export function evaluate({ title, body, labels = [], files = [] }) {
  const labelSet = new Set((labels ?? []).map((l) => String(l).toLowerCase()));
  const text = (body ?? '').replace(/\r\n?/g, '\n');
  const fileList = files ?? [];
  const results = [];

  // 1) PR 标题规范
  const parsed = parseTitle(title);
  results.push({
    check: 'title',
    ok: Boolean(parsed),
    warnings: [],
    detail: parsed
      ? `类型：${parsed.type}${parsed.scope ? `(${parsed.scope})` : ''}${parsed.breaking ? '!' : ''}`
      : `标题需符合 Conventional Commits「type(scope): subject」，type ∈ ${VALID_TYPES.join('/')}`,
  });

  const isFeature = parsed?.type === 'feat' || labelSet.has(LABELS.feature);

  // 2) 文档同步（所有 PR）
  const docsSection = extractSection(text, DOCS_SECTION_RE);
  const docsDeclared = Boolean(docsSection) && CHECKED_BOX_RE.test(docsSection);
  const codeFiles = fileList.filter((f) => CODE_PATH_RE.test(f) || CODE_FILE_RE.test(f));
  const docsChanged = fileList.some((f) => DOCS_PATH_RE.test(f));
  const docsWaived = labelSet.has(LABELS.docsWaiver);
  const docsProblems = [];
  if (!docsSection) {
    docsProblems.push('PR 描述缺少「## 文档更新说明」小节，请使用 PR 模板填写');
  } else if (!docsDeclared) {
    docsProblems.push('「文档更新说明」小节中没有勾选任何选项');
  }
  if (codeFiles.length > 0 && !docsChanged && !docsWaived) {
    const sample = codeFiles.slice(0, 5).join(', ');
    docsProblems.push(
      `本 PR 改动了代码/配置（${sample}${codeFiles.length > 5 ? ' 等' : ''}），但没有更新任何 Markdown 文档；` +
        '请同步更新 README.md 或 docs/，确无需要更新时添加 no-docs-needed 标签并在 PR 中说明原因',
    );
  }
  results.push({
    check: 'docs',
    ok: docsProblems.length === 0,
    warnings: [],
    detail:
      docsProblems.length > 0
        ? docsProblems.join('；')
        : codeFiles.length > 0
          ? `代码/配置 ${codeFiles.length} 个文件；Markdown 更新：${docsChanged ? '有' : '无（已豁免）'}`
          : '无代码/配置变更',
  });

  // 3) AgenticDataBench 评测证据（功能更新 PR）
  const benchWarnings = [];
  let benchOk = true;
  let benchDetail;
  if (!isFeature) {
    benchDetail = '非功能更新 PR（非 feat 且无 feature 标签），跳过';
  } else if (labelSet.has(LABELS.benchmarkWaiver)) {
    benchDetail = '功能更新 PR，已使用 benchmark-waiver 豁免';
  } else {
    const blocks = parseBenchmarkBlocks(text);
    const problems = [];
    if (blocks.length === 0) {
      problems.push(
        'PR 描述缺少 ```benchmark-results 代码块：功能更新 PR 必须粘贴 AgenticDataBench 官方 Evaluator 结果',
      );
    } else {
      const invalid = blocks.filter(
        (b) => !b.experimentId || !EXPERIMENT_ID_RE.test(b.experimentId) || !b.tasks || !b.score,
      );
      if (invalid.length > 0) {
        problems.push('benchmark-results 代码块字段不完整：需要非空的 experiment_id / tasks / score');
      }
      const runIds = [...new Set(fileList.map((f) => RUNS_PATH_RE.exec(f)?.[1]).filter(Boolean))];
      const blockIds = new Set(blocks.map((b) => b.experimentId).filter(Boolean));
      if (runIds.length > 0 && !runIds.some((id) => blockIds.has(id))) {
        problems.push(`PR 附带了评测产物 runs/${runIds.join('、')}/，但与描述中的 experiment_id 不一致`);
      }
      if (runIds.length === 0) {
        const msg = '建议随 PR 附带 runs/<experiment_id>/ 下的 JSON 评测产物（官方 Evaluator 输出）以便审计';
        if (REQUIRE_RUN_ARTIFACT) problems.push(msg);
        else benchWarnings.push(msg);
      }
    }
    benchOk = problems.length === 0;
    benchDetail = benchOk ? `已提供 ${blocks.length} 组评测结果` : problems.join('；');
  }
  results.push({ check: 'benchmark', ok: benchOk, warnings: benchWarnings, detail: benchDetail });

  return { results, isFeature };
}

function renderSummary(mode, results) {
  const rows = results
    .map((r) => `| \`${r.check}\` | ${r.ok ? '✅' : '❌'} | ${r.detail.replaceAll('|', '\\|')} |`)
    .join('\n');
  const warns = results.flatMap((r) => r.warnings).map((w) => `> ⚠️ ${w}`).join('\n\n');
  return `### PR 结构检查（本门槛：\`${mode}\`）\n\n| 检查项 | 结果 | 说明 |\n|---|---|---|\n${rows}\n${warns ? `\n${warns}\n` : ''}`;
}

async function listPrFiles(repo, number, token) {
  const files = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub API 读取 PR 文件列表失败: HTTP ${res.status}`);
    const batch = await res.json();
    for (const f of batch) {
      if (typeof f.filename === 'string') files.push(f.filename);
      if (typeof f.previous_filename === 'string') files.push(f.previous_filename);
    }
    if (batch.length < 100) break;
  }
  return files;
}

async function main() {
  const mode = process.argv[2];
  if (!['title', 'docs', 'benchmark'].includes(mode)) {
    console.error('用法: node scripts/check-pr-structure.mjs <title|docs|benchmark>');
    process.exit(2);
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repo) {
    console.error('缺少 GITHUB_EVENT_PATH / GITHUB_REPOSITORY，本脚本需在 GitHub Actions 中运行');
    process.exit(2);
  }

  const event = JSON.parse(await fs.readFile(eventPath, 'utf8'));
  const pr = event.pull_request;
  if (!pr) {
    console.log('非 pull_request 事件，跳过检查');
    return;
  }

  let files = [];
  if (token) {
    files = await listPrFiles(repo, pr.number, token);
  } else {
    console.error('警告: 未设置 GITHUB_TOKEN，无法读取 PR 文件列表，文档同步检查将按无代码变更处理');
  }

  const labels = (pr.labels ?? []).map((l) => l.name);
  const { results } = evaluate({ title: pr.title ?? '', body: pr.body ?? '', labels, files });

  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, renderSummary(mode, results));
  }
  for (const r of results) {
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.check}: ${r.detail}`);
  }
  for (const w of results.flatMap((r) => r.warnings)) {
    console.log(`[WARN] ${w}`);
  }

  const gate = results.find((r) => r.check === mode);
  if (!gate?.ok) {
    console.error(`::error title=PR 结构检查失败（${mode}）::${gate?.detail ?? '未知错误'}`);
    process.exit(1);
  }
}

function isDirectRun() {
  try {
    const argvUrl = pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
    return import.meta.url === argvUrl || import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
