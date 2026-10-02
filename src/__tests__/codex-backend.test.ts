import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createCodexServer } from "../proxy/backends/codex"
import { CodexRuntime } from "../proxy/backends/codexRuntime"
import { DEFAULT_PROXY_CONFIG, resolveBackendConfig } from "../proxy/types"
import { codexModel, contractKey, dynamicTools, isCodexModel, messageKey, parseCodexRequest, responseItems, toolCallResponse, type CodexMessage } from "../proxy/backends/codexProtocol"

const executable = fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url))

interface Reply {
  id: string
  stop_reason: string
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }
}
interface FixtureThread { id: string; items: Array<Record<string, unknown>>; injected?: Array<Record<string, unknown>>; tools: Array<{ name: string }>; base: string; models: Array<string | null>; efforts: Array<string | null>; turn: string | null }
interface FixtureState { threads: Record<string, FixtureThread>; unsubscribed: string[]; interrupted: string[] }

const closing: Array<() => Promise<void>> = []
function fixture(options = {}) {
  const runtime = new CodexRuntime({ executable, defaultModel: "gpt-5.5", ...options })
  const server = createCodexServer({ ...DEFAULT_PROXY_CONFIG, backend: "codex" }, runtime)
  closing.push(server.closeBackend)
  const send = async (body: unknown, signal?: AbortSignal): Promise<Response> => await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body), signal }))
  const state = async () => (await runtime.connection()).request<FixtureState>("fixture/state", {})
  return { runtime, server, send, state }
}
afterEach(async () => { for (const close of closing.splice(0)) await close() })

const tool = { name: "lookup", description: "Look up a key", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const system = "You are the client's coding agent."
const user = (content: unknown): CodexMessage => ({ role: "user", content } as CodexMessage)
const assistant = (content: unknown): CodexMessage => ({ role: "assistant", content } as CodexMessage)
const request = (messages: CodexMessage[], extra: Record<string, unknown> = {}) => ({ model: "gpt-5.5", max_tokens: 1000, system, tools: [tool], messages, ...extra })
async function json(response: Response): Promise<Reply> {
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return await response.json() as Reply
}
const text = (reply: Reply) => reply.content.filter(block => block.type === "text").map(block => block.text).join("")

describe("Codex request translation", () => {
  it("routes OpenAI model names and maps Claude names to the configured default", () => {
    expect(isCodexModel("gpt-5.5")).toBe(true)
    expect(isCodexModel("codex/gpt-5.5-codex")).toBe(true)
    expect(isCodexModel("o3")).toBe(true)
    expect(isCodexModel("claude-sonnet-5-5")).toBe(false)
    expect(isCodexModel(undefined)).toBe(false)
    expect(codexModel("codex/gpt-5.5")).toBe("gpt-5.5")
    expect(codexModel("claude-haiku-4-5-20251001", { defaultModel: "gpt-5.5-mini" })).toBe("gpt-5.5-mini")
    expect(codexModel("claude-opus-5-5")).toBeUndefined()
  })
  it("keys lineage on conversation content, not cache markers or thinking", () => {
    const plain = assistant([{ type: "text", text: "Hello" }, { type: "tool_use", id: "t1", name: "lookup", input: { b: 1, a: 2 } }])
    const decorated = assistant([{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: " Hello\n", cache_control: { type: "ephemeral" } }, { type: "tool_use", id: "t1", name: "lookup", input: { a: 2, b: 1 } }])
    expect(messageKey(plain)).toBe(messageKey(decorated))
    expect(messageKey(user("Hello"))).toBe(messageKey(user([{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }])))
    expect(messageKey(user("Hello"))).not.toBe(messageKey(assistant("Hello")))
  })
  it("binds the thread contract to system and client tool catalog", () => {
    const base = parseCodexRequest(request([user("hi")]))
    expect(contractKey(base)).toBe(contractKey(parseCodexRequest(request([user("other")], { model: "gpt-5.5-mini" }))))
    expect(contractKey(base)).not.toBe(contractKey(parseCodexRequest(request([user("hi")], { tools: [] }))))
    expect(contractKey(base)).not.toBe(contractKey(parseCodexRequest(request([user("hi")], { system: "changed" }))))
    expect(dynamicTools(parseCodexRequest(request([user("hi")], { tools: [tool, { type: "web_search_20250305", name: "web_search" }] })))).toEqual([{ type: "function", name: "lookup", description: "Look up a key", inputSchema: tool.input_schema }])
  })
  it("reproduces client history, tool calls and results as Responses items", () => {
    const items = responseItems([
      user([{ type: "text", text: "read it" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw==" } }]),
      assistant([{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "Reading" }, { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "k" } }]),
      user([{ type: "tool_result", tool_use_id: "toolu_1", content: "value", is_error: true }, { type: "text", text: "<system-reminder>note</system-reminder>" }]),
    ])
    expect(items).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }, { type: "input_image", image_url: "data:image/png;base64,iVBORw==" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading" }] },
      { type: "function_call", call_id: "toolu_1", name: "lookup", arguments: '{"key":"k"}' },
      { type: "function_call_output", call_id: "toolu_1", output: "[tool error] value" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder>note</system-reminder>" }] },
    ])
    expect(toolCallResponse({ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "a" }] }, ["b"])).toEqual({ contentItems: [{ type: "inputText", text: "a" }, { type: "inputText", text: "b" }], success: true })
  })
  it("rejects assistant prefill except when counting tokens", () => {
    expect(() => parseCodexRequest(request([user("a"), assistant("b")]))).toThrow("final message")
    expect(parseCodexRequest(request([user("a"), assistant("b")]), true).messages.length).toBe(2)
  })
  it("enables Codex beside Claude from the environment and standalone by backend", () => {
    const previous = process.env.MERIDIAN_CODEX
    try {
      process.env.MERIDIAN_CODEX = "1"
      expect(resolveBackendConfig({}).codex?.enabled).toBe(true)
      expect(resolveBackendConfig({ backend: "antigravity" }).codex).toBeUndefined()
      delete process.env.MERIDIAN_CODEX
      expect(resolveBackendConfig({}).codex).toBeUndefined()
      expect(resolveBackendConfig({ backend: "codex" }).codex?.enabled).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_CODEX
      else process.env.MERIDIAN_CODEX = previous
    }
  })
})

