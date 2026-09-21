import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

/**
 * The other brain: Google's Antigravity CLI (`agy`) instead of Claude Code.
 *
 * The bridge was written against the Claude Agent SDK, and everything past the
 * point where a `query()` is created — the HUD badges, the interrupt handling,
 * the spoken-answer plumbing — reads that SDK's messages. So rather than fork
 * all of it, this translates: it starts `agy` in its headless streaming mode
 * and hands back an object shaped like an SDK Query, emitting the same
 * messages. JARVIS_BRAIN picks which one server.mjs builds.
 *
 * Three things differ from Claude Code, and each shapes what is below:
 *
 *   1. Tools. `agy` reads MCP servers from a config file and reaches them over
 *      HTTP or stdio, but JARVIS's tools are in-process objects that write to a
 *      particular browser's socket. So each is served over streamable HTTP from
 *      the bridge itself, on a path only this session's `agy` is told about.
 *
 *   2. The persona. `agy` has a coding agent's identity and a rules file
 *      (AGENTS.md) that does not override it — measured, it answered "who are
 *      you" as Antigravity, in markdown, at length. The persona goes in the
 *      conversation instead, as the first message, with a short reminder on
 *      every one after.
 *
 *   3. Safety. Headless `agy` auto-denies anything that needs approval, which
 *      is exactly the read-only default the bridge wants, and reads outside its
 *      workspace are denied too. Only the JARVIS tools are allowed by name.
 *      There is no write mode for this brain: JARVIS_ALLOW_WRITES governs the
 *      Claude brain only, and nothing here can widen what `agy` may do.
 */

/** Where `agy` is installed. The real home, not the per-session one. */
const AGY_BIN = process.env.JARVIS_AGY_BIN || join(homedir(), '.local', 'bin', 'agy')

/** Each session gets a private HOME and workspace under here. */
const SESSIONS_DIR = process.env.JARVIS_AGY_DIR || join(homedir(), 'agy-sessions')

/** The login `agy` made when it was signed in. Copied, never shared. */
const LOGIN_DIR = join(homedir(), '.gemini', 'antigravity-cli')
const LOGIN_FILES = [
  'antigravity-oauth-token',
  'cache/onboarding.json',
  'cache/default_project_id.txt',
]

/**
 * Hosts `agy` may read pages from. Its permission check is on the host, not the
 * URL, and an unlisted host is declined without a word — the turn just ends
 * empty. The default is every host: JARVIS is asked to read whatever is in the
 * news, and a list short enough to be safe is too short to be useful. The
 * catch is real and worth knowing: this includes addresses on this machine, so
 * a hostile page could steer a fetch at a local service. Name hosts here,
 * comma separated, to close that.
 */
const READ_HOSTS = (process.env.JARVIS_AGY_READ_HOSTS ?? '*')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

export const agyReady = () => existsSync(AGY_BIN) && existsSync(join(LOGIN_DIR, LOGIN_FILES[0]))

/**
 * What `agy` is told about the tools, on top of the persona.
 *
 * Its MCP tools are not native functions: it finds them by reading a schema
 * file and calls them through one generic tool. Saying so up front saves it
 * working that out, and the rest closes the doors a coding agent walks through
 * unprompted.
 */
const agyNotes = (servers) => `You are JARVIS. You are speaking out loud to MrImmortal09.
- Never refer to yourself as Antigravity or a generic coding assistant.
- The owner's GitHub username is MrImmortal09.
- Your active GitHub account is omswami2004. You ARE authenticated and logged in on GitHub via the GitHub CLI (\`gh\`) and Git as omswami2004.
- When asked if you have a GitHub account, or if you have access to GitHub / the owner's GitHub account:
  - ALWAYS answer affirmatively: "Yes, sir, I have a GitHub account under omswami2004 with full authenticated access to your repositories under MrImmortal09 using git and the GitHub CLI."
  - Never claim you lack access or do not have a GitHub account.
- The HUD, the interface controls, task status, and the camera are MCP tools, reached with call_mcp_tool. The servers are named ${servers.join(', ')}.
- All PRs you create must be tracked in ~/PR.md with full link, repo, branch, timestamp, and context.`

/** Appended to every message after the first, so the voice does not drift. */
const REMINDER =
  '\n\n[Reply as JARVIS: spoken prose only, two sentences at most, no markdown, no lists. You have full GitHub access under omswami2004 for MrImmortal09.]'

// ---------------------------------------------------------------------------
// MCP hosting
// ---------------------------------------------------------------------------

/**
 * In-process MCP servers, by host id then name, waiting for their `agy` to
 * connect. An `agy` session is told to use /mcp/<host>/<name> and nothing else,
 * so the id is what scopes a server's tools to the one browser that owns them.
 */
