// Codex (ChatGPT) backend through the REAL official `codex app-server`.
//
//   npm run build && node scripts/e2e-codex.mjs          # simulated model service
//   npm run build && node scripts/e2e-codex.mjs --live   # your signed-in ChatGPT account
//
// Simulated mode points codex at a local Responses API stand-in, so it needs no
// account and no network, yet exercises the actual codex binary end to end and
// records exactly what codex would send to OpenAI. Live mode uses `codex login`
// credentials and spends a few requests of ChatGPT plan usage.
// Set MERIDIAN_CODEX_PATH to choose the codex executable.
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { once } from "node:events"
import { startProxyServer } from "../dist/server.js"

const live = process.argv.includes("--live")
const executable = process.env.MERIDIAN_CODEX_PATH || "codex"
const model = process.env.E2E_CODEX_MODEL || "gpt-5.5"
const root = await mkdtemp(join(tmpdir(), "meridian-codex-e2e-"))
console.log(`Artifacts: ${root}`)
const report = { mode: live ? "live" : "simulated", model, cli: spawnSync(executable, ["--version"], { encoding: "utf8" }).stdout?.trim(), platform: process.platform, passed: [] }

// --- Simulated Responses API: deterministic markers, records every request ---
const seen = []
let stand
if (!live) {
  stand = createServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.endsWith("/responses")) { res.writeHead(404).end(); return }
      const request = JSON.parse(body)
      seen.push(request)
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      const userText = [...request.input].reverse().find(item => item.type === "message" && item.role === "user")?.content.map(part => part.text ?? "").join("") ?? ""
      const last = request.input.at(-1)
      res.writeHead(200, { "content-type": "text/event-stream" })
      send({ type: "response.created", response: { id: `resp_${seen.length}` } })
      const output = item => { send({ type: "response.output_item.added", output_index: 0, item }); send({ type: "response.output_item.done", output_index: 0, item }) }
      const say = text => {
        const id = `msg_${seen.length}`
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id, role: "assistant", content: [] } })
        send({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text })
        send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] } })
      }
      const outputs = request.input.filter(item => item.type === "function_call_output")
      if (userText.includes("[tools2]") && !outputs.length) {
        for (const [index, key] of ["alpha", "beta"].entries()) {
          const item = { type: "function_call", id: `fc_${seen.length}_${index}`, call_id: `call_${seen.length}_${index}`, name: "lookup", arguments: JSON.stringify({ key }) }
          send({ type: "response.output_item.added", output_index: index, item }); send({ type: "response.output_item.done", output_index: index, item })
        }
      } else if (userText.includes("[tools2]")) say(`Both: ${outputs.map(item => typeof item.output === "string" ? item.output : item.output.map(part => part.text).join("")).join(",")}`)
      else if (last?.type === "function_call_output") say(`Result: ${typeof last.output === "string" ? last.output : last.output.map(part => part.text).join("")}`)
      else if (userText.includes("[tool]")) output({ type: "function_call", id: `fc_${seen.length}`, call_id: `call_${seen.length}`, name: request.tools.find(tool => tool.name === "lookup").name, arguments: JSON.stringify({ key: "alpha" }) })
      else say(`Echo: ${userText}`)
      send({ type: "response.completed", response: { id: `resp_${seen.length}`, usage: { input_tokens: 200, input_tokens_details: { cached_tokens: seen.length > 1 ? 150 : 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 209 } } })
      res.end()
    })
  })
  stand.listen(0, "127.0.0.1")
  await once(stand, "listening")
  process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",")
  process.env.no_proxy = process.env.NO_PROXY
}
const standUrl = stand ? `http://127.0.0.1:${stand.address().port}/v1` : undefined
const extraConfig = standUrl ? [
  'model_provider="meridian-e2e"', 'model_providers.meridian-e2e.name="meridian-e2e"', `model_providers.meridian-e2e.base_url="${standUrl}"`,
  'model_providers.meridian-e2e.wire_api="responses"', "model_providers.meridian-e2e.supports_websockets=false", "model_providers.meridian-e2e.requires_openai_auth=false",
] : []

const proxy = await startProxyServer({ backend: "codex", port: 0, silent: true, codex: { executable, defaultModel: model, extraConfig } })
if (!proxy.server.listening) await once(proxy.server, "listening")
const url = `http://127.0.0.1:${proxy.server.address().port}`
const lookup = { name: "lookup", description: "Look up the value stored under a key. Always use this tool when asked about a key.", input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }
const system = "You are a terse assistant inside a coding client. Follow instructions exactly."
const send = async (messages, extra = {}) => {
  const response = await fetch(url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 1024, system, tools: [lookup], messages, ...extra }), signal: AbortSignal.timeout(180_000) })
  const continuation = response.headers.get("x-meridian-codex-continuation")
  if (extra.stream) return { continuation, sse: await response.text(), status: response.status }
  const body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return { continuation, body, text: body.content.filter(block => block.type === "text").map(block => block.text).join("") }
}
const pass = name => { report.passed.push(name); console.log(`✓ ${name}`) }

