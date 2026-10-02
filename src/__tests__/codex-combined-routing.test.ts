/**
 * ChatGPT beside Claude on one Meridian: OpenAI model names (and `/codex/*`)
 * reach the Codex backend; Claude model names keep the existing SDK path.
 */
import { afterAll, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

let sdkQueries = 0
installSdkMock(() => ({
  query: () => {
    sdkQueries++
    return (async function* () {})()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "codex-combined-routing.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer } = await import("../proxy/server")
const executable = fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url))
const proxy = createProxyServer({ port: 0, host: "127.0.0.1", codex: { enabled: true, executable } })
afterAll(async () => { await proxy.closeBackend?.() })

const post = async (path: string, model: string) => await proxy.app.fetch(new Request(`http://local${path}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
}))

describe("Codex beside Claude", () => {
  it("routes OpenAI model names on the Claude route to Codex", async () => {
    const response = await post("/v1/messages", "gpt-5.5")
    expect(response.status).toBe(200)
    expect(response.headers.get("x-meridian-backend")).toBe("codex")
    const body = await response.json() as { content: Array<{ text: string }> }
    expect(body.content[0]!.text).toBe("Echo: hi")
    expect(sdkQueries).toBe(0)
  })
  it("serves the dedicated /codex prefix", async () => {
    const response = await post("/codex/v1/messages", "gpt-5.5")
    expect(response.headers.get("x-meridian-backend")).toBe("codex")
    const health = await proxy.app.fetch(new Request("http://local/codex/health"))
    expect(((await health.json()) as { backend: string }).backend).toBe("codex")
  })
  it("keeps Claude model names on the Claude SDK path", async () => {
    const response = await post("/v1/messages", "claude-sonnet-5-5")
    expect(response.headers.get("x-meridian-backend")).toBeNull()
    expect(sdkQueries).toBeGreaterThan(0)
  })
  it("lists Codex models beside Claude models", async () => {
    const response = await proxy.app.fetch(new Request("http://local/v1/models"))
    const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map(model => model.id)
    expect(ids).toContain("gpt-5.5")
    expect(ids.some(id => id.startsWith("claude-"))).toBe(true)
  })
})
