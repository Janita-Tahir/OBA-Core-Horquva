const domain = require('../domain')

const DEFAULT_GRAPH_STALE_HOURS = 6

function graphStale(source, snapshotAt) {
  if (!source?.loadedAt) return false

  const loadedAt = Date.parse(source.loadedAt)
  const snapshot = Date.parse(snapshotAt)

  if (!Number.isFinite(loadedAt) || !Number.isFinite(snapshot)) return false

  const thresholdHours = Number(process.env.AGENT_GRAPH_STALE_HOURS)
  const staleHours = Number.isFinite(thresholdHours) && thresholdHours >= 0
    ? thresholdHours
    : DEFAULT_GRAPH_STALE_HOURS

  return snapshot - loadedAt > staleHours * 60 * 60 * 1000
}

/**
 * Build one immutable snapshot for an agent turn.
 *
 * Roots and intelligence are loaded/computed once. Tools receive this
 * context and must not reread organizational data during the turn.
 *
 * @returns {{
 *   roots: object,
 *   intel: object,
 *   snapshotAt: string,
 *   graphSource: object,
 *   graphStale: boolean
 * }}
 */
async function buildTurnContext() {
  const roots = await domain.intelligence.compute.loadRoots()
  const intel = domain.intelligence.compute.allFromRoots(roots)

  const snapshotAt = new Date().toISOString()
  const graphSource = domain.graph.source()

  return Object.freeze({
    roots,
    intel,
    snapshotAt,
    graphSource,
    graphStale: graphStale(graphSource, snapshotAt),
  })
}

module.exports = {
  buildTurnContext,
  graphStale,
}
