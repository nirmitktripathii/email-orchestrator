/**
 * @module notifications/notifier
 * @description Desktop notifications via node-notifier. Best-effort: notification
 * failures are logged, never thrown (a headless/CI environment simply gets no popup).
 */

import notifier from 'node-notifier';
import type { NotificationConfig, EmailHighlight } from '../core/types.js';
import { logger } from '../utils/logger.js';

const notifLogger = logger.child('notifier');

export interface NotificationPayload {
  readonly title: string;
  readonly message: string;
  /** Override the config default for this one notification. */
  readonly sound?: boolean;
}

export class DesktopNotifier {
  private readonly config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Send a notification. Resolves even if the platform has no notification support. */
  async notify(payload: NotificationPayload): Promise<void> {
    if (!this.config.enabled) {
      notifLogger.debug('Notifications disabled; skipping', { title: payload.title });
      return;
    }
    await new Promise<void>(resolve => {
      try {
        notifier.notify(
          {
            title: payload.title,
            message: payload.message,
            sound: payload.sound ?? this.config.sound,
            wait: false,
          },
          error => {
            if (error) {
              notifLogger.warn('Notification failed to display', { error: error.message });
            }
            resolve();
          },
        );
      } catch (error) {
        notifLogger.warn('Notification threw', { error: error instanceof Error ? error.message : String(error) });
        resolve();
      }
    });
  }

  /** Notify about a single urgent email. */
  async notifyUrgent(email: EmailHighlight): Promise<void> {
    if (this.config.urgentOnly === false && !this.config.enabled) return;
    await this.notify({
      title: `🔴 Urgent (${email.urgencyScore}/10): ${truncate(email.subject, 60)}`,
      message: `${email.from} · ${email.accountEmail}\n${truncate(email.oneLiner, 120)}`,
      sound: true,
    });
  }

  /** Notify about a batch digest. */
  async notifyDigest(title: string, message: string): Promise<void> {
    await this.notify({ title, message: truncate(message, 240) });
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
