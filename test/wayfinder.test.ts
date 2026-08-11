import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDeterministicLayout,
  inspectCampaign,
  openCampaignOverlay,
  setCampaignPlayerFocus,
} from "../src/index.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BRAIN_FIXTURE = path.resolve(
  TEST_DIRECTORY,
  "fixtures/personal-brain-v1",
);

test("projects the Personal Brain fixture into the approved map state", async () => {
  const campaign = await inspectCampaign(PERSONAL_BRAIN_FIXTURE);

  assert.deepEqual(campaign.summary, {
    total: 14,
    resolved: 7,
    frontier: 1,
    blocked: 6,
    fog: 4,
    blockingDiagnostics: 0,
    warnings: 0,
  });
  assert.equal(campaign.diagnostics.length, 0);
  assert.equal(campaign.trail.length, 7);
  assert.deepEqual(
    campaign.locations.filter((location) => location.status === "frontier").map(({ id }) => id),
    ["08"],
  );
  assert.equal(location(campaign, "09").status, "blocked");
  assert.deepEqual(location(campaign, "11").blockers, ["08", "09"]);
  assert.equal(location(campaign, "14").dependencyRank, 5);
  assert.match(location(campaign, "08").question, /哪一组最小但有代表性的端到端场景/);
  assert.equal(location(campaign, "08").sourceRanges.status?.startLine, 4);
  assert.match(campaign.revision, /^sha256:[a-f0-9]{64}$/);

  const secondRead = await inspectCampaign(PERSONAL_BRAIN_FIXTURE);
  assert.equal(secondRead.revision, campaign.revision);
  assert.deepEqual(secondRead.routes, campaign.routes);
});