try {
  const health = await fetch(url + "/health")
  const healthBody = await health.json()
  assert.equal(health.status, 200, JSON.stringify(healthBody))
  assert.equal(healthBody.backend, "codex")
  pass("health")

  const firstPrompt = live ? "Reply with exactly READY. Do not use tools." : "hello"
  const first = await send([{ role: "user", content: firstPrompt }])
  assert.equal(first.continuation, "new")
  if (live) assert.match(first.text, /READY/)
  else {
    assert.equal(first.text, "Echo: hello")
    const tools = seen[0].tools.map(tool => tool.name ?? tool.type)
    report.modelVisibleTools = tools
    assert(tools.includes("lookup"), tools.join(","))
    for (const native of ["exec_command", "shell", "write_stdin", "web_search", "view_image", "request_user_input", "spawn_agent"]) assert(!tools.includes(native), `codex built-in ${native} reached the model: ${tools.join(",")}`)
    assert.equal(seen[0].instructions, system)
  }
  pass("text turn")

  const second = await send([{ role: "user", content: firstPrompt }, { role: "assistant", content: first.body.content }, { role: "user", content: live ? "Reply with exactly AGAIN." : "again" }])
  assert.equal(second.continuation, "reused")
  if (!live) {
    assert.equal(seen[1].prompt_cache_key, seen[0].prompt_cache_key, "reused turn must keep the prompt cache key")
    assert.equal(seen[1].input.filter(item => item.type === "message" && item.role === "user").length, 2)
  }
  pass("exact continuation reuses the thread")

  const secret = `VALUE-${randomUUID().slice(0, 8)}`
  const toolPrompt = live ? "Call the lookup tool with key alpha. After its result arrives, reply with exactly the returned value and nothing else." : "[tool] look up alpha"
  const call = await send([{ role: "user", content: toolPrompt }])
  assert.equal(call.body.stop_reason, "tool_use", JSON.stringify(call.body))
  const use = call.body.content.find(block => block.type === "tool_use")
  assert.equal(use.name, "lookup")
  const toolHistory = [{ role: "user", content: toolPrompt }, { role: "assistant", content: call.body.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: secret }] }]
  const result = await send(toolHistory)
  assert.equal(result.continuation, "tool-result")
  assert.match(result.text, new RegExp(secret))
  if (!live) assert(seen.at(-1).input.some(item => item.type === "function_call_output" && item.call_id === use.id), "tool result must reach the model under the client's call id")
  pass("client tool result routed to the blocked turn")

  if (!live) {
    // Codex dispatches a parallel batch one call at a time; each reaches the client in order.
    const prompt = "[tools2] look up both"
    const history = [{ role: "user", content: prompt }]
    const values = []
    for (const key of ["alpha", "beta"]) {
      const step = await send(history)
      const call = step.body.content.find(block => block.type === "tool_use")
      assert.equal(step.body.stop_reason, "tool_use", JSON.stringify(step.body))
      assert.deepEqual(call.input, { key })
      values.push(`V-${key}`)
      history.push({ role: "assistant", content: step.body.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `V-${key}` }] })
    }
    const both = await send(history)
    assert.equal(both.continuation, "tool-result")
    assert.equal(both.text, `Both: ${values.join(",")}`)
    pass("parallel tool batch delivered sequentially")
  }

  const before = seen.length
  const undone = await send([{ role: "user", content: firstPrompt }, { role: "assistant", content: first.body.content }, { role: "user", content: live ? "Reply with exactly REBUILT." : "after undo" }])
  assert.equal(undone.continuation, "rebuilt")
  if (live) assert.match(undone.text, /REBUILT/)
  else {
    const request = seen[before]
    const texts = request.input.flatMap(item => item.content ?? []).map(part => part.text)
    assert(texts.includes("hello") && texts.includes("after undo") && !texts.includes("again"), JSON.stringify(texts))
  }
  pass("undo rebuilds the thread from client history")

  const streamed = await send([{ role: "user", content: live ? "Reply with exactly STREAM." : "stream" }], { stream: true })
  assert.equal(streamed.status, 200)
  assert.match(streamed.sse, /event: message_start/)
  assert.match(streamed.sse, /text_delta/)
  assert.match(streamed.sse, /event: message_stop/)
  pass("streaming")

  report.health = healthBody
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? error.stack : String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  if (!live) report.requests = seen.map(request => ({ prompt_cache_key: request.prompt_cache_key, tools: request.tools.map(tool => tool.name ?? tool.type), input: request.input.map(item => item.type + (item.role ? `:${item.role}` : "")) }))
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(root, "report.json")}`)
  await proxy.close()
  stand?.close()
}
