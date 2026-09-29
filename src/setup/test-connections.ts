#!/usr/bin/env node
/**
 * @module setup/test-connections
 * @description Verifies that (a) the configured LLM responds and (b) each configured
 * provider MCP server connects and can list mail. Run with: npm run test-connections
 */

import { stdout } from 'node:process';
import { loadConfig, validateConfig } from '../orchestrator/core/config.js';
import { LLMClient } from '../orchestrator/ai/llm-client.js';
import { ProviderManager } from '../orchestrator/providers/provider-manager.js';
import { getErrorMessage } from '../orchestrator/utils/errors.js';

function ok(msg: string): void { stdout.write(`  ✅ ${msg}\n`); }
function bad(msg: string): void { stdout.write(`  ❌ ${msg}\n`); }
function info(msg: string): void { stdout.write(`${msg}\n`); }

async function testLLM(): Promise<boolean> {
  info('\n1) Testing LLM…');
  const config = loadConfig();
  if (!config.llm.apiKey && config.llm.provider !== 'ollama') {
    bad('LLM_API_KEY is not set. Run "npm run setup".');
    return false;
  }
  try {
    const llm = new LLMClient(config.llm);
    const start = Date.now();
    const res = await llm.complete({
      messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }],
      maxTokens: 8,
      temperature: 0,
    });
    ok(`${config.llm.provider}/${config.llm.model} responded in ${Date.now() - start}ms: "${res.content.trim().slice(0, 40)}"`);
    return true;
  } catch (error) {
    bad(`LLM call failed: ${getErrorMessage(error)}`);
    return false;
  }
}

async function testProviders(): Promise<boolean> {
  info('\n2) Testing email providers…');
  const config = loadConfig();
  const manager = ProviderManager.fromConfig(config);
  if (!manager.hasAccounts()) {
    bad('No provider accounts configured. Run "npm run setup".');
    return false;
  }

  const results = await manager.connectAll();
  let allOk = true;
  for (const r of results) {
    if (!r.connected) {
      bad(`${r.accountId}: connection failed — ${r.error ?? 'unknown error'}`);
      allOk = false;
      continue;
    }
    const adapter = manager.getAdapter(r.accountId)!;
    try {
      const emails = await adapter.listEmails({ maxResults: 1 });
      ok(`${r.accountId} (${adapter.provider}): connected · listed ${emails.length} email(s)`);
    } catch (error) {
      bad(`${r.accountId} (${adapter.provider}): connected but listing failed — ${getErrorMessage(error)}`);
      allOk = false;
    }
  }

  await manager.disconnectAll();
  return allOk;
}

async function main(): Promise<void> {
  info('=== Email AI Agent — Connection Test ===');
  for (const issue of validateConfig(loadConfig())) info(`  • note: ${issue}`);

  const llmOk = await testLLM();
  const providersOk = await testProviders();

  info('\n=== Summary ===');
  info(`  LLM:       ${llmOk ? 'OK' : 'FAILED'}`);
  info(`  Providers: ${providersOk ? 'OK' : 'FAILED (see above)'}`);
  info('');

  process.exit(llmOk ? 0 : 1);
}

main().catch(error => {
  bad(`Unexpected error: ${getErrorMessage(error)}`);
  process.exit(1);
});
