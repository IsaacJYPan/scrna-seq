#!/usr/bin/env node
'use strict';

process.env.RUN_NATIVE_UI_ACCEPTANCE = 'true';
require('./verify-compose-private-compute');
