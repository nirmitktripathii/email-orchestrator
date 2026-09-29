/**
 * @module ai/llm-client
 * @description LLM-agnostic client supporting Gemini, OpenAI, Anthropic, Groq.
 * Primary: Google Gemini API with Gemma model.
 * Fallback: Any OpenAI-compatible API endpoint.
 */

import { GoogleGenAI } from '@google/genai';
import type { LLMConfig } from '../core/types.js';
import { LLMError, LLMRateLimitError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const llmLogger = logger.child('llm-client');

/**
 * Minimum output-token budget for JSON calls. Thinking models spend hidden
 * reasoning tokens before the body, so a floor well above the visible JSON size
 * is required or the model hits MAX_TOKENS with nothing (or a fragment) emitted.
 */
const JSON_TOKEN_FLOOR = 2048;
/** Upper bound when doubling the budget on retry, to cap cost/latency. */
const JSON_TOKEN_CEILING = 8192;

/** Chat message format */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** LLM completion response */
export interface LLMResponse {
  readonly content: string;
  readonly model: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly finishReason: string;
  readonly latencyMs: number;
}

/** Options for a completion request */
export interface CompletionOptions {
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonMode?: boolean;  // Request JSON output
}

export class LLMClient {
  private readonly config: LLMConfig;
  private readonly geminiClient: GoogleGenAI | null;
  private readonly spacer: RequestSpacer;
  private totalTokensUsed: number = 0;
  private requestCount: number = 0;

  constructor(config: LLMConfig) {
    this.config = config;
    this.spacer = new RequestSpacer(config.requestsPerMinute ?? 0);

    // Initialize Gemini client if using Gemini provider
    if (config.provider === 'gemini' && config.apiKey) {
      this.geminiClient = new GoogleGenAI({ apiKey: config.apiKey });
      llmLogger.info('Gemini client initialized', { model: config.model });
    } else {
      this.geminiClient = null;
    }

    llmLogger.info('LLM client initialized', {
      provider: config.provider,
      model: config.model,
      hasApiKey: !!config.apiKey,
    });
  }

  /**
   * Generate a completion from the LLM.
   */
  async complete(options: CompletionOptions): Promise<LLMResponse> {
    this.requestCount++;

    try {
      const response = this.config.provider === 'gemini'
        ? await this.completeWithGemini(options)
        : await this.completeWithOpenAICompat(options);

      this.totalTokensUsed += response.usage.totalTokens;
      llmLogger.debug('LLM completion successful', {
        model: response.model,
        tokens: response.usage.totalTokens,
        latencyMs: response.latencyMs,
      });

      return response;
    } catch (error) {
      llmLogger.error('LLM completion failed', error);
      throw error;
    }
  }

  /**
   * Generate a completion and parse the response as JSON.
   *
   * Thinking models (e.g. `gemma-4-31b-it`) spend a variable, sometimes large
   * number of hidden reasoning tokens BEFORE emitting any JSON — and those count
   * against `maxOutputTokens`. If the budget is too small the model hits
   * `MAX_TOKENS` with an empty/truncated body. So instead of re-asking with the
   * same budget (the old behavior, which just truncated again), we:
   *   1. floor the JSON budget so there is room for reasoning + body,
   *   2. on an empty/truncated/unparseable response, retry with DOUBLE the budget,
   *   3. tolerate markdown fences and trailing commas when extracting the object.
   */
  async completeJSON<T>(options: CompletionOptions, validator?: (data: unknown) => T): Promise<T> {
    const maxAttempts = 3;
    // Reasoning tokens are emitted first; give them room before the body.
    let budget = Math.max(options.maxTokens ?? this.config.maxTokens ?? 0, JSON_TOKEN_FLOOR);
    let lastPreview = '';
    let lastFinish = 'unknown';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.complete({ ...options, maxTokens: budget, jsonMode: true });
      const text = (response.content ?? '').trim();
      lastPreview = text.slice(0, 200);
      lastFinish = response.finishReason;

      // Empty body or a hard token cut-off means "reasoning ate the budget".
      const starved = text.length === 0 || response.finishReason === 'MAX_TOKENS';
      if (!starved) {
        const parsed = extractJson(text);
        if (parsed !== undefined) {
          return validator ? validator(parsed) : (parsed as T);
        }
      }

      if (attempt < maxAttempts) {
        llmLogger.warn('LLM JSON response unusable — retrying with a larger token budget', {
          attempt,
          finishReason: response.finishReason,
          textLen: text.length,
          reason: starved ? 'empty-or-max-tokens' : 'parse-failed',
          nextBudget: Math.min(budget * 2, JSON_TOKEN_CEILING),
        });
        budget = Math.min(budget * 2, JSON_TOKEN_CEILING);
      }
    }

    throw new LLMError(
      `LLM did not return valid JSON after ${maxAttempts} attempts ` +
        `(last finishReason=${lastFinish}, preview="${lastPreview.slice(0, 120)}")`,
    );
  }

  /**
   * Get usage statistics.
   */
  getStats(): { totalTokensUsed: number; requestCount: number; provider: string; model: string } {
    return {
      totalTokensUsed: this.totalTokensUsed,
      requestCount: this.requestCount,
      provider: this.config.provider,
      model: this.config.model,
    };
  }

  // ---- Private Methods ----

  private async completeWithGemini(options: CompletionOptions): Promise<LLMResponse> {
    if (!this.geminiClient) {
      throw new LLMError('Gemini client not initialized — check LLM_API_KEY');
    }

    const startTime = Date.now();

    // Build the prompt from messages
    const systemMsg = options.messages.find(m => m.role === 'system');
    const userMessages = options.messages.filter(m => m.role !== 'system');

    // Convert messages to Gemini format
    const contents = userMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: m.content }],
    }));

    const result = await this.retryWithBackoff(async () => {
      return this.geminiClient!.models.generateContent({
        model: this.config.model,
        contents,
        config: {
          temperature: options.temperature ?? this.config.temperature,
          maxOutputTokens: options.maxTokens ?? this.config.maxTokens,
          ...(systemMsg ? { systemInstruction: systemMsg.content } : {}),
          ...(options.jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      });
    });

    const latencyMs = Date.now() - startTime;
    const text = result.text ?? '';
    const usage = result.usageMetadata;

    return {
      content: text,
      model: this.config.model,
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      finishReason: result.candidates?.[0]?.finishReason ?? 'unknown',
      latencyMs,
    };
  }

  private async completeWithOpenAICompat(options: CompletionOptions): Promise<LLMResponse> {
    const startTime = Date.now();

    // Determine base URL based on provider
    const baseUrl = this.config.baseUrl ?? this.getDefaultBaseUrl();

    const messages = options.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
    };

    if (options.jsonMode) {
      body['response_format'] = { type: 'json_object' };
    }

    const result = await this.retryWithBackoff(async () => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          throw new LLMRateLimitError(
            `Rate limited by ${this.config.provider}: ${errorBody}`,
            retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
          );
        }
        throw new LLMError(`${this.config.provider} API error (${response.status}): ${errorBody}`);
      }

      return response.json();
    });

    const latencyMs = Date.now() - startTime;
    const choice = (result as Record<string, unknown[]>)['choices']?.[0] as Record<string, unknown> | undefined;
    const usage = (result as Record<string, unknown>)['usage'] as Record<string, number> | undefined;

    return {
      content: String((choice?.['message'] as Record<string, unknown>)?.['content'] ?? ''),
      model: String((result as Record<string, unknown>)['model'] ?? this.config.model),
      usage: {
        promptTokens: usage?.['prompt_tokens'] ?? 0,
        completionTokens: usage?.['completion_tokens'] ?? 0,
        totalTokens: usage?.['total_tokens'] ?? 0,
      },
      finishReason: String(choice?.['finish_reason'] ?? 'unknown'),
      latencyMs,
    };
  }

  private getDefaultBaseUrl(): string {
    switch (this.config.provider) {
      case 'openai': return 'https://api.openai.com/v1';
      case 'anthropic': return 'https://api.anthropic.com/v1';
      case 'groq': return 'https://api.groq.com/openai/v1';
      case 'ollama': return 'http://localhost:11434/v1';
      case 'custom': return this.config.baseUrl ?? 'http://localhost:8000/v1';
      default: return 'https://api.openai.com/v1';
    }
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries: number = 5): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.spacer.wait(); // every attempt, retries included, counts against the quota
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === maxRetries) break;

        const { retryable, retryAfterMs } = classifyTransient(error);
        if (!retryable) throw error;

        // Honor a server-suggested delay (Gemini 429 bodies carry one); otherwise
        // exponential backoff with jitter, capped so we never stall too long.
        const delayMs = retryAfterMs
          ? retryAfterMs + Math.floor(Math.random() * 500)
          : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);

        llmLogger.warn(`LLM rate-limited/transient error — backing off ${Math.round(delayMs)}ms`, {
          attempt: attempt + 1,
          maxRetries,
          error: lastError.message.slice(0, 160),
        });

        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError ?? new LLMError('All retry attempts failed');
  }
}

