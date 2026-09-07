// backend/tests/agentUsageAccounting.unit.test.js
//
// W-L 11.7 — offline unit tests for backend/agent/usageAccounting.js.
//
// Uses makeAccounting(fakeSupabase) so no real database or network is needed.
// Run from backend/:  node tests/agentUsageAccounting.unit.test.js

'use strict'

const { makeAccounting } = require('../agent/usageAccounting')

let passed = 0
let failed = 0

function check(name, cond, detail) {
  if (cond) {
    passed++
    console.log('  ✓', name)
  } else {
    failed++
    console.error('  ✗', name, detail !== undefined ? '\n      got: ' + JSON.stringify(detail) : '')
  }
}

// ── Supabase stub builder ────────────────────────────────────────────────────

/**
 * Build a minimal Supabase v2 stub.
 *
 * @param {{
 *   selectResult?:  { count?: number, error?: object },
 *   insertResult?:  { error?: object },
 * }} overrides
 */
function fakeSupabase({ selectResult = {}, insertResult = {} } = {}) {
  const calls = { selects: [], inserts: [] }

  // The Supabase query-builder returns `this` at each chain step so the
  // terminal await resolves the final result.
  function selectChain(selectResultOverride) {
    const result = Object.assign({ count: null, data: null, error: null }, selectResultOverride)
    const chain = {
      select: (..._args) => chain,
      eq:     (..._args) => chain,
      gte:    (..._args) => chain,
      lt:     (..._args) => chain,
      then:   (resolve) => resolve(result),
    }
    return chain
  }

  function insertChain(insertResultOverride) {
    const result = Object.assign({ data: null, error: null }, insertResultOverride)
    const chain = {
      then: (resolve) => resolve(result),
    }
    return chain
  }

  return {
    calls,
    from(table) {
      return {
        select(...args) {
          calls.selects.push({ table, args })
          return selectChain(selectResult)
        },
        insert(row) {
          calls.inserts.push({ table, row })
          return insertChain(insertResult)
        },
      }
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== OBA Core — Usage Accounting Unit Test (W-L 11.7) ===\n')

  // ── 1. getDailyTurnCount returns count from Supabase ─────────────────────
  console.log('getDailyTurnCount:')
  {
    const sb = fakeSupabase({ selectResult: { count: 7, error: null } })
    const { getDailyTurnCount } = makeAccounting(sb)

    const n = await getDailyTurnCount('alice@example.com')
    check('returns the integer count from Supabase', n === 7, n)
    check('queries the agent_usage table', sb.calls.selects[0]?.table === 'agent_usage', sb.calls.selects[0]?.table)
  }

  {
    const sb = fakeSupabase({ selectResult: { count: 0, error: null } })
    const { getDailyTurnCount } = makeAccounting(sb)
    const n = await getDailyTurnCount('bob@example.com')
    check('returns 0 when count is 0', n === 0, n)
  }

  {
    // null count (unexpected Supabase shape) — must not blow up
    const sb = fakeSupabase({ selectResult: { count: null, error: null } })
    const { getDailyTurnCount } = makeAccounting(sb)
    const n = await getDailyTurnCount('carol@example.com')
    check('returns 0 when count is null', n === 0, n)
  }

  {
    // Supabase error — must return 0 without throwing
    const sb = fakeSupabase({ selectResult: { count: null, error: { message: 'DB offline' } } })
    const { getDailyTurnCount } = makeAccounting(sb)
    let threw = false
    let n
    try {
      n = await getDailyTurnCount('dave@example.com')
    } catch (_) {
      threw = true
    }
    check('returns 0 on Supabase error (does not throw)', !threw && n === 0, { threw, n })
  }

  // ── 2. persistUsage calls insert with the correct payload ─────────────────
  console.log('\npersistUsage:')
  {
    const sb = fakeSupabase({ insertResult: { error: null } })
    const { persistUsage } = makeAccounting(sb)

    await persistUsage({
      userId:          'alice@example.com',
      provider:        'gemini',
      model:           'gemini-3.7-flash',
      inputTokens:     100,
      outputTokens:    40,
      providerCalls:   2,
      toolIterations:  1,
      validatorStatus: null,
    })

    const inserted = sb.calls.inserts[0]
    check('inserts into agent_usage', inserted?.table === 'agent_usage', inserted?.table)
    check('user_id correct',          inserted?.row?.user_id          === 'alice@example.com', inserted?.row?.user_id)
    check('provider correct',         inserted?.row?.provider         === 'gemini', inserted?.row?.provider)
    check('model correct',            inserted?.row?.model            === 'gemini-3.7-flash', inserted?.row?.model)
    check('input_tokens correct',     inserted?.row?.input_tokens     === 100, inserted?.row?.input_tokens)
    check('output_tokens correct',    inserted?.row?.output_tokens    === 40, inserted?.row?.output_tokens)
    check('provider_calls correct',   inserted?.row?.provider_calls   === 2, inserted?.row?.provider_calls)
    check('tool_iterations correct',  inserted?.row?.tool_iterations  === 1, inserted?.row?.tool_iterations)
    check('validator_status is null', inserted?.row?.validator_status === null, inserted?.row?.validator_status)
    check('conversation_id is null (FK safety)', inserted?.row?.conversation_id === null, inserted?.row?.conversation_id)
  }

  {
    // validator_status defaults to null when omitted
    const sb = fakeSupabase({ insertResult: { error: null } })
    const { persistUsage } = makeAccounting(sb)

    await persistUsage({
      userId: 'bob@example.com',
      provider: 'gemini',
      model: 'gemini-3.7-flash',
    })

    const inserted = sb.calls.inserts[0]
    check('validator_status defaults to null when not supplied', inserted?.row?.validator_status === null, inserted?.row?.validator_status)
    check('providerCalls defaults to 0 when not supplied', inserted?.row?.provider_calls === 0, inserted?.row?.provider_calls)
    check('toolIterations defaults to 0 when not supplied', inserted?.row?.tool_iterations === 0, inserted?.row?.tool_iterations)
  }

  {
    // Supabase insert error — must NOT throw, must log (we can't capture console
    // easily here but we assert the promise resolves)
    const sb = fakeSupabase({ insertResult: { error: { message: 'DB write failed' } } })
    const { persistUsage } = makeAccounting(sb)

    let threw = false
    try {
      await persistUsage({
        userId: 'carol@example.com',
        provider: 'gemini',
        model: 'test',
        providerCalls: 1,
      })
    } catch (_) {
      threw = true
    }
    check('DB error on insert does not throw (non-fatal)', !threw, { threw })
  }

  // ── 3. provider_calls !== tool_iterations (critical W-L 11.7 invariant) ──
  console.log('\nProvider-call vs iteration distinction:')
  {
    const sb = fakeSupabase({ insertResult: { error: null } })
    const { persistUsage } = makeAccounting(sb)

    // 1 agent turn, 2 provider requests (1 initial + 1 retry), 1 iteration
    await persistUsage({
      userId: 'alice@example.com',
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      providerCalls: 2,
      toolIterations: 1,
    })

    const row = sb.calls.inserts[0]?.row
    check('provider_calls (2) can differ from tool_iterations (1)', row?.provider_calls !== row?.tool_iterations, { provider_calls: row?.provider_calls, tool_iterations: row?.tool_iterations })
    check('provider_calls stored correctly as 2', row?.provider_calls === 2, row?.provider_calls)
    check('tool_iterations stored correctly as 1', row?.tool_iterations === 1, row?.tool_iterations)
  }

  console.log('\n----------------------------------------')
  console.log('passed: ' + passed + '   failed: ' + failed)
  console.log(failed === 0 ? 'USAGE ACCOUNTING TESTS PASSED ✅' : 'USAGE ACCOUNTING TESTS FAILED ❌')
  console.log('----------------------------------------\n')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Test harness error:', err)
  process.exit(1)
})
