import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CampaignRegistry } from "../src/project/registry.ts";
import { campaignIdForRoot } from "../src/wayfinder.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BRAIN_FIXTURE = path.resolve(TEST_DIRECTORY, "../../.scratch/personal-brain-v1");

test("registers the existing campaign and creates a truly empty selectable project", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-registry-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));

  const registry = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  const initial = registry.getActiveRecord()!;
  assert.equal(initial.id, campaignIdForRoot(PERSONAL_BRAIN_FIXTURE));

  const chosenProjectsRoot = path.join(dataRoot, "用户选择的位置");
  await mkdir(chosenProjectsRoot);
  const empty = await registry.createEmpty("第二段旅程", chosenProjectsRoot);
  assert.equal(empty.root, path.join(chosenProjectsRoot, "第二段旅程"));
  assert.equal(empty.root.startsWith(path.join(dataRoot, "projects")), false);
  const createdIndex = await registry.getIndex();
  assert.equal(createdIndex.activeProjectId, empty.id);
  assert.equal(createdIndex.projects.find(({ id }) => id === empty.id)?.status, "empty");
  assert.equal(createdIndex.projects.find(({ id }) => id === initial.id)?.status, "ready");

  const movedRoot = path.join(dataRoot, "moved-empty-project");
  await rename(empty.root, movedRoot);
  assert.equal((await registry.getIndex()).projects.find(({ id }) => id === empty.id)?.status, "missing");
  const relinked = await registry.relink(empty.id, movedRoot);
  assert.equal(relinked.id, empty.id, "relink preserves Campaign identity");
  assert.equal((await registry.getIndex()).projects.find(({ id }) => id === empty.id)?.status, "empty");

  const reopened = await CampaignRegistry.open({ dataRoot });
  assert.equal(reopened.activeProjectId, empty.id);
  assert.equal(reopened.getActiveRecord()?.root, movedRoot);

  const reopenedFromCli = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
  });
  assert.equal(
    reopenedFromCli.activeProjectId,
    empty.id,
    "the CLI bootstrap root must not replace the user's last selected project",
  );
});
