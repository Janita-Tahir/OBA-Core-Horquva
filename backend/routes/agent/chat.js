const express = require('express')

const { buildTurnContext } = require('../../agent/turnContext')
const { buildRegistry } = require('../../agent/registry')
const { getProvider, isConfigured } = require('../../agent/providers')
const { runTurn } = require('../../agent/loop')
const agentConfig = require('../../agent/config')
const { getDailyTurnCount, persistUsage } = require('../../agent/usageAccounting')

const router = express.Router()

const HEARTBEAT_MS = 15 * 1000

function writeEvent(res, event, data) {
  if (res.writableEnded) return

  if (event) res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function writeComment(res) {
  if (!res.writableEnded) res.write(':\n\n')
}

function normalizeMessage(body) {
  if (typeof body?.message === 'string') return body.message.trim()
  if (typeof body?.userMessage === 'string') return body.userMessage.trim()
  return ''
}

router.post('/chat', async (req, res) => {
  // The router is normally mounted only when the agent is enabled/configured.
  // Keep this guard here as defense in depth.
  if (process.env.AGENT_ENABLED !== 'true' || !isConfigured()) {
    return res.status(404).json({ error: 'Agent route not available' })
  }

  const userMessage = normalizeMessage(req.body)

  if (!userMessage) {
    return res.status(400).json({
      error: 'message is required',
    })
  }

  // W-L 11.7 — user identity from the verified JWT (requireAuth always runs first).
  const userId = req.user?.email || req.user?.sub || 'unknown'

  // W-L 11.7 — daily budget check (happens BEFORE the SSE stream opens so we
  // can still return a normal 429 JSON response, not an SSE error frame).
  const dailyCount = await getDailyTurnCount(userId)
  const budget = agentConfig.dailyTurnBudget
  if (dailyCount >= budget) {
    const now = new Date()
    const nextMidnight = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
    ))
    const retryAfterSeconds = Math.max(1, Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000))
    res.set('Retry-After', String(retryAfterSeconds))
    return res.status(429).json({
      error: 'Daily agent turn budget exceeded',
      retryAfterSeconds,
    })
  }

  // Open the SSE stream immediately so proxies/clients know the connection
  // is alive before turn-context construction begins.
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  writeComment(res)

  const controller = new AbortController()
  let closed = false

  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) writeComment(res)
  }, HEARTBEAT_MS)

  const onClose = () => {
    if (req.complete) return
    closed = true
    controller.abort()
    clearInterval(heartbeat)
  }

  req.on('close', onClose)

  try {
    const turnContext = await buildTurnContext()

    if (closed || controller.signal.aborted) return

    const registry = buildRegistry([], turnContext)
    const provider = getProvider()

    writeEvent(res, 'ready', {
      conversationId: req.body?.conversationId || null,
      snapshotAt: turnContext.snapshotAt,
    })

    const history = Array.isArray(req.body?.history)
      ? req.body.history
      : []

    const result = await runTurn({
      turnContext,
      history,
      userMessage,
      emit: (event) => {
        if (!closed && !res.writableEnded && event?.type) {
          const { type, ...data } = event
          writeEvent(res, type, data)
        }
      },
      signal: controller.signal,
      registry,
      provider,
    })

    // W-L 11.7 — persist usage for every turn where the provider was called.
    // runTurn() always returns (never throws) once provider calls begin, so
    // this covers successful turns, error turns, timeouts, and aborts alike.
    // Non-fatal if the DB write fails — already logged inside persistUsage().
    if (result && (result.providerCalls || 0) > 0) {
      const desc = provider.describe ? provider.describe() : { provider: 'unknown', model: 'unknown' }
      persistUsage({
        userId,
        provider: desc.provider,
        model:    desc.model,
        inputTokens:    result.usage?.inputTokens    || 0,
        outputTokens:   result.usage?.outputTokens   || 0,
        providerCalls:  result.providerCalls         || 0,
        toolIterations: result.iterations            || 0,
        validatorStatus: result.validatorStatus      || null,
      }).catch((err) => {
        // persistUsage is already non-throwing, but defend anyway.
        console.error('[chat] persistUsage unexpected error:', err)
      })
    }

    if (closed || res.writableEnded) return

    writeEvent(res, 'done', {
      text: result?.text || '',
      toolTrace: result?.toolTrace || [],
      navigationOffer: result?.navigationOffer || null,
      provenance: result?.provenance || {
        snapshotAt: turnContext.snapshotAt,
        graphSource: turnContext.graphSource,
        graphStale: turnContext.graphStale,
      },
      usage: result?.usage || null,
      validatorStatus: result?.validatorStatus || null,
      finishReason: result?.finishReason || null,
    })
  } catch (err) {
    if (closed || controller.signal.aborted || res.writableEnded) return

    const message =
      err?.message === 'Cannot read organizational data right now'
        ? err.message
        : 'Unable to complete the agent turn'

    writeEvent(res, 'error', {
      code: err?.code || 'AGENT_TURN_FAILED',
      message,
      retryable: Boolean(err?.retryable),
    })
  } finally {
    clearInterval(heartbeat)
    req.off('close', onClose)

    if (!res.writableEnded) res.end()
  }
})

module.exports = router
