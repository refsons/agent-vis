#!/usr/bin/env node
/**
 * AgentScope — live activity view and control plane for Claude Code.
 *
 *   agentscope.mjs serve      start the dashboard (default)
 *   agentscope.mjs install    add hooks to Claude Code settings
 *   agentscope.mjs uninstall  remove them again
 *
 * Data plane   ~/.claude/projects/**.jsonl  (tailed)      -> full activity timeline
 * Control plane Claude Code hooks            (hook.mjs)    -> approvals, replies, lifecycle
 * Managed mode  claude -p stream-json child + MCP approver -> full two-way sessions
 *
 * Zero dependencies. Node >= 18.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CFG_DIR = process.env.AGENTSCOPE_HOME || path.join(HOME, '.agentscope');
let CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
let PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ───────────────────────────── args & config ─────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) o[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
if (args.remote && !args['claude-dir']) args['claude-dir'] = args.remote;   // remote dir also carries the mirrored transcripts
if (args['claude-dir']) { CLAUDE_DIR = path.resolve(String(args['claude-dir'])); PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects'); }
const cmd = args._[0] || 'serve';

function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }
function ensureCfgDir() { fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 }); }
function loadToken() {
  ensureCfgDir();
  const f = path.join(CFG_DIR, 'token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const saved = readJson(path.join(CFG_DIR, 'config.json'), {});
const cfg = {
  port: Number(args.port ?? process.env.AGENTSCOPE_PORT ?? saved.port ?? 7788),
  permWait: Number(args['perm-wait'] ?? saved.permWait ?? 45),        // seconds a hook holds a permission request
  replyWindow: Number(args['reply-window'] ?? saved.replyWindow ?? 0), // seconds the Stop hook waits for a reply
  endAfterMin: Number(args['end-after'] ?? saved.endAfterMin ?? 10),     // idle minutes before an observed session counts as ended
  sinceMin: Number(args.since ?? saved.sinceMin ?? 30),              // transcript backfill window
  claudeBin: args.claude || process.env.AGENTSCOPE_CLAUDE || 'claude',
  allowBypass: !!args['allow-bypass'],
  remote: args.remote ? path.resolve(String(args.remote)) : null,      // shared dir to a sandbox-side `agent`
  noMcp: !!(args['no-mcp'] || saved.noMcp || args.remote),                          // sandboxes where MCP and hooks are disabled
};

// ───────────────────────────── install / uninstall ─────────────────────────────
const isOurs = (c) => typeof c === 'string' && /agentscope[\\/]hook\.mjs/.test(c.replace(/"/g, ''));
function settingsFile(scope) {
  return scope === 'project' ? path.join(process.cwd(), '.claude', 'settings.local.json') : path.join(CLAUDE_DIR, 'settings.json');
}
function stripOurs(settings) {
  for (const [ev, groups] of Object.entries(settings.hooks || {})) {
    const kept = (groups || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}
function install() {
  const scope = args.scope === 'project' ? 'project' : 'user';
  const gate = String(args.gate || 'permission');           // permission | pretool | off
  const file = settingsFile(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = readJson(file, {});
  if (fs.existsSync(file) && !fs.existsSync(file + '.agentscope.bak')) fs.copyFileSync(file, file + '.agentscope.bak');
  stripOurs(settings);
  settings.hooks ||= {};
  const command = (ev) => `"${process.execPath}" "${path.join(DIR, 'hook.mjs')}" ${ev}`;
  const add = (ev, timeout, matcher) => {
    (settings.hooks[ev] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(ev), timeout }] });
  };
  add('SessionStart', 5); add('SessionEnd', 5); add('Notification', 5); add('SubagentStop', 5);
  add('Stop', cfg.replyWindow + 10);
  if (gate === 'permission') add('PermissionRequest', cfg.permWait + 10, '*');
  if (gate === 'pretool') add('PreToolUse', cfg.permWait + 10, args.matcher || 'Bash|Edit|MultiEdit|Write|NotebookEdit');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  ensureCfgDir();
  fs.writeFileSync(path.join(CFG_DIR, 'config.json'), JSON.stringify({ port: cfg.port, permWait: cfg.permWait, replyWindow: cfg.replyWindow, sinceMin: cfg.sinceMin }, null, 2));
  loadToken();
  console.log(`hooks installed in ${file}\n  gate=${gate} permWait=${cfg.permWait}s replyWindow=${cfg.replyWindow}s\nRestart running Claude Code sessions so they pick the hooks up.`);
}
function uninstall() {
  for (const scope of ['user', 'project']) {
    const file = settingsFile(scope);
    if (!fs.existsSync(file)) continue;
    const settings = readJson(file, null);
    if (!settings) continue;
    stripOurs(settings);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    console.log(`cleaned ${file}`);
  }
}
if (cmd === 'install') { install(); process.exit(0); }
if (cmd === 'uninstall') { uninstall(); process.exit(0); }
if (cmd !== 'serve' && cmd !== 'sync' && cmd !== 'agent') { console.error('usage: agentscope.mjs [serve|agent|sync|install|uninstall] [options]'); process.exit(1); }

// Mirror transcripts out of a sandbox so a dashboard on the host can read them.
// Run inside the sandbox:  agentscope.mjs sync --to <shared dir> [--every 2] [--since 120] [--once]
function syncOnce(to, sinceMin) {
  const cutoff = Date.now() - sinceMin * 60000;
  let copied = 0;
  const walk = (src, dst) => {
    let ents; try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const sp = path.join(src, e.name), dp = path.join(dst, e.name);
      if (e.isDirectory()) { walk(sp, dp); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let st; try { st = fs.statSync(sp); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      let have = 0; try { have = fs.statSync(dp).size; } catch {}
      if (have === st.size) continue;
      fs.mkdirSync(dst, { recursive: true });
      const start = have < st.size ? have : 0;             // append new bytes; recopy if file shrank
      const fd = fs.openSync(sp, 'r'), out = fs.openSync(dp, start ? 'a' : 'w');
      const buf = Buffer.alloc(st.size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      fs.writeSync(out, buf, 0, n); fs.closeSync(fd); fs.closeSync(out); copied++;
    }
  };
  walk(PROJECTS_DIR, path.join(path.resolve(to), 'projects'));
  return copied;
}
if (cmd === 'sync') {
  if (!args.to) { console.error('usage: agentscope.mjs sync --to <dir> [--every 2] [--since 120] [--once]'); process.exit(1); }
  const since = Number(args.since ?? 120), every = Number(args.every ?? 2);
  console.log(`syncing ${PROJECTS_DIR} -> ${path.resolve(args.to)}/projects every ${every}s (files touched in last ${since} min)`);
  syncOnce(args.to, since);
  if (args.once) process.exit(0);
  setInterval(() => { try { syncOnce(args.to, since); } catch (e) { console.error(e.message); } }, every * 1000);
} else if (cmd === 'agent') {
  // Runs INSIDE the sandbox. Mirrors transcripts to <dir>/projects and runs `claude -p` for the host dashboard.
  if (!args.dir) { console.error('usage: agentscope.mjs agent --dir <shared dir> [--claude claude] [--cwd <default dir>] [--every 2] [--since 120] [--allow-bypass]'); process.exit(1); }
  const R = path.resolve(String(args.dir));
  const since = Number(args.since ?? 120), every = Number(args.every ?? 2);
  const bin = args.claude || process.env.AGENTSCOPE_CLAUDE || 'claude';
  const defCwd = path.resolve(String(args.cwd || process.cwd()));
  const allowBypass = !!args['allow-bypass'];
  const FLAGS = new Set(['-p', '--input-format', '--output-format', '--verbose', '--resume', '--session-id', '--model', '--permission-mode', '--allowedTools']);
  const okArgs = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x.length < 400) && a.every((x, i) => !x.startsWith('-') || FLAGS.has(x))
    && (allowBypass || !a.includes('bypassPermissions'));
  fs.mkdirSync(path.join(R, 'cmd'), { recursive: true }); fs.mkdirSync(path.join(R, 'out'), { recursive: true });
  const procs = new Map();
  const app = (p, d) => fs.appendFileSync(p, d);
  const handle = (c) => {
    if (c.type === 'spawn') {
      if (!okArgs(c.args)) { fs.writeFileSync(path.join(R, 'out', `${c.procId}.err`), 'agent refused: unexpected arguments\n'); fs.writeFileSync(path.join(R, 'out', `${c.procId}.exit`), JSON.stringify({ code: 2 })); return; }
      const cwd = c.cwd && fs.existsSync(c.cwd) && fs.statSync(c.cwd).isDirectory() ? c.cwd : defCwd;
      const outF = path.join(R, 'out', `${c.procId}.out`), errF = path.join(R, 'out', `${c.procId}.err`);
      for (const f of [outF, errF, path.join(R, 'out', `${c.procId}.exit`)]) try { fs.unlinkSync(f); } catch {}
      fs.writeFileSync(outF, ''); fs.writeFileSync(errF, '');
      const child = spawn(bin, c.args, { cwd, env: { ...process.env, AGENTSCOPE_MANAGED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      procs.set(c.procId, child);
      child.stdout.on('data', (d) => app(outF, d));
      child.stderr.on('data', (d) => app(errF, d));
      child.on('error', (e) => { app(errF, (e.code === 'ENOENT' ? `Cannot start '${bin}' in the sandbox. Pass --claude /path/to/claude.` : e.message) + '\n'); fs.writeFileSync(path.join(R, 'out', `${c.procId}.exit`), JSON.stringify({ code: 127 })); procs.delete(c.procId); });
      child.on('close', (code) => { fs.writeFileSync(path.join(R, 'out', `${c.procId}.exit`), JSON.stringify({ code })); procs.delete(c.procId); });
      console.log(`start ${c.procId.slice(0, 8)} in ${cwd}${cwd !== c.cwd && c.cwd ? ` (requested ${c.cwd} not found here)` : ''}`);
    } else if (c.type === 'stdin') { const ch = procs.get(c.procId); if (ch && !ch.stdin.destroyed) ch.stdin.write(c.data); }
    else if (c.type === 'kill') { const ch = procs.get(c.procId); if (ch) ch.kill('SIGTERM'); }
  };
  const tick = () => {
    fs.writeFileSync(path.join(R, 'agent.json'), JSON.stringify({ ts: Date.now(), pid: process.pid, cwd: defCwd, claude: bin, procs: procs.size }));
    let names = []; try { names = fs.readdirSync(path.join(R, 'cmd')).filter((n) => n.endsWith('.json')).sort(); } catch {}
    for (const n of names) {
      const f = path.join(R, 'cmd', n);
      try { handle(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { console.error('bad command', n, e.message); }
      try { fs.unlinkSync(f); } catch {}
    }
  };
  console.log(`agent: shared dir ${R}\n  claude     ${bin}\n  default cwd ${defCwd}\n  mirroring  ${PROJECTS_DIR} every ${every}s`);
  tick(); syncOnce(R, since);
  setInterval(() => { try { tick(); } catch (e) { console.error(e.message); } }, 400);
  setInterval(() => { try { syncOnce(R, since); } catch (e) { console.error(e.message); } }, every * 1000);
  const stop = () => { for (const c of procs.values()) c.kill('SIGTERM'); try { fs.unlinkSync(path.join(R, 'agent.json')); } catch {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else {

// ───────────────────────────── state ─────────────────────────────
const TOKEN = loadToken();
const MAX_EVENTS = 5000;
const S = {
  sessions: new Map(),   // sid -> session
  agents: new Map(),     // `${sid}/${aid}` -> agent
  todos: new Map(),      // agentKey -> todo[]
  tools: new Map(),      // tool_use_id -> in-flight tool
  taskQueue: new Map(),  // sid -> pending Task/Agent invocations awaiting a sidechain
  prompts: new Map(),    // promptId -> { prompt, resolve, timer }
  replies: new Map(),    // sid -> string[]  (queued user replies for observed sessions)
  waiters: new Map(),    // sid -> wake()    (Stop hook holding for a reply)
  procs: new Map(),      // procId -> managed process
  events: [],
};
const managedSids = new Set();
const usageSeen = new Map();
const clients = new Set();
const startedAt = Date.now();
let seq = 0;

const now = () => Date.now();
const clipStr = (s, n = 2000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s);
function clip(v, n = 2000, d = 0) {
  if (typeof v === 'string') return clipStr(v, n);
  if (Array.isArray(v)) return d > 4 ? '[…]' : v.slice(0, 60).map((x) => clip(x, n, d + 1));
  if (v && typeof v === 'object') {
    if (d > 4) return '{…}';
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = clip(x, n, d + 1);
    return o;
  }
  return v;
}
const one = (s, n = 180) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isTask = (n) => n === 'Task' || n === 'Agent';

function summarize(name, i = {}) {
  switch (name) {
    case 'Bash': return one(i.command);
    case 'Read': return one(i.file_path);
    case 'Edit': case 'MultiEdit': case 'Write': return one(i.file_path);
    case 'NotebookEdit': return one(i.notebook_path);
    case 'Glob': return one(i.pattern);
    case 'Grep': return one(i.pattern + (i.path ? ` in ${i.path}` : ''));
    case 'Task': case 'Agent': return one(`${i.subagent_type || 'agent'}: ${i.description || i.prompt || ''}`);
    case 'WebFetch': return one(i.url);
    case 'WebSearch': return one(i.query);
    case 'TodoWrite': return `${(i.todos || []).length} todos`;
    case 'AskUserQuestion': return one((i.questions || []).map((q) => q.question).join(' / '));
    default: return one(JSON.stringify(i), 140);
  }
}
function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

// ───────────────────────────── broadcast ─────────────────────────────
function broadcast(kind, data) {
  if (!clients.size) return;
  const msg = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
function emit(ev) {
  ev.id = ++seq;
  ev.ts ||= now();
  S.events.push(ev);
  if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
  broadcast('event', ev);
  return ev;
}
const dirtyS = new Set(), dirtyA = new Set();
const markS = (s) => dirtyS.add(s);
const markA = (a) => dirtyA.add(a);
function deriveStatus(s) {
  if (s.ended) return 'ended';
  for (const p of S.prompts.values()) if (p.prompt.sid === s.id) return 'waiting';
  if (s.inflight > 0 && now() - s.last < 600000) return 'working';
  if (s.turnOpen && now() - s.last < 45000) return 'working';
  // Without hooks nothing announces that a terminal session closed, so infer it from the transcript:
  // long silence, or a newer session in the same directory (claude was restarted).
  const proc = s.proc && S.procs.get(s.proc);
  if (!(proc && proc.alive)) {
    const idle = now() - s.last;
    if (idle > cfg.endAfterMin * 60000) return 'ended';
    if (idle > 45000 && s.cwd) for (const o of S.sessions.values()) if (o !== s && o.cwd === s.cwd && o.started >= s.last) return 'ended';
  }
  return 'idle';
}
function pubSession(s) {
  const st = deriveStatus(s);
  s.status = st;
  const proc = s.proc && S.procs.get(s.proc);
  return {
    id: s.id, title: s.title, cwd: s.cwd, branch: s.branch, model: s.model, managed: s.managed,
    alive: !!(proc && proc.alive), status: st, started: s.started, last: s.last, tokens: s.tokens,
    cost: s.cost, ended: s.ended, hooked: s.hooked, queued: (S.replies.get(s.id) || []).length,
    replyOpen: S.waiters.has(s.id), turns: s.turns,
  };
}
const pubAgent = (a) => ({
  key: a.key, sid: a.sid, id: a.id, parent: a.parent, label: a.label, type: a.type, desc: a.desc, kind: a.kind, status: a.status,
  started: a.started, ended: a.ended, tools: a.tools, current: a.current, tokens: a.tokens,
});
const pubPrompt = (p) => ({
  id: p.id, kind: p.kind, sid: p.sid, tool: p.tool, summary: p.summary, input: p.input,
  created: p.created, expires: p.expires, source: p.source, aid: p.aid, agent: p.agent,
});
setInterval(() => {
  for (const s of S.sessions.values()) if (s.status !== deriveStatus(s)) markS(s);
  if (!dirtyS.size && !dirtyA.size) return;
  const msg = { sessions: [...dirtyS].map(pubSession), agents: [...dirtyA].map(pubAgent) };
  dirtyS.clear(); dirtyA.clear();
  broadcast('upsert', msg);
}, 250);

// ───────────────────────────── sessions & agents ─────────────────────────────
function getSession(id, ts = now()) {
  let s = S.sessions.get(id);
  if (!s) {
    s = {
      id, title: '', cwd: '', branch: '', model: '', managed: false, status: 'idle', started: ts, last: ts,
      turnOpen: false, inflight: 0, tokens: { i: 0, o: 0, r: 0, w: 0 }, cost: null, turns: 0, ended: false,
      hooked: false, allow: new Set(), transcript: '', proc: null, allowRules: [], retry: [], permissionMode: 'default',
    };
    S.sessions.set(id, s);
    emit({ sid: id, aid: 'main', type: 'session_start', ts, text: '' });
    getAgent(s, {}, {}, ts);
  }
  return s;
}

function getAgent(sess, e, ctx, ts) {
  let id = 'main';
  if (e.parent_tool_use_id) id = 't:' + e.parent_tool_use_id;
  else if (e.isSidechain) id = e.agentId ? 'a:' + e.agentId : 's:' + (ctx.file ? path.basename(ctx.file, '.jsonl') : 'x');
  const key = `${sess.id}/${id}`;
  let a = S.agents.get(key);
  if (a) return a;
  a = {
    key, sid: sess.id, id, parent: null, label: id === 'main' ? 'main' : (metaParts(ctx.file)?.label || one(firstText(e), 48) || 'subagent'), type: '', desc: '', kind: id === 'main' ? 'main' : 'sub', prompt: id === 'main' ? '' : firstText(e).slice(0, 400),
    status: 'running', started: ts, ended: null, tools: 0, inflight: 0, current: null, tokens: 0, tid: null,
  };
  if (id !== 'main') linkAgent(sess, a, e);
  S.agents.set(key, a);
  markA(a);
  if (id !== 'main') emit({ sid: sess.id, aid: id, type: 'agent_start', ts, text: a.label, parent: a.parent });
  return a;
}
/** Same wording as the CLI: "<agent type or name> <description>". Parts are kept so the UI can abbreviate the type. */
const taskParts = (i = {}) => {
  const type = String(i.name || i.subagent_type || 'agent').trim(), desc = one(i.description || i.prompt || '', 80);
  return { type, desc, label: one(`${type} ${desc}`, 100) };
};
/** Newer CLIs write agent-<id>.meta.json next to a subagent transcript; use it when present. */
function metaParts(file) {
  if (!file) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return taskParts({ name: m.name, description: m.description, subagent_type: m.agentType || m.subagent_type });
  } catch { return null; }
}
function firstText(e) {
  const c = e.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return (c.find((b) => b.type === 'text')?.text || '').trim();
  return '';
}
function linkAgent(sess, a, e) {
  const q = S.taskQueue.get(sess.id) || [];
  let t = null;
  if (a.id.startsWith('t:')) {
    a.tid = a.id.slice(2);
    t = q.find((x) => x.tid === a.tid) || null;
    const live = S.tools.get(a.tid);
    if (!t && live) t = { aid: live.aid, ...(isTask(live.name) ? taskParts(live.input) : { label: summarize(live.name, live.input) }) };
  } else {
    const txt = firstText(e).slice(0, 400);
    t = q.find((x) => !x.matched && txt && x.prompt === txt) || q.find((x) => !x.matched) || null;
    if (t) { t.matched = true; a.tid = t.tid; }
  }
  a.parent = t ? t.aid : 'main';
  if (t) { a.label = t.label; a.type = t.type || ''; a.desc = t.desc || ''; }
}

