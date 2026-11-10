'use strict';

// Deterministic capability catalog for delegated agent authority (docs/spec.md
// sections 7.2 and 19). Availability is decided here, in server code, never by
// a client, a package, or a delegation row. A capability that is not
// `delegable` cannot be granted to an agent, whatever the sponsor's own role.

const { codedError } = require('../codedError');

const READ_ROLES = Object.freeze(['owner', 'admin', 'analyst', 'viewer']);
const WRITE_ROLES = Object.freeze(['owner', 'admin', 'analyst']);
const MANAGE_ROLES = Object.freeze(['owner', 'admin']);

const CAPABILITIES = Object.freeze({
  'metadata.read': { availability: 'delegable', sponsorRoles: READ_ROLES,
    description: 'Read bounded project and dataset metadata.' },
  'results.read': { availability: 'delegable', sponsorRoles: READ_ROLES,
    description: 'Read bounded summaries of completed managed runs.' },
  'proposal.create': { availability: 'delegable', sponsorRoles: WRITE_ROLES,
    description: 'Submit inert code or method proposals for human review.' },
  // Planned agent capabilities. They exist in the catalog so that requests for
  // them fail with an explicit reason instead of an unknown-capability error.
  'workflow.plan': { availability: 'delegable', sponsorRoles: WRITE_ROLES,
    description: "Plan runs of approved workflows inside the sponsor's open studies." },
  'workflow.executeApproved': { availability: 'delegable', sponsorRoles: WRITE_ROLES,
    description: 'Submit planned runs of approved workflows, within study and compute budgets.' },
  'run.cancelOwn': { availability: 'delegable', sponsorRoles: WRITE_ROLES,
    description: "Cancel this agent's own runs." },
  'development.executeCandidate': { availability: 'delegable', sponsorRoles: WRITE_ROLES,
    description: "Run the agent's own R scripts in the sponsor's sandboxes: no network, read-only inputs, draft outputs." },
  'report.write': { availability: 'delegable', sponsorRoles: WRITE_ROLES,
    description: 'Draft report sections and attach figures from sandbox runs, for people to review.' },
  'artifact.export': { availability: 'planned', phase: 5 },
  // Human-only governance. Agent credentials are rejected even when the sponsor
  // holds the corresponding project role.
  'workflow.approve': { availability: 'human-only' },
  'study.expand': { availability: 'human-only' },
  'result.accept': { availability: 'human-only' },
  'result.publish': { availability: 'human-only' },
  'delegation.manage': { availability: 'human-only' },
  'security.manage': { availability: 'never' },
  'target.manage': { availability: 'never' },
  'budget.increase': { availability: 'never' },
});

const DELEGATION_POLICY_SCHEMA = 'traceomics.delegation-policy.v1';
const DISCLOSURE_PROFILES = Object.freeze(['identifiers', 'labels']);

const POLICY_LIMITS = Object.freeze({
  maxOpenProposals: { min: 0, max: 50, default: 10 },
  maxProposalBytes: { min: 1024, max: 262144, default: 65536 },
  maxRequestsPerMinute: { min: 1, max: 600, default: 60 },
  maxOutstandingRuns: { min: 0, max: 10, default: 1 },
  maxReservedCpuSeconds: { min: 0, max: 100000000, default: 14400 },
});

// Switches fixed off until the corresponding phase has a tested enforcement
// path. Approved-workflow execution is governed by capabilities and studies.
// Candidate code runs only through development.executeCandidate inside a
// sandbox a person defined; allowCandidateCodeExecution stays false because no
// other route runs agent code.
const FIXED_POLICY = Object.freeze({
  mode: 'approved-workflows',
  allowArbitraryCode: false,
  allowCandidateCodeExecution: false,
  allowArtifactExport: false,
  allowGpu: false,
  allowJobArrays: false,
});

const MIN_DELEGATION_SECONDS = 15 * 60;
const MAX_DELEGATION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_DELEGATION_SECONDS = 7 * 24 * 60 * 60;

function capabilityInfo(name) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, name) ? CAPABILITIES[name] : null;
}

function isDelegable(name) {
  return capabilityInfo(name)?.availability === 'delegable';
}

function sponsorRolesFor(name) {
  const info = capabilityInfo(name);
  return info && info.availability === 'delegable' ? info.sponsorRoles : [];
}

