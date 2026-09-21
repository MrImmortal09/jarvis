/**
 * Worker pool for parallel task execution.
 *
 * The orchestrator (main `agy` session) delegates long-running tasks to
 * independent worker `agy` processes. Each worker gets its own session
 * directory, HOME, and workspace — the same isolation the main session has.
 *
 * Workers are fire-and-forget from the orchestrator's perspective: it spawns
 * one, gets an id back immediately, and later checks on it or is notified
 * when it finishes. This keeps the orchestrator free for conversation.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where `agy` is installed. Same default as agy.mjs. */
const AGY_BIN = process.env.JARVIS_AGY_BIN || join(homedir(), '.local', 'bin', 'agy')

/** Worker sessions live alongside the main session's. */
const SESSIONS_DIR = process.env.JARVIS_AGY_DIR || join(homedir(), 'agy-sessions')

/** How many workers may run at once. */
const MAX_WORKERS = Number(process.env.JARVIS_MAX_WORKERS ?? 4)

/** Worker model — same as the main agent's by default. */
const WORKER_MODEL = process.env.JARVIS_WORKER_MODEL || process.env.JARVIS_AGY_MODEL || 'gemini-3.8-flash-high'

/** The login `agy` made when it was signed in. */
const LOGIN_DIR = join(homedir(), '.gemini', 'antigravity-cli')
const LOGIN_FILES = [
  'antigravity-oauth-token',
  'cache/onboarding.json',
  'cache/default_project_id.txt',
]

/** Hosts workers may read pages from. */
const READ_HOSTS = (process.env.JARVIS_AGY_READ_HOSTS ?? '*')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WorkerInfo
 * @property {string} id
 * @property {string} prompt
 * @property {'queued'|'running'|'completed'|'failed'|'cancelled'} status
 * @property {number} startedAt
 * @property {number} [completedAt]
 * @property {string[]} tools
 * @property {string} result
 * @property {string} error
 * @property {string[]} logs  - last N log lines
 */

class Worker {
  /**
   * @param {string} id
   * @param {string} prompt
   * @param {(event: object) => void} onEvent  - forwarded to the browser
   * @param {(worker: Worker) => void} onDone   - called when the worker finishes
   */
  constructor(id, prompt, onEvent, onDone) {
    this.id = id
    this.prompt = prompt
    this.status = 'running'
    this.startedAt = Date.now()
    this.completedAt = null
    this.tools = []
    this.result = ''
    this.error = ''
    this.logs = []
    this.proc = null
    this.root = null
    this._onEvent = onEvent
    this._onDone = onDone
    this._spoke = false
    this._buffer = ''
  }