function applyTask(a, t) {
  t.matched = true; a.tid = t.tid; a.parent = t.aid; a.label = t.label; a.type = t.type || ''; a.desc = t.desc || ''; markA(a);
}
/** A subagent transcript can be read before the Task call that spawned it (mirrored or backfilled files). */
function relinkPending(sess, t) {
  if (!t.prompt) return;
  for (const a of S.agents.values()) if (a.sid === sess.id && a.kind === 'sub' && !a.tid && a.prompt === t.prompt) { applyTask(a, t); return; }
}

function addUsage(sess, ag, msg) {
  const u = msg.usage;
  if (!u || !msg.id) return;
  const cur = { i: u.input_tokens || 0, o: u.output_tokens || 0, r: u.cache_read_input_tokens || 0, w: u.cache_creation_input_tokens || 0 };
  const prev = usageSeen.get(msg.id) || { i: 0, o: 0, r: 0, w: 0 };
  let total = 0;
  for (const k of ['i', 'o', 'r', 'w']) {
    const d = Math.max(0, cur[k] - prev[k]);
    sess.tokens[k] += d; total += d;
    prev[k] = Math.max(prev[k], cur[k]);
  }
  ag.tokens += total;
  usageSeen.set(msg.id, prev);
  if (usageSeen.size > 8000) for (const k of [...usageSeen.keys()].slice(0, 2000)) usageSeen.delete(k);
}

