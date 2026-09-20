#!/usr/bin/env node
/**
 * Claude Code hook -> AgentScope forwarder.
 * Usage (configured by `agentscope.mjs install`):  node hook.mjs <HookEventName>
 *
 * Fail-open by design: if the dashboard is not running, or anything goes wrong, this exits 0 with
 * no output and Claude Code behaves exactly as if the hook did not exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const event = process.argv[2] || '';
if (process.env.AGENTSCOPE_MANAGED) process.exit(0);   // managed sessions use the MCP approver instead

const home = process.env.AGENTSCOPE_HOME || path.join(os.homedir(), '.agentscope');
const read = (f) => { try { return fs.readFileSync(path.join(home, f), 'utf8'); } catch { return ''; } };

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  try {
    const cfg = JSON.parse(read('config.json') || '{}');
    const token = read('token').trim();
    if (!token) return process.exit(0);
    const payload = JSON.parse(input || '{}');
    const wait = Math.max(cfg.permWait || 0, cfg.replyWindow || 0) + 5;
    const r = await fetch(`http://127.0.0.1:${cfg.port || 7788}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ event, payload }),
      signal: AbortSignal.timeout(wait * 1000),
    });
    if (!r.ok) return process.exit(0);
    const { output } = await r.json();
    if (output) process.stdout.write(JSON.stringify(output));
  } catch { /* fail open */ }
  process.exit(0);
});
