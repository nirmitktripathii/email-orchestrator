/**
 * @module tools/schedule-tools
 * @description Tools to inspect/adjust scheduled digests and trigger one on demand.
 *
 * configure_schedule changes the RUNNING schedule immediately. To make it survive a
 * restart, set DIGEST_SCHEDULE in .env (the tool says so in its response) — the
 * orchestrator does not silently rewrite persistent config.
 */

import { type ToolDefinition, type ToolContext, optionalStringArray, optionalBool } from './tool-context.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const configureScheduleTool: ToolDefinition = {
  name: 'configure_schedule',
  description:
    'View or change the scheduled daily digest times (up to 3 per day, 24h "HH:MM"). ' +
    'Call with no arguments to view the current schedule. Changes take effect immediately for this ' +
    'session; to persist across restarts, set DIGEST_SCHEDULE in .env.',
  inputSchema: {
    type: 'object',
    properties: {
      times: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 3 times in 24h "HH:MM" format, e.g. ["09:00","14:00","19:00"].',
      },
      enabled: { type: 'boolean', description: 'Enable or disable scheduled digests.' },
    },
  },
  async handler(args, ctx: ToolContext) {
    if (!ctx.scheduler) {
      return { text: '⚠️ Scheduler is not running in this session, so the schedule cannot be changed here.', data: { available: false } };
    }

    const times = optionalStringArray(args, 'times');
    const hasEnabled = typeof args['enabled'] === 'boolean';

    // Pure view when no mutation requested.
    if (!times && !hasEnabled) {
      const current = ctx.scheduler.getSchedule();
      return {
        text: `Current schedule: ${current.enabled ? 'enabled' : 'disabled'} at [${current.times.join(', ') || '—'}] (${current.timezone}).`,
        data: current,
      };
    }

    if (times) {
      if (times.length > 3) {
        return { text: '❌ At most 3 digest times per day are allowed.', data: { error: 'too_many_times' } };
      }
      const bad = times.filter(t => !TIME_RE.test(t));
      if (bad.length > 0) {
        return { text: `❌ Invalid time(s): ${bad.join(', ')}. Use 24h "HH:MM".`, data: { error: 'invalid_time', bad } };
      }
    }

    const enabled = optionalBool(args, 'enabled', ctx.scheduler.getSchedule().enabled);
    const newTimes = times ?? ctx.scheduler.getSchedule().times;
    ctx.scheduler.setSchedule(newTimes, enabled);

    const updated = ctx.scheduler.getSchedule();
    return {
      text:
        `✅ Schedule updated: ${updated.enabled ? 'enabled' : 'disabled'} at [${updated.times.join(', ') || '—'}] (${updated.timezone}).\n` +
        `To persist across restarts, set DIGEST_SCHEDULE=${updated.times.join(',')} in your .env.`,
      data: updated,
    };
  },
};

const triggerDigestNowTool: ToolDefinition = {
  name: 'trigger_digest_now',
  description: 'Immediately generate and push a daily digest notification now (does not change the schedule).',
  inputSchema: { type: 'object', properties: {} },
  async handler(_args, ctx: ToolContext) {
    if (!ctx.scheduler) {
      return { text: '⚠️ Scheduler is not running in this session.', data: { available: false } };
    }
    await ctx.scheduler.triggerNow();
    return { text: '✅ Digest generated and pushed.', data: { triggered: true } };
  },
};

export const scheduleTools: readonly ToolDefinition[] = [configureScheduleTool, triggerDigestNowTool];
