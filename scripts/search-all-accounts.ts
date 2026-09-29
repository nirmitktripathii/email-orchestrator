import { loadConfig } from '../src/orchestrator/core/config.js';
import { ProviderManager } from '../src/orchestrator/providers/provider-manager.js';

async function main() {
  const config = loadConfig();
  const manager = ProviderManager.fromConfig(config);
  await manager.connectAll();

  const queries = ['OIA', 'GeM', 'Bidding-9757316', 'Finance Data Extraction'];
  for (const q of queries) {
    console.log(`\n=== SEARCH ALL FOR "${q}" ===`);
    const emails = await manager.searchAll(q, { maxResults: 10 });
    console.log(`Found ${emails.length} across accounts:`);
    for (const e of emails) {
      console.log(` - [${e.provider}] ${e.accountEmail} | ID: ${e.id} | Subject: ${e.subject} | From: ${e.from.email} | Attachments: ${e.hasAttachments}`);
    }
  }

  await manager.disconnectAll();
}

main().catch(console.error);
