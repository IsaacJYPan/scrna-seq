/**
 * Compatibility import for the removed SQLite module.
 *
 * The app runtime is Postgres-only. New code should import `./pgDatabase`
 * directly; this file exists only so accidental legacy imports resolve to the
 * runtime data layer instead of reintroducing SQLite.
 */

'use strict';

module.exports = require('./pgDatabase');
