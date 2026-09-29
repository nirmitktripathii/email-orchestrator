import { loadConfig } from '../src/orchestrator/core/config.js';
import { ZohoAdapter } from '../src/orchestrator/providers/zoho-adapter.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const config = loadConfig();
  const zohoAccount = config.accounts.find(a => a.provider === 'zoho');
  if (!zohoAccount || !zohoAccount.connection) {
    console.error('No Zoho account found in config');
    return;
  }

  console.log('Connecting to Zoho MCP at:', zohoAccount.connection.url);
  const transport = new StreamableHTTPClientTransport(new URL(zohoAccount.connection.url!));
  const client = new Client({ name: 'test-inspector', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('Connected!');

  const toolsResult = await client.listTools();
  console.log('Available Zoho Tools:');
  for (const t of toolsResult.tools) {
    console.log(` - ${t.name}: ${t.description}`);
  }

  // Let's use ZohoAdapter to list/search emails
  const adapter = new ZohoAdapter(zohoAccount);
  await adapter.connect();
  console.log('ZohoAdapter connected. Searching for RFP...');
  
  const queries = ['RFP', 'OIA', 'tender', 'GeM', 'entire:'];
  for (const q of queries) {
    console.log(`\n--- Searching with query: "${q}" ---`);
    try {
      const results = await adapter.searchEmails(q, { maxResults: 10 });
      console.log(`Found ${results.length} emails`);
      for (const email of results) {
        console.log(`[${email.id}] Subject: ${email.subject} | From: ${email.from.email} | Date: ${email.date} | Attachments: ${email.hasAttachments}`);
      }
    } catch (e) {
      console.error(`Search error for ${q}:`, e);
    }
  }

  await adapter.disconnect();
  await client.close();
}

main().catch(console.error);
