'use strict';

// Errors that carry a stable machine-readable code for route and worker mapping.
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = { codedError };
