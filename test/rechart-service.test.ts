import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RechartProposal } from "../src/charting/model.ts";
import {
  RechartService,
  RechartValidationError,
} from "../src/charting/rechart-service.ts";
import { inspectCampaignAs } from "../src/wayfinder.ts";
import { overlayPathFor } from "../src/overlay.ts";

test("a pending deletion is visible and must be reassessed before deletion", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-rechart-pending-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "issues"));
  await writeFile(path.join(root, "map.md"), `# Pending deletion test

## Destination

Close every planning question.

## Starting state

One confirmed premise and one open question.

## Evidence scope

- Current project

## Decisions so far

- [Premise](issues/01-premise.md) — confirmed

## Not yet specified

## Out of scope

- Reality execution
`);
  await writeFile(path.join(root, "issues/01-premise.md"), issue("Premise", "resolved"));
  await writeFile(path.join(root, "issues/02-obsolete.md"), issue("Obsolete branch", "open"));

  const campaignId = "campaign-acde00000001";
  const service = new RechartService({
    campaignRoot: root,
    campaignId,
    dataRoot: path.join(root, ".explorer-data"),
  });
  const before = await inspectCampaignAs(root, campaignId);
  await service.apply(proposal(before.revision, [{
    kind: "pending_delete",
    issueId: "02",
    reason: "The confirmed premise made this branch unnecessary.",
  }]), new Set());

  const pending = await inspectCampaignAs(root, campaignId);
  const location = pending.locations.find(({ id }) => id === "02");
  assert.equal(location?.rechartState, "pending_delete");
  assert.match(location?.pendingDeletionReason ?? "", /unnecessary/);

  await assert.rejects(
    service.apply(proposal(pending.revision, []), new Set()),
    (error) => error instanceof RechartValidationError && /重新评估/.test(error.message),
  );

  await service.apply(proposal(pending.revision, [{
    kind: "pending_delete",
    issueId: "02",
    reason: "It remains unnecessary after reassessment.",
  }]), new Set());
  const deleted = await inspectCampaignAs(root, campaignId);
  assert.deepEqual(deleted.locations.map(({ id }) => id), ["01"]);
  assert.match(
    await readFile(path.join(root, "history/unexplored/02-obsolete.md"), "utf8"),
    /## Archived without exploration[\s\S]*remains unnecessary/,
  );
});

test("restoring one rechart change only reverts that issue's current change", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-rechart-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "issues"));
  await writeFile(path.join(root, "map.md"), `# Restore test

## Destination

Close every planning question.

## Starting state

One confirmed premise and one open question.

## Evidence scope

- Current project

## Decisions so far

- [Premise](issues/01-premise.md) — confirmed

## Not yet specified

## Out of scope

- Reality execution
`);
  await writeFile(path.join(root, "issues/01-premise.md"), issue("Premise", "resolved"));
  await writeFile(path.join(root, "issues/02-open.md"), issue("Original question", "open"));

  const campaignId = "campaign-acde00000002";
  const service = new RechartService({
    campaignRoot: root,
    campaignId,
    dataRoot: path.join(root, ".explorer-data"),
  });
  const before = await inspectCampaignAs(root, campaignId);
  const change = await service.apply(proposal(before.revision, [{
    kind: "update",
    issueId: "02",
    title: "Updated question",
    type: "grilling",
    question: "What changed after the premise?",
    blockedBy: [],
    reason: "The latest answer sharpened the open question.",
  }]), new Set());

  assert.equal(change.files.find(({ locationId }) => locationId === "02")?.operation, "updated");
  assert.match(await readFile(path.join(root, "issues/02-open.md"), "utf8"), /Updated question/);

  await service.restore(change.id, "02");
  assert.match(await readFile(path.join(root, "issues/02-open.md"), "utf8"), /Original question/);
  await assert.rejects(
    service.restore(change.id, "02"),
    (error) => error instanceof RechartValidationError && /已经不再是这次重绘后的版本/.test(error.message),
  );
});

