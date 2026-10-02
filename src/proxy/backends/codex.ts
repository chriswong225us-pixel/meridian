import { randomUUID } from "node:crypto"
import type { ProxyConfig, ProxyServer } from "../types"
import { buildRuntime } from "../buildRuntime"
import { hasValidApiKey } from "../auth"
import { CodexError, estimateTokens, parseCodexRequest, type CodexBlock } from "./codexProtocol"
import { CodexRuntime, addUsage, type CodexTurn, type CodexUsage } from "./codexRuntime"

function errorResponse(error: unknown): Response {
  const e = error instanceof CodexError ? error : new CodexError(error instanceof Error ? error.message : String(error), 502, "api_error")
  return Response.json({ type: "error", error: { type: e.type, message: e.message } }, { status: e.status, headers: e.retryAfter ? { "retry-after": String(e.retryAfter) } : {} })
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > 32 * 1024 * 1024) throw new CodexError("Request exceeds 32 MiB", 413)
  try { return JSON.parse(text) }
  catch { throw new CodexError("Invalid JSON request body") }
}

/**
 * ChatGPT through the official Codex app-server, speaking Anthropic Messages so
 * Claude Code, OpenCode and other Anthropic clients use it natively. Client
 * tools run in the client; Codex only decides which ones to call.
 */