test("unlocks only locations whose complete dependency set is resolved", async (context) => {
  const root = await createCampaign({
    decisions: [{ id: "01", slug: "start", title: "Start" }],
    issues: [
      issue("01", "start", "Start", "resolved"),
      issue("02", "middle", "Middle", "open", ["01"]),
      issue("03", "branch", "Branch", "open", ["01", "02"]),
      issue("04", "other", "Other", "open", ["01"]),
    ],
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const before = await inspectCampaign(root);
  assert.deepEqual(frontierIds(before), ["02", "04"]);
  assert.equal(location(before, "03").status, "blocked");

  await writeFile(
    path.join(root, "issues/02-middle.md"),
    issue("02", "middle", "Middle", "resolved", ["01"]),
  );
  await writeFile(
    path.join(root, "map.md"),
    mapMarkdown([
      { id: "01", slug: "start", title: "Start" },
      { id: "02", slug: "middle", title: "Middle" },
    ]),
  );

  const after = await inspectCampaign(root);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(frontierIds(after), ["03", "04"]);
  assert.equal(location(after, "03").status, "frontier");
  assert.equal(after.diagnostics.length, 0);
});

test("resolving Personal Brain 08 unlocks only 09 while 11 remains gated", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-personal-brain-impact-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await cp(PERSONAL_BRAIN_FIXTURE, root, { recursive: true });

  const before = await inspectCampaign(root);
  const issue08Path = path.join(root, "issues/08-lock-v1-acceptance-boundary.md");
  const issue08 = await readFile(issue08Path, "utf8");
  await writeFile(
    issue08Path,
    `${issue08.replace("Status: open", "Status: resolved")}\n## Answer\n\n以代表性端到端场景作为 V1 验收边界。\n`,
  );

  const mapPath = path.join(root, "map.md");
  const map = await readFile(mapPath, "utf8");
  await writeFile(
    mapPath,
    map.replace(
      "\n## Not yet specified",
      "\n- [锁定 V1 的端到端验收边界](issues/08-lock-v1-acceptance-boundary.md) — 以代表性端到端场景验收。\n\n## Not yet specified",
    ),
  );

  const after = await inspectCampaign(root);
  const statusChanges = after.locations.flatMap((candidate) => {
    const previous = location(before, candidate.id);
    return previous.status === candidate.status
      ? []
      : [`${candidate.id}:${previous.status}->${candidate.status}`];
  });

  assert.deepEqual(statusChanges, ["08:frontier->resolved", "09:blocked->frontier"]);
  assert.equal(location(after, "11").status, "blocked");
  assert.deepEqual(
    location(after, "11").blockers.filter(
      (blocker) => location(after, blocker).sourceStatus !== "resolved",
    ),
    ["09"],
  );
  assert.equal(after.trail.length, 8);
  assert.equal(after.diagnostics.length, 0);
});

test("reports structural graph damage without inventing reachability", async (context) => {
  const root = await createCampaign({
    decisions: [{ id: "01", slug: "done", title: "Done" }],
    issues: [
      issue("01", "done", "Done", "resolved", ["02"]),
      issue("02", "left", "Left", "open", ["03"]),
      issue("03", "right", "Right", "open", ["02"]),
      issue("04", "lost", "Lost", "open", ["99"]),
    ],
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const campaign = await inspectCampaign(root);
  const codes = new Set(campaign.diagnostics.map(({ code }) => code));

  assert.ok(codes.has("dangling_blocker"));
  assert.ok(codes.has("dependency_cycle"));
  assert.ok(codes.has("resolved_depends_on_unresolved"));
  assert.equal(campaign.summary.blockingDiagnostics, 3);
  assert.deepEqual(frontierIds(campaign), []);
  assert.equal(location(campaign, "04").status, "blocked");
  assert.equal(
    campaign.diagnostics.find(({ code }) => code === "dangling_blocker")?.source?.startLine,
    5,
  );
});

test("validates strict ticket fields and the map decision ledger", async (context) => {
  const root = await createCampaign({
    decisions: [],
    issues: [
      `# Broken ticket

Type: brainstorm
Status: maybe

## Answer

There is no question.
`,
      issue("02", "resolved", "Resolved but unlisted", "resolved"),
    ],
    filenames: ["no-id.md", "02-resolved.md"],
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const campaign = await inspectCampaign(root);
  const codes = new Set(campaign.diagnostics.map(({ code }) => code));

  assert.ok(codes.has("location_id_missing"));
  assert.ok(codes.has("unsupported_type"));
  assert.ok(codes.has("unsupported_status"));
  assert.ok(codes.has("question_missing"));
  assert.ok(codes.has("map_decision_mismatch"));
  assert.equal(location(campaign, "02").status, "resolved");
});

test("creates a deterministic journey layout from trail order and dependencies", async () => {
  const campaign = await inspectCampaign(PERSONAL_BRAIN_FIXTURE);
  const first = createDeterministicLayout(campaign);
  const second = createDeterministicLayout(campaign);

  assert.deepEqual(second, first);
  assert.ok(first.locations["08"].x > first.locations["07"].x);
  assert.ok(first.locations["09"].x > first.locations["08"].x);
  assert.equal(first.locations["10"].x, first.locations["11"].x);
  assert.notEqual(first.locations["10"].y, first.locations["11"].y);
  assert.equal(first.locations["08"].region, "frontier");
  assert.equal(first.locations["14"].region, "gates");
  assert.equal(first.fogEntrance.region, "fog");
  assert.ok(first.destination.x > first.locations["14"].x);
});

test("persists manual coordinates while adding newly discovered locations", async (context) => {
  const root = await createCampaign({
    decisions: [{ id: "01", slug: "start", title: "Start" }],
    issues: [
      issue("01", "start", "Start", "resolved"),
      issue("02", "next", "Next", "open", ["01"]),
    ],
  });
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-explorer-data-"));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
  ]));
  const clock = () => new Date("2026-08-02T08:00:00.000Z");

  const firstCampaign = await inspectCampaign(root);
  const first = await openCampaignOverlay(firstCampaign, { dataRoot, now: clock });
  assert.equal(first.created, true);
  assert.equal(first.overlay.playerFocusId, "02");

  const persisted = JSON.parse(await readFile(first.path, "utf8"));
  persisted.layout.locations["01"].x = 777;
  persisted.layout.locations["01"].y = 333;
  await writeFile(first.path, `${JSON.stringify(persisted, null, 2)}\n`);

  await writeFile(
    path.join(root, "issues/03-later.md"),
    issue("03", "later", "Later", "open", ["02"]),
  );
  const changedCampaign = await inspectCampaign(root);
  const reopened = await openCampaignOverlay(changedCampaign, {
    dataRoot,
    now: () => new Date("2026-08-02T08:01:00.000Z"),
  });

  assert.equal(reopened.created, false);
  assert.equal(reopened.changed, true);
  assert.deepEqual(reopened.overlay.layout.locations["01"], {
    x: 777,
    y: 333,
    region: "trail",
  });
  assert.ok(reopened.overlay.layout.locations["03"]);
  assert.equal(reopened.overlay.lastObservedSourceRevision, changedCampaign.revision);

  const unchanged = await openCampaignOverlay(changedCampaign, {
    dataRoot,
    now: () => new Date("2026-08-02T08:02:00.000Z"),
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.overlay.updatedAt, "2026-08-02T08:01:00.000Z");
});

test("persists one selected node without changing the frontier set", async (context) => {
  const root = await createCampaign({
    decisions: [],
    issues: [
      issue("01", "first", "First", "open"),
      issue("02", "second", "Second", "open"),
    ],
  });
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-explorer-focus-"));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
  ]));

  const campaign = await inspectCampaign(root);
  assert.deepEqual(frontierIds(campaign), ["01", "02"]);
  const first = await openCampaignOverlay(campaign, { dataRoot });
  assert.equal(first.overlay.playerFocusId, "01");

  await setCampaignPlayerFocus(campaign, "02", { dataRoot });
  const reopened = await openCampaignOverlay(campaign, { dataRoot });

  assert.equal(reopened.overlay.playerFocusId, "02");
  assert.deepEqual(frontierIds(campaign), ["01", "02"]);
});

