import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ExpeditionService } from "../src/expedition/manager.ts";
import type { ExpeditionView } from "../src/expedition/model.ts";
import type { ChartingService } from "../src/charting/manager.ts";
import type { ChartingView } from "../src/charting/model.ts";
import { CampaignRegistry } from "../src/project/registry.ts";
import { CampaignStore } from "../src/service/campaign-store.ts";
import { createExplorerApp } from "../src/service/http-server.ts";
import type { CampaignSnapshot } from "../src/service/model.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BRAIN_FIXTURE = path.resolve(
  TEST_DIRECTORY,
  "fixtures/personal-brain-v1",
);

test("serves a token-bound same-origin bootstrap and protected campaign API", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-server-data-"));
  const assetsRoot = await createBrowserAssets();
  const store = await CampaignStore.open({
    campaignRoot: PERSONAL_BRAIN_FIXTURE,
    dataRoot,
    watch: false,
  });
  const explorer = await createExplorerApp({
    store,
    assetsRoot,
    apiToken: "test-token",
    publicOrigin: "http://127.0.0.1:43210",
    directoryPicker: {
      selectDirectory: async (purpose) => {
        assert.equal(purpose, "add-project");
        return PERSONAL_BRAIN_FIXTURE;
      },
    },
  });
  context.after(async () => {
    await explorer.app.close();
    await Promise.all([
      rm(dataRoot, { recursive: true, force: true }),
      rm(assetsRoot, { recursive: true, force: true }),
    ]);
  });

  const wrongHost = await explorer.app.inject({
    method: "GET",
    url: "/",
    headers: { host: "localhost:43210" },
  });
  assert.equal(wrongHost.statusCode, 421);

  const bootstrap = await explorer.app.inject({
    method: "GET",
    url: "/",
    headers: { host: "127.0.0.1:43210" },
  });
  assert.equal(bootstrap.statusCode, 200);
  assert.match(bootstrap.body, /test-token/);
  assert.doesNotMatch(bootstrap.body, /__WAYFINDER_BOOTSTRAP_JSON__/);
  assert.doesNotMatch(bootstrap.body, /__WAYFINDER_NONCE__/);
  assert.match(bootstrap.headers["content-security-policy"] ?? "", /nonce-/);

  const noToken = await explorer.app.inject({
    method: "GET",
    url: "/api/campaign",
    headers: {
      host: "127.0.0.1:43210",
      referer: "http://127.0.0.1:43210/",
    },
  });
  assert.equal(noToken.statusCode, 401);

  const wrongOrigin = await explorer.app.inject({
    method: "GET",
    url: "/api/campaign",
    headers: {
      host: "127.0.0.1:43210",
      origin: "http://evil.example",
      "x-wayfinder-token": "test-token",
    },
  });
  assert.equal(wrongOrigin.statusCode, 403);

  const pickedDirectory = await explorer.app.inject({
    method: "POST",
    url: "/api/system/select-directory",
    headers: {
      host: "127.0.0.1:43210",
      origin: "http://127.0.0.1:43210",
      "x-wayfinder-token": "test-token",
      "content-type": "application/json",
    },
    payload: { snapshotVersion: 1, purpose: "add-project" },
  });
  assert.equal(pickedDirectory.statusCode, 200);
  assert.equal(pickedDirectory.json().root, PERSONAL_BRAIN_FIXTURE);

  const campaign = await explorer.app.inject({
    method: "GET",
    url: "/api/campaign",
    headers: {
      host: "127.0.0.1:43210",
      referer: "http://127.0.0.1:43210/map",
      "x-wayfinder-token": "test-token",
    },
  });
  assert.equal(campaign.statusCode, 200);
  assert.deepEqual(campaign.json().campaign.summary, {
    total: 14,
    resolved: 7,
    frontier: 1,
    blocked: 6,
    fog: 4,
    blockingDiagnostics: 0,
    warnings: 0,
  });

  const focused = await explorer.app.inject({
    method: "POST",
    url: "/api/player-focus",
    headers: {
      host: "127.0.0.1:43210",
      origin: "http://127.0.0.1:43210",
      "x-wayfinder-token": "test-token",
      "content-type": "application/json",
    },
    payload: { snapshotVersion: campaign.json().sequence, locationId: "09" },
  });
  assert.equal(focused.statusCode, 200);
  assert.equal(focused.json().snapshot.overlay.playerFocusId, "09");
  assert.equal(focused.json().snapshot.campaign.summary.frontier, 1);
});

