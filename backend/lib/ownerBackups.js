// Resolved defensively, matching domain/index.js: supabase.js constructs its
// client at module load and throws without SUPABASE_URL. A bare require here
// reached brain/ through graphLoader.js, so it took out every test that
// merely requires brain/ — including ones that need no database at all.
let _supabase = null
try {
  _supabase = require('../supabase')
} catch (_) {
  _supabase = null
}
function requireSupabase() {
  if (!_supabase) throw new Error('ownerBackups requires Supabase; none is configured')
  return _supabase
}

/**
 * employee_id -> full `owners` row (a 10-row subset of employees carrying
 * id/name/role/backup_owner/risk, keyed by owners.employee_id).
 *
 * "Backup coverage" for an agent or workflow is NOT a column on those tables —
 * it's a property of whoever owns them (agents.owner_id / workflow_runbooks.owner_id,
 * both -> employees.id), recorded here. See ownership.js's header comment for
 * why this can't be joined on owners.id instead of owners.employee_id.
 *
 * The one query behind this file. `loadOwnerBackupByEmployee()` below is a
 * thin narrowing for callers that only ever wanted the backup_owner name —
 * ownership.js needs the rest of the row (id/name/role/risk), and used to
 * run this exact query itself rather than share it.
 */
async function loadOwners() {
  const supabase = requireSupabase()
  const { data, error } = await supabase.from('owners').select('id, name, role, backup_owner, risk, employee_id').not('employee_id', 'is', null)
  if (error) throw new Error(`owners: ${error.message}`)
  const byEmployee = {}
  for (const o of data || []) byEmployee[o.employee_id] = o
  return byEmployee
}

/** employee_id -> backup_owner name, for callers that only need the boolean/name. */
async function loadOwnerBackupByEmployee() {
  const owners = await loadOwners()
  const byEmployee = {}
  for (const [employeeId, o] of Object.entries(owners)) byEmployee[employeeId] = o.backup_owner
  return byEmployee
}

module.exports = { loadOwners, loadOwnerBackupByEmployee }
