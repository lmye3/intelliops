'use strict';

const { runEvaluation } = require('./runner');
const result = runEvaluation();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
