# AgentScope

Live view of every Claude Code session, subagent, tool call and task list on your machine,
with an inbox to approve tool calls, answer agent questions and reply to agents from the browser.
Zero dependencies, Node 18+, binds to 127.0.0.1 only.

## Quick start

```bash
node agentscope.mjs install            # one-off: adds hooks to ~/.claude/settings.json (backup kept)
node agentscope.mjs serve --open       # prints http://127.0.0.1:7788/?t=<token>
```

Restart any running `claude` sessions once so they load the hooks. Sessions active in the last
30 minutes appear automatically (`--since <min>` to change). Undo with `node agentscope.mjs uninstall`.

## What you get

| Area | What it shows / does |
|---|---|
| Sessions | Every session, status (working, waiting for you, idle, ended), branch, model, tokens, cache hit rate, cost for managed sessions, plus the subagent tree with the tool each agent is running now |
| Timeline | Prompts, replies, thinking, tool calls with input, result, duration and errors, subagent start and end, task list changes. Filter by session or agent, search with `/` |
| Lanes | One swimlane per agent over the last 5 to 60 minutes. Bars are tool calls coloured by kind, red outline for errors, pulsing while in flight. Diamonds are approvals, triangles are your prompts. Click a bar to jump to it |
| Needs you | Approval cards (command, diff or file preview) with Allow `y`, Allow for this session, Deny `n` with a reason sent to the agent; multiple choice question cards |
| Tasks | Live TodoWrite lists per agent with progress |
| Composer | Reply to any session, start new ones, stop or take over |

## How it integrates with the CLI

```
                ┌──────────── ~/.claude/projects/**/*.jsonl  (tailed) ─────► timeline, agents, tokens
 claude (any    │
 terminal)  ────┼─ hooks: PermissionRequest, Stop, Notification,        ─► approvals, replies, lifecycle
                │         SessionStart/End, SubagentStop  (hook.mjs)
                │
 dashboard ─────┴─ claude -p --input/output-format stream-json           ─► managed sessions: full two-way
   "New session"    --permission-prompt-tool mcp__agentscope__approve      control (mcp-approve.mjs)
```

**Observed sessions** (started in your terminal). Activity comes from the transcripts, so it works
even without hooks. With hooks installed:
- Permission requests are held for `--perm-wait` seconds (default 45). Answer in the browser, or
  ignore it and the normal terminal prompt takes over. Answering in the terminal cancels the card.
- Replies are delivered through the Stop hook as a "continue" instruction. A reply queued while the
  agent is working is delivered the moment it stops. `--reply-window <sec>` makes the Stop hook wait
  that long for you (the terminal is blocked meanwhile, so it is off by default).

**Managed sessions** (started from the dashboard). AgentScope owns the process, so replies are
direct, every permission prompt and `AskUserQuestion` is routed to the inbox with no timeout, and
cost per session is exact. Ended sessions resume with `--resume` when you send a message.

## Options

`serve --port 7788 --since 30 --claude /path/to/claude --allow-bypass --open`
`install --gate permission|pretool|off --perm-wait 45 --reply-window 0 --scope user|project`

`--gate pretool` gates only Bash/Edit/Write/NotebookEdit through PreToolUse, for Claude Code
versions without the PermissionRequest hook.

## Security model

The dashboard can approve commands and spawn agents, so it is locked down: loopback only, Host and
Origin checks (blocks DNS rebinding and cross-site requests), a random 192-bit token in
`~/.agentscope/token` (mode 600) required on every API call, and `bypassPermissions` refused unless
you start the server with `--allow-bypass`. The hook script fails open: if the dashboard is not
running, Claude Code behaves exactly as if AgentScope were not installed. "Allow for this session"
matches the tool for edits and the exact command for Bash.

## Known limits

- Built against the documented hook and stream-json interfaces and verified with synthetic
  transcripts and a stand-in `claude` binary. Do one real run to confirm your CLI version: install,
  start a session, trigger an edit. Field names read from transcripts are handled defensively.
- Linking a subagent to the Task call that spawned it uses the sub-agent's first prompt, or ids when
  the CLI provides them. If several identical Task prompts run in parallel, parents can be swapped.
- `AskUserQuestion` answers are returned as `updatedInput.answers`; verify on your version.
- Tokens are shown for observed sessions, not dollars, since prices change. Cost appears for managed ones.
- Nothing is persisted; history is rebuilt from transcripts on start.
