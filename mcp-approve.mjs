#!/usr/bin/env node
/**
 * Minimal MCP stdio server used as `--permission-prompt-tool mcp__agentscope__approve`
 * for sessions started from the dashboard. Every permission request (and AskUserQuestion)
 * is forwarded to AgentScope and blocks until a human answers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.AGENTSCOPE_HOME || path.join(os.homedir(), '.agentscope');
const read = (f) => { try { return fs.readFileSync(path.join(home, f), 'utf8'); } catch { return ''; } };
const cfg = JSON.parse(read('config.json') || '{}');
const token = read('token').trim();
const port = process.env.AGENTSCOPE_PORT || cfg.port || 7788;
const proc = process.env.AGENTSCOPE_PROC;

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');

const TOOL = {
  name: 'approve',
  description: 'Ask the human operator (AgentScope dashboard) whether a tool call may proceed.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool requesting permission' },
      input: { type: 'object', description: 'The input for the tool', additionalProperties: true },
      tool_use_id: { type: 'string', description: 'The unique tool use request ID' },
    },
    required: ['tool_name', 'input'],
  },
};

async function approve(a) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ proc, tool_name: a.tool_name, input: a.input, tool_use_id: a.tool_use_id }),
    });
    const d = await r.json();
    if (d.decision === 'allow') return { behavior: 'allow', updatedInput: d.updatedInput || a.input };
    return { behavior: 'deny', message: d.message || 'Denied by the operator in AgentScope' };
  } catch (e) {
    return { behavior: 'deny', message: `AgentScope unreachable: ${e.message}` };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;   // notifications need no reply
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentscope', version: '1.0.0' } } });
    case 'tools/list':
      return send({ id: m.id, result: { tools: [TOOL] } });
    case 'tools/call': {
      if (m.params?.name !== 'approve') return send({ id: m.id, error: { code: -32602, message: 'unknown tool' } });
      const decision = await approve(m.params.arguments || {});
      return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
    }
    case 'ping':
      return send({ id: m.id, result: {} });
    default:
      return send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});
rl.on('close', () => process.exit(0));