function turnEnd(sess, ts, { force, ...extra } = {}) {
  if (!sess.turnOpen && !force) return;
  sess.turnOpen = false;
  sess.turns++;
  for (const a of S.agents.values()) {
    if (a.sid === sess.id && a.kind === 'sub' && a.status === 'running') { a.status = 'done'; a.ended = ts; a.current = null; markA(a); }
  }
  emit({ sid: sess.id, aid: 'main', type: 'turn_end', ts, ...extra });
  markS(sess);
}

// ───────────────────────────── transcript / stream ingestion ─────────────────────────────
function ingest(e, ctx = {}) {
  if (!e || typeof e !== 'object') return;
  const sid = e.sessionId || e.session_id || ctx.sid;
  if (!sid) return;
  if (ctx.source === 'transcript' && managedSids.has(sid)) return;   // managed sessions come from their own stream
  if (!['assistant', 'user', 'result', 'system'].includes(e.type)) return;
  const ts = e.timestamp ? Date.parse(e.timestamp) || now() : now();
  const sess = getSession(sid, ts);
  if (e.cwd && !sess.cwd) sess.cwd = e.cwd;
  if (e.gitBranch) sess.branch = e.gitBranch;
  if (ctx.file && !sess.transcript) sess.transcript = ctx.file;
  sess.last = Math.max(sess.last, ts);
  markS(sess);

  if (e.type === 'system') {
    if (e.subtype === 'init') {
      if (e.model) sess.model = e.model;
      if (e.cwd) sess.cwd = e.cwd;
      const m = Array.isArray(e.mcp_servers) && e.mcp_servers.find((x) => x.name === 'agentscope');
      if (!cfg.noMcp && m && m.status !== 'connected') emit({ sid, aid: 'main', type: 'error', ts, text: 'MCP is unavailable in this environment, so approvals cannot reach the dashboard. Restart the server with --no-mcp.' });
    }
    else if (typeof e.content === 'string' && e.content.trim()) emit({ sid, aid: 'main', type: 'sys', ts, text: clipStr(one(e.content, 300)) });
    return;
  }
  if (e.type === 'result') {
    if (typeof e.total_cost_usd === 'number') sess.cost = e.total_cost_usd;
    if (cfg.noMcp && ctx.source === 'stream' && Array.isArray(e.permission_denials)) for (const d of e.permission_denials) addDenial(sess, d);
    turnEnd(sess, ts, { force: true, ms: e.duration_ms, cost: e.total_cost_usd, ok: !e.is_error, text: e.is_error ? clipStr(String(e.result || e.subtype || 'error'), 500) : '' });
    return;
  }

  const ag = getAgent(sess, e, ctx, ts);
  const msg = e.message || {};
  if (e.type === 'assistant') {
    if (msg.model && msg.model !== '<synthetic>') sess.model = msg.model;
    addUsage(sess, ag, msg);
    const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) { sess.turnOpen = sess.turnOpen || ag.kind === 'main'; emit({ sid, aid: ag.id, type: 'assistant_text', ts, text: clipStr(b.text, 8000) }); }
      else if (b.type === 'thinking' && b.thinking?.trim()) emit({ sid, aid: ag.id, type: 'thinking', ts, text: clipStr(b.thinking, 4000) });
      else if (b.type === 'tool_use') onToolUse(sess, ag, b, ts);
    }
    if (msg.stop_reason === 'end_turn' && ag.kind === 'main' && ctx.source === 'transcript') turnEnd(sess, ts);   // streams end turns on `result`
    return;
  }
  // user entry: prompts, tool results
  const c = msg.content;
  if (typeof c === 'string') onUserText(sess, ag, e, c, ts);
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') onUserText(sess, ag, e, b.text || '', ts);
      else if (b.type === 'tool_result') onToolResult(sess, ag, b, e, ts);
    }
  }
}

