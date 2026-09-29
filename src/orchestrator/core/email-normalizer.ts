/**
 * @module core/email-normalizer
 * @description Normalizes email data from different MCP server tool responses
 * into the unified NormalizedEmail format.
 */

import type { NormalizedEmail, EmailContact, EmailAttachment, EmailProvider } from './types.js';
import { logger } from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

const normLogger = logger.child('normalizer');

/**
 * Represents a raw email response from an MCP tool.
 * This is intentionally loose-typed to accommodate different provider formats.
 */
export interface RawEmailData {
  [key: string]: unknown;
}

/**
 * Parse an email contact from various formats.
 */
function parseContact(raw: unknown): EmailContact {
  if (typeof raw === 'string') {
    // Parse "Name <email@example.com>" format
    const match = raw.match(/^(.+?)\s*<(.+)>$/);
    if (match) {
      return { name: match[1]!.trim(), email: match[2]!.trim() };
    }
    // Just an email address
    return { name: raw, email: raw };
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    return {
      name: String(obj['name'] ?? obj['displayName'] ?? obj['emailAddress'] ?? ''),
      email: String(obj['email'] ?? obj['emailAddress'] ?? obj['address'] ?? ''),
    };
  }
  return { name: '', email: '' };
}

/**
 * Parse an array of contacts from various formats.
 */
function parseContacts(raw: unknown): EmailContact[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    return raw.split(',').map(s => parseContact(s.trim()));
  }
  if (Array.isArray(raw)) {
    return raw.map(parseContact);
  }
  return [parseContact(raw)];
}

/**
 * Parse attachments from raw data.
 */
function parseAttachments(raw: unknown): EmailAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const obj = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    return {
      id: String(obj['id'] ?? obj['attachmentId'] ?? `attachment-${index}`),
      filename: String(obj['filename'] ?? obj['name'] ?? obj['fileName'] ?? 'unknown'),
      mimeType: String(obj['mimeType'] ?? obj['contentType'] ?? 'application/octet-stream'),
      size: Number(obj['size'] ?? obj['fileSize'] ?? 0),
    };
  });
}

/**
 * Extract plain text body from various content formats.
 */
function extractBody(raw: RawEmailData): string {
  // Try common field names
  const bodyFields = ['body', 'content', 'text', 'textBody', 'plainText', 'snippet'];
  for (const field of bodyFields) {
    const value = raw[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }

  // Try nested content structures (Gmail format)
  const payload = raw['payload'] as Record<string, unknown> | undefined;
  if (payload) {
    const body = payload['body'] as Record<string, unknown> | undefined;
    if (body && typeof body['data'] === 'string') {
      // Gmail returns base64url encoded body
      try {
        return Buffer.from(body['data'] as string, 'base64url').toString('utf-8');
      } catch {
        return body['data'] as string;
      }
    }
  }

  return String(raw['snippet'] ?? '');
}

/**
 * Extract HTML body if available.
 */
function extractHtmlBody(raw: RawEmailData): string | undefined {
  const htmlFields = ['bodyHtml', 'htmlBody', 'htmlContent', 'html'];
  for (const field of htmlFields) {
    const value = raw[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Normalize a raw email response from any MCP server into the unified format.
 */
export function normalizeEmail(
  raw: RawEmailData,
  provider: EmailProvider,
  accountId: string,
  accountEmail: string
): NormalizedEmail {
  try {
    const id = String(raw['id'] ?? raw['messageId'] ?? raw['uid'] ?? '');
    if (!id) {
      throw new ValidationError('Email missing required ID field', { raw: JSON.stringify(raw).slice(0, 200) });
    }

    const subject = String(raw['subject'] ?? raw['Subject'] ?? '(No Subject)');
    const dateStr = String(raw['date'] ?? raw['receivedDateTime'] ?? raw['receivedDate'] ?? raw['internalDate'] ?? '');
    const date = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

    const normalized: NormalizedEmail = {
      id,
      globalId: `${accountId}:${id}`,
      provider,
      accountId,
      accountEmail,
      from: parseContact(raw['from'] ?? raw['sender'] ?? raw['fromAddress']),
      to: parseContacts(raw['to'] ?? raw['toAddress'] ?? raw['toRecipients']),
      cc: parseContacts(raw['cc'] ?? raw['ccAddress'] ?? raw['ccRecipients']),
      bcc: parseContacts(raw['bcc'] ?? raw['bccAddress'] ?? raw['bccRecipients']),
      replyTo: raw['replyTo'] ? parseContact(raw['replyTo']) : undefined,
      subject,
      date,
      receivedAt: date,
      snippet: String(raw['snippet'] ?? raw['bodyPreview'] ?? '').slice(0, 200),
      body: extractBody(raw),
      bodyHtml: extractHtmlBody(raw),
      isRead: Boolean(raw['isRead'] ?? raw['read'] ?? !(raw['labelIds'] as string[] ?? []).includes?.('UNREAD')),
      isStarred: Boolean(raw['isStarred'] ?? raw['isFlagged'] ?? raw['flagged'] ?? (raw['labelIds'] as string[] ?? []).includes?.('STARRED')),
      isDraft: Boolean(raw['isDraft'] ?? raw['draft'] ?? (raw['labelIds'] as string[] ?? []).includes?.('DRAFT')),
      labels: Array.isArray(raw['labels'] ?? raw['labelIds'] ?? raw['categories'])
        ? (raw['labels'] ?? raw['labelIds'] ?? raw['categories']) as string[]
        : [],
      folder: String(raw['folder'] ?? raw['folderId'] ?? raw['parentFolderId'] ?? 'INBOX'),
      hasAttachments: Boolean(raw['hasAttachments'] ?? raw['hasAttachment'] ?? (Array.isArray(raw['attachments']) && (raw['attachments'] as unknown[]).length > 0)),
      attachments: parseAttachments(raw['attachments']),
      threadId: raw['threadId'] ? String(raw['threadId']) : undefined,
      inReplyTo: raw['inReplyTo'] ? String(raw['inReplyTo']) : undefined,
      references: Array.isArray(raw['references']) ? raw['references'] as string[] : undefined,
    };

    return normalized;
  } catch (error) {
    normLogger.error('Failed to normalize email', error, { provider, accountId });
    throw error;
  }
}

/**
 * Normalize a batch of raw emails.
 */
export function normalizeEmails(
  raws: readonly RawEmailData[],
  provider: EmailProvider,
  accountId: string,
  accountEmail: string
): NormalizedEmail[] {
  const normalized: NormalizedEmail[] = [];
  for (const raw of raws) {
    try {
      normalized.push(normalizeEmail(raw, provider, accountId, accountEmail));
    } catch (error) {
      normLogger.warn('Skipping email that failed normalization', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  normLogger.debug(`Normalized ${normalized.length}/${raws.length} emails`, { provider, accountId });
  return normalized;
}
