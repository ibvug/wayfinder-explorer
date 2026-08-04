#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { startExplorerServer } from "./service/http-server.ts";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Wayfinder Explorer M3

Usage:
  npm run build
  npm start -- <campaign-root> [--port 44993] [--data-root <directory>] [--no-watch]

The service binds only to 127.0.0.1.
`;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!parsed.campaignRoot) {
    process.stderr.write(HELP);
    process.exitCode = 2;
    return;
  }

  const server = await startExplorerServer({
    campaignRoot: parsed.campaignRoot,
    dataRoot: parsed.dataRoot,
    watch: parsed.watch,
    port: parsed.port,
    assetsRoot: path.join(PROJECT_ROOT, "dist", "web"),
  });

  process.stdout.write(`Wayfinder Explorer\n${server.origin}\nCampaign: ${server.store.campaignRoot}\n`);

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await server.close();
  };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
}

interface ParsedArguments {
  campaignRoot?: string;
  dataRoot?: string;
  port: number;
  watch: boolean;
  help: boolean;
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const parsed: ParsedArguments = { port: 44993, watch: true, help: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--no-watch") {
      parsed.watch = false;
    } else if (argument === "--port") {
      parsed.port = parsePort(arguments_[++index]);
    } else if (argument === "--data-root") {
      const value = arguments_[++index];
      if (!value) {
        throw new Error("--data-root requires a directory.");
      }
      parsed.dataRoot = path.resolve(value);
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option ${argument}.`);
    } else if (!parsed.campaignRoot) {
      parsed.campaignRoot = path.resolve(argument);
    } else {
      throw new Error(`Unexpected argument ${argument}.`);
    }
  }
  return parsed;
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port ${JSON.stringify(value)}.`);
  }
  return port;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
