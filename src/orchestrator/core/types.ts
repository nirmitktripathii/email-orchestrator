/**
 * @module core/types
 * @description Core type definitions for the Email AI Agent orchestrator.
 * All email data from any provider is normalized to these types.
 */

import { z } from 'zod';

// ============================
// Email Provider Types
// ============================

/** Supported email providers */
export type EmailProvider = 'gmail' | 'zoho' | 'yahoo' | 'outlook' | 'imap';

/** Transport used to reach a downstream provider MCP server */
export type McpTransportType = 'stdio' | 'sse' | 'http';

/**
 * Logical operations the orchestrator needs from any provider MCP server.
 * These are mapped to provider-specific tool names via {@link McpConnectionConfig.toolMap}.
 */
export type ProviderOperation =
  | 'listEmails'
  | 'getEmail'
  | 'searchEmails'
  | 'createDraft';

/**
 * How the orchestrator connects to (and speaks to) a downstream provider MCP server.
 * stdio spawns a local process; sse/http connect to a remote endpoint (e.g. mcp.zoho.com).
 */
export interface McpConnectionConfig {
  readonly transport: McpTransportType;
  // --- stdio ---
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  // --- sse / http ---
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Override auto-detected tool names for each logical operation. */
  readonly toolMap?: Readonly<Partial<Record<ProviderOperation, string>>>;
  /**
   * Provider-specific mailbox account identifier required in tool paths.
   * Used by Zoho (its REST-style tools need the internal `accountId` in
   * `path_variables`). If omitted, the Zoho adapter auto-detects it via the
   * "get mail accounts" tool at connect time.
   */
  readonly accountId?: string;
}

/** Email account configuration */
export interface EmailAccount {
  readonly id: string;            // Unique ID e.g. "nirmit-gmail"
  readonly provider: EmailProvider;
  readonly email: string;         // e.g. "nirmit@gmail.com"
  readonly displayName: string;   // e.g. "Nirmit's Gmail"
  readonly isActive: boolean;
  readonly mcpServerName: string; // MCP server identifier in claude_desktop_config
  /** How the orchestrator reaches this account's MCP server (optional — omitted = not wired). */
  readonly connection?: McpConnectionConfig;
}

// ============================
// Normalized Email Types
// ============================

/** Contact information */
export interface EmailContact {
  readonly name: string;
  readonly email: string;
}

/** Email attachment metadata */
export interface EmailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number; // bytes
}

/** Email categories assigned by AI */
export type EmailCategory =
  | 'urgent'          // Has deadline today/tomorrow, time-sensitive
  | 'follow-up'       // Requires user's response/action
  | 'promotional'     // Marketing, newsletters, offers
  | 'hr-employee'     // HR, appraisals, internal policies
  | 'financial'       // Invoices, payments, billing
  | 'informational'   // FYI, announcements, updates
  | 'personal'        // Personal/social emails
  | 'spam'            // Junk, phishing
  | 'uncategorized';  // Not yet categorized

/** Suggested action types */
export type ActionType =
  | 'reply'
  | 'reply-all'
  | 'forward'
  | 'archive'
  | 'delete'
  | 'label'
  | 'schedule-meeting'
  | 'set-reminder'
  | 'delegate'
  | 'follow-up-later';

/** Priority levels */
export type PriorityLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';

/** Suggested action for an email */
export interface SuggestedAction {
  readonly type: ActionType;
  readonly description: string;
  readonly priority: PriorityLevel;
  readonly reasoning: string;
  readonly draftContent?: string; // Pre-drafted reply content if applicable
}

/** Extracted task from an email */
export interface ExtractedTask {
  readonly description: string;
  readonly deadline?: string;     // ISO date string if mentioned
  readonly assignee?: string;     // Person responsible
  readonly priority: PriorityLevel;
  readonly source: string;        // Email subject/context
}

/** Unified normalized email — the core data model */
export interface NormalizedEmail {
  // Identity
  readonly id: string;              // Provider-specific message ID
  readonly globalId: string;        // Composite: `${accountId}:${id}`
  readonly provider: EmailProvider;
  readonly accountId: string;       // Account ID this email belongs to
  readonly accountEmail: string;    // Account email address

  // Metadata
  readonly from: EmailContact;
  readonly to: readonly EmailContact[];
  readonly cc: readonly EmailContact[];
  readonly bcc: readonly EmailContact[];
  readonly replyTo?: EmailContact;
  readonly subject: string;
  readonly date: string;            // ISO 8601 date string
  readonly receivedAt: string;      // ISO 8601 when received

  // Content
  readonly snippet: string;         // Short preview (first ~200 chars)
  readonly body: string;            // Full plain text body
  readonly bodyHtml?: string;       // HTML body (optional)

  // State
  readonly isRead: boolean;
  readonly isStarred: boolean;
  readonly isDraft: boolean;
  readonly labels: readonly string[];
  readonly folder: string;          // INBOX, SENT, DRAFTS, etc.

  // Attachments
  readonly hasAttachments: boolean;
  readonly attachments: readonly EmailAttachment[];

  // Threading
  readonly threadId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];

  // AI-Enriched Fields (populated by orchestrator)
  readonly aiEnrichment?: EmailAIEnrichment;
}

/** AI-generated enrichment data for an email */
export interface EmailAIEnrichment {
  readonly summary: string;                      // 3-5 bullet point summary
  readonly category: EmailCategory;
  readonly urgencyScore: number;                 // 0-10
  readonly priority: PriorityLevel;
  readonly suggestedActions: readonly SuggestedAction[];
  readonly extractedTasks: readonly ExtractedTask[];
  readonly sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  readonly keyTopics: readonly string[];         // Key topics/entities
  readonly requiresResponse: boolean;
  readonly deadlineDetected?: string;            // ISO date if deadline found
  readonly enrichedAt: string;                   // ISO timestamp
}

