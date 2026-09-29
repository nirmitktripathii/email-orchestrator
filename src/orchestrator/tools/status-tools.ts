/**
 * @module tools/status-tools
 * @description Account status / connectivity tools.
 */

import type { AccountSummary } from '../core/types.js';
import { type ToolDefinition, type ToolContext, optionalBool } from './tool-context.js';
import { formatAccountStatusText } from './summary-builder.js';
import { getErrorMessage } from '../utils/errors.js';

const accountStatusTool: ToolDefinition = {
  name: 'account_status',
  description:
    'Show the connection status of every configured email account (connected/disconnected, provider, last sync). ' +
    'Set refresh=true to also fetch a live unread count per account.',
  inputSchema: {
    type: 'object',
    properties: {
      refresh: { type: 'boolean', description: 'Fetch a live unread count per account (slower). Default false.' },
    },
  },
  async handler(args, ctx: ToolContext) {
    const refresh = optionalBool(args, 'refresh', false);
    let statuses: AccountSummary[] = ctx.providers.getStatuses();

    if (refresh) {
      statuses = await Promise.all(
        ctx.providers.getAdapters().map(async adapter => {
          const base = adapter.getStatus();
          try {
            // Actively (re)connect a dropped account so the live count reflects a
            // real fetch — and so status is what heals a child that died since boot.
            await adapter.ensureConnected();
            const unread = await adapter.listEmails({ unreadOnly: true, maxResults: 100 });
            return { ...base, isConnected: true, unreadCount: unread.length, totalEmails: unread.length };
          } catch (error) {
            return { ...base, isConnected: adapter.isConnected(), lastSyncedAt: `error: ${getErrorMessage(error)}` };
          }
        }),
      );
    }

    const connected = statuses.filter(s => s.isConnected).length;
    const text = `${formatAccountStatusText(statuses)}\n\n${connected}/${statuses.length} account(s) connected.`;
    return { text, data: statuses };
  },
};

export const statusTools: readonly ToolDefinition[] = [accountStatusTool];
