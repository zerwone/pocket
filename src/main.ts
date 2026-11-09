#!/usr/bin/env node
import { run } from './cli.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`pocket: ${e?.stack ?? e}\n`);
    process.exitCode = 70;
  },
);
