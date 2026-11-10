'use strict';

// Errors that carry a stable machine-readable `code` (and optionally an HTTP
// `status`) so route handlers can map them to public responses without parsing
// messages. Shared by every backend module instead of per-file copies.
function codedError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

module.exports = { codedError };
