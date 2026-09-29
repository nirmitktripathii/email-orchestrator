import { loadConfig } from '../src/orchestrator/core/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const config = loadConfig();
  const zohoAccount = config.accounts.find(a => a.provider === 'zoho');
  const transport = new StreamableHTTPClientTransport(new URL(zohoAccount!.connection!.url!));
  const client = new Client({ name: 'test-inspector', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    const res = await client.listResources();
    console.log('Resources:', JSON.stringify(res));
  } catch (e) {
    console.log('listResources error:', e);
  }

  try {
    const resTemplates = await client.listResourceTemplates();
    console.log('Resource templates:', JSON.stringify(resTemplates));
  } catch (e) {
    console.log('listResourceTemplates error:', e);
  }

  await client.close();
}

main().catch(console.error);