function onUserText(sess, ag, e, text, ts) {
  if (e.isMeta) return;
  const t = text.trim();
  if (!t || t.startsWith('<system-reminder>') || t.startsWith('Caveat:')) return;
  if (t.startsWith('<local-command-stdout>')) return emit({ sid: sess.id, aid: ag.id, type: 'sys', ts, text: one(t.replace(/<\/?local-command-stdout>/g, ''), 300) });
  if (t.startsWith('[Request interrupted')) { emit({ sid: sess.id, aid: ag.id, type: 'sys', ts, text: 'interrupted by user' }); return turnEnd(sess, ts); }
  let shown = t;
  const m = /<command-name>([^<]+)<\/command-name>(?:[\s\S]*<command-args>([^<]*)<\/command-args>)?/.exec(t);
  if (m) shown = `${m[1].trim()} ${(m[2] || '').trim()}`.trim();
  if (ag.kind === 'main') {
    sess.turnOpen = true;
    if (!sess.title) sess.title = one(shown, 80);
    emit({ sid: sess.id, aid: ag.id, type: 'user_prompt', ts, text: clipStr(shown, 8000) });
  } else {
    emit({ sid: sess.id, aid: ag.id, type: 'agent_prompt', ts, text: clipStr(shown, 4000) });
  }
}

function onToolUse(sess, ag, b, ts) {
  if (S.tools.has(b.id)) return;
  const input = b.input || {};
  const summary = summarize(b.name, input);
  S.tools.set(b.id, { sid: sess.id, aid: ag.id, name: b.name, start: ts, input });
  if (S.tools.size > 20000) for (const k of [...S.tools.keys()].slice(0, 5000)) S.tools.delete(k);
  ag.tools++; ag.inflight++; sess.inflight++;
  ag.current = one(`${b.name} ${summary}`, 120);
  markA(ag);
  if (isTask(b.name)) {
    const q = S.taskQueue.get(sess.id) || [];
    q.push({ tid: b.id, aid: ag.id, prompt: String(input.prompt || '').trim().slice(0, 400), ...taskParts(input), matched: false });
    relinkPending(sess, q[q.length - 1]);
    if (q.length > 50) q.shift();
    S.taskQueue.set(sess.id, q);
  }
  emit({ sid: sess.id, aid: ag.id, type: 'tool_use', ts, tid: b.id, tool: b.name, summary, input: clip(input) });
  watchForWait(sess, ag, b, ts);
  if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos.map((t) => ({ content: one(t.content, 200), status: t.status, activeForm: one(t.activeForm, 200) }));
    S.todos.set(ag.key, todos);
    broadcast('todos', { key: ag.key, todos });
    emit({ sid: sess.id, aid: ag.id, type: 'todos', ts, done: todos.filter((t) => t.status === 'completed').length, total: todos.length });
  }
}

