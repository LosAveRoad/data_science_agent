/**
 * 可选的真实 LLM 连通性自检脚本（不进入 vitest，避免 CI 消耗 token）。
 *
 * 运行方式（任选其一）：
 *   node --experimental-strip-types scripts/test-llm.ts
 *   npx tsx scripts/test-llm.ts
 *
 * 行为：读取项目根目录 .env（若存在）与环境变量，向 OpenAI 兼容端点发一轮
 * 带 1 个测试工具的小对话，打印 stopReason、工具调用与 token 用量。
 * 自包含实现，不 import src/（src 内部使用 .js 后缀的 TS 相对导入，
 * node 原生 strip-types 无法解析）。
 */
import { complete, Type } from '@mariozechner/pi-ai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 手工解析 KEY=VALUE 行（已存在的环境变量优先，不覆盖）。 */
function loadEnvFile(filePath: string): void {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && !(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvFile(path.resolve(process.cwd(), '.env'));
  const apiKey = process.env.PI_API_KEY ?? '';
  const baseUrl = process.env.PI_BASE_URL ?? 'https://api.deepseek.com';
  const modelId = process.env.MODEL_ID ?? 'deepseek-chat';
  if (!apiKey) {
    console.error('缺少 PI_API_KEY（请设置环境变量或写入项目根目录 .env）');
    process.exitCode = 1;
    return;
  }

  // 与 src/agent/pi-runtime.ts 的 buildModel 保持一致（脚本自包含，不 import src/）。
  // supportsStore=false：Mistral 及本地代理网关会对未知字段直接 422。
  const model = {
    id: modelId,
    name: modelId,
    api: 'openai-completions' as const,
    provider: 'custom-openai-compatible',
    baseUrl,
    reasoning: false,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    compat: { supportsStore: false },
  };

  const startedAt = Date.now();
  const message = await complete(
    model,
    {
      systemPrompt: '你是连通性测试助手：先调用 echo 工具，然后简短回复。',
      messages: [
        { role: 'user', content: '调用 echo 工具，text 传 "pong"。', timestamp: Date.now() },
      ],
      tools: [
        {
          name: 'echo',
          description: '原样返回 text 参数，用于连通性测试',
          parameters: Type.Object({ text: Type.String({ description: '要回显的文本' }) }),
        },
      ],
    },
    { apiKey, timeoutMs: 120_000, maxRetries: 1 },
  );

  const toolCalls = message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => (block.type === 'toolCall' ? `${block.name}(${JSON.stringify(block.arguments)})` : ''))
    .filter((s) => s.length > 0);
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');

  console.log(
    JSON.stringify(
      {
        endpoint: baseUrl,
        model: modelId,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        toolCalls,
        text: text.trim(),
        usage: message.usage
          ? {
              inputTokens: message.usage.input,
              outputTokens: message.usage.output,
              totalTokens: message.usage.totalTokens,
            }
          : null,
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  console.error('连通性测试失败:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
