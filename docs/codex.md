# ChatGPT (Codex) backend — preview

[← Back to README](../README.md)

Meridian can serve **ChatGPT models from your ChatGPT plan** beside Claude. Your
coding client keeps speaking the Anthropic Messages API, so Claude Code,
OpenCode and other Anthropic clients use ChatGPT models with their own tools,
approvals, undo and session history.

Requests run through OpenAI's official, signed-in **`codex app-server`** — the
same protocol the Codex IDE extension uses. Meridian never reads or forwards
your ChatGPT credentials. Codex plan usage limits apply.

> **Preview.** The integration uses app-server fields that Codex marks
> experimental (dynamic tools and history injection). It was verified against
> codex-cli **0.160.0** with a simulated model service; authenticated live
> verification on each platform is still outstanding. Run the live gate below
> before relying on it.

## Setup

```sh
npm install -g @openai/codex
codex login            # choose "Sign in with ChatGPT"
```

### Beside Claude (recommended)

```sh
MERIDIAN_CODEX=1 meridian
```

- `POST /v1/messages` with an OpenAI model name (`gpt-*`, `o<N>`, `codex-*`) or
  any `codex/<model>` name goes to ChatGPT. Claude model names keep the Claude
  path unchanged. One base URL serves both, so a client can switch models
  mid-session.
- `/codex/v1/messages`, `/codex/v1/models` and `/codex/health` always address
  ChatGPT.
- `/v1/models` lists the ChatGPT models your account can use after the Claude
  models.

**Claude Code:** keep `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`, then run
`/model gpt-5.5` (or start with `claude --model gpt-5.5`). Background calls that
name a Claude model still use Claude.

**OpenCode:** add the ChatGPT model IDs to your Meridian provider's `models`,
or add a second Anthropic provider whose `baseURL` is
`http://127.0.0.1:3456/codex`.

### ChatGPT only

```sh
MERIDIAN_BACKEND=codex MERIDIAN_CODEX_MODEL=gpt-5.5 meridian
```

Every request goes to ChatGPT. Claude model names (for example Claude Code's
background `claude-haiku-*` calls) use `MERIDIAN_CODEX_MODEL`, or Codex's own
default when it is unset.

## How sessions work

Your client's message history is the source of truth for every request:

| Request | What Meridian does | Prompt cache |
| :--- | :--- | :--- |
| Exact continuation of a live conversation | Starts the next turn on the same Codex thread | Same thread, same cache key |
| Tool result for a call Codex is waiting on | Returns the result to the blocked turn by call ID | Same thread |
| Undo, edit, compaction, subagent, changed tools/system prompt, Meridian or Codex restart | Starts a fresh thread and injects the client's history exactly | New cache key |

Because a rebuilt thread is seeded from the client's own messages, undo,
compaction and subagents can never leave Codex with a different conversation
than the client shows. Concurrent subagents get separate threads, and every
tool result is matched by its call ID, never by arrival order. The
`x-meridian-codex-continuation` response header reports `new`, `reused`,
`tool-result` or `rebuilt`.

### Tools

Codex sees only the client's tools. Its built-in shell, web search, image,
plugin, skill and multi-agent tools are switched off, so every action goes
through the client and its approvals and undo record it. Codex still exposes
its `apply_patch` tool; it runs in an empty, private, read-only directory, so
it can never change your files. Built-in approval requests are declined.

## Limitations

- Anthropic Messages only. `/v1/chat/completions` and `/v1/responses` are not
  served by the Codex backend yet.
- When Codex requests several tools at once, they reach the client one at a
  time (one HTTP round trip each, no extra model calls).
- Usage for the model call that produced a tool call is reported on the next
  response, because Codex reports it after the tool result arrives.
- `tool_choice`, `max_tokens`, sampling settings and stop sequences are
  advisory; `count_tokens` is an estimate. No thinking blocks are returned.
  `output_config.effort` maps to Codex reasoning effort (`max` → `xhigh`).
- Settings in `~/.codex/config.toml` that add tools, such as MCP servers,
  still apply to Codex.
- Live state is in memory. After a restart the next request rebuilds from the
  client's history, which costs one cold prompt cache.

## Environment variables

| Variable | Meaning |
| :--- | :--- |
| `MERIDIAN_CODEX=1` | Serve ChatGPT beside Claude |
| `MERIDIAN_BACKEND=codex` | ChatGPT only |
| `MERIDIAN_CODEX_PATH` | Official `codex` executable (default `codex` on `PATH`) |
| `MERIDIAN_CODEX_MODEL` | ChatGPT model used when a client sends a Claude model name |
| `MERIDIAN_CODEX_TOOL_TIMEOUT_MS` | How long a turn waits for a client tool result (default 900000). A result that arrives later still works through a history rebuild |
| `MERIDIAN_CODEX_MAX_CONVERSATIONS` | Live Codex threads kept for reuse (default 64) |

## Verification

```sh
npm run build
node scripts/e2e-codex.mjs          # real codex binary, simulated model service
node scripts/e2e-codex.mjs --live   # real codex binary, your ChatGPT account
```

The simulated gate runs the real `codex app-server` against a local stand-in
for the OpenAI Responses API. It checks which tools reach the model, that
reused turns keep the prompt-cache key, that tool results arrive under the
client's call ID, and that undo rebuilds the exact client history. The live gate
repeats text, reuse, tool, undo and streaming checks against your account.
Both write a JSON report to the printed artifacts directory.
