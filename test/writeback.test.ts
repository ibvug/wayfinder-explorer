import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { DecisionProposal } from "../src/expedition/model.ts";
import { overlayPathFor } from "../src/overlay.ts";
import { inspectCampaign } from "../src/wayfinder.ts";
import {
  WritebackConflictError,
  WritebackService,
} from "../src/writeback/writeback-service.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BRAIN_FIXTURE = path.resolve(TEST_DIRECTORY, "fixtures/personal-brain-v1");
const ISSUE_08 = "issues/08-lock-v1-acceptance-boundary.md";

test("previews and confirms 08 while unlocking only 09", async (context) => {
  const { campaignRoot, dataRoot } = await disposableCampaign(context);
  const before = await inspectCampaign(campaignRoot);
  const service = await WritebackService.open({
    campaignRoot,
    campaignId: before.id,
    dataRoot,
  });
  const proposal = proposalFor(before.revision);
  const plan = await service.createPlan({
    expeditionId: "expedition-00000000-0000-4000-8000-000000000008",
    locationId: "08",
    proposal,
    expectedSourceRevision: before.revision,
  });

  assert.deepEqual(
    plan.impact.map(({ locationId, beforeStatus, afterStatus }) => [locationId, beforeStatus, afterStatus]),
    [
      ["08", "frontier", "resolved"],
      ["09", "blocked", "frontier"],
    ],
  );
  assert.match(plan.files.find(({ path: sourcePath }) => sourcePath === ISSUE_08)?.diff ?? "", /\+## Answer/);
  assert.match(plan.files.find(({ path: sourcePath }) => sourcePath === ISSUE_08)?.diff ?? "", /\+### 验收原则/);
  assert.doesNotMatch(plan.files.find(({ path: sourcePath }) => sourcePath === ISSUE_08)?.diff ?? "", /\+## 验收原则/);
  assert.match(plan.files.find(({ path: sourcePath }) => sourcePath === "map.md")?.diff ?? "", /\+.*08-lock-v1-acceptance-boundary/);

  let confirmedPlanId: string | undefined;
  await service.confirm(plan.id, {
    expectedSourceRevision: before.revision,
    proposalHash: plan.proposalHash,
    onConfirmed: async (confirmed) => {
      confirmedPlanId = confirmed.id;
    },
  });
  assert.equal(confirmedPlanId, plan.id);

  const after = await inspectCampaign(campaignRoot);
  assert.equal(after.revision, plan.resultingSourceRevision);
  assert.deepEqual(after.summary, {
    total: 14,
    resolved: 8,
    frontier: 1,
    blocked: 5,
    fog: 4,
    blockingDiagnostics: 0,
    warnings: 0,
  });
  assert.equal(after.locations.find(({ id }) => id === "08")?.status, "resolved");
  assert.equal(after.locations.find(({ id }) => id === "09")?.status, "frontier");
  assert.equal(after.locations.find(({ id }) => id === "11")?.status, "blocked");
  assert.deepEqual(after.locations.find(({ id }) => id === "11")?.blockers, ["08", "09"]);
  assert.match(await readFile(path.join(campaignRoot, ISSUE_08), "utf8"), /Status: resolved[\s\S]*## Answer/);
  assert.match(await readFile(path.join(campaignRoot, "map.md"), "utf8"), /\[锁定 V1 的端到端验收边界\]\(issues\/08-lock-v1-acceptance-boundary\.md\)/);
});

test("rejects confirmation after an external edit without losing either version", async (context) => {
  const { campaignRoot, dataRoot } = await disposableCampaign(context);
  const before = await inspectCampaign(campaignRoot);
  const service = await WritebackService.open({
    campaignRoot,
    campaignId: before.id,
    dataRoot,
  });
  const plan = await service.createPlan({
    expeditionId: "expedition-00000000-0000-4000-8000-000000000008",
    locationId: "08",
    proposal: proposalFor(before.revision),
    expectedSourceRevision: before.revision,
  });
  const issue08Before = await readFile(path.join(campaignRoot, ISSUE_08));
  const issue09Path = path.join(campaignRoot, "issues/09-define-minimum-memory-unit-contract.md");
  const externalVersion = `${await readFile(issue09Path, "utf8")}\n<!-- external note -->\n`;
  await writeFile(issue09Path, externalVersion);

  await assert.rejects(
    service.confirm(plan.id, {
      expectedSourceRevision: before.revision,
      proposalHash: plan.proposalHash,
      onConfirmed: async () => assert.fail("conflicting plan must not confirm"),
    }),
    WritebackConflictError,
  );
  assert.equal(await readFile(issue09Path, "utf8"), externalVersion);
  assert.deepEqual(await readFile(path.join(campaignRoot, ISSUE_08)), issue08Before);
});

test("recovers an unfinished journal before accepting new writebacks", async (context) => {
  const { campaignRoot, dataRoot } = await disposableCampaign(context);
  const before = await inspectCampaign(campaignRoot);
  const issuePath = path.join(campaignRoot, ISSUE_08);
  const mapPath = path.join(campaignRoot, "map.md");
  const [issueBytes, mapBytes, issueStat, mapStat] = await Promise.all([
    readFile(issuePath),
    readFile(mapPath),
    stat(issuePath),
    stat(mapPath),
  ]);
  const campaignData = path.dirname(overlayPathFor(before.id, dataRoot));
  const transactionDirectory = path.join(campaignData, "transactions");
  await mkdir(transactionDirectory, { recursive: true });
  await writeFile(issuePath, "partially replaced\n");
  await writeFile(path.join(transactionDirectory, "writeback-crash.json"), `${JSON.stringify({
    schemaVersion: 1,
    campaignId: before.id,
    planId: "writeback-crash",
    expeditionId: "expedition-00000000-0000-4000-8000-000000000008",
    phase: "issue_renamed",
    createdAt: "2026-08-02T00:00:00.000Z",
    targets: [
      {
        relativePath: ISSUE_08,
        temporaryRelativePath: `issues/.${path.basename(ISSUE_08)}.writeback-crash.tmp`,
        beforeBase64: issueBytes.toString("base64"),
        afterBase64: Buffer.from("partially replaced\n").toString("base64"),
        mode: issueStat.mode & 0o777,
      },
      {
        relativePath: "map.md",
        temporaryRelativePath: ".map.md.writeback-crash.tmp",
        beforeBase64: mapBytes.toString("base64"),
        afterBase64: mapBytes.toString("base64"),
        mode: mapStat.mode & 0o777,
      },
    ],
  })}\n`);

  await WritebackService.open({
    campaignRoot,
    campaignId: before.id,
    dataRoot,
  });
  assert.deepEqual(await readFile(issuePath), issueBytes);
  assert.deepEqual(await readFile(mapPath), mapBytes);
  await assert.rejects(readFile(path.join(transactionDirectory, "writeback-crash.json")), /ENOENT/);
});

function proposalFor(sourceRevision: string): DecisionProposal {
  return {
    id: "proposal-00000000-0000-4000-8000-000000000008",
    answerMarkdown: [
      "## 验收原则",
      "",
      "V1 必须通过一条从输入、形成记忆到按 Current Input 返回上下文的端到端主路径，并对每一步给出可观察断言。",
      "",
      "## 最小场景集",
      "",
      "### 对话来源",
      "",
      "必须形成可追溯且能在后续 Current Input 下激活的记忆。",
    ].join("\n"),
    rationale: ["完整主路径能证明三层契约协同成立。"],
    evidenceRefs: ["location:08:question", "turn:turn-2"],
    rejectedAlternatives: ["只验收单个接口。"],
    assumptions: ["验收使用固定输入。"],
    revisitConditions: ["首个真实集成暴露新的必要主路径。"],
    confidence: "high",
    sourceRevision,
    sourceTurnId: "turn-proposal",
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

async function disposableCampaign(context: test.TestContext): Promise<{
  campaignRoot: string;
  dataRoot: string;
}> {
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-writeback-campaign-"));
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-writeback-data-"));
  await cp(PERSONAL_BRAIN_FIXTURE, campaignRoot, { recursive: true });
  context.after(() => Promise.all([
    rm(campaignRoot, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
  ]));
  return { campaignRoot, dataRoot };
}
