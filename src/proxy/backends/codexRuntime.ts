import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawnCodexAppServer, type CodexTransport, type RpcId } from "./codexAppServer"
import {
  CodexError, blocks, classifyCodexFailure, codexEffort, codexModel, contractKey, dynamicTools, messageKey, responseItems, systemText, toolCallResponse, userInputs,
  type CodexBlock, type CodexMessage, type CodexRequest, type CodexToolResult,
} from "./codexProtocol"

export interface CodexOptions {
  /** Official Codex CLI executable. Defaults to `codex` on PATH. */
  executable?: string
  /** Model used for Claude model names (for example Claude Code background calls). */
  defaultModel?: string
  /** Extra `-c key=value` overrides passed to `codex app-server`. */
  extraConfig?: string[]
  /** Live threads retained for exact continuation. */
  maxConversations?: number
  /** How long a delivered tool call may wait for its client result. */
  pendingToolTimeoutMs?: number
  /** Maximum silence from Codex while a response is streaming. */
  idleTimeoutMs?: number
}

/** How a request was attached to Codex state; exposed for diagnostics and tests. */
export type CodexContinuation = "new" | "reused" | "tool-result" | "rebuilt"

export interface CodexUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
export type CodexEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "usage"; usage: CodexUsage }
  | { kind: "done" }
  | { kind: "error"; error: CodexError }

/** Single-consumer queue for one HTTP response. */
class EventQueue {
  private readonly items: CodexEvent[] = []
  private waiter?: (event: CodexEvent) => void
  push(event: CodexEvent): void {
    const waiter = this.waiter
    if (waiter) { this.waiter = undefined; waiter(event) } else this.items.push(event)
  }
  next(): Promise<CodexEvent> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    return new Promise(resolve => { this.waiter = resolve })
  }
}

/** One HTTP response's share of a Codex turn. */
export class CodexSegment {
  readonly queue = new EventQueue()
  readonly content: CodexBlock[] = []
  finished = false
  private lastItem?: string
  private idleTimer?: NodeJS.Timeout
  constructor(readonly requestKeys: string[], private readonly idleTimeoutMs: number, private readonly onIdle: () => void) { this.touch() }
  /** Any Codex activity on the thread (reasoning, tool items) proves the turn is alive. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.finished || this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(this.onIdle, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }
  text(itemId: string, delta: string): void {
    if (this.finished || !delta) return
    const tail = this.content.at(-1)
    // Separate agent messages within one response the way Claude separates paragraphs.
    const text = tail?.type === "text" && this.lastItem !== undefined && this.lastItem !== itemId ? "\n\n" + delta : delta
    this.lastItem = itemId
    if (tail?.type === "text") tail.text += text
    else this.content.push({ type: "text", text })
    this.queue.push({ kind: "text", text })
    this.touch()
  }
  usage(usage: CodexUsage): void { if (!this.finished) { this.queue.push({ kind: "usage", usage }); this.touch() } }
  tool(id: string, name: string, input: unknown): void {
    if (this.finished) return
    this.content.push({ type: "tool_use", id, name, input })
    this.queue.push({ kind: "tool", id, name, input })
    this.finish()
  }
  done(): void { if (!this.finished) { this.queue.push({ kind: "done" }); this.finish() } }
  fail(error: CodexError): void { if (!this.finished) { this.queue.push({ kind: "error", error }); this.finish() } }
  private finish(): void { this.finished = true; if (this.idleTimer) clearTimeout(this.idleTimer) }
  /** Lineage key of the assistant message this response produced. */
  assistantKey(): string { return messageKey({ role: "assistant", content: this.content }) }
}

