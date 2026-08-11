import assert from "node:assert/strict";
import test from "node:test";

import {
  ApprovalBroker,
  type ApprovalTransport,
} from "../src/codex/approval.ts";
import type { RequestId } from "../schemas/codex-app-server/RequestId.ts";

test("ordinary tool approval cannot bypass canonical map confirmation", () => {
  const transport = new RecordingApprovalTransport();
  const broker = new ApprovalBroker(
    transport,
    () => new Date("2026-08-07T00:00:00.000Z"),
    { campaignRoot: "/workspace/campaign" },
  );

  const canonicalPatch = broker.capture({
    id: "patch-map",
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-1",
      cwd: "/workspace/campaign",
      fileChanges: { "map.md": { type: "update" } },
    },
  });
  assert.match(canonicalPatch.blockedReason ?? "", /规范 map\.md/);
  broker.resolve(canonicalPatch.id, "approve");
  assert.deepEqual(transport.responses.at(-1)?.result, {
    decision: {
      denied: {
        rejection: canonicalPatch.blockedReason,
      },
    },
  });

  const ordinaryPatch = broker.capture({
    id: "patch-source",
    method: "applyPatchApproval",
    params: {
      conversationId: "thread-1",
      cwd: "/workspace/campaign",
      fileChanges: { "src/example.ts": { type: "update" } },
    },
  });
  assert.equal(ordinaryPatch.blockedReason, undefined);

  const unknownModernPatch = broker.capture({
    id: "patch-unknown",
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", itemId: "item-1" },
  });
  assert.match(unknownModernPatch.blockedReason ?? "", /没有提供文件变化目标/);

  const broadPermission = broker.capture({
    id: "permission-root",
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      permissions: {
        fileSystem: { read: null, write: ["/workspace/campaign"] },
      },
    },
  });
  assert.match(broadPermission.blockedReason ?? "", /规范地图文件/);

  const canonicalCommand = broker.capture({
    id: "command-map",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      cwd: "/workspace/campaign",
      command: "node -e \"require('fs').writeFileSync('map.md','x')\"",
    },
  });
  assert.match(canonicalCommand.blockedReason ?? "", /普通命令不能直接修改/);

  const readOnlyCommand = broker.capture({
    id: "command-read",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      cwd: "/workspace/campaign",
      command: "node --version",
    },
  });
  assert.equal(readOnlyCommand.blockedReason, undefined);
});

class RecordingApprovalTransport implements ApprovalTransport {
  responses: Array<{ id: RequestId; result: unknown }> = [];
  errors: Array<{ id: RequestId; code: number; message: string }> = [];

  respond(id: RequestId, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.errors.push({ id, code, message });
  }
}