test("watches external Markdown edits without rearranging persisted locations", async (context) => {
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-server-campaign-"));
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-server-overlay-"));
  await cp(PERSONAL_BRAIN_FIXTURE, campaignRoot, { recursive: true });
  const store = await CampaignStore.open({
    campaignRoot,
    dataRoot,
    watch: true,
    debounceMs: 20,
  });
  context.after(async () => {
    await store.close();
    await Promise.all([
      rm(campaignRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
    ]);
  });

  const before = store.getSnapshot();
  const coordinatesBefore = structuredClone(before.overlay.layout.locations);
  const update = nextSnapshot(store, 5_000);
  const mapPath = path.join(campaignRoot, "map.md");
  const map = await readFile(mapPath, "utf8");
  await writeFile(mapPath, map.replace("形成一份可直接", "形成一份已刷新、可直接"));

  const after = await update;
  assert.equal(after.sequence, before.sequence + 1);
  assert.notEqual(after.campaign.revision, before.campaign.revision);
  assert.match(after.campaign.destination, /已刷新/);
  assert.deepEqual(after.overlay.layout.locations, coordinatesBefore);
  assert.equal(after.overlay.playerFocusId, "08");
});

test("accepts only token-bound JSON Expedition commands and returns the Codex binding", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-command-data-"));
  const assetsRoot = await createBrowserAssets();
  const store = await CampaignStore.open({
    campaignRoot: PERSONAL_BRAIN_FIXTURE,
    dataRoot,
    watch: false,
  });
  const expeditions = new StubExpeditionService(store.getSnapshot().campaign.id);
  const explorer = await createExplorerApp({
    store,
    expeditions,
    assetsRoot,
    apiToken: "test-token",
    publicOrigin: "http://127.0.0.1:43210",
  });
  context.after(async () => {
    await explorer.app.close();
    await Promise.all([
      rm(dataRoot, { recursive: true, force: true }),
      rm(assetsRoot, { recursive: true, force: true }),
    ]);
  });

  const headers = {
    host: "127.0.0.1:43210",
    origin: "http://127.0.0.1:43210",
    "x-wayfinder-token": "test-token",
  };
  const wrongContentType = await explorer.app.inject({
    method: "POST",
    url: "/api/locations/08/expeditions",
    headers: { ...headers, "content-type": "text/plain" },
    payload: JSON.stringify({ snapshotVersion: 1 }),
  });
  assert.equal(wrongContentType.statusCode, 415);

  const started = await explorer.app.inject({
    method: "POST",
    url: "/api/locations/08/expeditions",
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().expedition.locationId, "08");
  assert.equal(started.json().expedition.threadId, "thread-stub-08");

  const answered = await explorer.app.inject({
    method: "POST",
    url: "/api/expeditions/expedition-00000000-0000-4000-8000-000000000008/messages",
    headers,
    payload: { snapshotVersion: 1, message: "我的验收主路径。" },
  });
  assert.equal(answered.statusCode, 200);
  assert.deepEqual(answered.json().expedition.messages.map(({ role }: { role: string }) => role), ["player"]);

  const proposed = await explorer.app.inject({
    method: "POST",
    url: "/api/expeditions/expedition-00000000-0000-4000-8000-000000000008/proposal",
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(proposed.statusCode, 200);
  assert.equal(proposed.json().expedition.state, "returned");

  const deferred = await explorer.app.inject({
    method: "POST",
    url: "/api/expeditions/expedition-00000000-0000-4000-8000-000000000008/proposal/defer",
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(deferred.statusCode, 200);
  assert.equal(deferred.json().expedition.state, "drafted");

  const resumed = await explorer.app.inject({
    method: "POST",
    url: "/api/expeditions/expedition-00000000-0000-4000-8000-000000000008/proposal/resume",
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.json().expedition.state, "awaiting_player");

  const reproposed = await explorer.app.inject({
    method: "POST",
    url: "/api/expeditions/expedition-00000000-0000-4000-8000-000000000008/proposal",
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(reproposed.statusCode, 200);
  assert.equal(reproposed.json().expedition.state, "returned");

  const previewed = await explorer.app.inject({
    method: "POST",
    url: "/api/locations/08/writeback-preview",
    headers,
    payload: {
      snapshotVersion: 1,
      expeditionId: "expedition-00000000-0000-4000-8000-000000000008",
      expectedSourceRevision: store.getSnapshot().campaign.revision,
    },
  });
  assert.equal(previewed.statusCode, 200);
  assert.equal(previewed.json().expedition.state, "previewing");

  const confirmed = await explorer.app.inject({
    method: "POST",
    url: "/api/writebacks/writeback-stub/confirm",
    headers,
    payload: {
      snapshotVersion: 1,
      expectedSourceRevision: store.getSnapshot().campaign.revision,
      proposalHash: "sha256:stub",
    },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().expedition.state, "confirmed");
});

test("exposes the empty-project Charting conversation, proposal, preview, and confirmation", async (context) => {
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-api-campaign-"));
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-api-data-"));
  const assetsRoot = await createBrowserAssets();
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const charting = new StubChartingService(store.getSnapshot().campaign.id);
  const explorer = await createExplorerApp({
    store,
    charting,
    assetsRoot,
    apiToken: "test-token",
    publicOrigin: "http://127.0.0.1:43210",
  });
  context.after(async () => {
    await explorer.app.close();
    await Promise.all([
      rm(campaignRoot, { recursive: true, force: true }),
      rm(dataRoot, { recursive: true, force: true }),
      rm(assetsRoot, { recursive: true, force: true }),
    ]);
  });
  const headers = {
    host: "127.0.0.1:43210",
    origin: "http://127.0.0.1:43210",
    "x-wayfinder-token": "test-token",
  };

  const started = await explorer.app.inject({
    method: "POST",
    url: "/api/charting",
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().charting.threadId, "thread-charting-stub");

  const answered = await explorer.app.inject({
    method: "POST",
    url: `/api/charting/${started.json().charting.id}/messages`,
    headers,
    payload: { snapshotVersion: 1, message: "我要验证空项目可以创建首张地图。" },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json().charting.messages.at(-1).role, "player");

  const proposed = await explorer.app.inject({
    method: "POST",
    url: `/api/charting/${started.json().charting.id}/proposal`,
    headers,
    payload: { snapshotVersion: 1 },
  });
  assert.equal(proposed.statusCode, 200);
  assert.equal(proposed.json().charting.state, "returned");

  const previewed = await explorer.app.inject({
    method: "POST",
    url: `/api/charting/${started.json().charting.id}/map-preview`,
    headers,
    payload: {
      snapshotVersion: 1,
      expectedSourceRevision: store.getSnapshot().campaign.revision,
    },
  });
  assert.equal(previewed.statusCode, 200);
  assert.equal(previewed.json().charting.creationPlan.locations.length, 2);

  const confirmed = await explorer.app.inject({
    method: "POST",
    url: "/api/map-creations/map-creation-stub/confirm",
    headers,
    payload: {
      snapshotVersion: 1,
      expectedSourceRevision: store.getSnapshot().campaign.revision,
      proposalHash: "sha256:charting-stub",
    },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().charting.state, "confirmed");
});

test("creates an empty project and switches back to the existing Campaign on one origin", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-project-switch-"));
  const assetsRoot = await createBrowserAssets();
  const registry = await CampaignRegistry.open({
    dataRoot,
    initialCampaignRoot: PERSONAL_BRAIN_FIXTURE,
  });
  const initialRecord = registry.getActiveRecord()!;
  const openContext = async (record: typeof initialRecord) => {
    const store = await CampaignStore.open({
      campaignRoot: record.root,
      campaignId: record.id,
      dataRoot,
      watch: false,
    });
    return {
      store,
      expeditions: new StubExpeditionService(record.id),
    };
  };
  const initial = await openContext(initialRecord);
  const explorer = await createExplorerApp({
    store: initial.store,
    expeditions: initial.expeditions,
    assetsRoot,
    apiToken: "test-token",
    publicOrigin: "http://127.0.0.1:43210",
    projects: {
      registry,
      index: await registry.getIndex(),
      open: openContext,
    },
  });
  context.after(async () => {
    await explorer.app.close();
    await Promise.all([
      rm(dataRoot, { recursive: true, force: true }),
      rm(assetsRoot, { recursive: true, force: true }),
    ]);
  });
  const headers = {
    host: "127.0.0.1:43210",
    origin: "http://127.0.0.1:43210",
    "x-wayfinder-token": "test-token",
  };

  const chosenProjectsRoot = path.join(dataRoot, "user-chosen-projects");
  await mkdir(chosenProjectsRoot);

  const created = await explorer.app.inject({
    method: "POST",
    url: "/api/projects",
    headers,
    payload: {
      snapshotVersion: 1,
      name: "从零开始的旅程",
      parentRoot: chosenProjectsRoot,
    },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(
    created.json().snapshot.projects.projects.find(
      ({ id }: { id: string }) => id === created.json().snapshot.projects.activeProjectId,
    ).root,
    path.join(chosenProjectsRoot, "从零开始的旅程"),
  );
  assert.equal(created.json().snapshot.projects.projects.length, 2);
  assert.equal(created.json().snapshot.projects.projects.find(
    ({ id }: { id: string }) => id === created.json().snapshot.projects.activeProjectId,
  ).status, "empty");
  assert.equal(created.json().snapshot.campaign.diagnostics[0].code, "map_missing");

  const switched = await explorer.app.inject({
    method: "POST",
    url: `/api/projects/${initialRecord.id}/activate`,
    headers,
    payload: { snapshotVersion: created.json().snapshot.sequence },
  });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().snapshot.projects.activeProjectId, initialRecord.id);
  assert.equal(switched.json().snapshot.campaign.title, "Personal Brain V1 决策地图");
  assert.equal(explorer.getStore().getSnapshot().campaign.id, initialRecord.id);
});

async function createBrowserAssets(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-browser-assets-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "index.html"),
    `<!doctype html><div id="root"></div><script nonce="__WAYFINDER_NONCE__">window.__WAYFINDER_BOOTSTRAP__ = __WAYFINDER_BOOTSTRAP_JSON__;</script>`,
  );
  await writeFile(path.join(root, "assets", "app.js"), "export {};\n");
  return root;
}

function nextSnapshot(store: CampaignStore, timeoutMs: number): Promise<CampaignSnapshot> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the watched campaign update."));
    }, timeoutMs);
    const unsubscribe = store.subscribe((snapshot) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

class StubExpeditionService implements ExpeditionService {
  #view: ExpeditionView;
  #listeners = new Set<() => void>();

  constructor(campaignId: string) {
    this.#view = {
      id: "expedition-00000000-0000-4000-8000-000000000008",
      campaignId,
      locationId: "08",
      threadId: "thread-stub-08",
      mode: "initial",
      state: "awaiting_player",
      messages: [],
      pendingCoordinations: [],
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
  }

  getServiceView() {
    return { state: "ready" as const };
  }

  getViews() {
    return [structuredClone(this.#view)];
  }

  getView(id: string) {
    return id === this.#view.id ? structuredClone(this.#view) : undefined;
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startExpedition() {
    return structuredClone(this.#view);
  }

  async sendMessage(_expeditionId: string, text: string) {
    this.#view.messages.push({
      id: "player-stub",
      role: "player",
      text,
      createdAt: "2026-08-02T00:00:01.000Z",
    });
    this.#publish();
    return structuredClone(this.#view);
  }

  async formProposal() {
    this.#view.state = "returned";
    this.#publish();
    return structuredClone(this.#view);
  }

  async deferProposal() {
    this.#view.state = "drafted";
    this.#view.writebackPlan = undefined;
    this.#publish();
    return structuredClone(this.#view);
  }

  async resumeProposal() {
    this.#view.state = "awaiting_player";
    this.#view.writebackPlan = undefined;
    this.#publish();
    return structuredClone(this.#view);
  }

  async previewWriteback() {
    this.#view.state = "previewing";
    this.#view.writebackPlan = {
      id: "writeback-stub",
      expeditionId: this.#view.id,
      locationId: "08",
      changeKind: "confirmation",
      expectedSourceRevision: "sha256:stub-before",
      resultingSourceRevision: "sha256:stub-after",
      proposalHash: "sha256:stub",
      createdAt: "2026-08-02T00:00:02.000Z",
      expiresAt: "2026-08-02T00:10:02.000Z",
      files: [],
      impact: [],
    };
    this.#publish();
    return structuredClone(this.#view);
  }

  async confirmWriteback() {
    this.#view.state = "confirmed";
    this.#view.writebackPlan = undefined;
    this.#publish();
    return structuredClone(this.#view);
  }

  async interrupt() {
    this.#view.state = "failed";
    this.#publish();
    return structuredClone(this.#view);
  }

  async endExpedition() {
    this.#view.state = "ending";
    this.#publish();
    return structuredClone(this.#view);
  }

  async coordinateRechart() {}

  async resolveApproval() {
    return structuredClone(this.#view);
  }

  async close() {}

  #publish() {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

class StubChartingService implements ChartingService {
  #view: ChartingView;
  #listeners = new Set<() => void>();

  constructor(campaignId: string) {
    this.#view = {
      id: "charting-00000000-0000-4000-8000-000000000001",
      campaignId,
      threadId: "thread-charting-stub",
      state: "awaiting_player",
      messages: [],
      rechartQueue: [],
      rechartChanges: [],
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    };
  }

  getServiceView() {
    return { state: "ready" as const };
  }

  getViews() {
    return [structuredClone(this.#view)];
  }

  getView(id: string) {
    return id === this.#view.id ? structuredClone(this.#view) : undefined;
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startCharting() {
    return structuredClone(this.#view);
  }

  async sendMessage(_chartingId: string, text: string) {
    this.#view.messages.push({
      id: "player-charting-stub",
      role: "player",
      text,
      createdAt: "2026-08-04T00:00:01.000Z",
    });
    this.#publish();
    return structuredClone(this.#view);
  }

  async formMapProposal() {
    this.#view.state = "returned";
    this.#view.proposal = {
      id: "map-proposal-stub",
      title: "首张地图",
      destination: "验证空项目建图。",
      startingState: "当前项目目录为空。",
      evidenceScope: ["当前项目目录"],
      notes: [],
      tickets: [
        { key: "first", title: "第一个入口", type: "grilling", question: "第一问？", blockedBy: [] },
        { key: "second", title: "第二个入口", type: "grilling", question: "第二问？", blockedBy: [] },
      ],
      fog: [],
      outOfScope: [],
      evidenceRefs: ["turn:stub"],
      sourceRevision: "sha256:stub-before",
      sourceTurnId: "turn:proposal-stub",
      createdAt: "2026-08-04T00:00:02.000Z",
    };
    this.#publish();
    return structuredClone(this.#view);
  }

  async resumeProposal() {
    this.#view.state = "awaiting_player";
    this.#view.creationPlan = undefined;
    this.#publish();
    return structuredClone(this.#view);
  }

  async previewMap(_chartingId: string, expectedSourceRevision: string) {
    this.#view.state = "previewing";
    this.#view.creationPlan = {
      id: "map-creation-stub",
      chartingId: this.#view.id,
      expectedSourceRevision,
      resultingSourceRevision: "sha256:stub-after",
      proposalHash: "sha256:charting-stub",
      createdAt: "2026-08-04T00:00:03.000Z",
      expiresAt: "2026-08-04T00:10:03.000Z",
      files: [],
      locations: [
        { id: "01", title: "第一个入口", type: "grilling", status: "frontier", blockers: [] },
        { id: "02", title: "第二个入口", type: "grilling", status: "frontier", blockers: [] },
      ],
    };
    this.#publish();
    return structuredClone(this.#view);
  }

  async confirmMap() {
    this.#view.state = "confirmed";
    this.#view.creationPlan = undefined;
    this.#publish();
    return structuredClone(this.#view);
  }

  async rechartAfterConfirmation() {
    this.#view.state = "confirmed";
    this.#publish();
    return structuredClone(this.#view);
  }

  async rechartAfterExplorationEnd() {
    this.#view.state = "confirmed";
    this.#publish();
    return structuredClone(this.#view);
  }

  async retryRechart() {
    return structuredClone(this.#view);
  }

  async restoreRechartChange() {
    return structuredClone(this.#view);
  }

  setRechartConsumer() {}

  async resolveApproval() {
    return structuredClone(this.#view);
  }

  async interrupt() {
    this.#view.state = "failed";
    this.#publish();
    return structuredClone(this.#view);
  }

  async close() {}

  #publish() {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