type ConversationState = "starting" | "running" | "awaiting" | "idle"
export class CodexConversation {
  readonly id = randomUUID()
  state: ConversationState = "starting"
  /** Client message keys Codex has seen, including its own last answer. */
  keys: string[] = []
  segment?: CodexSegment
  pendingCall?: { rpcId: RpcId; callId: string }
  turnId?: string
  carriedUsage?: CodexUsage
  turnError?: string
  lastUsed = Date.now()
  private toolTimer?: NodeJS.Timeout
  constructor(readonly threadId: string, readonly contract: string) {}
  active(): boolean { return this.state !== "idle" }
  armToolTimer(ms: number, expire: () => void): void { this.clearToolTimer(); if (ms > 0) { this.toolTimer = setTimeout(expire, ms); this.toolTimer.unref?.() } }
  clearToolTimer(): void { if (this.toolTimer) clearTimeout(this.toolTimer); this.toolTimer = undefined }
}

export interface CodexTurn { conversation: CodexConversation; segment: CodexSegment; continuation: CodexContinuation; model?: string }

export interface CodexRecord { requestId: string; timestamp: number; durationMs: number; model: string; continuation: CodexContinuation; status: number; error?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number }

const zeroUsage = (): CodexUsage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index])
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Maps client conversations onto Codex threads.
 *
 * Exact continuations reuse the live thread, so Codex keeps one prompt-cache
 * key per conversation. A client tool result is routed by call ID to the turn
 * that is blocked on it. Anything else (undo, compaction, edited history, a
 * subagent, a restarted server) starts a fresh thread seeded with the client's
 * own history, so lineage can never drift from what the client believes.
 */
export class CodexRuntime {
  readonly options: Required<Pick<CodexOptions, "maxConversations" | "pendingToolTimeoutMs" | "idleTimeoutMs">> & CodexOptions
  readonly conversations = new Map<string, CodexConversation>()
  private readonly byThread = new Map<string, CodexConversation>()
  private readonly byCall = new Map<string, CodexConversation>()
  private connecting?: Promise<CodexTransport>
  private transport?: CodexTransport
  private readonly workspace: string
  draining = false
  readonly requests: CodexRecord[] = []
  readonly totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  readonly continuations: Record<CodexContinuation, number> = { new: 0, reused: 0, "tool-result": 0, rebuilt: 0 }
  nativeActions = 0
  lastError?: string