function onToolResult(sess, ag, b, e, ts) {
  const t = S.tools.get(b.tool_use_id);
  const aid = t ? t.aid : ag.id;
  emit({
    sid: sess.id, aid, type: 'tool_result', ts, tid: b.tool_use_id, tool: t?.name, ok: !b.is_error,
    ms: t ? ts - t.start : null, output: clipStr(resultText(b.content), 4000),
  });
  clearWaiting(b.tool_use_id);
  if (!t) return;
  const a = S.agents.get(`${sess.id}/${t.aid}`);
  if (a) { a.inflight = Math.max(0, a.inflight - 1); if (!a.inflight) a.current = null; markA(a); }
  sess.inflight = Math.max(0, sess.inflight - 1);
  if (isTask(t.name)) endSubagent(sess, b.tool_use_id, e.toolUseResult, ts, !b.is_error);
  S.tools.delete(b.tool_use_id);
}

function endSubagent(sess, tid, result, ts, ok) {
  let a = [...S.agents.values()].find((x) => x.sid === sess.id && x.tid === tid);
  if (!a && result?.agentId) a = S.agents.get(`${sess.id}/a:${result.agentId}`);
  if (!a) return;
  if (!a.tid) { const t = (S.taskQueue.get(sess.id) || []).find((x) => x.tid === tid); if (t) applyTask(a, t); }
  a.status = ok ? 'done' : 'failed';
  a.ended = ts; a.current = null; a.inflight = 0;
  if (result?.totalTokens) a.tokens = Math.max(a.tokens, result.totalTokens);
  markA(a);
  emit({ sid: sess.id, aid: a.id, type: 'agent_end', ts, ok, text: a.label, ms: result?.totalDurationMs, tools: result?.totalToolUseCount });
}

// ───────────────────────────── transcript tailer ─────────────────────────────
const tracked = new Map();
const TAIL_BYTES = 4 * 1024 * 1024;
function trackFile(file, { force = false } = {}) {
  if (!file || tracked.has(file)) return;
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (!force && now() - st.mtimeMs > cfg.sinceMin * 60000) return;
  const start = Math.max(0, st.size - TAIL_BYTES);
  const t = { file, off: start, dec: new StringDecoder('utf8'), buf: '', skipFirst: start > 0 };
  tracked.set(file, t);
  readNew(t);
}
function readNew(t) {
  let st;
  try { st = fs.statSync(t.file); } catch { return; }
  if (st.size < t.off) { t.off = 0; t.buf = ''; t.skipFirst = false; }
  if (st.size === t.off) return;
  let fd;
  try {
    fd = fs.openSync(t.file, 'r');
    while (t.off < st.size) {
      const len = Math.min(st.size - t.off, 8 * 1024 * 1024);
      const b = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, b, 0, len, t.off);
      if (n <= 0) break;
      t.off += n;
      t.buf += t.dec.write(b.subarray(0, n));
      const lines = t.buf.split('\n');
      t.buf = lines.pop();
      for (const line of lines) {
        if (t.skipFirst) { t.skipFirst = false; continue; }
        if (!line.trim()) continue;
        try { ingest(JSON.parse(line), { source: 'transcript', file: t.file }); } catch {}
      }
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
}
function scan(dir = PROJECTS_DIR, depth = 0) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (depth < 4) scan(p, depth + 1); }
    else if (d.name.endsWith('.jsonl')) trackFile(p);
  }
}
function renumber() {
  S.events.sort((a, b) => a.ts - b.ts || a.id - b.id);
  S.events.forEach((e, i) => { e.id = i + 1; });
  seq = S.events.length;
}
function startTailing() {
  scan();
  renumber();
  setInterval(() => { for (const t of tracked.values()) readNew(t); }, 400);
  setInterval(scan, 4000);
}

// ───────────────────────────── prompts (approvals / questions) ─────────────────────────────
const ruleKey = (tool, input) => (tool === 'Bash' ? `Bash:${input?.command}` : tool);

/** Create a prompt and wait for a human decision. Resolves to {decision,...} or null on timeout/cancel. */
function askHuman({ sid, proc, tool, input, source, waitMs, cancelOn }) {
  const sess = sid ? getSession(sid) : null;
  const key = ruleKey(tool, input);
  if (sess && tool !== 'AskUserQuestion' && sess.allow.has(key)) {
    const ev = emit({ sid, aid: 'main', type: 'permission', pid: crypto.randomUUID(), tool, summary: summarize(tool, input), input: clip(input), kind: 'permission' });
    emit({ sid, aid: 'main', type: 'permission_resolved', pid: ev.pid, decision: 'allow', by: 'session rule' });
    return Promise.resolve({ decision: 'allow', auto: true });
  }
  const id = crypto.randomUUID();
  const kind = tool === 'AskUserQuestion' ? 'question' : 'permission';
  const prompt = { id, kind, sid, tool, summary: summarize(tool, input), input: clip(input, 6000), created: now(), expires: waitMs ? now() + waitMs : null, source, key, proc };
  return new Promise((resolve) => {
    const entry = { prompt, done: false };
    const finish = (r, by) => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      S.prompts.delete(id);
      broadcast('pending_remove', { id });
      emit({ sid, aid: 'main', type: 'permission_resolved', pid: id, decision: r?.decision || 'none', by: by || 'dashboard', message: r?.message });
      if (sess) markS(sess);
      resolve(r);
    };
    entry.finish = finish;
    if (waitMs) entry.timer = setTimeout(() => finish(null, 'timed out, terminal took over'), waitMs);
    if (cancelOn) cancelOn(() => finish(null, 'answered in the terminal'));
    S.prompts.set(id, entry);
    emit({ sid, aid: 'main', type: 'permission', pid: id, tool, summary: prompt.summary, input: prompt.input, kind });
    broadcast('pending', pubPrompt(prompt));
    if (sess) markS(sess);
  });
}
function resolvePrompt(id, body) {
  const entry = S.prompts.get(id);
  if (!entry) throw httpErr(404, 'prompt already resolved or expired');
  const p = entry.prompt;
  if (p.kind === 'waiting') { entry.finish({ decision: 'none' }, 'dismissed'); return { ok: true }; }
  const allow = body.decision === 'allow';
  if (p.kind === 'denial') {
    const s = S.sessions.get(p.sid);
    if (allow && s) {
      const rule = allowRule(p.tool, p.rawInput, body.scope);
      if (!s.allowRules.includes(rule)) s.allowRules.push(rule);
      s.retry.push(rule);
    }
    entry.finish({ decision: allow ? 'allow' : 'deny' }, 'dashboard');
    const more = [...S.prompts.values()].some((e) => e.prompt.sid === p.sid && e.prompt.kind === 'denial');
    if (!more && s?.retry.length) { const rules = s.retry.splice(0); restartWithRules(s, rules); }
    return { ok: true };
  }
  const r = { decision: allow ? 'allow' : 'deny', message: body.message ? String(body.message).slice(0, 2000) : undefined };
  if (allow && p.kind === 'question' && body.answers) r.updatedInput = { ...p.input, answers: body.answers };
  if (allow && body.remember) { const s = S.sessions.get(p.sid); if (s) s.allow.add(p.key); }
  entry.finish(r, 'dashboard');
  return { ok: true };
}


