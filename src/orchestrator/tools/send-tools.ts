/**
 * @module tools/send-tools
 * @description The one tool that sends email. It is not part of `allTools`: the server offers it
 * only when sending was switched on (`ctx.send` exists), so a default install has no send button
 * at all. The message is built by {@link SendPolicy}, never taken as the model wrote it.
 */

import { type ToolDefinition, type ToolContext, requireString } from './tool-context.js';
import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const sendLogger = logger.child('send');

export const sendEmailTool: ToolDefinition = {
  name: 'send_email',
  description:
    'Send one plain-text email to one address. Use it only when the user asked to be emailed. ' +
    'The recipient may be fixed by the platform that hosts this server; a footer is added to the text.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'One email address.' },
      subject: { type: 'string', description: 'Single line, up to 150 characters.' },
      body: { type: 'string', description: 'Plain text, up to 4000 characters.' },
    },
    required: ['to', 'subject', 'body'],
  },
  async handler(args, ctx: ToolContext) {
    if (!ctx.send) throw new ValidationError('Sending is not enabled on this server.');
    const message = ctx.send.policy.prepare({
      to: requireString(args, 'to'),
      subject: args['subject'],
      body: args['body'],
    });
    try {
      const { id } = await ctx.send.mailer.send(message);
      sendLogger.info('Email sent', { id });
      return { text: `Email sent to ${message.to}.`, data: { sent: true, to: message.to, id } };
    } catch (error) {
      ctx.send.policy.undoLast();
      // The SMTP error can carry server details: log it, and tell the model only that it failed.
      sendLogger.error('Email send failed', error);
      throw new ValidationError('The email could not be sent. Try again later.');
    }
  },
};

export const sendTools: readonly ToolDefinition[] = [sendEmailTool];