/**
 * Decide whether an error from any provider (Gemini SDK, OpenAI-compat fetch) is a
 * transient rate-limit / availability error worth retrying, and extract a server-
 * suggested delay if present. Gemini 429s arrive as RAW SDK errors whose message
 * embeds a JSON body with code 429 / "RESOURCE_EXHAUSTED" and often a
 * `"retryDelay":"NNs"` hint — none of which is an LLMError, so we match on text.
 */
export function classifyTransient(error: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (error instanceof LLMRateLimitError) {
    return error.retryAfterMs !== undefined
      ? { retryable: true, retryAfterMs: error.retryAfterMs }
      : { retryable: true };
  }
  const msg = error instanceof Error ? error.message : String(error);
  const transient =
    /\b(429|500|502|503|504)\b/.test(msg) ||
    /RESOURCE_EXHAUSTED|UNAVAILABLE|rate.?limit|quota|overloaded|temporarily/i.test(msg);
  if (!transient) return { retryable: false };
  // Accept `"retryDelay":"46s"`, `'retryDelay': '46s'` (Python-style dict dumps) and
  // the prose form "Please retry in 46.5s".
  const m = msg.match(/['"]?retryDelay['"]?\s*[:=]\s*['"]?(\d+(?:\.\d+)?)s/i) ?? msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  return m ? { retryable: true, retryAfterMs: Math.ceil(parseFloat(m[1]!) * 1000) } : { retryable: true };
}

