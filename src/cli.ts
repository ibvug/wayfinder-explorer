#!/usr/bin/env node

import { inspectCampaign } from "./index.ts";

const HELP = `Wayfinder Explorer M0

Usage:
  node src/cli.ts inspect [campaign-root] [--json]
  npm run inspect -- [campaign-root] [--json]

The campaign root must contain map.md and issues/*.md.
`;

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.includes("--help") || rawArguments.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const argumentsWithoutCommand = rawArguments[0] === "inspect"
    ? rawArguments.slice(1)
    : rawArguments;
  const json = argumentsWithoutCommand.includes("--json");
  const positional = argumentsWithoutCommand.filter((argument) => !argument.startsWith("-"));
  const unknownOptions = argumentsWithoutCommand.filter(
    (argument) => argument.startsWith("-") && argument !== "--json",
  );

  if (unknownOptions.length || positional.length > 1) {
    process.stderr.write(`${HELP}\nInvalid arguments: ${unknownOptions.join(" ")}\n`);
    process.exitCode = 2;
    return;
  }

  const projection = await inspectCampaign(positional[0] ?? process.cwd());
  if (json) {
    process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
  } else {
    printHumanSummary(projection);
  }

  if (projection.summary.blockingDiagnostics > 0) {
    process.exitCode = 1;
  }
}

function printHumanSummary(projection: Awaited<ReturnType<typeof inspectCampaign>>): void {
  const frontier = projection.locations.filter((location) => location.status === "frontier");
  const summary = projection.summary;
  const lines = [
    `Campaign: ${projection.title}`,
    `Root: ${projection.root}`,
    `Revision: ${projection.revision}`,
    "",
    `Locations: ${summary.total} (${summary.resolved} resolved, ${summary.frontier} frontier, ${summary.blocked} blocked)`,
    `Trail: ${projection.trail.length} stops`,
    `Fog: ${summary.fog} areas`,
    `Diagnostics: ${summary.blockingDiagnostics} blocking, ${summary.warnings} warnings`,
  ];

  if (frontier.length) {
    lines.push("", "Frontier:");
    for (const location of frontier) {
      lines.push(`  ${location.id}  ${location.title}`);
    }
  }

  if (projection.diagnostics.length) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of projection.diagnostics) {
      const source = diagnostic.source
        ? `${diagnostic.source.path}:${diagnostic.source.startLine}`
        : "campaign";
      lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${source}`);
      lines.push(`    ${diagnostic.message}`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
