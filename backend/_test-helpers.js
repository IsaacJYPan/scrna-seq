'use strict';

// Small shared fixtures for backend tests. Underscore-prefixed so Vitest does
// not treat this file as a suite.

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

async function seedProject(ownerUserId, name = 'P') {
  const db = require('./pgDatabase');
  const org = await db.createOrganizationForUser(ownerUserId, { name: 'Acme' });
  return db.createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

module.exports = { silentLogger, seedProject };