test("an older rechart change cannot overwrite a later change to the same issue", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-rechart-stale-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "issues"));
  await writeFile(path.join(root, "map.md"), `# Stale restore test

## Destination

Close every planning question.

## Starting state

One confirmed premise and one open question.

## Evidence scope

- Current project

## Decisions so far

- [Premise](issues/01-premise.md) — confirmed

## Not yet specified

## Out of scope

- Reality execution
`);
  await writeFile(path.join(root, "issues/01-premise.md"), issue("Premise", "resolved"));
  await writeFile(path.join(root, "issues/02-open.md"), issue("Original question", "open"));

  const campaignId = "campaign-acde00000003";
  const service = new RechartService({
    campaignRoot: root,
    campaignId,
    dataRoot: path.join(root, ".explorer-data"),
  });
  const first = await inspectCampaignAs(root, campaignId);
  const firstChange = await service.apply(proposal(first.revision, [{
    kind: "update",
    issueId: "02",
    title: "First revision",
    type: "grilling",
    question: "What changed first?",
    blockedBy: [],
    reason: "First rechart.",
  }]), new Set());
  const second = await inspectCampaignAs(root, campaignId);
  await service.apply(proposal(second.revision, [{
    kind: "update",
    issueId: "02",
    title: "Second revision",
    type: "grilling",
    question: "What changed second?",
    blockedBy: [],
    reason: "Second rechart.",
  }]), new Set());

  await assert.rejects(
    service.restore(firstChange.id, "02"),
    (error) => error instanceof RechartValidationError && /已经不再是这次重绘后的版本/.test(error.message),
  );
  assert.match(await readFile(path.join(root, "issues/02-open.md"), "utf8"), /Second revision/);
});

test("ending an exploration archives it without creating an answer and reconciles dependents", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-rechart-end-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "issues"));
  await writeFile(path.join(root, "map.md"), `# End exploration test

## Destination

Close every planning question.

## Starting state

One confirmed premise and two open questions.

## Evidence scope

- Current project

## Decisions so far

- [Premise](issues/01-premise.md) — confirmed

## Not yet specified

## Out of scope

- Reality execution
`);
  await writeFile(path.join(root, "issues/01-premise.md"), issue("Premise", "resolved"));
  await writeFile(path.join(root, "issues/02-ended.md"), issue("Ended exploration", "open"));
  await writeFile(path.join(root, "issues/03-dependent.md"), `# Dependent question

Type: grilling
Status: open
Blocked by: 02

## Question

What remains after the optional exploration?
`);

  const campaignId = "campaign-acde00000004";
  const service = new RechartService({
    campaignRoot: root,
    campaignId,
    dataRoot: path.join(root, ".explorer-data"),
  });
  const before = await inspectCampaignAs(root, campaignId);
  const change = await service.apply({
    ...proposal(before.revision, [
      {
        kind: "end",
        issueId: "02",
        reason: "The claimant explicitly ended this exploration.",
      },
      {
        kind: "update",
        issueId: "03",
        title: "Dependent question",
        type: "grilling",
        question: "What remains after the optional exploration was excluded?",
        blockedBy: [],
        reason: "The ended optional branch is no longer a prerequisite.",
      },
    ]),
    confirmedLocationId: "02",
    triggerKind: "exploration_ended",
    evidenceRefs: [`campaign:${before.revision}`, "location:02:exploration-ended"],
  }, new Set());

  await assert.rejects(readFile(path.join(root, "issues/02-ended.md")), { code: "ENOENT" });
  assert.match(
    await readFile(path.join(root, "history/unfinished/02-ended.md"), "utf8"),
    /## Exploration ended[\s\S]*explicitly ended/,
  );
  const after = await inspectCampaignAs(root, campaignId);
  assert.deepEqual(after.locations.map(({ id }) => id), ["01", "03"]);
  assert.equal(after.locations.find(({ id }) => id === "03")?.status, "frontier");
  assert.equal(after.mapNodes.some(({ id }) => id === "02"), false);
  assert.equal(change.files.some(({ path }) => path.startsWith("history/unfinished/")), true);
  await assert.rejects(
    service.restore(change.id, "02"),
    /不是可恢复的机械重绘变化/,
    "ended exploration is not a mechanical restore path",
  );
});