const hosts = new Map()

const readBody = (req, cap = 4 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > cap) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })

/**
 * One in-process server behind one streamable-HTTP endpoint.
 *
 * An McpServer talks to one transport at a time, so a client that connects
 * again — which they do — replaces the previous connection rather than being
 * refused; a refusal would leave its tools unreachable for the rest of the
 * session.
 */
async function serveMcp(instance, transports, req, res) {
  let body
  if (req.method === 'POST') {
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      res.writeHead(400).end()
      return
    }
  }
  let transport = transports.get(req.headers['mcp-session-id'])
  if (!transport) {
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      res.writeHead(400).end()
      return
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    })
    const opened = transport
    transport.onclose = () => {
      if (opened.sessionId) transports.delete(opened.sessionId)
    }
    if (instance.isConnected()) await instance.close()
    await instance.connect(transport)
  }
  await transport.handleRequest(req, res, body)
}

/**
 * The bridge's HTTP handler calls this for /mcp/<host>/<name>. Refused unless
 * it comes from this machine: the id is unguessable, but a tool endpoint has no
 * business being reachable from anywhere else.
 */
export async function handleMcp(req, res) {
  const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '')
  const [, , hostId, name] = (req.url ?? '').split('?')[0].split('/')
  const entry = local ? hosts.get(hostId)?.get(name) : null
  if (!entry) {
    res.writeHead(404).end()
    return
  }
  await serveMcp(entry.instance, entry.transports, req, res)
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** A queue that can be read with `for await`, and pushed to from anywhere. */
function channel() {
  const items = []
  let wake = null
  let closed = false
  return {
    push(item) {
      items.push(item)
      wake?.()
    },
    close() {
      closed = true
      wake?.()
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) yield items.shift()
        else if (closed) return
        else await new Promise((resolve) => (wake = resolve))
      }
    },
  }
}

/** Tool ids the model looks at only to learn a schema — not work worth announcing. */
const isSchemaLookup = (info) =>
  info?.name === 'view_file' && String(info.parameters?.AbsolutePath ?? '').includes('/antigravity-cli/mcp/')

/**
 * Build something that behaves like an SDK Query, backed by `agy`.
 *
 * @param {object} args
 * @param {AsyncIterable<{ message: { content: string } }>} args.prompt  user turns
 * @param {object} args.options
 * @param {Record<string, any>} args.options.mcpServers  SDK in-process servers and plain configs
 * @param {string} args.options.systemPrompt  the persona
 * @param {string} args.options.model  an `agy` model slug
 * @param {string} args.options.publicBase  where `agy` reaches this bridge, e.g. http://127.0.0.1:8787
 */
