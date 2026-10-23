#!/usr/bin/env node
'use strict';

// The same genuine publication lifecycle, with exact saved-analysis references.
require('./verify-analysis-publications-ui').main({ linkedResults: true }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
