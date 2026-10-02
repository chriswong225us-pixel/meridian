#!/usr/bin/env node
// Deterministic `codex app-server` protocol fixture. Never contacts a model service.
// Behaviour is keyed on markers in the latest user text:
//   [tool]  call the first dynamic tool once, then answer with its output
//   [slow]  stream one delta and wait to be interrupted
//   [fail]  fail the turn with a usage-limit error
//   [crash] exit the process mid-turn
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args[0] !== 'app-server') { process.stderr.write('fixture expects app-server\n'); process.exit(2) }

const threads = new Map()
const unsubscribed = []
const interrupted = []
let ids = 0
let rpc = 0
const waiting = new Map()
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const notify = (method, params) => send({ method, params })
const ask = (method, params) => new Promise(resolve => { const id = `srv_${++rpc}`; waiting.set(id, resolve); send({ id, method, params }) })

function lastUserText(thread) {
  for (let index = thread.items.length - 1; index >= 0; index--) {
    const item = thread.items[index]
    if (item.type === 'message' && item.role === 'user') return item.content.filter(part => part.type === 'input_text').map(part => part.text).join('\n')
  }
  return ''
}
function usage(threadId, turnId) {
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { totalTokens: 130, inputTokens: 120, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: 400000 } })
}
function finish(thread, turn, status, error) {
  if (thread.turn !== turn) return
  thread.turn = undefined
  notify('turn/completed', { threadId: thread.id, turn: { id: turn.id, items: [], status, error: error ? { message: error } : null } })
}
function say(thread, turn, text) {
  const itemId = `msg_${++ids}`
  const half = Math.ceil(text.length / 2)
  notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId, delta: text.slice(0, half) })
  notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId, delta: text.slice(half) })
  thread.items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
}
async function run(thread, turn) {
  const text = lastUserText(thread)
  const last = thread.items.at(-1)
  if (text.includes('[crash]')) process.exit(1)
  if (text.includes('[fail]')) return finish(thread, turn, 'failed', 'You have hit your usage limit. Try again later.')
  if (text.includes('[slow]')) { say(thread, turn, 'Working'); return }
  if (last && last.type === 'function_call_output') {
    const output = typeof last.output === 'string' ? last.output : last.output.map(part => part.text || part.image_url).join('|')
    say(thread, turn, `Result: ${output}`)
    usage(thread.id, turn.id)
    return finish(thread, turn, 'completed')
  }
  if (text.includes('[tool]') && thread.tools.length) {
    say(thread, turn, 'Checking.')
    const callId = `call_${++ids}`
    const tool = thread.tools[0].name
    thread.items.push({ type: 'function_call', call_id: callId, name: tool, arguments: '{"key":"k"}' })
    const response = await ask('item/tool/call', { threadId: thread.id, turnId: turn.id, callId, namespace: null, tool, arguments: { key: 'k' } })
    if (thread.turn !== turn) return
    const output = response.error ? `error: ${response.error.message}` : response.result.contentItems.map(item => item.text || item.imageUrl).join('|')
    thread.items.push({ type: 'function_call_output', call_id: callId, output, success: response.result ? response.result.success : false })
    usage(thread.id, turn.id)
    return run(thread, turn)
  }
  say(thread, turn, `Echo: ${text}`)
  usage(thread.id, turn.id)
  finish(thread, turn, 'completed')
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === undefined) { const resolve = waiting.get(message.id); waiting.delete(message.id); if (resolve) resolve(message); return }
  if (message.id === undefined) return
  const params = message.params || {}
  const reply = result => send({ id: message.id, result })
  const fail = text => send({ id: message.id, error: { code: -32000, message: text } })
  switch (message.method) {
    case 'initialize': return reply({ userAgent: 'fixture', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' })
    case 'account/read': return reply({ account: process.env.CODEX_FIXTURE_SIGNED_OUT ? null : { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: null })
    case 'model/list': return reply({ data: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }, { id: 'internal', displayName: 'Hidden', hidden: true }], nextCursor: null })
    case 'thread/start': {
      const id = `thr_${++ids}`
      threads.set(id, { id, items: [], tools: params.dynamicTools || [], base: params.baseInstructions, developer: params.developerInstructions, model: params.model, models: [], cwd: params.cwd })
      return reply({ thread: { id }, model: params.model || 'gpt-5.5' })
    }
    case 'thread/inject_items': {
      const thread = threads.get(params.threadId)
      if (!thread) return fail('unknown thread')
      thread.injected = params.items
      thread.items.push(...params.items)
      return reply({})
    }
    case 'turn/start': {
      const thread = threads.get(params.threadId)
      if (!thread) return fail('unknown thread')
      if (thread.turn) return fail('turn already active')
      const turn = { id: `turn_${++ids}` }
      thread.turn = turn
      thread.models.push(params.model || null)
      thread.efforts = [...(thread.efforts || []), params.effort || null]
      const content = (params.input || []).map(input => input.type === 'text' ? { type: 'input_text', text: input.text } : { type: 'input_image', image_url: input.url })
      if (content.length) thread.items.push({ type: 'message', role: 'user', content })
      reply({ turn: { id: turn.id, items: [], status: 'inProgress', error: null } })
      notify('turn/started', { threadId: thread.id, turn: { id: turn.id } })
      setTimeout(() => { void run(thread, turn) }, 5)
      return
    }
    case 'turn/interrupt': {
      const thread = threads.get(params.threadId)
      interrupted.push(params.threadId)
      if (thread && thread.turn && thread.turn.id === params.turnId) finish(thread, thread.turn, 'interrupted')
      return reply({})
    }
    case 'thread/unsubscribe': unsubscribed.push(params.threadId); return reply({ status: 'unsubscribed' })
    case 'fixture/state': return reply({ threads: Object.fromEntries([...threads].map(([id, thread]) => [id, { ...thread, turn: thread.turn ? thread.turn.id : null }])), unsubscribed, interrupted })
    default: return fail(`unsupported ${message.method}`)
  }
})
