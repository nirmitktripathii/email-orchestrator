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
  const messageId = '1789371543996105200';

  console.log('--- Calling ZohoMail_getOriginalMessage ---');
  const orig = await client.callTool({
    name: 'ZohoMail_getOriginalMessage',
    arguments: {
      path_variables: { accountId, messageId }
    }
  });

  console.log('Result keys:', Object.keys(orig as any));
  const text = JSON.stringify(orig);
  console.log('Length of text:', text.length);
  console.log('Snippet:', text.slice(0, 500));

  await client.close();
}

main().catch(console.error);
