/**
 * @module tools/tool-context
 * @description Shared types + argument helpers for orchestrator MCP tools.
 * Each tool is a {@link ToolDefinition}; the server registers them and dispatches
 * calls, passing a {@link ToolContext} with the engines it needs.
 */

import type { AppConfig } from '../core/types.js';
import type { ProviderManager } from '../providers/provider-manager.js';
import type { EmailEnrichmentService } from '../ai/enrichment.js';
import type { EmailSummarizer } from '../ai/summarizer.js';
import type { EmailCategorizer } from '../ai/categorizer.js';
import type { ActionRecommender } from '../ai/action-recommender.js';
import { ValidationError } from '../utils/errors.js';

/** Runtime scheduler surface the schedule tools drive (implemented by the scheduler). */
export interface RuntimeScheduler {
  setSchedule(times: readonly string[], enabled: boolean): void;
  getSchedule(): { enabled: boolean; times: readonly string[]; timezone: string };
  triggerNow(): Promise<void>;
}

/** Everything a tool handler may need. Populated once at startup. */
export interface ToolContext {
  readonly config: AppConfig;
  readonly providers: ProviderManager;
  readonly enrichment: EmailEnrichmentService;
  readonly summarizer: EmailSummarizer;
  readonly categorizer: EmailCategorizer;
  readonly actionRecommender: ActionRecommender;
  /** Set after the scheduler is constructed (index.ts). */
  scheduler?: RuntimeScheduler;
}

/** A tool's output: human-readable text (shown in chat) + optional structured data. */
export interface ToolOutput {
  readonly text: string;
  readonly data?: unknown;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object describing the tool's arguments. */
  readonly inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

// ============================
// Argument helpers
// ============================

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`Missing or invalid required string argument: "${key}"`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function optionalNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function optionalBool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (Array.isArray(value)) return value.map(String).filter(s => s.length > 0);
  if (typeof value === 'string' && value.length > 0) return value.split(',').map(s => s.trim()).filter(Boolean);
  return undefined;
}
