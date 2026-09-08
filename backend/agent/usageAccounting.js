'use strict'
/*
 * OBA Core — agent usage accounting (W-L 11.7).
 *
 * Responsibilities:
 *   1. getDailyTurnCount(userId) — how many turns has this user run today (UTC)?
 *   2. persistUsage(opts)        — write one row to agent_usage after a turn.
 *
 * The Supabase client is injected via makeAccounting() so unit tests can
 * supply a fake without touching the module cache.
 *
 * Design notes
 * ─────────────
 * • Daily window is UTC midnight-to-midnight.  The index
 *   idx_agent_usage_user(user_id, created_at DESC) makes the range scan cheap.
 * • conversation_id is ALWAYS persisted as NULL in W-L 11.7.  The FK
 *   REFERENCES agent_conversations(id) would reject an arbitrary client UUID
 *   because W-L 11.7 does not create conversation rows.  Conversation
 *   management is a separate future task.
 * • validator_status NULL is valid — the column has no NOT NULL constraint,
 *   only a CHECK for the three allowed string values.  No validator is wired
 *   in T11.5/T11.6, so the value is always NULL here.
 * • persistUsage never throws to the caller.  A DB failure is logged but the
 *   SSE result has already been delivered to the user, so accounting loss
 *   must not cause a second observable error.  It IS logged visibly.
 */

/**
 * @param {object} supabase  — a @supabase/supabase-js v2 client
 * @returns {{ getDailyTurnCount, persistUsage }}
 */
function makeAccounting(supabase) {
  /**
   * Count turns recorded in agent_usage for `userId` during the current
   * UTC calendar day.
   *
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async function getDailyTurnCount(userId) {
    const now = new Date()
    // UTC midnight start of today
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    // UTC midnight start of tomorrow
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

    const { count, error } = await supabase
      .from('agent_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', dayStart.toISOString())
      .lt('created_at', dayEnd.toISOString())

    if (error) {
      // Log but don't throw — a DB error here means we can't enforce the
      // budget, but that's better than blocking every user on a DB outage.
      console.error('[usageAccounting] getDailyTurnCount error:', error.message)
      return 0
    }

    return typeof count === 'number' ? count : 0
  }

  /**
   * Write one usage row to agent_usage.
   *
   * Called after runTurn() returns, for both successful and failed turns
   * (the loop always returns, never throws, once the provider has been called).
   *
   * @param {{
   *   userId:          string,
   *   provider:        string,
   *   model:           string,
   *   inputTokens:     number,
   *   outputTokens:    number,
   *   providerCalls:   number,
   *   toolIterations:  number,
   *   validatorStatus: string|null,
   * }} opts
   */
  async function persistUsage(opts) {
    const {
      userId,
      provider,
      model,
      inputTokens = 0,
      outputTokens = 0,
      providerCalls = 0,
      toolIterations = 0,
      validatorStatus = null,
    } = opts

    // conversation_id is always NULL in W-L 11.7 (see module doc above).
    const row = {
      user_id:          userId,
      conversation_id:  null,
      provider,
      model,
      input_tokens:     inputTokens,
      output_tokens:    outputTokens,
      provider_calls:   providerCalls,
      tool_iterations:  toolIterations,
      validator_status: validatorStatus,  // NULL or 'clean'|'repaired'|'flagged'
    }

    const { error } = await supabase.from('agent_usage').insert(row)

    if (error) {
      // Non-fatal: the turn result was already sent to the client.
      // Visibility is important — log clearly.
      console.error('[usageAccounting] persistUsage failed:', error.message, '| row:', JSON.stringify(row))
    }
  }

  return { getDailyTurnCount, persistUsage }
}

// Production singleton wired to the project's Supabase client.
// Loaded lazily so the module can be required in offline tests without
// triggering the Supabase/dotenv bootstrap.
let _default = null
function getDefault() {
  if (!_default) {
    const supabase = require('../supabase')
    _default = makeAccounting(supabase)
  }
  return _default
}

module.exports = {
  makeAccounting,
  getDailyTurnCount: (userId) => getDefault().getDailyTurnCount(userId),
  persistUsage:      (opts)   => getDefault().persistUsage(opts),
}
