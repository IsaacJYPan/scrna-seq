'use strict';

/**
 * Canonical server-side R session key derivation.
 *
 * The owner prefix is always built from authenticated/database state. Callers may
 * supply an object id only after the relevant ownership/scope check has succeeded.
 */
function sanitizeObjectIdSegment(value) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return cleaned.replace(/^[._-]+/, '');
}

function deriveRObjectStateKey(ownerUserId, objectId) {
  if (ownerUserId === undefined || ownerUserId === null || ownerUserId === '') {
    throw new Error('An owner user id is required to derive an R state key.');
  }
  const base = `user-${ownerUserId}`;
  const objectSegment = sanitizeObjectIdSegment(objectId);
  return objectSegment ? `${base}:obj-${objectSegment}` : base;
}

function deriveRStateKey(user, objectId) {
  if (!user || (user.id === undefined || user.id === null)) {
    throw new Error('Authenticated user is required to derive an R state key.');
  }
  return deriveRObjectStateKey(user.id, objectId);
}

module.exports = {
  sanitizeObjectIdSegment,
  deriveRObjectStateKey,
  deriveRStateKey,
};
