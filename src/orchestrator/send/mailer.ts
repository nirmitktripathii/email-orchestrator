/**
 * @module send/mailer
 * @description The one place that can put an email on the wire. It speaks SMTP, so any account
 * that offers it works (a Gmail app password, for instance), and it can reach any recipient,
 * unlike the sandbox tiers of some HTTP mail APIs that only deliver to the account owner.
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
        // 465 is implicit TLS; other ports upgrade with STARTTLS, which we require.
        secure: settings.port === 465,
        requireTLS: settings.port !== 465,
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
