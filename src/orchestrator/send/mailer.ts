/**
 * @module send/mailer
 * @description The one place that can put an email on the wire. It speaks SMTP, so any account
 * that offers it works (a Gmail app password, for instance), and it can reach any recipient,
 * unlike the sandbox tiers of some HTTP mail APIs that only deliver to the account owner.
 *
 * Render's free tier blocks outbound SMTP on ports 25, 465 and 587: a connection there is
 * silently dropped and ends in a connection timeout. On a free instance, use the provider's
 * alternate port, such as 2525 (Brevo, Mailjet) or 2587 (Resend, Amazon SES). Gmail has none.
 */

import nodemailer from 'nodemailer';

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: OutgoingEmail): Promise<{ id: string }>;
}

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

/** The slice of a nodemailer transport this code uses, so a test can stand in for it. */
export interface SmtpTransport {
  sendMail(options: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

/** Ports that speak TLS from the first byte. Every other port must upgrade with STARTTLS. */
const IMPLICIT_TLS_PORTS: ReadonlySet<number> = new Set([465, 2465]);

/** How to secure a connection to this port; STARTTLS is required, not just attempted. */
export function tlsOptions(port: number): { secure: boolean; requireTLS: boolean } {
  const implicit = IMPLICIT_TLS_PORTS.has(port);
  return { secure: implicit, requireTLS: !implicit };
}

export class SmtpMailer implements Mailer {
  private readonly transport: SmtpTransport;

  constructor(
    private readonly settings: SmtpSettings,
    transport?: SmtpTransport,
  ) {
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: settings.host,
        port: settings.port,
        ...tlsOptions(settings.port),
        auth: { user: settings.user, pass: settings.password },
        connectionTimeout: 15_000,
        socketTimeout: 20_000,
      });
  }

  async send(message: OutgoingEmail): Promise<{ id: string }> {
    const info = await this.transport.sendMail({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { id: info.messageId ?? 'sent' };
  }
}
