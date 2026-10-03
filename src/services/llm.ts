const OPENROUTER_BASE =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

/**
 * Free OpenRouter model ids get retired without warning and the free tier
 * shares one saturated rate-limited pool, so a single pinned model is a
 * liability and even a chain can be briefly exhausted. Walk the whole list
 * before failing. `LLM_MODEL` pins one for debugging.
 *
 * Ordered best-first for instruction following: the larger general models tend
 * to hold JSON structure, the small ones are the last resort.
 */
const DEFAULT_CHAIN = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'qwen/qwen3.8-27b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'apodex/apodex-1.1-mini:free',
  'cohere/north-mini-code:free',
];

const CHAIN = (() => {
  const list = (process.env.LLM_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  if (list.length) return list;
  const single = (process.env.LLM_MODEL || '').trim();
  return single ? [single] : DEFAULT_CHAIN;
})();

const ATTEMPTS = parseInt(process.env.LLM_ATTEMPTS || '2', 10);
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);

/** Exposed so /health can say the pool is exhausted rather than "unconfigured". */
export function llmChain(): string[] {
  return CHAIN;
}

export function llmConfigured(): boolean {
  return Boolean(OPENROUTER_API_KEY);
}

export class LlmError extends Error {
  constructor(message: string, readonly attempts: string[]) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Plain-text completion. Throws LlmError when the whole chain fails. */
export async function complete(
  system: string,
  user: string,
  maxTokens = 400
): Promise<string> {
  if (!OPENROUTER_API_KEY) {
    throw new LlmError('OPENROUTER_API_KEY is not set on this deployment', []);
  }

  const errors: string[] = [];
  for (const model of CHAIN) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.1,
            max_tokens: maxTokens,
          }),
          signal: controller.signal,
        });

        if (res.ok) {
          const body = (await res.json()) as {
            choices?: { message?: { content?: string } }[];
          };
          const text = body.choices?.[0]?.message?.content?.trim();
          if (text) return text;
          errors.push(`${model}: empty completion`);
          break; // answered, but with nothing usable
        }

        errors.push(`${model}: HTTP ${res.status}`);
        // 429 and 5xx are transient and worth another go; other 4xx are not.
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        errors.push(`${model}: ${(err as Error).name}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new LlmError('all models failed', errors);
}

/**
 * Free models wrap JSON in prose or code fences often enough that a bare
 * JSON.parse cannot be relied on. Pull out the first balanced object.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to a brace scan */
  }
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON object in model output');
}