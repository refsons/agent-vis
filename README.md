# AgentScope

Live view of every Claude Code session, subagent, tool call and task list on your machine,
with an inbox to approve tool calls, answer agent questions and reply to agents from the browser.
Zero dependencies, Node 18+, binds to 127.0.0.1 only.

## Quick start

No install, no hooks, no MCP, nothing written outside `~/.agentscope/` by the dashboard itself:

```bash
node agentscope.mjs serve --open       # prints http://127.0.0.1:7788/?t=<token>
```

Sessions active in the last 30 minutes appear automatically (`--since <min>` to change). This reads
Claude Code's own transcripts, so it works in locked-down environments. Choose a mode below for
approvals and replies.

| Environment | Command | What works |
|---|---|---|
| Hooks and MCP disabled (sandboxes) | `serve --no-mcp` | Full read-only view of terminal sessions. Sessions started from the dashboard get inbox approvals through "Blocked" cards |
| MCP available, hooks disabled | `serve` | Read-only view of terminal sessions. Dashboard-started sessions get live approvals over MCP |
| Hooks available (optional) | `install`, then `serve` | Adds approvals and replies for sessions you started in your own terminal |

## Claude in a sandbox, dashboard on the host

If Claude runs in a sandbox with its own home (transcripts in the sandbox's `~/.claude`, invisible to
the host), mirror them into a directory both sides can see, normally the workspace mount:

```bash
# inside the sandbox
node agentscope.mjs sync --to /path/in/workspace/.agentscope-sync      # every 2s, files touched in the last 120 min

# on the host
node agentscope.mjs serve --claude-dir /host/path/to/workspace/.agentscope-sync --open
```

`sync` only appends new bytes, never modifies the originals, and `--once` copies a single time.
This gives the full read-only view (timeline, lanes, agent tree, tasks, tokens). **Needs you** shows
read-only alerts here: an `AskUserQuestion` appears within a second, and any other tool call still
unanswered after 6 seconds appears as "Waiting: <tool>" (it is probably an approval prompt, but a slow
command looks identical). The card clears itself when you answer in the terminal, and browser
notifications fire if the tab is in the background. Approving and
replying still happen in the sandbox terminal, because sessions started from a host dashboard
run `claude` on the host, not in the sandbox. Add `.agentscope-sync/` to your `.gitignore`.

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

**Observed sessions** (started in your terminal). Activity comes from the transcripts, so timeline,
lanes, agent tree, tokens and tasks work with no hooks. Approving and replying to these sessions
from the browser needs the optional hooks (`node agentscope.mjs install`, then restart any running
`claude` sessions; undo with `uninstall`; a backup of `~/.claude/settings.json` is kept):
- Permission requests are held for `--perm-wait` seconds (default 45). Answer in the browser, or
  ignore it and the normal terminal prompt takes over. Answering in the terminal cancels the card.
- Replies are delivered through the Stop hook as a "continue" instruction. A reply queued while the
  agent is working is delivered the moment it stops. `--reply-window <sec>` makes the Stop hook wait
  that long for you (the terminal is blocked meanwhile, so it is off by default).

**Managed sessions** (started from the dashboard). AgentScope owns the process, so replies are
direct and cost per session is exact. Ended sessions resume with `--resume` when you send a message.
This is the route that needs no hooks. Approvals arrive one of two ways:
- Default: permission prompts and `AskUserQuestion` are routed to the inbox over a local MCP tool
  (`mcp-approve.mjs`), with no timeout.
- `--no-mcp`: for sandboxes where hooks and MCP are both disabled. Claude blocks tool calls that need
  approval and reports them when the turn ends. Each becomes a "Blocked: <tool>" card with
  **Allow and retry** (scoped `--allowedTools` rule for that exact command), **Allow all `<cmd>`
  commands** (prefix rule) or **Dismiss**. Allowing resumes the session with `--resume` and asks
  Claude to retry. The new-session dialog has a "Pre-approved tools" field to skip most prompts.
  Approvals are per turn rather than mid-turn, so this mode is slower than the MCP route.

## Options

`serve --port 7788 --since 30 --claude /path/to/claude --claude-dir <dir> --no-mcp --allow-bypass --open`
`sync --to <dir> --every 2 --since 120 --once`
`install --gate permission|pretool|off --perm-wait 45 --reply-window 0 --scope user|project`

`--gate pretool` gates only Bash/Edit/Write/NotebookEdit through PreToolUse, for Claude Code
versions without the PermissionRequest hook.

## Security model

The dashboard can approve commands and spawn agents, so it is locked down: loopback only, Host and
Origin checks (blocks DNS rebinding and cross-site requests), a random 192-bit token in
`~/.agentscope/token` (mode 600) required on every API call, and `bypassPermissions` refused unless
you start the server with `--allow-bypass`. If you install the optional hooks, the hook script
fails open: if the dashboard is not running, Claude Code behaves exactly as if AgentScope were not installed. "Allow for this session"
matches the tool for edits and the exact command for Bash.

## Known limits

- Built against the documented hook and stream-json interfaces and verified with synthetic
  transcripts and a stand-in `claude` binary. Do one real run to confirm your CLI version: start a
  session from the dashboard and trigger an edit. Field names read from transcripts are handled defensively.
- Linking a subagent to the Task call that spawned it uses the sub-agent's first prompt, or ids when
  the CLI provides them. If several identical Task prompts run in parallel, parents can be swapped.
- `AskUserQuestion` answers are returned as `updatedInput.answers`; verify on your version.
- Tokens are shown for observed sessions, not dollars, since prices change. Cost appears for managed ones.
- Nothing is persisted; history is rebuilt from transcripts on start.