test("moves empty-project landmarks when the first map would overlap them", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-empty-landmarks-"));
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-empty-landmarks-data-"));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(dataRoot, { recursive: true, force: true }),
  ]));

  const emptyCampaign = await inspectCampaign(root);
  const emptyOverlay = await openCampaignOverlay(emptyCampaign, { dataRoot });
  await mkdir(path.join(root, "issues"));
  await writeFile(path.join(root, "map.md"), mapMarkdown([]));
  await Promise.all([
    writeFile(path.join(root, "issues/01-first.md"), issue("01", "first", "First", "open")),
    writeFile(path.join(root, "issues/02-second.md"), issue("02", "second", "Second", "open", ["01"])),
    writeFile(path.join(root, "issues/03-third.md"), issue("03", "third", "Third", "open", ["02"])),
    writeFile(path.join(root, "issues/04-fourth.md"), issue("04", "fourth", "Fourth", "open", ["03"])),
  ]);

  const mappedCampaign = await inspectCampaign(root);
  const mappedOverlay = await openCampaignOverlay(mappedCampaign, { dataRoot });
  const landmark = mappedOverlay.overlay.layout.destination;
  const nearestNodeDistance = Math.min(
    ...Object.values(mappedOverlay.overlay.layout.locations).map((point) =>
      Math.hypot(point.x - landmark.x, point.y - landmark.y)),
  );

  assert.deepEqual(emptyOverlay.overlay.layout.destination, { x: 540, y: 420, region: "destination" });
  assert.ok(nearestNodeDistance >= 110);
  assert.notDeepEqual(mappedOverlay.overlay.layout.destination, emptyOverlay.overlay.layout.destination);
});