  start() {
    const root = join(SESSIONS_DIR, `w-${this.id}`)
    this.root = root
    const home = join(root, 'home')
    const workspace = join(root, 'cwd')

    // ---- private HOME
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'cache'), { recursive: true })
    mkdirSync(workspace, { recursive: true })

    for (const file of LOGIN_FILES) {
      const from = join(LOGIN_DIR, file)
      if (existsSync(from)) copyFileSync(from, join(home, '.gemini', 'antigravity-cli', file))
    }

    // Copy GitHub auth, Git config and PR.md
    const realHome = homedir()
    const ghConfigSrc = join(realHome, '.config', 'gh')
    if (existsSync(ghConfigSrc)) {
      mkdirSync(join(home, '.config'), { recursive: true })
      try { cpSync(ghConfigSrc, join(home, '.config', 'gh'), { recursive: true }) } catch {}
    }
    const gitConfigSrc = join(realHome, '.gitconfig')
    if (existsSync(gitConfigSrc)) {
      try { copyFileSync(gitConfigSrc, join(home, '.gitconfig')) } catch {}
    }
    const prMdSrc = join(realHome, 'PR.md')
    if (existsSync(prMdSrc)) {
      try { copyFileSync(prMdSrc, join(home, 'PR.md')) } catch {}
    }

    // Permissions: allow everything a worker needs
    const allow = [
      ...READ_HOSTS.map((host) => `read_url(${host})`),
      'command(*)', 'command:*', 'run_command(*)',
      'file(*)', 'file:*',
      'view_file(*)', 'write_to_file(*)',
      'replace_file_content(*)', 'multi_replace_file_content(*)',
      'list_dir(*)', 'grep_search(*)',
    ]
    writeFileSync(
      join(home, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify({ permissions: { allow } }),
    )

    // Worker system prompt — concise, task-focused
    const systemPrompt = [
      `You are a JARVIS worker agent. Execute the task below thoroughly and report results.`,
      `The owner's GitHub username is MrImmortal09. Your GitHub account is omswami2004.`,
      `Use \`gh\` (GitHub CLI) for all GitHub operations. You are fully authenticated.`,
      `All PRs you create must be tracked in ~/PR.md with full link, repo, branch, timestamp, and context.`,
      `Work silently and efficiently. When done, give a concise summary of what was accomplished.`,
    ].join('\n')

    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', WORKER_MODEL,
      '--dangerously-skip-permissions',
    ]

    const child = spawn(AGY_BIN, args, {
      cwd: workspace,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = child

    this._log(`Worker started for: "${this.prompt}"`)

    // ---- stdout: stream-json events
    child.stdout.on('data', (chunk) => {
      this._buffer += chunk
      let nl
      while ((nl = this._buffer.indexOf('\n')) >= 0) {
        const line = this._buffer.slice(0, nl).trim()
        this._buffer = this._buffer.slice(nl + 1)
        if (!line) continue
        try {
          this._handle(JSON.parse(line))
        } catch {
          this._log(line.slice(0, 200))
        }
      }
    })

    // ---- stderr
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this._log(text.slice(0, 300))
    })

    // ---- exit
    child.on('exit', (code, signal) => {
      if (this.status === 'running') {
        // Unexpected exit
        this.status = 'failed'
        this.error = `Process exited (${signal ?? code})`
        this.completedAt = Date.now()
        this._log(`Worker exited unexpectedly: ${signal ?? code}`)
        this._finish()
      }
    })
    child.on('error', (err) => {
      this.status = 'failed'
      this.error = err.message
      this.completedAt = Date.now()
      this._log(`Worker error: ${err.message}`)
      this._finish()
    })

    // Send the task
    const body = `[OPERATING INSTRUCTIONS]\n${systemPrompt}\n[END]\n\n${this.prompt}`
    child.stdin.write(JSON.stringify({ event: 'user', message: { content: body } }) + '\n')
  }

  _handle(event) {
    if (event.event === 'step_update') {
      const step = event.step_update
      if (step.step_type === 'thought') {
        const thought = step.thought ?? step.text_delta ?? step.text ?? ''
        if (thought) {
          this._log(String(thought))
          this._emitEvent('worker_thought', { text: String(thought), source: 'thought' })
        }
      }
      if (step.step_type === 'agent_response' && step.text_delta) {
        this._spoke = true
        this._log(step.text_delta)
        this._emitEvent('worker_thought', { text: step.text_delta, source: 'response' })
      }
      if (step.step_type === 'tool' && step.tool_info) {
        const info = step.tool_info
        const name = info.name === 'call_mcp_tool'
          ? `mcp__${info.parameters?.ServerName}__${info.parameters?.ToolName}`
          : info.name
        if (step.state === 'ACTIVE') {
          if (!this.tools.includes(name)) this.tools.push(name)
          this._log(`Tool: ${name}`)
          this._emitEvent('worker_thought', { text: `Tool: ${name}`, source: 'tool' })
        } else if (step.state === 'DONE') {
          this._log(`Tool done: ${name}`)
        } else if (step.state === 'ERROR') {
          this._log(`Tool error: ${name} ${info.error ?? ''}`)
        }
      }
    }

    if (event.event === 'result') {
      const result = event.result ?? {}
      this.completedAt = Date.now()
      if (result.status === 'SUCCESS') {
        this.status = 'completed'
        this.result = result.response ?? ''
        this._log(`Completed: ${this.result.slice(0, 200)}`)
      } else {
        this.status = 'failed'
        this.error = result.error ?? result.status ?? 'Unknown error'
        this._log(`Failed: ${this.error}`)
      }
      this._finish()
    }
  }

  _log(text) {
    const ts = new Date().toTimeString().split(' ')[0]
    this.logs.push(`[${ts}] ${text}`)
    if (this.logs.length > 200) this.logs.shift()
  }

  _emitEvent(type, data) {
    this._onEvent?.({
      type,
      workerId: this.id,
      workerPrompt: this.prompt,
      ...data,
    })
  }

  _finish() {
    // Sync PR.md back to real home if the worker created/modified it
    if (this.root) {
      const workerPr = join(this.root, 'home', 'PR.md')
      const realPr = join(homedir(), 'PR.md')
      if (existsSync(workerPr)) {
        try { copyFileSync(workerPr, realPr) } catch {}
      }
    }

    this._emitEvent('worker_done', {
      status: this.status,
      result: this.result,
      error: this.error,
      duration: Math.round(((this.completedAt || Date.now()) - this.startedAt) / 1000),
    })
    this._onDone?.(this)

    // Clean up the session dir after a short delay
    if (this.root) {
      const root = this.root
      setTimeout(() => rmSync(root, { recursive: true, force: true }), 5000)
    }
  }

  kill() {
    if (this.status !== 'running') return
    this.status = 'cancelled'
    this.completedAt = Date.now()
    this._log('Cancelled by user')
    try { this.proc?.kill('SIGTERM') } catch {}
    this._finish()
  }

  toInfo() {
    return {
      id: this.id,
      prompt: this.prompt,
      status: this.status,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: this.completedAt ? new Date(this.completedAt).toISOString() : null,
      elapsedSeconds: Math.round(((this.completedAt || Date.now()) - this.startedAt) / 1000),
      tools: this.tools,
      result: this.result.slice(0, 500),
      error: this.error,
      logTail: this.logs.slice(-20),
    }
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export class WorkerPool {
  constructor() {
    /** @type {Map<string, Worker>} */
    this.active = new Map()
    /** @type {WorkerInfo[]} */
    this.history = []
    /** @type {Array<{prompt: string, resolve: Function}>} */
    this.queue = []
    /** @type {((event: object) => void)|null} */
    this.onEvent = null
    /** @type {((worker: object) => void)|null} */
    this.onWorkerDone = null
  }

  /**
   * Spawn a new worker for the given task. Returns the worker id immediately.
   * If at capacity, the task is queued.
   *
   * @param {string} prompt
   * @returns {{ id: string, status: 'running'|'queued' }}
   */
  spawn(prompt) {
    const id = randomUUID().slice(0, 8)

    if (this.active.size >= MAX_WORKERS) {
      // Queue it
      const info = { id, prompt, status: 'queued' }
      this.queue.push({ prompt, id, resolve: null })
      console.log(`[jarvis] worker ${id} queued (${this.active.size}/${MAX_WORKERS} active)`)
      return info
    }

    this._startWorker(id, prompt)
    return { id, status: 'running' }
  }

  _startWorker(id, prompt) {
    const worker = new Worker(
      id,
      prompt,
      (event) => this.onEvent?.(event),
      (w) => this._onDone(w),
    )
    this.active.set(id, worker)
    worker.start()
    console.log(`[jarvis] worker ${id} started (${this.active.size}/${MAX_WORKERS} active)`)
  }

  _onDone(worker) {
    this.active.delete(worker.id)
    this.history.unshift(worker.toInfo())
    if (this.history.length > 30) this.history.pop()
    console.log(`[jarvis] worker ${worker.id} ${worker.status} (${this.active.size}/${MAX_WORKERS} active)`)

    // Notify the orchestrator
    this.onWorkerDone?.(worker.toInfo())

    // Start next queued task
    if (this.queue.length > 0 && this.active.size < MAX_WORKERS) {
      const next = this.queue.shift()
      this._startWorker(next.id, next.prompt)
    }
  }

  /**
   * List all active and recently completed workers.
   * @param {number} [limit=10]
   */
  list(limit = 10) {
    const active = [...this.active.values()].map((w) => w.toInfo())
    const recent = this.history.slice(0, limit)
    const queued = this.queue.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      status: 'queued',
    }))
    return { active, queued, recent, maxWorkers: MAX_WORKERS }
  }

  /**
   * Detailed status of one worker.
   * @param {string} id
   */
  status(id) {
    const worker = this.active.get(id)
    if (worker) return worker.toInfo()
    return this.history.find((h) => h.id === id) ?? null
  }

  /**
   * Cancel a running worker.
   * @param {string} id
   * @returns {boolean}
   */
  kill(id) {
    const worker = this.active.get(id)
    if (worker) {
      worker.kill()
      return true
    }
    // Check queue
    const qi = this.queue.findIndex((q) => q.id === id)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      return true
    }
    return false
  }

  /** Kill all running workers and clear the queue. */
  killAll() {
    for (const worker of this.active.values()) {
      worker.kill()
    }
    this.queue.length = 0
  }

  /** Summary for the task status readout. */
  summary() {
    return {
      activeCount: this.active.size,
      queuedCount: this.queue.length,
      active: [...this.active.values()].map((w) => ({
        id: w.id,
        prompt: w.prompt,
        status: w.status,
        elapsedSeconds: Math.round((Date.now() - w.startedAt) / 1000),
        tools: w.tools,
      })),
      recent: this.history.slice(0, 5),
    }
  }
}
