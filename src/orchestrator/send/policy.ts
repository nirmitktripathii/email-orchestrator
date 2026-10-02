/**
 * @module send/policy
 * @description Everything that decides whether, and in what shape, a message may go out. The model
 * writes the subject and body, which may be built from mail a stranger wrote, so this layer keeps
 * the blast radius small: one recipient, plain text, capped length, a footer saying where the text
 * came from, and hourly caps per recipient and overall.
 */

import { ValidationError } from '../utils/errors.js';
import type { OutgoingEmail } from './mailer.js';

export interface SendLimits {
  readonly perRecipientPerHour: number;
  readonly globalPerHour: number;
  /** When set, a recipient must be on one of these domains. */
  readonly allowedDomains?: readonly string[];
}

export const DEFAULT_LIMITS: SendLimits = { perRecipientPerHour: 5, globalPerHour: 30 };

export const MAX_SUBJECT = 150;
export const MAX_BODY = 4000;

export const FOOTER = [
  '',
  '--',
  'Written by an AI assistant that may have read untrusted email text. Check anything it tells you before acting on it.',
  'You are getting this because you asked your assistant to email you.',
].join('\n');

// One plain address: no display name, no angle brackets, no list, no whitespace or control characters.
const ADDRESS = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const HOUR_MS = 3_600_000;

export class SendPolicy {
  private sent: Array<{ at: number; to: string }> = [];

  constructor(
    private readonly limits: SendLimits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks the arguments and the caps, records the send, and returns the message to deliver. */
  prepare(args: { to: unknown; subject: unknown; body: unknown }): OutgoingEmail {
    const to = typeof args.to === 'string' ? args.to.trim().toLowerCase() : '';
    if (!to || to.length > 254 || !ADDRESS.test(to)) {
      throw new ValidationError('"to" must be one plain email address.');
    }
    const domain = to.slice(to.indexOf('@') + 1);
    const allowed = this.limits.allowedDomains;
    if (allowed && allowed.length > 0 && !allowed.includes(domain)) {
      throw new ValidationError('That address is not on a domain this server may send to.');
    }

    const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
    if (!subject) throw new ValidationError('"subject" is required.');
    if (/[\r\n]/.test(subject)) throw new ValidationError('"subject" must be a single line.');
    if (subject.length > MAX_SUBJECT) throw new ValidationError(`"subject" is longer than ${MAX_SUBJECT} characters.`);

    const body = typeof args.body === 'string' ? args.body.trim() : '';
    if (!body) throw new ValidationError('"body" is required.');
    if (body.length > MAX_BODY) throw new ValidationError(`"body" is longer than ${MAX_BODY} characters.`);

    this.checkCaps(to);
    this.sent.push({ at: this.now(), to });
    return { to, subject, text: `${body}\n${FOOTER}` };
  }

  /** Forget the last recorded send, for when delivery failed and the cap should not be spent. */
  undoLast(): void {
    this.sent.pop();
  }

  private checkCaps(to: string): void {
    const cutoff = this.now() - HOUR_MS;
    this.sent = this.sent.filter(s => s.at > cutoff);
    if (this.sent.length >= this.limits.globalPerHour) {
      throw new ValidationError('Email sending is busy right now. Try again later.');
    }
    if (this.sent.filter(s => s.to === to).length >= this.limits.perRecipientPerHour) {
      throw new ValidationError('That address has had its emails for this hour. Try again later.');
    }
  }
}
