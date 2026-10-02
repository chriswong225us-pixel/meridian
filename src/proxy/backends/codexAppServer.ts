import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { signalAgProcess } from "./antigravityProcess"

/**
 * Newline-delimited JSON-RPC connection to the official `codex app-server`
 * (the protocol the Codex IDE extension uses). Authentication stays inside the
 * signed-in CLI; Meridian never reads or forwards ChatGPT credentials.
 */
export type RpcId = number | string
export interface RpcMessage { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void
export type ServerRequestHandler = (id: RpcId, method: string, params: Record<string, unknown>) => void

export interface CodexTransport {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params?: unknown): void
  respond(id: RpcId, result: unknown): void
  respondError(id: RpcId, message: string, code?: number): void
  onNotification(handler: NotificationHandler): void
  onServerRequest(handler: ServerRequestHandler): void
  /** Resolves with a reason when the connection is gone. */
  readonly closed: Promise<string>
  close(): Promise<void>
}

/**
 * Codex built-ins that would act outside the client. The client (OpenCode,
 * Claude Code, ...) owns every tool so its approvals, undo and session history
 * observe all actions; these overrides leave only the client's function tools.
 */
export const CODEX_CLIENT_TOOL_OVERRIDES: readonly string[] = [
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  "features.goals=false",
  "features.default_mode_request_user_input=false",
  "tools.experimental_request_user_input.enabled=false",
  "features.skill_search=false",
  "features.apps=false",
  "features.plugins=false",
  "features.multi_agent=false",
  "features.image_generation=false",
  "features.memories=false",
  'web_search="disabled"',
  "skills.bundled.enabled=false",
  "include_environment_context=false",
  "include_permissions_instructions=false",
]

const parseObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Wrap any line-based duplex (a child process or a test double) as a transport. */
export class LineRpcTransport implements CodexTransport {
  private nextId = 1
  private readonly pending = new Map<RpcId, { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }>()
  private notificationHandler: NotificationHandler = () => {}
  private requestHandler: ServerRequestHandler = (id) => this.respondError(id, "Unsupported server request", -32601)
  private finished = false
  private resolveClosed!: (reason: string) => void
  readonly closed = new Promise<string>(resolve => { this.resolveClosed = resolve })

  constructor(private readonly write: (line: string) => void, private readonly shutdown: () => Promise<void> = async () => {}) {}

  /** Feed one received line. */
  receive(line: string): void {
    if (!line.trim()) return
    let message: RpcMessage
    try { message = JSON.parse(line) as RpcMessage }
    catch { console.error("[codex] Ignoring malformed app-server line"); return }
    if (message.method !== undefined && message.id !== undefined) { this.requestHandler(message.id, message.method, parseObject(message.params)); return }
    if (message.method !== undefined) { this.notificationHandler(message.method, parseObject(message.params)); return }
    if (message.id === undefined) return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(message.error.message ?? "Codex app-server request failed"))
    else waiter.resolve(message.result)
  }

  /** Mark the connection gone and fail outstanding requests. */
  end(reason: string): void {
    if (this.finished) return
    this.finished = true
    for (const waiter of this.pending.values()) { if (waiter.timer) clearTimeout(waiter.timer); waiter.reject(new Error(reason)) }
    this.pending.clear()
    this.resolveClosed(reason)
  }

  private send(message: RpcMessage): void {
    if (this.finished) throw new Error("Codex app-server connection is closed")
    this.write(JSON.stringify(message) + "\n")
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs) : undefined
      timer?.unref?.()
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      try { this.send({ id, method, params }) }
      catch (error) { this.pending.delete(id); if (timer) clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  notify(method: string, params?: unknown): void { this.send(params === undefined ? { method } : { method, params }) }
  respond(id: RpcId, result: unknown): void { if (!this.finished) this.send({ id, result }) }
  respondError(id: RpcId, message: string, code = -32000): void { if (!this.finished) this.send({ id, error: { code, message } }) }
  onNotification(handler: NotificationHandler): void { this.notificationHandler = handler }
  onServerRequest(handler: ServerRequestHandler): void { this.requestHandler = handler }
  async close(): Promise<void> { this.end("Codex app-server connection closed"); await this.shutdown() }
}

export interface SpawnCodexOptions {
  executable?: string
  /** Additional `-c key=value` overrides appended after Meridian's own. */
  extraConfig?: string[]
  env?: NodeJS.ProcessEnv
  version?: string
}

/** Start `codex app-server` over stdio and complete the initialize handshake. */
export async function spawnCodexAppServer(options: SpawnCodexOptions = {}): Promise<CodexTransport> {
  const executable = options.executable || "codex"
  const args = ["app-server", ...[...CODEX_CLIENT_TOOL_OVERRIDES, ...(options.extraConfig ?? [])].flatMap(value => ["-c", value])]
  // npm installs codex as a .cmd shim on Windows, which Node only starts through a shell.
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
  const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env }, detached: process.platform !== "win32", shell, windowsHide: true,
  })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
  const transport = new LineRpcTransport(line => { child.stdin.write(line) }, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    signalAgProcess(child, "SIGTERM")
    const timer = setTimeout(() => signalAgProcess(child, "SIGKILL"), 3000)
    timer.unref()
    await exited
    clearTimeout(timer)
  })
  child.stdin.on("error", error => transport.end(`Codex app-server stdin failed: ${error.message}`))
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on("line", line => transport.receive(line))
  child.once("error", error => transport.end(`Codex app-server failed to start (${executable}): ${error.message}. Install it with "npm install -g @openai/codex" and sign in with "codex login".`))
  child.once("exit", (code, signal) => {
    const detail = stderr.split("\n").filter(line => line.trim() && !/^WARNING:/.test(line)).slice(-3).join(" | ")
    transport.end(`Codex app-server exited (${signal ?? code})${detail ? ": " + detail : ""}`)
  })
  try {
    await transport.request("initialize", {
      clientInfo: { name: "meridian", title: "Meridian", version: options.version ?? "unknown" },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ["item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"] },
    }, 30_000)
    transport.notify("initialized")
  } catch (error) {
    await transport.close()
    throw error
  }
  return transport
}
