# Codex (ChatGPT) backend — evidence

## Real codex binary, simulated model service

`node scripts/e2e-codex.mjs` with codex-cli 0.160.0 on Linux x86_64. The real
`codex app-server` ran against a local Responses API stand-in; the recorded
requests are what codex would send to OpenAI
([report](codex-backend-simulated.json)).

| Check | Result |
| :--- | :--- |
| Health reports `backend: codex` | pass |
| Text turn; `instructions` equals the client's system prompt | pass |
| Model-visible tools are the client's tools plus codex `apply_patch` only (no shell, web search, image, request-user-input or agent tools) | pass |
| Exact continuation reuses the thread; `prompt_cache_key` unchanged | pass |
| Tool result reaches the model as `function_call_output` under the client's `tool_use` id | pass |
| Parallel model tool batch reaches the client one call at a time, in order | pass |
| Undo rebuilds a fresh thread whose input is exactly the client's retained history | pass |
| Anthropic SSE streaming | pass |

Unit/integration: `src/__tests__/codex-backend.test.ts` (19) and
`src/__tests__/codex-combined-routing.test.ts` (4) through a deterministic
app-server fixture; full `npm test` green.

## Missing evidence (follow-up gates)

- **Authenticated live run** (`node scripts/e2e-codex.mjs --live`) with a
  signed-in ChatGPT account. This container blocks `api.openai.com` and has no
  ChatGPT login.
- **Actual Claude Code and OpenCode clients** against a live ChatGPT model:
  multi-turn tool use, undo, compaction and subagents.
- macOS and Windows runs.