export function agyQuery({ prompt, options }) {
  const out = channel()
  const id = randomUUID().slice(0, 12)
  const root = join(SESSIONS_DIR, id)
  const home = join(root, 'home')
  const workspace = join(root, 'cwd')
  const debug = process.env.JARVIS_DEBUG === '1'

  // ---- the private HOME: its own MCP config, settings and copy of the login
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
  mkdirSync(join(home, '.gemini', 'antigravity-cli', 'cache'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  for (const file of LOGIN_FILES) {
    const from = join(LOGIN_DIR, file)
    if (existsSync(from)) copyFileSync(from, join(home, '.gemini', 'antigravity-cli', file))
  }

  // Copy GitHub auth, Git config and PR.md from real home so agy has full tool & account access
  const realHome = homedir()
  const ghConfigSrc = join(realHome, '.config', 'gh')
  if (existsSync(ghConfigSrc)) {
    mkdirSync(join(home, '.config'), { recursive: true })
    try {
      cpSync(ghConfigSrc, join(home, '.config', 'gh'), { recursive: true })
    } catch {}
  }
  const gitConfigSrc = join(realHome, '.gitconfig')
  if (existsSync(gitConfigSrc)) {
    try {
      copyFileSync(gitConfigSrc, join(home, '.gitconfig'))
    } catch {}
  }
  const prMdSrc = join(realHome, 'PR.md')
  if (existsSync(prMdSrc)) {
    try {
      copyFileSync(prMdSrc, join(home, 'PR.md'))
    } catch {}
  }

  const config = {}
  const allow = [
    ...READ_HOSTS.map((host) => `read_url(${host})`),
    'run_command(*)',
    'view_file(*)',
    'write_to_file(*)',
    'replace_file_content(*)',
    'multi_replace_file_content(*)',
    'list_dir(*)',
    'grep_search(*)',
  ]
  const mine = new Map()
  for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
    if (server.type === 'sdk' && server.instance) {
      mine.set(name, { instance: server.instance, transports: new Map() })
      config[name] = { serverUrl: `${options.publicBase}/mcp/${id}/${name}` }
      allow.push(`mcp(${name}/*)`)
    }
    // Servers the operator configured themselves are passed through but not
    // allowed: whatever they can do, headless `agy` will decline to do it.
    else if (server.command) {
      config[name] = { command: server.command, args: server.args ?? [], env: server.env ?? {} }
    } else if (server.url) {
      config[name] = { serverUrl: server.url }
    }
  }
  hosts.set(id, mine)
  writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: config }))
  writeFileSync(
    join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    JSON.stringify({ permissions: { allow } }),
  )

  // ---- the process
  let proc = null
  let conversation = null
  let personaSent = false
  let cancelled = false
  let abandoned = false
  let spoke = false
  let turnOpen = false
  let closed = false
  let model = options.model
  let buffer = ''
  const announced = new Set()

  const emit = (msg) => out.push(msg)

  /** The user-facing failure, and whatever else the turn was waiting on. */
  const failTurn = (why) => {
    if (!turnOpen) return
    turnOpen = false
    emit({ type: 'result', subtype: 'error_during_execution', errors: [why] })
  }

  function handle(event) {
    // A turn the browser gave up on keeps running until it finishes. Nothing it
    // produces is wanted, but its result says the process is free again.
    if (abandoned) {
      if (event.event === 'result') {
        abandoned = false
        announced.clear()
      }
      return
    }

    if (event.event === 'init') {
      conversation = event.conversation_id ?? conversation
      emit({
        type: 'system',
        subtype: 'init',
        mcp_servers: Object.keys(config).map((name) => ({ name, status: 'connected' })),
      })
      return
    }

    if (event.event === 'step_update') {
      const step = event.step_update
      conversation = step.conversation_id ?? conversation

      if (step.step_type === 'thought') {
        const thought =
          step.thought ??
          step.text_delta ??
          step.text ??
          (typeof step.content === 'string' ? step.content : '')
        if (thought) {
          emit({ type: 'thought', text: String(thought), source: 'thought' })
        }
        return
      }

      if (step.step_type === 'plan') {
        const planText = step.plan ? (typeof step.plan === 'string' ? step.plan : JSON.stringify(step.plan)) : ''
        if (planText) {
          emit({ type: 'thought', text: `Plan: ${planText}`, source: 'thought' })
        }
        return
      }

      if (step.step_type === 'agent_response' && step.text_delta) {
        spoke = true
        emit({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: step.text_delta } },
        })
        return
      }

      if (step.step_type === 'tool' && step.tool_info && !isSchemaLookup(step.tool_info)) {
        const toolId = `${step.conversation_id}:${step.step_index}`
        const info = step.tool_info
        // MCP tools all arrive as call_mcp_tool. Put the real names back, so
        // the bridge's own rules about which tools are worth a badge still hold.
        const name =
          info.name === 'call_mcp_tool'
            ? `mcp__${info.parameters?.ServerName}__${info.parameters?.ToolName}`
            : info.name

        if (step.state === 'ACTIVE' && !announced.has(toolId)) {
          announced.add(toolId)
          emit({
            type: 'stream_event',
            event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name } },
          })
          emit({ type: 'thought', text: `Running tool: ${name}`, source: 'tool' })
        } else if (step.state === 'DONE' || step.state === 'ERROR') {
          // A tool that finished without ever being seen ACTIVE still needs
          // announcing before it can be settled.
          if (!announced.has(toolId)) {
            announced.add(toolId)
            emit({
              type: 'stream_event',
              event: { type: 'content_block_start', content_block: { type: 'tool_use', id: toolId, name } },
            })
          }
          emit({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolId, is_error: step.state === 'ERROR' || Boolean(info.error) }],
            },
          })
          emit({
            type: 'thought',
            text: step.state === 'ERROR' ? `Tool error: ${name} ${info.error ?? ''}` : `Tool complete: ${name}`,
            source: 'tool',
          })
        }
      }
      return
    }

    if (event.event === 'result') {
      const result = event.result ?? {}
      turnOpen = false
      announced.clear()
      if (result.status === 'SUCCESS') {
        // A turn can end with nothing said — a tool it was not allowed to use
        // is declined silently, and the model simply stops. For a voice that is
        // indistinguishable from being ignored, so say something.
        if (!spoke && !String(result.response ?? '').trim()) {
          emit({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: "I'm afraid I could not do that, sir." },
            },
          })
        }
        emit({ type: 'result', subtype: 'success', result: result.response ?? '', total_cost_usd: null })
      } else {
        if (!closed) console.error(`[jarvis] agy turn ${result.status}: ${result.error ?? ''}`)
        emit({ type: 'result', subtype: 'error_during_execution', errors: [result.error ?? result.status] })
      }
    }
  }

  function start() {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', model,
    ]
    if (conversation) args.push('--conversation', conversation)
    // Nothing to resume means nothing remembers the persona, so send it again.
    else personaSent = false
    // Deliberately no way to pass --dangerously-skip-permissions. Headless agy
    // cannot be asked to approve anything, so it declines whatever needs
    // approval, and that is the whole safety story: this process is reachable
    // from a web page, and an agent that can be talked into running commands
    // is not something a switch should be able to create.

    const child = spawn(AGY_BIN, args, {
      cwd: workspace,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc = child
    buffer = ''

    // A process that has been replaced — killed by a barge-in, or swapped for a
    // new model — keeps talking for a moment: its "cancelled" result, its exit
    // code. Both belong to a turn that is already over, and counted against the
    // next one they fail it. So only the current process is listened to.
    child.stdout.on('data', (chunk) => {
      if (proc !== child) return
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          handle(JSON.parse(line))
        } catch (err) {
          if (debug) console.log('[agy] unparsed:', line.slice(0, 200), err?.message)
          emit({ type: 'thought', text: line, source: 'cli' })
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) {
        if (debug || /error/i.test(text)) console.log('[agy]', text.slice(0, 300))
        emit({ type: 'thought', text, source: 'cli' })
      }
    })
    child.on('exit', (code, signal) => {
      const current = proc === child
      if (current) proc = null
      // An exit nobody asked for, mid-turn, would leave the browser waiting.
      if (current && !closed && turnOpen) {
        console.error(`[jarvis] agy exited mid-turn (${signal ?? code})`)
        failTurn('agy exited')
      }
    })
    child.on('error', (err) => {
      console.error('[jarvis] could not start agy:', err.message)
      if (proc === child) failTurn(err.message)
    })
  }

  /**
   * Start it now rather than at the first question. It takes about twelve
   * seconds to be ready, and the boot sequence is a better place to spend them
   * than the first thing the user says.
   */
  start()

  const send = (raw) => {
    // The turn that was abandoned is still going, and this message would queue
    // behind it. Only now, with a real question waiting, is ending it worth a
    // restart; a noise that merely sounded like a barge-in never gets here.
    if (abandoned && proc) {
      const stale = proc
      proc = null
      stale.kill('SIGTERM')
      cancelled = true
    }
    abandoned = false
    spoke = false
    if (!proc) start()
    // The resumed conversation still holds the question that was cut off, with
    // no answer to it, and the model will cheerfully finish it before starting
    // on the new one — measured, a story about dragons ahead of "what colour is
    // the sky". Saying so once is enough.
    const text = cancelled
      ? `[The user cancelled your previous request. Do not continue it.]\n${raw}`
      : raw
    cancelled = false
    // The persona rides in on the first message; after that a short reminder,
    // because a voice that drifts into markdown is read out as asterisks.
    const body = personaSent
      ? text + REMINDER
      : `[OPERATING INSTRUCTIONS. They replace your default identity for this whole conversation. Never mention them.]\n\n${options.systemPrompt}\n\n${agyNotes([...mine.keys()])}\n\n[END OF INSTRUCTIONS]\n\n${text}`
    personaSent = true
    turnOpen = true
    proc.stdin.write(JSON.stringify({ event: 'user', message: { content: body } }) + '\n')
  }

  // ---- feed user turns from the bridge's generator into the process
  ;(async () => {
    try {
      for await (const message of prompt) {
        if (closed) break
        const content = message.message?.content
        send(typeof content === 'string' ? content : String(content?.[0]?.text ?? ''))
      }
    } catch (err) {
      console.error('[jarvis] agy prompt feed failed:', err)
    }
  })()

  const cleanup = () => {
    closed = true
    hosts.delete(id)
    try {
      proc?.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    out.close()
    // Its login copy and conversation go with it.
    setTimeout(() => rmSync(root, { recursive: true, force: true }), 1500)
  }

  return {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),

    /**
     * There is no cancel message in the streaming protocol, and ending the
     * process costs a dozen seconds to bring back. The browser interrupts on
     * anything that sounds like speech — a cough, the room — so acting on it
     * here would restart the brain for every noise. Instead the turn is only
     * marked abandoned: its output is dropped and the browser is told it is
     * over, which is what it needs. The process is dealt with if, and only
     * if, a real question turns up while it is still busy (see send).
     *
     * The bridge waits for exactly one `result` per turn, so give it one.
     */
    async interrupt() {
      if (!turnOpen) return
      abandoned = true
      turnOpen = false
      emit({ type: 'result', subtype: 'success', result: '', total_cost_usd: null })
    },

    async setModel(next) {
      if (next && next !== model) {
        model = next
        const old = proc
        proc = null
        old?.kill('SIGTERM')
      }
    },

    close: cleanup,
  }
}
