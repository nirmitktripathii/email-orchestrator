import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { OAuth2Client } from 'google-auth-library';
import open from 'open';

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

async function main() {
  if (!fs.existsSync(OAUTH_PATH)) {
    console.error('No GCP OAuth keys found at:', OAUTH_PATH);
    process.exit(1);
  }
  const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
  const keys = keysContent.installed || keysContent.web;
  const oauth2Client = new OAuth2Client(keys.client_id, keys.client_secret, 'http://localhost:3000/oauth2callback');

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.settings.basic',
    ],
  });

  console.log('\n======================================================');
  console.log('GMAIL AUTHENTICATION URL:');
  console.log(authUrl);
  console.log('======================================================\n');

  const server = http.createServer();
  server.listen(3000, () => {
    console.log('Listening on http://localhost:3000/oauth2callback ...');
    try {
      open(authUrl);
    } catch (e) {
      console.log('Could not automatically open browser:', e);
    }
  });

  server.on('request', async (req, res) => {
    if (!req.url?.startsWith('/oauth2callback')) return;
    const url = new URL(req.url, 'http://localhost:3000');
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      res.end('No code provided');
      return;
    }
    try {
      const { tokens } = await oauth2Client.getToken(code);
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2));
      console.log('Authentication successful! Token saved to:', CREDENTIALS_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authentication successful!</h1><p>You can close this tab now and return to Antigravity.</p>');
      server.close(() => process.exit(0));
    } catch (err) {
      console.error('Error exchanging token:', err);
      res.writeHead(500);
      res.end('Authentication failed');
    }
  });
}

main().catch(console.error);
