#!/usr/bin/env node
/**
 * bin/netrecon.js
 * ---------------------------------------------------------------------------
 * CLI entry point: parse arguments, run the capture, print the summary and
 * write the JSON report.
 *
 *   node bin/netrecon.js https://example.com -t 20 -o report.json
 */

import { USAGE, parseCli } from '../src/cli.js';
import { runRecon } from '../src/recon.js';
import { defaultReportPath, printSummary, writeReport } from '../src/reporter.js';

async function main() {
  // -- Parse arguments -------------------------------------------------------
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  // -- Ctrl+C stops observation early but still writes the report ----------
  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.error('\nInterrupted: finishing up and writing report… (Ctrl+C again to force quit)');
    controller.abort();
    process.once('SIGINT', () => process.exit(130));
  });

  // Progress goes to stderr so stdout stays clean for the summary.
  const log = (msg) => console.error(`[netrecon] ${msg}`);

  // -- Run ---------------------------------------------------------------------
  const report = await runRecon(opts, { log, signal: controller.signal });
  const outPath = await writeReport(report, opts.outFile ?? defaultReportPath(opts.outDir, opts.url));
  printSummary(report, outPath);
}

main().catch((err) => {
  console.error(`[netrecon] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