test("regenerates a malformed replaceable overlay", async (context) => {
  const campaign = await inspectCampaign(PERSONAL_BRAIN_FIXTURE);
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-explorer-corrupt-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));

  const first = await openCampaignOverlay(campaign, { dataRoot });
  await writeFile(first.path, "{not-json\n");
  const recovered = await openCampaignOverlay(campaign, { dataRoot });

  assert.equal(recovered.created, false);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.overlay.playerFocusId, "08");
  assert.equal(recovered.overlay.layout.locations["08"].region, "frontier");
});

test("keeps a review-pending answer in the same node while removing its determined routes", async (context) => {
  const root = await createCampaign({
    decisions: [
      { id: "01", slug: "premise", title: "Premise" },
      { id: "02", slug: "dependent", title: "Dependent" },
    ],
    issues: [
      issue("01", "premise", "Premise", "resolved"),
      `${issue("02", "dependent", "Dependent", "resolved", ["01"])
        .replace("Status: resolved", "Status: resolved\nReview state: pending").trimEnd()}\n\n` +
        "## Review question\n\nDoes the answer still hold?\n\n" +
        "## Review reason\n\nIts premise changed.\n",
    ],
  });
  context.after(() => rm(root, { recursive: true, force: true }));
  const mapPath = path.join(root, "map.md");
  await writeFile(mapPath, (await readFile(mapPath, "utf8")).replace("- Unknown terrain", ""));

  const campaign = await inspectCampaign(root);
  assert.equal(location(campaign, "02").reviewState, "pending");
  assert.equal(location(campaign, "02").reviewQuestion, "Does the answer still hold?");
  assert.deepEqual(
    campaign.mapNodes.map(({ id, state }) => [id, state]),
    [["start", "current"], ["01", "current"], ["02", "review_pending"], ["destination", "open"]],
  );
  assert.deepEqual(campaign.determinedRoutes, [{ from: "start", to: "01" }]);
});

function location(
  campaign: Awaited<ReturnType<typeof inspectCampaign>>,
  id: string,
) {
  const found = campaign.locations.find((candidate) => candidate.id === id);
  assert.ok(found, `Expected location ${id}`);
  return found;
}

function frontierIds(campaign: Awaited<ReturnType<typeof inspectCampaign>>): string[] {
  return campaign.locations
    .filter((candidate) => candidate.status === "frontier")
    .map(({ id }) => id);
}

interface CampaignInput {
  decisions: Array<{ id: string; slug: string; title: string }>;
  issues: string[];
  filenames?: string[];
}

async function createCampaign(input: CampaignInput): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-explorer-test-"));
  await mkdir(path.join(root, "issues"));
  await writeFile(path.join(root, "map.md"), mapMarkdown(input.decisions));
  for (const [index, contents] of input.issues.entries()) {
    const filename = input.filenames?.[index] ?? inferFilename(contents);
    await writeFile(path.join(root, "issues", filename), contents);
  }
  return root;
}

function mapMarkdown(
  decisions: Array<{ id: string; slug: string; title: string }>,
): string {
  const decisionLines = decisions
    .map(({ id, slug, title }) => `- [${title}](issues/${id}-${slug}.md) — decided`)
    .join("\n");
  return `# Test campaign

## Destination

Reach a testable destination.

## Decisions so far

${decisionLines}

## Not yet specified

- Unknown terrain

## Out of scope

- Everything else
`;
}

function issue(
  id: string,
  slug: string,
  title: string,
  status: "open" | "resolved",
  blockers: string[] = [],
): string {
  const blockedBy = blockers.length ? `Blocked by: ${blockers.join(", ")}\n` : "";
  const answer = status === "resolved" ? "\n## Answer\n\nA confirmed decision.\n" : "";
  return `# ${title}

Type: grilling
Status: ${status}
${blockedBy}
## Question

What should happen at ${id}-${slug}?
${answer}`;
}

function inferFilename(contents: string): string {
  const id = /^# .*\n\nType:[\s\S]*?What should happen at (\d+)-([a-z-]+)\?/m.exec(contents);
  assert.ok(id, "Fixture issue must include an inferable id and slug");
  return `${id[1]}-${id[2]}.md`;
}
