import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SystemDirectoryPicker } from "../src/project/directory-picker.ts";

test("opens a foreground Windows folder chooser and returns its selected directory", async (context) => {
  const selectedDirectory = await mkdtemp(path.join(tmpdir(), "wayfinder-picker-测试-"));
  context.after(() => rm(selectedDirectory, { force: true, recursive: true }));

  let invocation: {
    executable: string;
    arguments_: string[];
    options: { maxBuffer: number; timeout: number; windowsHide?: boolean };
  } | undefined;
  const picker = new SystemDirectoryPicker({
    platform: "win32",
    runCommand: async (executable, arguments_, options) => {
      invocation = { executable, arguments_, options };
      return selectedDirectory;
    },
  });

  assert.equal(await picker.selectDirectory("add-project"), selectedDirectory);
  assert.ok(invocation);
  assert.match(invocation.executable, /powershell\.exe$/i);
  assert.equal(invocation.options.windowsHide, undefined);
  assert.equal(invocation.arguments_.includes("-WindowStyle"), false);
  const encodedCommandIndex = invocation.arguments_.indexOf("-EncodedCommand");
  assert.notEqual(encodedCommandIndex, -1);
  const script = Buffer.from(
    invocation.arguments_[encodedCommandIndex + 1] ?? "",
    "base64",
  ).toString("utf16le");
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /WayfinderOwnerWindow/);
  assert.match(script, /GetLastActivePopup/);
  assert.match(script, /SetWindowPos/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /Timer/);
  assert.match(script, /ShowDialog\(owner\)/);
  assert.doesNotMatch(script, /New-Object System\.Windows\.Forms\.Form/);
  assert.match(script, /选择已有 Wayfinder 项目文件夹/);
});
