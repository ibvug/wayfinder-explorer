import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AppServerProtocolError,
  CodexAppServerClient,
  type AppServerInbound,
  type AppServerLifecycleEvent,
} from "../src/codex/app-server-client.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(TEST_DIRECTORY, "fixtures", "fake-app-server.ts");

test("initializes once and dispatches interleaved app-server responses and notifications", async (context) => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FAKE_SERVER, "normal"],
    requestTimeoutMs: 2_000,
  });
  context.after(() => client.close());
  const events: AppServerInbound[] = [];
  client.subscribe((event) => events.push(event));

  const first = await client.start();
  const second = await client.start();
  assert.equal(first.userAgent, "fake-codex/1");
  assert.equal(second, first);

  const started = await client.request<{ thread: { id: string } }>("thread/start", {});
  assert.equal(started.thread.id, "thread-fake");
  await client.request("turn/start", { threadId: started.thread.id, input: [] });
  await waitFor(() => events.some(({ message }) => message.method === "turn/completed"));

  assert.deepEqual(
    events.map(({ kind, message }) => `${kind}:${message.method}`),
    [
      "notification:thread/started",
      "notification:turn/started",
      "notification:item/agentMessage/delta",
      "notification:item/agentMessage/delta",
      "notification:item/completed",
      "notification:turn/completed",
    ],
  );
});

test("starts an app-server exposed through a Windows command shim", {
  skip: process.platform !== "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wayfinder codex shim-"));
  const shim = path.join(directory, "fake-codex.cmd");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${FAKE_SERVER}" normal\r\n`, "utf8");
  context.after(() => rm(directory, { force: true, recursive: true }));

  const client = new CodexAppServerClient({
    command: shim,
    args: [],
    requestTimeoutMs: 2_000,
  });
  context.after(() => client.close());

  const initialized = await client.start();
  assert.equal(initialized.userAgent, "fake-codex/1");
});

test("treats malformed stdout as a protocol failure and closes the transport", async (context) => {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: [FAKE_SERVER, "malformed"],
    requestTimeoutMs: 2_000,
  });
  context.after(() => client.close());
  const lifecycle: AppServerLifecycleEvent[] = [];
  client.subscribeLifecycle((event) => lifecycle.push(event));

  await client.start();
  await waitFor(() => lifecycle.some(({ type }) => type === "protocol_error"));

  const protocolEvent = lifecycle.find(({ type }) => type === "protocol_error");
  assert.ok(protocolEvent?.type === "protocol_error");
  assert.ok(protocolEvent.error instanceof AppServerProtocolError);
  assert.equal(client.ready, false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for fake app-server output.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
