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

  const details = await client.callTool({
    name: 'ZohoMail_getMessageDetails',
    arguments: {
      path_variables: { accountId, folderId, messageId }
    }
  });
  console.log('DETAILS:');
  console.log(JSON.stringify(details, null, 2));

  await client.close();
}

main().catch(console.error);
