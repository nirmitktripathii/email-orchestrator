/**
 * @module send/config
 * @description Reads the send settings. Sending is off unless `EMAIL_SEND_ENABLED=true`, and when it
 * is on, an incomplete setup stops startup instead of leaving a send tool that fails later.
 */

import { SmtpMailer, type Mailer } from './mailer.js';
import { DEFAULT_LIMITS, SendPolicy, type SendLimits } from './policy.js';

export interface SendSetup {
  readonly mailer: Mailer;
  readonly policy: SendPolicy;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1.`);
  return n;
}

export function loadSend(env: NodeJS.ProcessEnv, mailer?: Mailer): SendSetup | undefined {
  if (env['EMAIL_SEND_ENABLED'] !== 'true') return undefined;

  const host = (env['SMTP_HOST'] ?? '').trim();
  const user = (env['SMTP_USER'] ?? '').trim();
  const password = env['SMTP_PASSWORD'] ?? '';
  const from = (env['EMAIL_SEND_FROM'] ?? user).trim();
  const missing = [
    !host && 'SMTP_HOST',
    !user && 'SMTP_USER',
    !password && 'SMTP_PASSWORD',
    !from && 'EMAIL_SEND_FROM',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`EMAIL_SEND_ENABLED=true needs ${missing.join(', ')} to be set.`);
  }

  const port = positiveInt(env['SMTP_PORT'], 587, 'SMTP_PORT');
  const domains = (env['EMAIL_SEND_ALLOWED_DOMAINS'] ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const limits: SendLimits = {
    perRecipientPerHour: positiveInt(env['EMAIL_SEND_PER_RECIPIENT_PER_HOUR'], DEFAULT_LIMITS.perRecipientPerHour, 'EMAIL_SEND_PER_RECIPIENT_PER_HOUR'),
    globalPerHour: positiveInt(env['EMAIL_SEND_GLOBAL_PER_HOUR'], DEFAULT_LIMITS.globalPerHour, 'EMAIL_SEND_GLOBAL_PER_HOUR'),
    ...(domains.length > 0 ? { allowedDomains: domains } : {}),
  };
  return {
    mailer: mailer ?? new SmtpMailer({ host, port, user, password, from }),
    policy: new SendPolicy(limits),
  };
}
