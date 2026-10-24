#!/usr/bin/env node
'use strict';

require('./verify-analysis-publications-ui').main({ embeddingResults: true }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