test("opening the rechart service rolls back a partially committed prepared transaction", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-rechart-crash-"));
  const dataRoot = path.join(root, ".explorer-data");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "issues"));
  const mapBefore = `# Crash recovery test

## Destination

Close every planning question.

## Starting state

One confirmed premise and one open question.

## Evidence scope

- Current project

## Decisions so far

- [Premise](issues/01-premise.md) — confirmed

## Not yet specified

## Out of scope

- Reality execution
`;
  const issueBefore = issue("Original question", "open");
  await writeFile(path.join(root, "map.md"), mapBefore);
  await writeFile(path.join(root, "issues/01-premise.md"), issue("Premise", "resolved"));
  await writeFile(path.join(root, "issues/02-open.md"), issueBefore);

  const campaignId = "campaign-acde00000005";
  const before = await inspectCampaignAs(root, campaignId);
  const issueAfter = issue("Partially installed question", "open");
  const mapAfter = mapBefore.replace("Reality execution", "A changed boundary");
  await writeFile(path.join(root, "issues/02-open.md"), issueAfter);

  const changeId = "rechart-change-crash-recovery";
  const changesDirectory = path.join(
    path.dirname(overlayPathFor(campaignId, dataRoot)),
    "rechart-changes",
  );
  await mkdir(changesDirectory, { recursive: true });
  await writeFile(path.join(changesDirectory, `${changeId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    phase: "prepared",
    id: changeId,
    campaignId,
    confirmedLocationId: "01",
    sourceRevisionBefore: before.revision,
    sourceRevisionAfter: "sha256:not-fully-installed",
    createdAt: "2026-08-07T00:00:00.000Z",
    targets: [
      {
        locationId: "02",
        relativePath: "issues/02-open.md",
        beforeBase64: Buffer.from(issueBefore).toString("base64"),
        afterBase64: Buffer.from(issueAfter).toString("base64"),
      },
      {
        relativePath: "map.md",
        beforeBase64: Buffer.from(mapBefore).toString("base64"),
        afterBase64: Buffer.from(mapAfter).toString("base64"),
      },
    ],
  })}\n`);

  await RechartService.open({ campaignRoot: root, campaignId, dataRoot });
  assert.equal(await readFile(path.join(root, "issues/02-open.md"), "utf8"), issueBefore);
  assert.equal(await readFile(path.join(root, "map.md"), "utf8"), mapBefore);
  await assert.rejects(readFile(path.join(changesDirectory, `${changeId}.json`)), { code: "ENOENT" });
});

function proposal(
  sourceRevision: string,
  issueChanges: RechartProposal["issueChanges"],
): RechartProposal {
  return {
    id: `proposal-${sourceRevision.slice(-8)}`,
    sourceRevision,
    sourceTurnId: "turn-test",
    confirmedLocationId: "01",
    triggerKind: "answer_confirmed",
    createdAt: "2026-08-07T00:00:00.000Z",
    issueChanges,
    fog: [],
    outOfScope: ["Reality execution"],
    reviewConflicts: [],
    explorationUpdates: [],
    summary: "Reassessed the remaining branch.",
    evidenceRefs: ["location:01:answer"],
  };
}

function issue(title: string, status: "open" | "resolved"): string {
  return `# ${title}

Type: grilling
Status: ${status}

## Question

What remains to decide?
${status === "resolved" ? "\n## Answer\n\nThe premise is confirmed.\n" : ""}`;
}