describe("Codex backend sessions", () => {
  it("reuses the live thread for an exact continuation", async () => {
    const { send, state } = fixture()
    const first = await send(request([user("hello")]))
    expect(first.headers.get("x-meridian-codex-continuation")).toBe("new")
    const answer = await json(first)
    expect(text(answer)).toBe("Echo: hello")
    expect(answer.stop_reason).toBe("end_turn")
    expect(answer.usage).toEqual({ input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } as Reply["usage"])

    const second = await send(request([user("hello"), assistant([{ type: "text", text: "Echo: hello", cache_control: { type: "ephemeral" } }]), user("again")]))
    expect(second.headers.get("x-meridian-codex-continuation")).toBe("reused")
    expect(text(await json(second))).toBe("Echo: again")
    const threads = Object.values((await state()).threads)
    expect(threads).toHaveLength(1)
    expect(threads[0]!.injected).toBeUndefined()
    expect(threads[0]!.base).toBe(system)
    expect(threads[0]!.tools.map(t => t.name)).toEqual(["lookup"])
  })

  it("routes a client tool result back to the blocked Codex turn", async () => {
    const { send, state } = fixture()
    const call = await json(await send(request([user("[tool] find it")])))
    expect(call.stop_reason).toBe("tool_use")
    expect(call.content[0]).toEqual({ type: "text", text: "Checking." })
    const use = call.content[1]!
    expect(use).toMatchObject({ type: "tool_use", name: "lookup", input: { key: "k" } })

    const history = [user("[tool] find it"), assistant(call.content), user([{ type: "tool_result", tool_use_id: use.id, content: "42" }, { type: "text", text: "<system-reminder>keep going</system-reminder>" }])]
    const resumed = await send(request(history))
    expect(resumed.headers.get("x-meridian-codex-continuation")).toBe("tool-result")
    const final = await json(resumed)
    expect(text(final)).toBe("Result: 42|<system-reminder>keep going</system-reminder>")
    expect(final.usage.cache_read_input_tokens).toBeGreaterThan(0)
    expect(Object.keys((await state()).threads)).toHaveLength(1)

    const next = await send(request([...history, assistant(final.content), user("thanks")]))
    expect(next.headers.get("x-meridian-codex-continuation")).toBe("reused")
  })

  it("streams Anthropic SSE for text and tool calls", async () => {
    const { send } = fixture()
    const response = await send(request([user("[tool] stream")], { stream: true }))
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    const events = body.split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as { type: string; delta?: { type?: string; stop_reason?: string } })
    expect(events[0]!.type).toBe("message_start")
    expect(events.filter(e => e.delta?.type === "text_delta").length).toBeGreaterThan(0)
    expect(events.some(e => e.delta?.type === "input_json_delta")).toBe(true)
    expect(events.find(e => e.type === "message_delta")!.delta!.stop_reason).toBe("tool_use")
    expect(events.at(-1)!.type).toBe("message_stop")
  })

  it("rebuilds a fresh thread from client history after undo", async () => {
    const { send, state } = fixture()
    const a = await json(await send(request([user("one")])))
    const twoHistory = [user("one"), assistant(a.content), user("two")]
    const b = await json(await send(request(twoHistory)))
    // Undo turn two and ask something else: Codex must not remember "two".
    const undone = await send(request([user("one"), assistant(a.content), user("three")]))
    expect(undone.headers.get("x-meridian-codex-continuation")).toBe("rebuilt")
    expect(text(await json(undone))).toBe("Echo: three")
    const threads = Object.values((await state()).threads)
    expect(threads).toHaveLength(2)
    const rebuilt = threads.find(thread => thread.injected)!
    expect(rebuilt.injected).toEqual(responseItems([user("one"), assistant(a.content)]))
    expect(JSON.stringify(rebuilt.items)).not.toContain("two")
    expect(text(b)).toBe("Echo: two")
  })

  it("rebuilds after client compaction replaces the history", async () => {
    const { send } = fixture()
    const a = await json(await send(request([user("long task")])))
    await json(await send(request([user("long task"), assistant(a.content), user("more")])))
    const compacted = await send(request([user("Summary of the conversation so far: long task, more."), assistant("Understood."), user("continue")]))
    expect(compacted.headers.get("x-meridian-codex-continuation")).toBe("rebuilt")
    expect(text(await json(compacted))).toBe("Echo: continue")
  })

  it("keeps concurrent subagent tool calls on their own threads", async () => {
    const { send, state } = fixture()
    const [parent, child] = await Promise.all([
      send(request([user("[tool] parent task")])).then(json),
      send(request([user("[tool] child task")], { system: "You are a subagent." })).then(json),
    ])
    const parentUse = parent.content.find(block => block.type === "tool_use")!
    const childUse = child.content.find(block => block.type === "tool_use")!
    expect(parentUse.id).not.toBe(childUse.id)
    // Answer in the opposite order: each result must reach its own thread.
    const childFinal = await json(await send(request([user("[tool] child task"), assistant(child.content), user([{ type: "tool_result", tool_use_id: childUse.id, content: "child-result" }])], { system: "You are a subagent." })))
    const parentFinal = await json(await send(request([user("[tool] parent task"), assistant(parent.content), user([{ type: "tool_result", tool_use_id: parentUse.id, content: "parent-result" }])])))
    expect(text(childFinal)).toBe("Result: child-result")
    expect(text(parentFinal)).toBe("Result: parent-result")
    const threads = Object.values((await state()).threads)
    expect(threads).toHaveLength(2)
    expect(threads.find(thread => thread.base === "You are a subagent.")!.items.some(item => item.output === "child-result")).toBe(true)
  })

  it("recovers a tool result whose turn is gone by replaying the full history", async () => {
    const { send, state } = fixture()
    const history = [
      user("[tool] look"),
      assistant([{ type: "text", text: "Checking." }, { type: "tool_use", id: "toolu_lost", name: "lookup", input: { key: "k" } }]),
      user([{ type: "tool_result", tool_use_id: "toolu_lost", content: "from-before-restart" }]),
    ]
    const response = await send(request(history))
    expect(response.headers.get("x-meridian-codex-continuation")).toBe("rebuilt")
    expect(text(await json(response))).toBe("Result: from-before-restart")
    const thread = Object.values((await state()).threads)[0]!
    expect(thread.injected).toEqual(responseItems(history))
  })

  it("retires a pending tool owner when the client changes the tool catalog", async () => {
    const { send, state } = fixture()
    const call = await json(await send(request([user("[tool] go")])))
    const use = call.content.find(block => block.type === "tool_use")!
    const extra = { name: "extra", input_schema: { type: "object" } }
    const response = await send(request([user("[tool] go"), assistant(call.content), user([{ type: "tool_result", tool_use_id: use.id, content: "v" }])], { tools: [tool, extra] }))
    expect(response.headers.get("x-meridian-codex-continuation")).toBe("rebuilt")
    expect(text(await json(response))).toBe("Result: v")
    const snapshot = await state()
    expect(Object.values(snapshot.threads).at(-1)!.tools.map(t => t.name)).toEqual(["lookup", "extra"])
    expect(snapshot.unsubscribed).toContain(Object.keys(snapshot.threads)[0]!)
  })

  it("interrupts Codex when the client cancels and rebuilds afterwards", async () => {
    const { send, state, runtime } = fixture()
    const controller = new AbortController()
    const response = await send(request([user("[slow] think")], { stream: true }), controller.signal)
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await reader.cancel().catch(() => undefined)
    for (let attempt = 0; attempt < 50 && runtime.conversations.size; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtime.conversations.size).toBe(0)
    for (let attempt = 0; attempt < 50 && !(await state()).interrupted.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    expect((await state()).interrupted).toHaveLength(1)
    const retry = await send(request([user("[slow] think"), assistant("Work"), user("hello")]))
    expect(retry.headers.get("x-meridian-codex-continuation")).toBe("rebuilt")
  })

  it("maps turn failures to actionable HTTP errors", async () => {
    const { send } = fixture()
    const response = await send(request([user("[fail] go")]))
    expect(response.status).toBe(429)
    expect(((await response.json()) as { error: { type: string } }).error.type).toBe("rate_limit_error")
  })

  it("survives an app-server crash and serves the next request from history", async () => {
    const { send } = fixture()
    const crashed = await send(request([user("[crash] now")]))
    expect(crashed.status).toBe(502)
    const next = await send(request([user("[crash] now"), assistant("partial"), user("hello again")]))
    expect(next.headers.get("x-meridian-codex-continuation")).toBe("rebuilt")
    expect(text(await json(next))).toBe("Echo: hello again")
  })

  it("passes model and effort per turn and maps Claude model names", async () => {
    const { send, state } = fixture()
    const first = await send(request([user("hi")], { model: "claude-haiku-4-5-20251001", output_config: { effort: "max" } }))
    expect(first.headers.get("x-meridian-effective-model")).toBe("gpt-5.5")
    const a = await json(first)
    await json(await send(request([user("hi"), assistant(a.content), user("again")], { model: "codex/gpt-5.5-codex", output_config: { effort: "low" } })))
    const thread = Object.values((await state()).threads)[0]!
    expect(thread.models).toEqual(["gpt-5.5", "gpt-5.5-codex"])
    expect(thread.efforts).toEqual(["xhigh", "low"])
  })

  it("reports health, models and token estimates", async () => {
    const { server } = fixture()
    const health = await server.app.fetch(new Request("http://local/health"))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: "healthy", backend: "codex", auth: { type: "chatgpt", plan: "pro" } })
    const models = await (await server.app.fetch(new Request("http://local/v1/models"))).json() as { data: Array<{ id: string }> }
    expect(models.data.map(model => model.id)).toEqual(["gpt-5.5"])
    const count = await (await server.app.fetch(new Request("http://local/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(request([user("count me")])) }))).json() as { input_tokens: number }
    expect(count.input_tokens).toBeGreaterThan(0)
  })
})