// Validates a requested capability set. Unknown, planned, and human-only
// capabilities are rejected explicitly; duplicates collapse; output is sorted
// so equivalent requests produce identical stored delegations.
function normalizeCapabilities(value, sponsorRole) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw codedError('INVALID_CAPABILITIES', 'Choose between 1 and 16 capabilities.', 400);
  }
  const out = new Set();
  for (const name of value) {
    if (typeof name !== 'string') throw codedError('INVALID_CAPABILITIES', 'Capabilities must be strings.', 400);
    const info = capabilityInfo(name);
    if (!info) throw codedError('UNKNOWN_CAPABILITY', `Unknown capability: ${name.slice(0, 64)}.`, 400);
    if (info.availability === 'planned') {
      throw codedError('CAPABILITY_UNAVAILABLE', `${name} is not available to agents in this release.`, 400);
    }
    if (info.availability !== 'delegable') {
      throw codedError('CAPABILITY_NOT_DELEGABLE', `${name} cannot be delegated to an agent.`, 400);
    }
    if (!info.sponsorRoles.includes(sponsorRole)) {
      throw codedError('SPONSOR_ROLE_INSUFFICIENT',
        `Your project role does not include ${name}, so it cannot be delegated.`, 403);
    }
    out.add(name);
  }
  return [...out].sort();
}

// Builds the stored policy. Unknown fields are rejected; omitted limits take
// conservative defaults; execution switches cannot be enabled.
function normalizePolicy(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('INVALID_POLICY', 'Delegation limits must be an object.', 400);
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(POLICY_LIMITS, key)) {
      if (Object.prototype.hasOwnProperty.call(FIXED_POLICY, key)) {
        throw codedError('POLICY_FIELD_FIXED', `${key} cannot be changed in this release.`, 400);
      }
      throw codedError('INVALID_POLICY', `Unknown delegation limit: ${key.slice(0, 64)}.`, 400);
    }
  }
  const policy = { schema: DELEGATION_POLICY_SCHEMA, ...FIXED_POLICY };
  for (const [key, bounds] of Object.entries(POLICY_LIMITS)) {
    const raw = value[key] === undefined ? bounds.default : value[key];
    if (!Number.isSafeInteger(raw) || raw < bounds.min || raw > bounds.max) {
      throw codedError('INVALID_POLICY', `${key} must be an integer from ${bounds.min} to ${bounds.max}.`, 400);
    }
    policy[key] = raw;
  }
  return policy;
}

function normalizeDisclosure(value) {
  const profile = value === undefined ? 'identifiers' : value;
  if (!DISCLOSURE_PROFILES.includes(profile)) {
    throw codedError('INVALID_DISCLOSURE', `Disclosure must be one of: ${DISCLOSURE_PROFILES.join(', ')}.`, 400);
  }
  return profile;
}

function normalizeLifetimeSeconds(value) {
  const seconds = value === undefined ? DEFAULT_DELEGATION_SECONDS : value;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_DELEGATION_SECONDS || seconds > MAX_DELEGATION_SECONDS) {
    throw codedError('INVALID_EXPIRY',
      `Delegation lifetime must be between ${MIN_DELEGATION_SECONDS} and ${MAX_DELEGATION_SECONDS} seconds.`, 400);
  }
  return seconds;
}

function publicCatalog() {
  return Object.entries(CAPABILITIES).map(([name, info]) => ({
    name,
    availability: info.availability,
    ...(info.phase ? { plannedPhase: info.phase } : {}),
    ...(info.description ? { description: info.description } : {}),
    ...(info.sponsorRoles ? { sponsorRoles: [...info.sponsorRoles] } : {}),
  }));
}

module.exports = {
  CAPABILITIES,
  DELEGATION_POLICY_SCHEMA,
  DISCLOSURE_PROFILES,
  POLICY_LIMITS,
  FIXED_POLICY,
  READ_ROLES,
  WRITE_ROLES,
  MANAGE_ROLES,
  MIN_DELEGATION_SECONDS,
  MAX_DELEGATION_SECONDS,
  DEFAULT_DELEGATION_SECONDS,
  capabilityInfo,
  isDelegable,
  sponsorRolesFor,
  normalizeCapabilities,
  normalizePolicy,
  normalizeDisclosure,
  normalizeLifetimeSeconds,
  publicCatalog,
  codedError,
};
