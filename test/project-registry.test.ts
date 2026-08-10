import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CampaignRegistry } from "../src/project/registry.ts";
import { campaignIdForRoot } from "../src/wayfinder.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BRAIN_FIXTURE = path.resolve(TEST_DIRECTORY, "fixtures/personal-brain-v1");

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

test("removes inactive and active projects without requiring a fallback", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-registry-remove-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const registry = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
  });
  const initial = registry.getActiveRecord()!;
  const chosenProjectsRoot = path.join(dataRoot, "projects");
  await mkdir(chosenProjectsRoot);
  const active = await registry.createEmpty("保留的旅程", chosenProjectsRoot);

  const removed = await registry.remove(initial.id);

  assert.equal(removed.id, initial.id);
  assert.equal(registry.getRecord(initial.id), undefined);
  assert.equal((await stat(PERSONAL_BRAIN_FIXTURE)).isDirectory(), true);
  const removedActive = await registry.remove(active.id);
  assert.equal(removedActive.id, active.id);
  assert.equal(registry.getRecord(active.id), undefined);
  assert.equal(registry.activeProjectId, undefined);
  assert.equal((await registry.getIndex()).projects.length, 0);
  assert.equal((await stat(active.root)).isDirectory(), true);

  const reopened = await CampaignRegistry.open({ dataRoot });
  assert.equal(reopened.getRecord(initial.id), undefined);
  assert.equal(reopened.activeProjectId, undefined);
  assert.equal((await reopened.getIndex()).projects.length, 0);
});

test("opens and persists an intentional no-project library state", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-registry-library-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));

  const emptyRegistry = await CampaignRegistry.open({ dataRoot });
  assert.equal(emptyRegistry.activeProjectId, undefined);
  assert.deepEqual((await emptyRegistry.getIndex()).projects, []);

  const registry = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
  });
  assert.ok(registry.activeProjectId);
  await registry.deactivate();

  const reopened = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
  });
  assert.equal(reopened.activeProjectId, undefined);
  assert.equal((await reopened.getIndex()).projects.length, 1);
});

test("coordinates managed-project removal with trashing and restores the record on failure", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-registry-managed-remove-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const registry = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
  });
  const chosenProjectsRoot = path.join(dataRoot, "projects");
  await mkdir(chosenProjectsRoot);
  const managed = await registry.createEmpty("待回收旅程", chosenProjectsRoot);

  await assert.rejects(
    registry.remove(managed.id, {
      moveRootToTrash: async () => {
        throw new Error("trash unavailable");
      },
    }),
    /trash unavailable/,
  );
  assert.equal(registry.getRecord(managed.id)?.root, managed.root);
  assert.equal(registry.activeProjectId, managed.id);
  assert.equal((await stat(managed.root)).isDirectory(), true);

  let trashedRoot: string | undefined;
  await registry.remove(managed.id, {
    moveRootToTrash: async (root) => {
      trashedRoot = root;
      await rm(root, { recursive: true });
    },
  });
  assert.equal(trashedRoot, managed.root);
  assert.equal(registry.getRecord(managed.id), undefined);
  assert.equal(registry.activeProjectId, undefined);
  await assert.rejects(stat(managed.root), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
});

test("restarts from the remaining project after the original bootstrap root was trashed", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-registry-restart-after-trash-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const originalRoot = path.join(dataRoot, "original-project");
  const projectsRoot = path.join(dataRoot, "remaining-projects");
  await mkdir(originalRoot);
  await mkdir(projectsRoot);
  const registry = await CampaignRegistry.open({ dataRoot, initialCampaignRoot: originalRoot });
  const original = registry.getActiveRecord()!;
  const remaining = await registry.createEmpty("仍可打开的旅程", projectsRoot);
  await registry.remove(original.id, {
    moveRootToTrash: async (root) => rm(root, { recursive: true }),
  });

  const reopened = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: originalRoot,
  });

  assert.equal(reopened.activeProjectId, remaining.id);
  assert.equal(reopened.getActiveRecord()?.root, remaining.root);
});