/**
 * Spaces request STARTS at least 60/perMinute seconds apart. Free-tier quotas are
 * "N requests per minute"; staying under them is cheaper than hitting 429 and backing
 * off. Each caller reserves the next free slot, then sleeps outside any lock, so
 * concurrent callers queue up in order. perMinute <= 0 disables spacing.
 */
export class RequestSpacer {
  private readonly intervalMs: number;
  private nextSlot = 0;

  constructor(
    perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  ) {
    this.intervalMs = perMinute > 0 ? 60_000 / perMinute : 0;
  }

  async wait(): Promise<void> {
    if (!this.intervalMs) return;
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
  }
}

/**
 * Best-effort extraction of a JSON value from an LLM response. Handles markdown
 * code fences, surrounding prose, and trailing commas. Returns `undefined` if no
 * valid JSON object/array can be recovered.
 */
function extractJson(raw: string): unknown | undefined {
  let s = raw.trim();
  // Strip a ```json … ``` (or ``` … ```) fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) s = fence[1]!.trim();

  // Narrow to the first balanced { } or [ ] block (ignores surrounding prose).
  const sliced = sliceBalanced(s);
  if (sliced) s = sliced;

  // Direct parse, then a light repair pass (drop trailing commas before } or ]).
  for (const candidate of [s, s.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Return the first balanced {…} or […] substring, respecting strings/escapes. */
function sliceBalanced(s: string): string | undefined {
  const start = s.search(/[{[]/);
  if (start === -1) return undefined;
  const open = s[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined; // unbalanced (truncated) — caller retries with a larger budget
}