/** Sessions running in your own terminal with no hooks: the dashboard can only observe. A tool call that is
 *  still unanswered after a short grace period is probably sitting on an approval prompt (or is a slow command),
 *  and an AskUserQuestion is always waiting on you. Both become read-only "waiting" cards; answer in the terminal. */
const NO_PROMPT = new Set(['Task', 'Agent', 'TodoWrite', 'Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
function watchForWait(sess, ag, b, ts) {
  if (sess.managed || sess.hooked || NO_PROMPT.has(b.name)) return;
  if (now() - ts > 180000) return;                       // history being replayed, not live
  const question = b.name === 'AskUserQuestion';
  setTimeout(() => {
    if (!S.tools.has(b.id) || [...S.prompts.values()].some((e) => e.prompt.tid === b.id)) return;
    const input = b.input || {};
    const id = crypto.randomUUID();
    const prompt = { id, kind: 'waiting', sid: sess.id, aid: ag.id, agent: ag.label || ag.id, tool: b.name, summary: summarize(b.name, input), input: clip(input, 6000), created: ts, expires: null, source: 'transcript', tid: b.id };
    const entry = { prompt, done: false };
    entry.finish = (r, by) => {
      if (entry.done) return;
      entry.done = true;
      S.prompts.delete(id);
      broadcast('pending_remove', { id });
      emit({ sid: sess.id, aid: ag.id, type: 'permission_resolved', pid: id, decision: 'none', by: by || 'terminal' });
      markS(sess);
    };
    S.prompts.set(id, entry);
    emit({ sid: sess.id, aid: ag.id, type: 'permission', pid: id, tool: b.name, summary: prompt.summary, input: prompt.input, kind: 'waiting' });
    broadcast('pending', pubPrompt(prompt));
    markS(sess);
  }, question ? 800 : 6000);
}
function clearWaiting(tid) {
  for (const e of [...S.prompts.values()]) if (e.prompt.kind === 'waiting' && e.prompt.tid === tid) e.finish(null, 'answered in the terminal');
}

/** No-MCP mode: a tool call blocked by `claude -p` becomes an "Allow and retry" card. */
function addDenial(sess, d) {
  if ([...S.prompts.values()].some((e) => e.prompt.tid === d.tool_use_id)) return;
  const id = crypto.randomUUID();
  const input = d.tool_input || {};
  const prompt = { id, kind: 'denial', sid: sess.id, tool: d.tool_name, summary: summarize(d.tool_name, input), input: clip(input, 6000), created: now(), expires: null, source: 'denial', proc: sess.proc, tid: d.tool_use_id, rawInput: input };
  const entry = { prompt, done: false };
  entry.finish = (r, by) => {
    if (entry.done) return;
    entry.done = true;
    S.prompts.delete(id);
    broadcast('pending_remove', { id });
    emit({ sid: sess.id, aid: 'main', type: 'permission_resolved', pid: id, decision: r?.decision || 'none', by: by || 'dashboard' });
    markS(sess);
  };
  S.prompts.set(id, entry);
  emit({ sid: sess.id, aid: 'main', type: 'permission', pid: id, tool: d.tool_name, summary: prompt.summary, input: prompt.input, kind: 'denial' });
  broadcast('pending', pubPrompt(prompt));
  markS(sess);
}
function allowRule(tool, input, scope) {
  if (tool !== 'Bash') return tool;
  const cmd = String(input?.command || '').trim();
  const first = cmd.split(/\s+/)[0];
  if (scope === 'prefix' || /[\n()]/.test(cmd)) return `Bash(${first}:*)`;
  return `Bash(${cmd})`;
}
function restartWithRules(s, rules) {
  const proc = s.proc && S.procs.get(s.proc);
  if (proc?.alive) proc.child.kill('SIGTERM');
  try {
    startManaged({ cwd: s.cwd, resume: s.id, model: s.model, permissionMode: s.permissionMode, prompt: `Permission was granted for: ${rules.join(', ')}. Please retry what was blocked and continue.` });
  } catch (err) { emit({ sid: s.id, aid: 'main', type: 'error', text: err.message }); }
}
function dismissDenials(sid) {
  for (const e of [...S.prompts.values()]) if (e.prompt.sid === sid && e.prompt.kind === 'denial') e.finish(null, 'superseded');
}

function hookOutput(ev, r) {
  if (!r) return null;
  const allow = r.decision === 'allow';
  if (ev === 'PermissionRequest') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow ? { behavior: 'allow', ...(r.updatedInput ? { updatedInput: r.updatedInput } : {}) } : { behavior: 'deny', message: r.message || 'Denied from AgentScope' } } };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: r.message || 'Decided in AgentScope', ...(allow && r.updatedInput ? { updatedInput: r.updatedInput } : {}) } };
}

// ───────────────────────────── replies to observed sessions ─────────────────────────────
function queueReply(sid, text) {
  const q = S.replies.get(sid) || [];
  q.push(text);
  S.replies.set(sid, q);
  const s = getSession(sid);
  emit({ sid, aid: 'main', type: 'reply_queued', text: clipStr(text, 4000) });
  markS(s);
  S.waiters.get(sid)?.();
}
async function onStop(p, cancelOn) {
  const sid = p.session_id;
  const sess = getSession(sid);
  sess.hooked = true;
  turnEnd(sess, now());
  let q = S.replies.get(sid);
  if ((!q || !q.length) && cfg.replyWindow > 0) {
    await new Promise((resolve) => {
      const t = setTimeout(done, cfg.replyWindow * 1000);
      function done() { clearTimeout(t); S.waiters.delete(sid); markS(sess); resolve(); }
      S.waiters.set(sid, done);
      cancelOn(done);
      markS(sess);
    });
    q = S.replies.get(sid);
  }
  if (q && q.length) {
    S.replies.delete(sid);
    const text = q.join('\n\n');
    sess.turnOpen = true;
    emit({ sid, aid: 'main', type: 'reply_delivered', text: clipStr(text, 4000) });
    markS(sess);
    return { decision: 'block', reason: `Message from the user (sent via the AgentScope dashboard). Continue the work accordingly:\n\n${text}` };
  }
  return null;
}

