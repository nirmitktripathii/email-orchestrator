import { loadConfig } from '../src/orchestrator/core/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const config = loadConfig();
  const zohoAccount = config.accounts.find(a => a.provider === 'zoho');
  const transport = new StreamableHTTPClientTransport(new URL(zohoAccount!.connection!.url!));
  const client = new Client({ name: 'test-inspector', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const tools = (await client.listTools()).tools;
  const sendEmail = tools.find(t => t.name === 'ZohoMail_sendEmail');
  console.log('sendEmail:', JSON.stringify(sendEmail, null, 2));

  const sendReplyEmail = tools.find(t => t.name === 'ZohoMail_sendReplyEmail');
  console.log('sendReplyEmail:', JSON.stringify(sendReplyEmail, null, 2));

  await client.close();
}

main().catch(console.error);
