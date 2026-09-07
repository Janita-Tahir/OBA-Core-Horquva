/**
 * Central export for all agent tools.
 * This makes it easy for the route to import all tools at once.
 * 
 * Tools from:
 * - 11.2: read-tools.js (resolve_entity, get_org_snapshot, etc.)
 * - 11.3: simulation-tools.js (run_simulation, rank_scenarios, compare_scenarios)
 * - 13.2: simulate-reassignment.js (simulate_reassignment) ← YOUR TOOL
 */

const readTools = require('./read-tools');
const simulationTools = require('./simulation-tools');
const simulateReassignment = require('./simulate-reassignment');

// Each tool module exports: { name, description, parameters, run() }
// We can export them individually or as an array
module.exports = {
  // Individual exports
  readTools,
  simulationTools,
  simulateReassignment,
  
  // Or as an array for easy registration
  all: [readTools, simulationTools, simulateReassignment],
};