// ───────────────────────────── hook endpoint ─────────────────────────────
async function onHook(ev, p, cancelOn) {
  const sid = p.session_id;
  if (!sid) return null;
  const sess = getSession(sid);
  sess.hooked = true;
  if (p.cwd && !sess.cwd) sess.cwd = p.cwd;
  if (p.transcript_path) { sess.transcript = sess.transcript || p.transcript_path; trackFile(p.transcript_path, { force: true }); }
  switch (ev) {
    case 'SessionStart':
      sess.ended = false;
      emit({ sid, aid: 'main', type: 'sys', text: `session ${p.source || 'started'}` });
      break;
    case 'SessionEnd':
      sess.ended = true; sess.turnOpen = false;
      emit({ sid, aid: 'main', type: 'session_end', text: p.reason || '' });
      break;
    case 'Notification':
      emit({ sid, aid: 'main', type: 'notification', text: clipStr(String(p.message || ''), 500) });
      break;
    case 'SubagentStop':
      if (p.agent_id) { const a = S.agents.get(`${sid}/a:${p.agent_id}`); if (a && a.status === 'running') { a.status = 'done'; a.ended = now(); a.current = null; markA(a); } }
      break;
    case 'Stop':
      return onStop(p, cancelOn);
    case 'PermissionRequest':
    case 'PreToolUse': {
      const r = await askHuman({ sid, tool: p.tool_name, input: p.tool_input || {}, source: 'hook', waitMs: cfg.permWait * 1000, cancelOn });
      return hookOutput(ev, r);
    }
  }
  markS(sess);
  return null;
}

// ───────────────────────────── managed sessions ─────────────────────────────
const PERM_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
function httpErr(status, message) { return Object.assign(new Error(message), { status }); }


// ───────────────────────────── remote (sandbox) transport ─────────────────────────────
// Host side of the shared-directory channel to `agentscope.mjs agent` running inside a sandbox:
//   <dir>/cmd/*.json       host -> agent   spawn | stdin | kill
//   <dir>/out/<proc>.out   agent -> host   raw stream-json stdout of claude
//   <dir>/out/<proc>.err / .exit           stderr tail, and {code} when claude has exited
//   <dir>/agent.json       agent heartbeat
function agentAlive() {
  try { const hb = JSON.parse(fs.readFileSync(path.join(cfg.remote, 'agent.json'), 'utf8')); return Date.now() - hb.ts < 15000; } catch { return false; }
}
let cmdSeq = 0;
function putCmd(dir, procId, type, body) {
  fs.mkdirSync(path.join(dir, 'cmd'), { recursive: true });
  const name = `${String(Date.now()).padStart(14, '0')}-${String(cmdSeq++).padStart(6, '0')}-${procId}`;
  const tmp = path.join(dir, 'cmd', name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ procId, type, ...body }));
  fs.renameSync(tmp, path.join(dir, 'cmd', name + '.json'));
}
function remoteSpawn(procId, cwd, cliArgs) {
  const dir = cfg.remote;
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = { write: (data) => putCmd(dir, procId, 'stdin', { data: String(data) }) };
  child.kill = () => putCmd(dir, procId, 'kill', {});
  const files = { out: { off: 0, dec: new StringDecoder('utf8'), stream: child.stdout }, err: { off: 0, dec: new StringDecoder('utf8'), stream: child.stderr } };
  const drain = () => {
    for (const [ext, f] of Object.entries(files)) {
      const file = path.join(dir, 'out', `${procId}.${ext}`);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.size <= f.off) continue;
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(st.size - f.off);
      const n = fs.readSync(fd, buf, 0, buf.length, f.off); fs.closeSync(fd);
      f.off += n;
      const text = f.dec.write(buf.subarray(0, n));
      if (text) f.stream.emit('data', text);
    }
  };
  const timer = setInterval(() => {
    drain();
    const exitFile = path.join(dir, 'out', `${procId}.exit`);
    if (!fs.existsSync(exitFile)) return;
    drain();
    let code = 0; try { code = JSON.parse(fs.readFileSync(exitFile, 'utf8')).code ?? 0; } catch {}
    clearInterval(timer);
    child.emit('close', code);
  }, 300);
  putCmd(dir, procId, 'spawn', { cwd, args: cliArgs });
  return child;
}