  constructor(options: CodexOptions = {}, private readonly connect: () => Promise<CodexTransport> = () => spawnCodexAppServer({ executable: options.executable, extraConfig: options.extraConfig })) {
    const defined = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && !(typeof value === "number" && !Number.isFinite(value)))) as CodexOptions
    this.options = { maxConversations: 64, pendingToolTimeoutMs: 15 * 60_000, idleTimeoutMs: 10 * 60_000, ...defined }
    // Tools execute in the client; Codex only needs an empty, private working root.
    this.workspace = mkdtempSync(join(tmpdir(), "meridian-codex-"))
  }

  async connection(): Promise<CodexTransport> {
    if (this.transport) return this.transport
    this.connecting ??= this.connect().then(transport => {
      this.transport = transport
      transport.onNotification((method, params) => this.notification(method, params))
      transport.onServerRequest((id, method, params) => this.serverRequest(transport, id, method, params))
      void transport.closed.then(reason => this.lost(transport, reason))
      return transport
    }).finally(() => { this.connecting = undefined })
    return this.connecting
  }

  /** The app-server died: every live thread is gone, but client history is not. */
  private lost(transport: CodexTransport, reason: string): void {
    if (this.transport !== transport) return
    this.transport = undefined
    this.lastError = reason
    for (const conversation of this.conversations.values()) conversation.segment?.fail(new CodexError(reason, 502, "api_error"))
    this.conversations.clear(); this.byThread.clear(); this.byCall.clear()
  }

  private notification(method: string, params: Record<string, unknown>): void {
    const conversation = typeof params.threadId === "string" ? this.byThread.get(params.threadId) : undefined
    if (!conversation) return
    conversation.segment?.touch()
    if (method === "item/agentMessage/delta") {
      conversation.segment?.text(String(params.itemId ?? ""), typeof params.delta === "string" ? params.delta : "")
    } else if (method === "thread/tokenUsage/updated") {
      const last = record(record(params.tokenUsage).last)
      const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0
      const cached = number(last.cachedInputTokens)
      const usage: CodexUsage = { input_tokens: Math.max(0, number(last.inputTokens) - cached), output_tokens: number(last.outputTokens), cache_read_input_tokens: cached, cache_creation_input_tokens: number(last.cacheWriteInputTokens) }
      // Usage for the sampling that produced a tool call arrives after its result.
      if (conversation.segment && !conversation.segment.finished) conversation.segment.usage(usage)
      else conversation.carriedUsage = addUsage(conversation.carriedUsage ?? zeroUsage(), usage)
    } else if (method === "error") {
      if (params.willRetry !== true) conversation.turnError = String(record(params.error).message ?? "Codex turn failed")
    } else if (method === "item/started") {
      const type = record(params.item).type
      if (type === "commandExecution" || type === "fileChange" || type === "mcpToolCall" || type === "webSearch") this.nativeActions++
    } else if (method === "turn/started") {
      const id = record(params.turn).id
      if (typeof id === "string") conversation.turnId = id
    } else if (method === "turn/completed") {
      const turn = record(params.turn)
      const status = turn.status
      conversation.state = "idle"
      conversation.turnId = undefined
      conversation.lastUsed = Date.now()
      const segment = conversation.segment
      if (status === "completed") {
        if (segment) { conversation.keys = [...segment.requestKeys, segment.assistantKey()]; segment.done() }
      } else {
        const message = String(record(turn.error).message ?? conversation.turnError ?? `Codex turn ${String(status)}`)
        segment?.fail(status === "interrupted" ? new CodexError("Codex turn was interrupted", 499, "api_error") : classifyCodexFailure(message))
        this.discard(conversation, false)
      }
      conversation.turnError = undefined
    }
  }

  private serverRequest(transport: CodexTransport, id: RpcId, method: string, params: Record<string, unknown>): void {
    if (method === "item/tool/call") {
      const conversation = typeof params.threadId === "string" ? this.byThread.get(params.threadId) : undefined
      const segment = conversation?.segment
      const callId = typeof params.callId === "string" ? params.callId : ""
      if (!conversation || !segment || segment.finished || !callId || typeof params.tool !== "string") {
        transport.respondError(id, "No client is attached to receive this tool call")
        return
      }
      conversation.pendingCall = { rpcId: id, callId }
      conversation.state = "awaiting"
      this.byCall.set(callId, conversation)
      conversation.keys = [...segment.requestKeys]
      const name = typeof params.namespace === "string" && params.namespace ? `${params.namespace}__${params.tool}` : params.tool
      segment.tool(callId, name, params.arguments ?? {})
      conversation.keys.push(segment.assistantKey())
      conversation.armToolTimer(this.options.pendingToolTimeoutMs, () => this.discard(conversation, true))
      return
    }
    // Codex built-ins are disabled; refuse anything that would act outside the client.
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") { transport.respond(id, { decision: "decline" }); return }
    if (method === "applyPatchApproval" || method === "execCommandApproval") { transport.respond(id, { decision: { denied: { rejection: "Use the client's tools; Codex built-in actions are disabled by Meridian." } } }); return }
    if (method === "mcpServer/elicitation/request") { transport.respond(id, { action: "decline", content: null, _meta: null }); return }
    transport.respondError(id, `Meridian does not handle ${method}`, -32601)
  }

  /** Forget a conversation; interrupt Codex when it is mid-turn. */
  discard(conversation: CodexConversation, interrupt: boolean): void {
    if (this.conversations.get(conversation.id) !== conversation) return
    this.conversations.delete(conversation.id)
    this.byThread.delete(conversation.threadId)
    for (const [call, owner] of this.byCall) if (owner === conversation) this.byCall.delete(call)
    conversation.clearToolTimer()
    const transport = this.transport
    if (!transport) return
    const busy = conversation.state === "running" || conversation.state === "awaiting"
    if (conversation.pendingCall) transport.respondError(conversation.pendingCall.rpcId, "Client abandoned this tool call")
    conversation.pendingCall = undefined
    void (async () => {
      if (interrupt && busy && conversation.turnId) await transport.request("turn/interrupt", { threadId: conversation.threadId, turnId: conversation.turnId }, 10_000).catch(() => undefined)
      await transport.request("thread/unsubscribe", { threadId: conversation.threadId }, 10_000).catch(() => undefined)
    })()
  }

  private evict(): void {
    while (this.conversations.size >= this.options.maxConversations) {
      const candidates = [...this.conversations.values()].filter(conversation => conversation.state === "idle" || conversation.state === "awaiting")
      const oldest = candidates.sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!oldest) return
      this.discard(oldest, true)
    }
  }

  /** Attach one Messages request to Codex and return its event stream. */
  async start(request: CodexRequest): Promise<CodexTurn> {
    if (this.draining) throw new CodexError("Codex backend is shutting down", 503, "api_error")
    const transport = await this.connection()
    const keys = request.messages.map(messageKey)
    const contract = contractKey(request)
    const last = request.messages.at(-1)!
    const lastBlocks = blocks(last)
    const results = lastBlocks.filter((block): block is CodexToolResult => block.type === "tool_result")
    const model = codexModel(request.model, this.options)
    const effort = codexEffort(request)

    if (results.length) {
      const owner = this.byCall.get(results[0]!.tool_use_id)
      if (owner && owner.state === "awaiting" && owner.pendingCall && results.length === 1 && owner.pendingCall.callId === results[0]!.tool_use_id && owner.contract === contract && same(owner.keys, keys.slice(0, -1))) {
        const segment = this.segment(owner, keys)
        const pending = owner.pendingCall
        owner.pendingCall = undefined
        owner.state = "running"
        owner.clearToolTimer()
        this.byCall.delete(pending.callId)
        this.flushCarried(owner)
        this.continuations["tool-result"]++
        const extra = lastBlocks.filter(block => block.type === "text").map(block => block.text).filter(Boolean)
        transport.respond(pending.rpcId, toolCallResponse(results[0]!, extra))
        return { conversation: owner, segment, continuation: "tool-result", model }
      }
      // The client moved on (edited, undone or replayed history): retire stale owners.
      for (const result of results) { const stale = this.byCall.get(result.tool_use_id); if (stale) this.discard(stale, true) }
    } else {
      const match = [...this.conversations.values()]
        .filter(conversation => conversation.state === "idle" && conversation.contract === contract && same(conversation.keys, keys.slice(0, -1)))
        .sort((a, b) => b.lastUsed - a.lastUsed)[0]
      if (match) {
        const segment = this.segment(match, keys)
        match.state = "running"
        this.flushCarried(match)
        try {
          const response = await transport.request<{ turn?: { id?: string } }>("turn/start", { threadId: match.threadId, input: userInputs(last), ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
          if (match.active()) match.turnId ??= response?.turn?.id
        } catch (error) {
          this.discard(match, false)
          throw classifyCodexFailure(error instanceof Error ? error.message : String(error))
        }
        this.continuations.reused++
        return { conversation: match, segment, continuation: "reused", model }
      }
    }
    return this.rebuild(transport, request, keys, contract, model, effort, results.length > 0)
  }

  private segment(conversation: CodexConversation, keys: string[]): CodexSegment {
    conversation.lastUsed = Date.now()
    const segment = new CodexSegment(keys, this.options.idleTimeoutMs, () => {
      segment.fail(new CodexError(`Codex produced no output for ${Math.round(this.options.idleTimeoutMs / 1000)}s`, 504, "api_error"))
      this.discard(conversation, true)
    })
    conversation.segment = segment
    return segment
  }
  private flushCarried(conversation: CodexConversation): void {
    if (conversation.carriedUsage && conversation.segment) conversation.segment.usage(conversation.carriedUsage)
    conversation.carriedUsage = undefined
  }

  /** Fresh thread seeded with the client's history; the client stays the source of truth. */
  private async rebuild(transport: CodexTransport, request: CodexRequest, keys: string[], contract: string, model: string | undefined, effort: string | undefined, continuingTools: boolean): Promise<CodexTurn> {
    this.evict()
    const history: CodexMessage[] = continuingTools ? request.messages : request.messages.slice(0, -1)
    const input = continuingTools ? [] : userInputs(request.messages.at(-1)!)
    const started = await transport.request<{ thread?: { id?: string } }>("thread/start", {
      ...(model ? { model } : {}), cwd: this.workspace, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: systemText(request) || "You are a helpful coding assistant.",
      developerInstructions: "Act only through the provided function tools. Built-in shell, patch and file tools are unavailable in this environment.",
      dynamicTools: dynamicTools(request),
    }).catch(error => { throw classifyCodexFailure(error instanceof Error ? error.message : String(error)) })
    const threadId = started.thread?.id
    if (!threadId) throw new CodexError("Codex app-server did not return a thread", 502, "api_error")
    const conversation = new CodexConversation(threadId, contract)
    this.conversations.set(conversation.id, conversation)
    this.byThread.set(threadId, conversation)
    const segment = this.segment(conversation, keys)
    try {
      const items = responseItems(history)
      if (items.length) await transport.request("thread/inject_items", { threadId, items })
      conversation.state = "running"
      const response = await transport.request<{ turn?: { id?: string } }>("turn/start", { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
      if (conversation.active()) conversation.turnId ??= response?.turn?.id
    } catch (error) {
      this.discard(conversation, false)
      throw classifyCodexFailure(error instanceof Error ? error.message : String(error))
    }
    const continuation: CodexContinuation = request.messages.length === 1 ? "new" : "rebuilt"
    this.continuations[continuation]++
    return { conversation, segment, continuation, model }
  }

  /** The HTTP client went away mid-response; Codex history no longer matches it. */
  abandon(turn: CodexTurn): void {
    if (!turn.segment.finished) { turn.segment.fail(new CodexError("Request cancelled", 499, "api_error")); this.discard(turn.conversation, true) }
  }

  recordRequest(entry: CodexRecord): void {
    this.requests.push(entry)
    if (this.requests.length > 200) this.requests.shift()
    this.totals.requests++
    if (entry.status >= 400) this.totals.errors++
    this.totals.inputTokens += entry.inputTokens
    this.totals.outputTokens += entry.outputTokens
    this.totals.cacheReadTokens += entry.cacheReadTokens
  }

  private modelsCache?: { at: number; models: Array<{ id: string; displayName: string }> }
  async models(): Promise<Array<{ id: string; displayName: string }>> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 5 * 60_000) return this.modelsCache.models
    const transport = await this.connection()
    const models: Array<{ id: string; displayName: string }> = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const response: { data?: unknown[]; nextCursor?: string | null } = await transport.request("model/list", { cursor, limit: 100 })
      for (const value of response.data ?? []) {
        const model = record(value)
        if (model.hidden === true || typeof model.id !== "string") continue
        models.push({ id: model.id, displayName: typeof model.displayName === "string" ? model.displayName : model.id })
      }
      cursor = response.nextCursor ?? null
      if (!cursor) break
    }
    this.modelsCache = { at: Date.now(), models }
    return models
  }

  async account(): Promise<{ signedIn: boolean; type?: string; plan?: string }> {
    const transport = await this.connection()
    const response = record(await transport.request("account/read", {}))
    const account = record(response.account)
    const type = typeof account.type === "string" ? account.type : undefined
    return { signedIn: type !== undefined || response.requiresOpenaiAuth === false, type, plan: typeof account.planType === "string" ? account.planType : undefined }
  }

  async close(): Promise<void> {
    this.draining = true
    for (const conversation of [...this.conversations.values()]) conversation.segment?.fail(new CodexError("Codex backend is shutting down", 503, "api_error"))
    const transport = this.transport ?? await this.connecting?.catch(() => undefined)
    this.transport = undefined
    this.conversations.clear(); this.byThread.clear(); this.byCall.clear()
    await transport?.close()
    rmSync(this.workspace, { recursive: true, force: true })
  }
}

export function addUsage(a: CodexUsage, b: CodexUsage): CodexUsage {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens, cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens, cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens }
}
