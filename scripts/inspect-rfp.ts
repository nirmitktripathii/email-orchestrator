import { loadConfig } from '../src/orchestrator/core/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const config = loadConfig();
  const zohoAccount = config.accounts.find(a => a.provider === 'zoho');
  const transport = new StreamableHTTPClientTransport(new URL(zohoAccount!.connection!.url!));
  const client = new Client({ name: 'test-inspector', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const accountId = '5563564000000002002';
  const folderId = '5563564000000002008';
  const messageId = '1789371543996105200';

  const attachInfo = await client.callTool({
    name: 'ZohoMail_getMessageAttachmentInfo',
    arguments: {
      path_variables: { accountId, folderId, messageId }
    }
  });
  console.log('ATTACHMENT INFO:');
  console.dir(attachInfo, { depth: null });

  // Also print schema for ZohoMail_getOriginalMessage and any other tool
  const tools = (await client.listTools()).tools;
  for (const t of tools) {
    if (t.name.toLowerCase().includes('original') || t.name.toLowerCase().includes('attach')) {
      console.log(`TOOL SCHEMA: ${t.name}`);
      console.dir(t.inputSchema, { depth: null });
    }
  }

  await client.close();
}

main().catch(console.error);
