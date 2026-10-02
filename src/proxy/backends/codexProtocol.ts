import { createHash } from "node:crypto"
import { z } from "zod"

/**
 * Pure translation between Anthropic Messages requests and the official Codex
 * app-server protocol. The client's message history is the source of truth for
 * conversation lineage: every key here is derived from what the client sent,
 * so undo, compaction and subagent forks never depend on server-side guesses.
 */
export class CodexError extends Error {
  constructor(message: string, readonly status = 400, readonly type = "invalid_request_error", readonly retryAfter = status === 429 ? 60 : status === 503 ? 5 : undefined) { super(message) }
}

/** Keep account and capacity failures actionable for clients that retry on status. */
export function classifyCodexFailure(message: string): CodexError {
  if (/usage.?limit|rate.?limit|quota|too many requests|\b429\b/i.test(message)) return new CodexError(message, 429, "rate_limit_error")
  if (/not logged in|unauthori[sz]ed|authentication|sign.?in|login|token (?:expired|revoked)|\b401\b/i.test(message)) return new CodexError(message, 401, "authentication_error")
  if (/overloaded|service unavailable|server_is_overloaded|\b503\b|\b529\b/i.test(message)) return new CodexError(message, 503, "overloaded_error")
  if (/context.?(?:window|length)|too long|maximum context/i.test(message)) return new CodexError(message, 400, "invalid_request_error")
  return new CodexError(message, 502, "api_error")
}

const cacheControl = z.unknown().optional()
const textBlock = z.object({ type: z.literal("text"), text: z.string(), cache_control: cacheControl }).passthrough()
const imageSource = z.union([
  z.object({ type: z.literal("base64"), media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]), data: z.string().min(4) }).passthrough(),
  z.object({ type: z.literal("url"), url: z.string().url() }).passthrough(),
])
const imageBlock = z.object({ type: z.literal("image"), source: imageSource, cache_control: cacheControl }).passthrough()
const documentBlock = z.object({ type: z.literal("document"), title: z.string().nullish(), source: z.object({ type: z.literal("text"), data: z.string() }).passthrough(), cache_control: cacheControl }).passthrough()
const thinkingBlock = z.object({ type: z.enum(["thinking", "redacted_thinking"]) }).passthrough()
const callBlock = z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.unknown(), cache_control: cacheControl }).passthrough()
const resultContent = z.discriminatedUnion("type", [textBlock, imageBlock, documentBlock])
const resultBlock = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(resultContent)]).optional(), is_error: z.boolean().optional(), cache_control: cacheControl,
}).passthrough()
const block = z.discriminatedUnion("type", [textBlock, imageBlock, documentBlock, thinkingBlock, callBlock, resultBlock])
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(block)]) }).passthrough()
const schema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()).optional(), type: z.string().optional() }).passthrough()).max(512).default([]),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  tool_choice: z.object({ type: z.enum(["auto", "any", "tool", "none"]), name: z.string().optional() }).passthrough().optional(),
  output_config: z.object({ effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional() }).passthrough().optional(),
}).passthrough()

export type CodexRequest = z.infer<typeof schema>
export type CodexMessage = z.infer<typeof message>
export type CodexBlock = z.infer<typeof block>
export type CodexToolResult = z.infer<typeof resultBlock>
type ResultContent = z.infer<typeof resultContent>

export interface CodexOptionsView {
  /** Model used when a client sends a Claude model name to the Codex backend. */
  defaultModel?: string
}

/** OpenAI model names (or an explicit `codex/` prefix) select the Codex backend beside Claude. */
export function isCodexModel(model: unknown): boolean {
  return typeof model === "string" && (model.startsWith("codex/") || /^(gpt-|o[1-9](?:-|$)|codex-)/i.test(model))
}

/** Resolve the effective Codex model. Claude names map to the configured default. */
export function codexModel(requested: string, options: CodexOptionsView = {}): string | undefined {
  const model = requested.startsWith("codex/") ? requested.slice("codex/".length) : requested
  if (/^claude-/i.test(model) || /^(opus|sonnet|haiku|default)(\[1m\])?$/i.test(model)) return options.defaultModel
  return model
}

/** Codex reasoning effort names; Anthropic `max` has no larger Codex tier. */
export function codexEffort(request: CodexRequest): string | undefined {
  const effort = request.output_config?.effort
  return effort === "max" ? "xhigh" : effort
}

export function parseCodexRequest(value: unknown, counting = false): CodexRequest {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new CodexError("Invalid or unsupported request for the Codex backend: " + parsed.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join("; "))
  const request = parsed.data
  const last = request.messages.at(-1)!
  if (last.role !== "user" && !counting) throw new CodexError("The final message must have role user; assistant prefill is unavailable on the Codex backend")
  return request
}

export function blocks(message: CodexMessage): CodexBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
}

export function systemText(request: CodexRequest): string {
  if (request.system === undefined) return ""
  return typeof request.system === "string" ? request.system : request.system.map(block => block.text).join("\n\n")
}

/** JSON with sorted keys, so key order never changes lineage identity. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]"
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => JSON.stringify(key) + ":" + stableJson((value as Record<string, unknown>)[key])).join(",") + "}"
  }
  return JSON.stringify(value) ?? "null"
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function imageUrl(source: z.infer<typeof imageSource>): string {
  return source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url
}
function documentText(block: z.infer<typeof documentBlock>): string {
  return block.title ? `${block.title}\n\n${block.source.data}` : block.source.data
}

/**
 * Canonical form of one message for lineage comparison. Cache markers,
 * thinking blocks and whitespace-only differences are not conversation content.
 */