function startManaged({ cwd, prompt, model, permissionMode, resume, allow }) {
  const dir = cfg.remote ? String(cwd || '').trim() : path.resolve(String(cwd || process.cwd()).replace(/^~(?=$|[\\/])/, HOME));
  if (cfg.remote) { if (!agentAlive()) throw httpErr(503, 'The sandbox agent is not running. Inside the sandbox run: node agentscope.mjs agent --dir ' + cfg.remote); }
  else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpErr(400, `Working directory not found: ${dir}`);
  const mode = permissionMode || 'default';
  if (!PERM_MODES.includes(mode)) throw httpErr(400, 'Unknown permission mode');
  if (mode === 'bypassPermissions' && !cfg.allowBypass) throw httpErr(403, 'bypassPermissions is disabled. Start the server with --allow-bypass to enable it.');
  if (model && !/^[\w.\-:[\]/]+$/.test(model)) throw httpErr(400, 'Invalid model name');
  if (!prompt || !String(prompt).trim()) throw httpErr(400, 'A prompt is required');

  const procId = crypto.randomUUID();
  const sid = resume || crypto.randomUUID();
  const sess = getSession(sid);
  const extra = (Array.isArray(allow) ? allow : String(allow || '').split(',')).map((x) => x.trim()).filter(Boolean).slice(0, 40);
  for (const r of extra) if (r.length < 200 && !sess.allowRules.includes(r)) sess.allowRules.push(r);
  sess.permissionMode = mode;
  let mcpFile = null;
  const cliArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...(resume ? ['--resume', resume] : ['--session-id', sid])];
  if (!cfg.noMcp) {
    ensureCfgDir();
    mcpFile = path.join(CFG_DIR, `mcp-${procId}.json`);
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { agentscope: { command: process.execPath, args: [path.join(DIR, 'mcp-approve.mjs')], env: { AGENTSCOPE_PROC: procId, AGENTSCOPE_HOME: CFG_DIR } } } }), { mode: 0o600 });
    cliArgs.push('--permission-prompt-tool', 'mcp__agentscope__approve', '--mcp-config', mcpFile);
  }
  if (model) cliArgs.push('--model', model);
  if (mode !== 'default') cliArgs.push('--permission-mode', mode);
  if (sess.allowRules.length) cliArgs.push('--allowedTools', ...sess.allowRules);

  sess.managed = true; sess.ended = false; sess.cwd = sess.cwd || dir; sess.proc = procId; sess.hooked = true;
  managedSids.add(sid);
  const proc = { id: procId, sid, alive: true, child: null, mcpFile };
  S.procs.set(procId, proc);

  const child = cfg.remote ? remoteSpawn(procId, dir, cliArgs) : spawn(cfg.claudeBin, cliArgs, { cwd: dir, env: { ...process.env, AGENTSCOPE_MANAGED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.child = child;
  let buf = '', errBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { onStream(proc, JSON.parse(line)); } catch {}
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-2000); });
  child.on('error', (err) => {
    emit({ sid: proc.sid, aid: 'main', type: 'error', text: err.code === 'ENOENT' ? `Cannot start '${cfg.claudeBin}'. Install Claude Code or pass --claude /path/to/claude.` : err.message });
  });
  child.on('close', (code) => {
    proc.alive = false;
    const s = S.sessions.get(proc.sid);
    const current = s && s.proc === procId;
    if (current) { s.ended = true; s.turnOpen = false; s.inflight = 0; markS(s); }
    for (const e of [...S.prompts.values()]) if (e.prompt.proc === procId && e.prompt.kind !== 'denial') e.finish(null, 'process exited');
    if (!current) return;
    if (code) emit({ sid: proc.sid, aid: 'main', type: 'error', text: `claude exited with code ${code}${errBuf ? `: ${one(errBuf, 400)}` : ''}` });
    else emit({ sid: proc.sid, aid: 'main', type: 'session_end', text: 'process exited' });
    if (mcpFile) try { fs.unlinkSync(mcpFile); } catch {}
  });
  sendToProc(proc, String(prompt).trim());
  return { sid };
}
function onStream(proc, o) {
  if (o.session_id && o.session_id !== proc.sid) { proc.sid = o.session_id; managedSids.add(proc.sid); }
  const sess = getSession(proc.sid);
  sess.managed = true; sess.proc = proc.id; sess.ended = false;
  ingest(o, { sid: proc.sid, source: 'stream' });
}
function sendToProc(proc, text) {
  const sess = getSession(proc.sid);
  dismissDenials(proc.sid);
  sess.turnOpen = true;
  if (!sess.title) sess.title = one(text, 80);
  emit({ sid: proc.sid, aid: 'main', type: 'user_prompt', by: 'you', text: clipStr(text, 8000) });
  proc.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  markS(sess);
}
function sendMessage(sid, text) {
  const s = S.sessions.get(sid);
  if (!s) throw httpErr(404, 'Unknown session');
  if (!text || !text.trim()) throw httpErr(400, 'Empty message');
  const proc = s.proc && S.procs.get(s.proc);
  if (proc?.alive) { sendToProc(proc, text.trim()); return { mode: 'direct' }; }
  if (s.managed) { startManaged({ cwd: s.cwd, prompt: text, resume: sid, model: s.model, permissionMode: s.permissionMode }); return { mode: 'resumed' }; }
  queueReply(sid, text.trim());
  return { mode: 'queued' };
}
function stopSession(sid) {
  const s = S.sessions.get(sid);
  const proc = s?.proc && S.procs.get(s.proc);
  if (!proc?.alive) throw httpErr(409, 'Session is not managed by AgentScope or already stopped');
  proc.child.kill('SIGTERM');
  return { ok: true };
}

// ───────────────────────────── HTTP ─────────────────────────────
const HOSTS = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
function body(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 2e6) { reject(httpErr(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpErr(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
function authorized(req, url) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('t') || '';
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function snapshot() {
  const todos = {};
  for (const [k, v] of S.todos) todos[k] = v;
  return {
    now: now(), caps: { version: VERSION, allowBypass: cfg.allowBypass, noMcp: cfg.noMcp, remote: !!cfg.remote, agentAlive: cfg.remote ? agentAlive() : null, permWait: cfg.permWait, replyWindow: cfg.replyWindow },
    sessions: [...S.sessions.values()].map(pubSession), agents: [...S.agents.values()].map(pubAgent), todos,
    pending: [...S.prompts.values()].map((e) => pubPrompt(e.prompt)), events: S.events.slice(-1500),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host || '')) return json(res, 403, { error: 'bad host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      return res.end(fs.readFileSync(path.join(DIR, 'ui', 'index.html')));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.headers.origin && !ORIGINS.has(req.headers.origin)) return json(res, 403, { error: 'bad origin' });

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot());

    const cancelOn = (fn) => res.on('close', () => { if (!res.writableEnded) fn(); });
    if (req.method === 'POST' && url.pathname === '/api/hook') {
      const b = await body(req);
      const out = await onHook(String(b.event), b.payload || {}, cancelOn);
      return json(res, 200, { output: out });
    }
    if (req.method === 'POST' && url.pathname === '/api/permission') {
      const b = await body(req);
      const proc = S.procs.get(b.proc);
      if (!proc) return json(res, 200, { decision: 'deny', message: 'Unknown AgentScope session' });
      const r = await askHuman({ sid: proc.sid, proc: proc.id, tool: b.tool_name, input: b.input || {}, source: 'mcp', waitMs: 0, cancelOn });
      return json(res, 200, r ? { decision: r.decision, message: r.message, updatedInput: r.updatedInput } : { decision: 'deny', message: 'Session ended before a decision was made' });
    }
    let m;
    if (req.method === 'POST' && (m = /^\/api\/prompts\/([\w-]+)$/.exec(url.pathname))) return json(res, 200, resolvePrompt(m[1], await body(req)));
    if (req.method === 'POST' && url.pathname === '/api/sessions') return json(res, 200, startManaged(await body(req)));
    if (req.method === 'POST' && (m = /^\/api\/sessions\/([\w-]+)\/message$/.exec(url.pathname))) return json(res, 200, sendMessage(m[1], String((await body(req)).text || '')));
    if (req.method === 'POST' && (m = /^\/api\/sessions\/([\w-]+)\/stop$/.exec(url.pathname))) return json(res, 200, stopSession(m[1]));
    if (req.method === 'POST' && (m = /^\/api\/sessions\/([\w-]+)\/resume$/.exec(url.pathname))) {
      const s = S.sessions.get(m[1]);
      if (!s) throw httpErr(404, 'Unknown session');
      const b = await body(req);
      return json(res, 200, startManaged({ cwd: s.cwd, prompt: b.prompt || 'Continue.', resume: s.id, model: s.model, permissionMode: s.permissionMode }));
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message || 'error' });
  }
});


server.listen(cfg.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${cfg.port}/?t=${TOKEN}`;
  console.log(`AgentScope ${VERSION}\n  dashboard  ${url}\n  watching   ${PROJECTS_DIR} (last ${cfg.sinceMin} min)\n  sessions   ${cfg.remote ? `run in the sandbox via ${cfg.remote} (agent ${agentAlive() ? 'connected' : 'NOT running yet'})` : 'run on this machine'}\n  hooks      perm-wait=${cfg.permWait}s reply-window=${cfg.replyWindow}s`);
  startTailing();
  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${cfg.port} is in use. Try --port <n>.` : e.message); process.exit(1); });
const shutdown = () => { for (const p of S.procs.values()) if (p.alive) p.child.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
