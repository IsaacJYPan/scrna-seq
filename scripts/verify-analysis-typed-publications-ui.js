#!/usr/bin/env node
'use strict';

// Completed R workflow findings pass through the real retained-sharing lifecycle.
require('./verify-analysis-publications-ui').main({ typedResults: true }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
