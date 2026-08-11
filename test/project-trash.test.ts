import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SystemProjectTrash } from "../src/project/trash.ts";

test("moves a managed project into the recoverable macOS Trash directory", async (context) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "wayfinder-project-trash-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const homeDirectory = path.join(sandbox, "home");
  const projectRoot = path.join(sandbox, "projects", "待删除旅程");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "map.md"), "# Recoverable\n");

  const trash = new SystemProjectTrash({ platform: "darwin", homeDirectory });
  await trash.moveToTrash(projectRoot);

  await assert.rejects(stat(projectRoot), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  const entries = await readdir(path.join(homeDirectory, ".Trash"));
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /^待删除旅程 — Wayfinder [a-f0-9]{8}$/);
  assert.equal(
    await readFile(path.join(homeDirectory, ".Trash", entries[0]!, "map.md"), "utf8"),
    "# Recoverable\n",
  );
});

test("uses the Windows Recycle Bin instead of permanent deletion", async (context) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "wayfinder-project-trash-win-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const projectRoot = path.join(sandbox, "managed-project");
  await mkdir(projectRoot);
  let captured: { executable: string; arguments_: string[] } | undefined;
  const trash = new SystemProjectTrash({
    platform: "win32",
    runCommand: async (executable, arguments_) => {
      captured = { executable, arguments_ };
      return "";
    },
  });

  await trash.moveToTrash(projectRoot);

  assert.ok(captured);
  assert.match(captured.executable, /powershell\.exe$/i);
  const encodedCommand = captured.arguments_.at(-1)!;
  const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
  assert.match(script, /RecycleOption\]::SendToRecycleBin/);
  assert.match(script, new RegExp(Buffer.from(projectRoot, "utf8").toString("base64")));
});

test("uses the freedesktop trash command on Linux", async (context) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "wayfinder-project-trash-linux-"));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const projectRoot = path.join(sandbox, "managed-project");
  await mkdir(projectRoot);
  let captured: { executable: string; arguments_: string[] } | undefined;
  const trash = new SystemProjectTrash({
    platform: "linux",
    runCommand: async (executable, arguments_) => {
      captured = { executable, arguments_ };
      return "";
    },
  });

  await trash.moveToTrash(projectRoot);

  assert.deepEqual(captured, {
    executable: "gio",
    arguments_: ["trash", "--", projectRoot],
  });
});
