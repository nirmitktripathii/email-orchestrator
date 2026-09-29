/**
 * @module notifications/scheduler
 * @description Cron-based scheduled digests (up to 3x/day) plus an optional
 * polling monitor that pushes real-time desktop alerts for newly-seen urgent
 * emails. Implements the RuntimeScheduler surface the schedule tools drive.
 */

import cron from 'node-cron';
import type { ScheduleConfig, EmailHighlight } from '../core/types.js';
import type { RuntimeScheduler } from '../tools/tool-context.js';
import { DesktopNotifier } from './notifier.js';
import { logger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';

const schedLogger = logger.child('scheduler');

/** What a digest run produces, ready to be pushed as a notification. */
export interface DigestNotification {
  readonly title: string;
  readonly message: string;
  readonly urgentItems: readonly EmailHighlight[];
}

export interface DigestSchedulerDeps {
  readonly schedule: ScheduleConfig;
  readonly notifier: DesktopNotifier;
  /** Produce the digest to push at each scheduled time (and on triggerNow). */
  readonly produceDigest: () => Promise<DigestNotification>;
  /** Optional: produce the current set of urgent emails for the real-time monitor. */
  readonly produceUrgent?: () => Promise<readonly EmailHighlight[]>;
  /** How often (minutes) to poll for urgent emails. 0 disables the monitor. Default 0. */
  readonly urgentPollMinutes?: number;
}

type ScheduledTask = ReturnType<typeof cron.schedule>;

export class DigestScheduler implements RuntimeScheduler {
  private readonly deps: DigestSchedulerDeps;
  private readonly timezone: string;

  private times: string[];
  private enabled: boolean;

  private tasks: ScheduledTask[] = [];
  private urgentTimer: ReturnType<typeof setInterval> | null = null;
  private readonly notifiedUrgent = new Set<string>();

  constructor(deps: DigestSchedulerDeps) {
    this.deps = deps;
    this.timezone = deps.schedule.timezone;
    this.times = [...deps.schedule.times];
    this.enabled = deps.schedule.enabled;
  }

  /** Start cron digests and (if configured) the urgent monitor. */
  start(): void {
    this.scheduleDigestTasks();
    this.startUrgentMonitor();
  }

  /** Stop everything (called on shutdown). */
  stop(): void {
    this.clearTasks();
    if (this.urgentTimer) {
      clearInterval(this.urgentTimer);
      this.urgentTimer = null;
    }
    schedLogger.info('Scheduler stopped');
  }

  // ---- RuntimeScheduler ----

  getSchedule(): { enabled: boolean; times: readonly string[]; timezone: string } {
    return { enabled: this.enabled, times: [...this.times], timezone: this.timezone };
  }

  setSchedule(times: readonly string[], enabled: boolean): void {
    this.times = [...times];
    this.enabled = enabled;
    this.scheduleDigestTasks();
    schedLogger.info('Schedule reconfigured', { enabled, times: this.times });
  }

  async triggerNow(): Promise<void> {
    await this.runDigest('manual');
  }

  // ---- internals ----

  private clearTasks(): void {
    for (const task of this.tasks) {
      try {
        task.stop();
      } catch {
        /* ignore */
      }
    }
    this.tasks = [];
  }

  private scheduleDigestTasks(): void {
    this.clearTasks();
    if (!this.enabled || this.times.length === 0) {
      schedLogger.info('Digest schedule disabled or empty');
      return;
    }
    for (const time of this.times) {
      const expr = toCron(time);
      if (!expr || !cron.validate(expr)) {
        schedLogger.warn(`Skipping invalid schedule time "${time}"`);
        continue;
      }
      const task = cron.schedule(expr, () => void this.runDigest(time), { timezone: this.timezone });
      this.tasks.push(task);
      schedLogger.info(`Scheduled digest at ${time} (${this.timezone})`, { cron: expr });
    }
  }

  private async runDigest(label: string): Promise<void> {
    schedLogger.info(`Running digest (${label})`);
    try {
      const digest = await this.deps.produceDigest();
      await this.deps.notifier.notifyDigest(digest.title, digest.message);
      schedLogger.info('Digest pushed', { urgentCount: digest.urgentItems.length });
    } catch (error) {
      schedLogger.error('Digest run failed', error, { label });
    }
  }

  private startUrgentMonitor(): void {
    const minutes = this.deps.urgentPollMinutes ?? 0;
    if (minutes <= 0 || !this.deps.produceUrgent) return;

    const intervalMs = minutes * 60 * 1000;
    schedLogger.info(`Starting urgent monitor (every ${minutes} min)`);
    this.urgentTimer = setInterval(() => void this.checkUrgent(), intervalMs);
    // Prevent the poll timer from keeping the process alive on its own.
    this.urgentTimer.unref?.();
  }

  private async checkUrgent(): Promise<void> {
    if (!this.deps.produceUrgent) return;
    try {
      const urgent = await this.deps.produceUrgent();
      for (const item of urgent) {
        if (this.notifiedUrgent.has(item.globalId)) continue;
        this.notifiedUrgent.add(item.globalId);
        await this.deps.notifier.notifyUrgent(item);
      }
      // Bound memory: keep the set from growing without limit.
      if (this.notifiedUrgent.size > 5000) this.notifiedUrgent.clear();
    } catch (error) {
      schedLogger.warn('Urgent monitor check failed', { error: getErrorMessage(error) });
    }
  }
}

/** Convert "HH:MM" to a daily cron expression `M H * * *`. */
function toCron(time: string): string | null {
  const match = time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return `${minute} ${hour} * * *`;
}