export function normalizeMessage(message: CodexMessage): unknown {
  const parts: unknown[] = []
  for (const part of blocks(message)) {
    if (part.type === "thinking" || part.type === "redacted_thinking") continue
    if (part.type === "text" || part.type === "document") {
      const text = (part.type === "text" ? part.text : documentText(part)).trim()
      if (!text) continue
      const previous = parts.at(-1) as { t?: string } | undefined
      if (previous?.t !== undefined) previous.t += "\n" + text
      else parts.push({ t: text })
    } else if (part.type === "image") parts.push({ i: imageUrl(part.source) })
    else if (part.type === "tool_use") parts.push({ c: part.id, n: part.name, a: part.input ?? {} })
    else if (part.type === "tool_result") parts.push({ r: part.tool_use_id, e: part.is_error === true, o: resultParts(part).map(item => item.type === "inputText" ? item.text.trim() : item.imageUrl) })
  }
  return { role: message.role, parts }
}

export function messageKey(message: CodexMessage): string { return hash(stableJson(normalizeMessage(message))) }

/** Thread-level contract: a changed system prompt or tool catalog needs a new thread. */
export function contractKey(request: CodexRequest): string {
  return hash(stableJson({ system: systemText(request).trim(), tools: dynamicTools(request) }))
}

export interface DynamicToolSpec { type: "function"; name: string; description: string; inputSchema: unknown }
/** Client-executed function tools. Anthropic server tools have no client schema. */
export function dynamicTools(request: CodexRequest): DynamicToolSpec[] {
  return request.tools.filter(tool => tool.input_schema !== undefined && (tool.type === undefined || tool.type === "custom")).map(tool => ({
    type: "function", name: tool.name, description: tool.description ?? "", inputSchema: tool.input_schema,
  }))
}

export type DynamicContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
function resultParts(result: CodexToolResult): DynamicContentItem[] {
  if (result.content === undefined) return []
  if (typeof result.content === "string") return result.content ? [{ type: "inputText", text: result.content }] : []
  return result.content.map((part: ResultContent): DynamicContentItem => part.type === "image" ? { type: "inputImage", imageUrl: imageUrl(part.source) } : { type: "inputText", text: part.type === "text" ? part.text : documentText(part) })
}

/** Answer a pending `item/tool/call` request. Extra user text rides with the result. */
export function toolCallResponse(result: CodexToolResult, extraText: string[] = []): { contentItems: DynamicContentItem[]; success: boolean } {
  const contentItems = resultParts(result)
  for (const text of extraText) contentItems.push({ type: "inputText", text })
  if (contentItems.length === 0) contentItems.push({ type: "inputText", text: result.is_error ? "Tool failed without output" : "(no output)" })
  return { contentItems, success: result.is_error !== true }
}

export type UserInput = { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
/** Fresh user input for `turn/start`. */
export function userInputs(message: CodexMessage): UserInput[] {
  const inputs: UserInput[] = []
  for (const part of blocks(message)) {
    if (part.type === "text" || part.type === "document") {
      const text = part.type === "text" ? part.text : documentText(part)
      if (text) inputs.push({ type: "text", text, text_elements: [] })
    } else if (part.type === "image") inputs.push({ type: "image", url: imageUrl(part.source) })
  }
  return inputs
}

type OutputItem = { type: "input_text"; text: string } | { type: "input_image"; image_url: string }
export type ResponseItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<OutputItem | { type: "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | OutputItem[] }

/** Responses items that reproduce client history inside a fresh Codex thread. */
export function responseItems(messages: CodexMessage[]): ResponseItem[] {
  const items: ResponseItem[] = []
  for (const message of messages) {
    if (message.role === "assistant") {
      let text = ""
      const flush = () => { if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }); text = "" }
      for (const part of blocks(message)) {
        if (part.type === "text") text += (text ? "\n" : "") + part.text
        else if (part.type === "tool_use") { flush(); items.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) }) }
      }
      flush()
      continue
    }
    const content: OutputItem[] = []
    for (const part of blocks(message)) {
      if (part.type === "tool_result") {
        const output = resultParts(part).map((item): OutputItem => item.type === "inputText" ? { type: "input_text", text: item.text } : { type: "input_image", image_url: item.imageUrl })
        const prefix = part.is_error ? "[tool error] " : ""
        items.push({ type: "function_call_output", call_id: part.tool_use_id, output: output.every(item => item.type === "input_text") ? prefix + output.map(item => item.text).join("\n") : output })
      } else if (part.type === "text" || part.type === "document") {
        const text = part.type === "text" ? part.text : documentText(part)
        if (text) content.push({ type: "input_text", text })
      } else if (part.type === "image") content.push({ type: "input_image", image_url: imageUrl(part.source) })
    }
    if (content.length) items.push({ type: "message", role: "user", content })
  }
  return items
}

/** Token estimate for count_tokens; Codex exposes no counting endpoint. */
export function estimateTokens(request: CodexRequest): number {
  const text = systemText(request) + stableJson(request.messages.map(normalizeMessage)) + stableJson(dynamicTools(request))
  return Math.max(1, Math.ceil(text.length / 4))
}