export function createCodexServer(config: ProxyConfig, runtime = new CodexRuntime({ ...config.codex })): ProxyServer & { closeBackend(): Promise<void>; runtime: CodexRuntime } {
  async function messages(request: Request): Promise<Response> {
    const body = parseCodexRequest(await readBody(request))
    if (request.signal.aborted) throw new CodexError("Request cancelled", 499, "api_error")
    const started = Date.now()
    const turn = await runtime.start(body)
    const effectiveModel = turn.model ?? body.model
    const id = "msg_codex_" + randomUUID().replaceAll("-", "")
    const headers = { "x-meridian-backend": "codex", "x-meridian-codex-continuation": turn.continuation, "x-meridian-effective-model": effectiveModel }
    const cancel = () => runtime.abandon(turn)
    request.signal.addEventListener("abort", cancel, { once: true })

    async function consume(emit?: (event: string, value: unknown) => void) {
      const content: CodexBlock[] = []
      let usage: CodexUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      let textOpen = false
      let status = 200
      let failure: string | undefined
      const base = { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage }
      emit?.("message_start", { type: "message_start", message: base })
      const closeText = () => { if (textOpen) { emit?.("content_block_stop", { type: "content_block_stop", index: content.length - 1 }); textOpen = false } }
      try {
        let reason: "end_turn" | "tool_use" = "end_turn"
        while (true) {
          const event = await turn.segment.queue.next()
          if (event.kind === "error") throw event.error
          if (event.kind === "usage") { usage = addUsage(usage, event.usage); continue }
          if (event.kind === "text") {
            if (!textOpen) {
              content.push({ type: "text", text: "" }); textOpen = true
              emit?.("content_block_start", { type: "content_block_start", index: content.length - 1, content_block: { type: "text", text: "" } })
            }
            const tail = content.at(-1)
            if (tail?.type === "text") tail.text += event.text
            emit?.("content_block_delta", { type: "content_block_delta", index: content.length - 1, delta: { type: "text_delta", text: event.text } })
            continue
          }
          closeText()
          if (event.kind === "tool") {
            content.push({ type: "tool_use", id: event.id, name: event.name, input: event.input })
            const index = content.length - 1
            emit?.("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } })
            emit?.("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input ?? {}) } })
            emit?.("content_block_stop", { type: "content_block_stop", index })
            reason = "tool_use"
          }
          break
        }
        emit?.("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage })
        emit?.("message_stop", { type: "message_stop" })
        return { ...base, content, stop_reason: reason, usage }
      } catch (error) {
        status = error instanceof CodexError ? error.status : 502
        failure = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        request.signal.removeEventListener("abort", cancel)
        runtime.recordRequest({ requestId: id, timestamp: started, durationMs: Date.now() - started, model: effectiveModel, continuation: turn.continuation, status, error: failure, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens })
      }
    }

    if (!body.stream) {
      try { return Response.json(await consume(), { headers }) }
      catch (error) { return errorResponse(error) }
    }
    return streamResponse(turn, consume, headers)
  }

  function streamResponse(turn: CodexTurn, consume: (emit: (event: string, value: unknown) => void) => Promise<unknown>, headers: Record<string, string>): Response {
    const encoder = new TextEncoder()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: string, value: unknown) => {
          if (cancelled) return
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
        }
        const heartbeat = setInterval(() => emit("ping", { type: "ping" }), 10_000)
        heartbeat.unref?.()
        void consume(emit).catch(error => {
          const e = error instanceof CodexError ? error : new CodexError(error instanceof Error ? error.message : String(error), 502, "api_error")
          emit("error", { type: "error", error: { type: e.type, message: e.message } })
        }).finally(() => { clearInterval(heartbeat); if (!cancelled) controller.close() })
      },
      cancel() { cancelled = true; runtime.abandon(turn) },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...headers } })
  }

  const fetch = async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname
      if (!["/health", "/readyz", "/livez"].includes(path) && !hasValidApiKey(request.headers)) throw new CodexError("Invalid or missing API key", 401, "authentication_error")
      if (request.method === "GET" && path === "/livez") return Response.json({ status: "alive" })
      if (request.method === "GET" && (path === "/health" || path === "/readyz")) {
        if (runtime.draining) return Response.json({ status: "draining" }, { status: 503 })
        const account = await runtime.account().catch(error => { throw new CodexError(error instanceof Error ? error.message : String(error), 503, "api_error") })
        if (!account.signedIn) return Response.json({ status: "unhealthy", backend: "codex", error: 'Codex is not signed in. Run "codex login" and choose Sign in with ChatGPT.' }, { status: 503 })
        return Response.json({
          status: "healthy", version: config.version ?? "unknown", build: buildRuntime.info(config.version ?? "unknown"), backend: "codex", mode: "passthrough",
          auth: { provider: "codex-account", type: account.type, plan: account.plan },
          capabilities: { text: true, tools: "client", parallelTools: "sequential", images: true, conversationReuse: "live-thread", lineage: "client-history", toolResultRouting: "call-id", nativeTools: false, tokenCounting: "estimate", openai: false },
          conversations: runtime.conversations.size, continuations: runtime.continuations, nativeActions: runtime.nativeActions, lastError: runtime.lastError,
        })
      }
      if (request.method === "GET" && path === "/build-status") return buildRuntime.local ? Response.json(buildRuntime.status(), { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 })
      if (request.method === "GET" && path === "/v1/models") {
        const models = await runtime.models()
        return Response.json({ object: "list", data: models.map(model => ({ id: model.id, type: "model", object: "model", display_name: model.displayName, owned_by: "openai" })), has_more: false, first_id: models[0]?.id ?? null, last_id: models.at(-1)?.id ?? null })
      }
      if (request.method === "GET" && path === "/telemetry/requests") return Response.json(runtime.requests.map(entry => ({ ...entry, provider: "codex", adapter: "codex" })))
      if (request.method === "GET" && path === "/telemetry/summary") return Response.json({ totalRequests: runtime.totals.requests, errorCount: runtime.totals.errors, tokenUsage: { totalInputTokens: runtime.totals.inputTokens, totalOutputTokens: runtime.totals.outputTokens, totalCacheReadTokens: runtime.totals.cacheReadTokens }, continuations: runtime.continuations })
      if (request.method === "POST" && path === "/v1/messages/count_tokens") return Response.json({ input_tokens: estimateTokens(parseCodexRequest(await readBody(request), true)) }, { headers: { "x-meridian-token-count": "estimate" } })
      if (request.method === "POST" && (path === "/v1/messages" || path === "/messages")) return await messages(request)
      throw new CodexError("Endpoint unavailable on the Codex backend", 404, "not_found_error")
    } catch (error) { return errorResponse(error) }
  }

  return {
    app: { fetch }, config, runtime,
    initPlugins: async () => {},
    beginDrain: () => { runtime.draining = true },
    forceAbortInFlight: () => { for (const conversation of [...runtime.conversations.values()]) runtime.discard(conversation, true) },
    getInFlightCount: () => [...runtime.conversations.values()].filter(conversation => conversation.state === "running").length,
    closeBackend: () => runtime.close(),
  }
}