// ============================
// Inbox Summary Types
// ============================

/** Category count in inbox summary */
export interface CategoryCount {
  readonly category: EmailCategory;
  readonly count: number;
  readonly unreadCount: number;
}

/** Inbox summary across all accounts */
export interface InboxSummary {
  readonly generatedAt: string;   // ISO timestamp
  readonly accounts: readonly AccountSummary[];
  readonly totalEmails: number;
  readonly totalUnread: number;
  readonly categoryBreakdown: readonly CategoryCount[];
  readonly urgentItems: readonly EmailHighlight[];
  readonly actionRequired: readonly EmailHighlight[];
  readonly digest: string;        // AI-generated narrative summary
}

/** Account-level summary */
export interface AccountSummary {
  readonly accountId: string;
  readonly accountEmail: string;
  readonly provider: EmailProvider;
  readonly totalEmails: number;
  readonly unreadCount: number;
  readonly isConnected: boolean;
  readonly lastSyncedAt?: string;
}

/** Highlighted email in summary */
export interface EmailHighlight {
  readonly globalId: string;
  readonly accountEmail: string;
  readonly subject: string;
  readonly from: string;
  readonly date: string;
  readonly category: EmailCategory;
  readonly urgencyScore: number;
  readonly oneLiner: string;      // One-line AI summary
}

// ============================
// Daily Digest Types
// ============================

export interface DailyDigest {
  readonly generatedAt: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly summary: InboxSummary;
  readonly newEmailCount: number;
  readonly topPriorityEmails: readonly EmailHighlight[];
  readonly categorizedEmails: Record<EmailCategory, readonly EmailHighlight[]>;
  readonly narrativeSummary: string; // Full AI-written digest
}

// ============================
// Schedule Types
// ============================

export interface ScheduleConfig {
  readonly enabled: boolean;
  readonly times: readonly string[];   // e.g. ["09:00", "14:00", "19:00"]
  readonly timezone: string;           // e.g. "Asia/Kolkata"
  readonly maxTimesPerDay: 3;
}

// ============================
// Configuration Types
// ============================

export interface AppConfig {
  readonly llm: LLMConfig;
  readonly accounts: readonly EmailAccount[];
  readonly schedule: ScheduleConfig;
  readonly notifications: NotificationConfig;
  readonly cache: CacheConfig;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface LLMConfig {
  readonly provider: 'gemini' | 'openai' | 'anthropic' | 'groq' | 'ollama' | 'custom';
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly maxTokens: number;
  readonly temperature: number;
  /** Space LLM requests to stay under a per-minute quota (e.g. 14 for a 15 RPM free tier). 0/undefined = off. */
  readonly requestsPerMinute?: number;
}

export interface NotificationConfig {
  readonly enabled: boolean;
  readonly sound: boolean;
  readonly urgentOnly: boolean;
}

export interface CacheConfig {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly maxEntries: number;
}

// ============================
// Zod Schemas for Validation
// ============================

export const EmailCategorySchema = z.enum([
  'urgent', 'follow-up', 'promotional', 'hr-employee',
  'financial', 'informational', 'personal', 'spam', 'uncategorized'
]);

export const PriorityLevelSchema = z.enum(['critical', 'high', 'medium', 'low', 'none']);

export const SuggestedActionSchema = z.object({
  type: z.enum(['reply', 'reply-all', 'forward', 'archive', 'delete', 'label',
    'schedule-meeting', 'set-reminder', 'delegate', 'follow-up-later']),
  description: z.string(),
  priority: PriorityLevelSchema,
  reasoning: z.string(),
  draftContent: z.string().optional(),
});

export const ExtractedTaskSchema = z.object({
  description: z.string(),
  deadline: z.string().optional(),
  assignee: z.string().optional(),
  priority: PriorityLevelSchema,
  source: z.string(),
});

export const EmailAIEnrichmentSchema = z.object({
  summary: z.string(),
  category: EmailCategorySchema,
  urgencyScore: z.number().min(0).max(10),
  priority: PriorityLevelSchema,
  suggestedActions: z.array(SuggestedActionSchema),
  extractedTasks: z.array(ExtractedTaskSchema),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
  keyTopics: z.array(z.string()),
  requiresResponse: z.boolean(),
  deadlineDetected: z.string().optional(),
  enrichedAt: z.string(),
});

// ============================
// MCP Tool Result Types
// ============================

/** Standard result wrapper for all tool responses */
export interface ToolResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly metadata: {
    readonly executionTimeMs: number;
    readonly accountsQueried: readonly string[];
    readonly timestamp: string;
  };
}

// ============================
// Provider Query / Draft Types
// ============================

/** Options for listing/searching emails from a provider */
export interface EmailQueryOptions {
  readonly folder?: string;        // e.g. INBOX (default), SENT
  readonly maxResults?: number;    // default 25
  readonly unreadOnly?: boolean;
  readonly since?: string;         // ISO date — only emails newer than this
  readonly query?: string;         // provider-native search query (searchEmails)
}

/** A reply/compose draft to be created via a provider (never auto-sent) */
export interface EmailDraft {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;     // message ID being replied to
  readonly threadId?: string;
}

/** Result of creating a draft */
export interface DraftResult {
  readonly draftId: string;
  readonly accountId: string;
  readonly provider: EmailProvider;
}
