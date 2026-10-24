#!/usr/bin/env node
'use strict';
require('./verify-analysis-publications-ui.js').main({ sharedLinks: true }).catch(error => { console.error(error.message); process.exitCode = 1; });
