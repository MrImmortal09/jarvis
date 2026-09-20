import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { tmpdir } from 'node:os'
import { z } from 'zod'

/**
 * The `list_models` and `switch_model` tools — which model JARVIS thinks with.
 *
 * The bridge starts a conversation on one model, JARVIS_MODEL. When the brain
 * sits behind a gateway that serves many — AgentRouter, OpenRouter, a company
 * proxy — being stuck on that one is a waste of the gateway, and "use sonnet
 * for this" or "try the faster one" is a perfectly natural thing to say out
 * loud. These are how JARVIS carries it out.
 *
 * The catalogue is a hint, not a gate. A gateway's own list is not something a
 * client can always read — some refuse anything that is not a recognised coding
 * agent — so JARVIS_MODELS names what is worth offering and anything else the
 * user says is tried on its merits.
 */

/**
 * What `list_models` offers, from JARVIS_MODELS (comma separated). Empty is
 * fine: the aliases below are always understood, and the user can name any id.
 */
const CATALOGUE = (process.env.JARVIS_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Claude Code's own shorthands. They resolve against the gateway's mapping. */
const ALIASES = ['opus', 'sonnet', 'haiku']

/** Longer than a normal reply takes, short enough that a bad id fails in-turn. */
const PROBE_TIMEOUT_MS = 60_000

const ok = (text) => ({ content: [{ type: 'text', text }] })

const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * Whether a model will actually answer, found out by asking it something tiny.
 *
 * Switching first and discovering the id was wrong on the next spoken question
 * is the failure to avoid: the gateway's complaint comes back as the answer,
 * and JARVIS reads it aloud. So the id is tried on a throwaway one-shot query
 * before the live session is touched. It goes through the same client as every
 * other turn, so it is authenticated and routed exactly as a real one would be.
 *
 * @returns {Promise<{ ok: true } | { ok: false, why: string }>}
 */
async function probe(model) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  try {
    const run = query({
      prompt: 'ok',
      options: {
        model,
        systemPrompt: 'Reply with the single word: ready',
        settingSources: [],
        tools: [],
        maxTurns: 1,
        cwd: tmpdir(),
        abortController: abort,
        // A real turn is worth retrying; a question about whether an id exists
        // is not. Left at its default, a wrong name spends a minute in backoff
        // before saying so, while the user waits in silence.
        env: { ...process.env, CLAUDE_CODE_MAX_RETRIES: '1' },
      },
    })
    for await (const msg of run) {
      if (msg.type !== 'result') continue
      if (msg.subtype === 'success' && !msg.is_error) return { ok: true }
      // Only the first line: gateways append request ids and support links,
      // none of which are worth putting in JARVIS's mouth.
      const why = String(msg.result ?? msg.errors?.[0] ?? 'no answer')
        .split('\n')[0]
        .slice(0, 160)
      return { ok: false, why }
    }
    return { ok: false, why: 'no answer' }
  } catch (err) {
    return {
      ok: false,
      why: abort.signal.aborted
        ? 'it did not answer in time'
        : String(err?.message ?? err).split('\n')[0].slice(0, 160),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {object} hooks
 * @param {() => string} hooks.current            the model answering now
 * @param {(model: string) => Promise<void>} hooks.switchTo  change it for this session
 */
export function modelsServer({ current, switchTo }) {
  return createSdkMcpServer({
    name: 'jarvis_models',
    version: '1.0.0',
    instructions:
      'Which model JARVIS is running on, and the means to change it when the ' +
      'user asks. Never switch unprompted.',
    // Same reasoning as the other in-process servers: deferred behind tool
    // search, "switch to sonnet" would never occur to the model as possible.
    alwaysLoad: true,
    tools: [
      tool(
        'list_models',
        'Say which model is answering right now and which others are worth ' +
          'offering. Use when the user asks what you are running on, or which ' +
          'models are available. The list is a suggestion, not a limit: the user ' +
          'may name any model and switch_model will try it.',
        {},
        async () => {
          const now = current()
          const others = [...new Set([...CATALOGUE, ...ALIASES])].filter(
            (m) => m !== now,
          )
          return ok(
            `Answering now: ${now}.\n` +
              `Others to offer: ${others.join(', ')}.\n` +
              'Any other model id the user names can be tried with switch_model.',
          )
        },
      ),

      tool(
        'switch_model',
        'Change the model that answers for the rest of this conversation. Use ' +
          'only when the user asks — "use sonnet", "switch to glm", "go back to ' +
          'opus". The model is tried before the switch, so a wrong or ' +
          'unavailable id leaves things exactly as they were and comes back as ' +
          'a refusal; say so in one line and carry on. Some models handle tools ' +
          'less well than others: if the next answer goes wrong, offer to switch ' +
          'back.',
        {
          model: z
            .string()
            .describe(
              'The model id as the gateway knows it, or a shorthand: opus, ' +
                'sonnet, haiku.',
            ),
        },
        async ({ model }) => {
          const wanted = String(model ?? '').trim()
          if (!wanted) return refuse('Not switched: no model was named.')
          if (wanted === current()) return ok(`Already on ${wanted}.`)

          const verdict = await probe(wanted)
          if (!verdict.ok) {
            return refuse(
              `Not switched: ${wanted} did not answer (${verdict.why}). ` +
                `Still on ${current()}.`,
            )
          }
          await switchTo(wanted)
          return ok(`Switched. Now answering as ${wanted}.`)
        },
      ),
    ],
  })
}
