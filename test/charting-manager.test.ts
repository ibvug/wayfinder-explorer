import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RequestId } from "../schemas/codex-app-server/RequestId.ts";
import type {
  AppServerInbound,
  AppServerLifecycleEvent,
} from "../src/codex/app-server-client.ts";
import {
  ChartingManager,
  type ChartingTransport,
} from "../src/charting/manager.ts";
import { ChartingStore, chartingPathFor } from "../src/charting/store.ts";
import { CampaignStore } from "../src/service/campaign-store.ts";
import { inspectCampaignAs } from "../src/wayfinder.ts";
import { RechartService } from "../src/charting/rechart-service.ts";

test("persists one charting conversation and confirms a valid first Wayfinder map", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const world = new FakeChartingWorld();

  const firstStore = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const firstManager = await ChartingManager.open({
    store: firstStore,
    projectName: "Wayfinder 流程验证",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });

  const started = await firstManager.startCharting();
  await waitFor(() => firstManager.getView(started.id)?.state === "awaiting_player");
  assert.equal(firstManager.getView(started.id)?.threadId, "thread-charting-1");
  assert.equal(firstManager.getView(started.id)?.phase, "destination");
  assert.match(firstManager.getView(started.id)!.messages[0].text, /目的地/);
  assert.ok(firstManager.getView(started.id)?.destinationDraft);
  const chartingInstructions = readString(world.threadStartParams[0], "developerInstructions");
  assert.match(chartingInstructions, /Initial-map proposal/);
  assert.match(chartingInstructions, /dedicated confirm-destination and confirm-starting-point operations/);
  assert.match(chartingInstructions, /first map has only the confirmed start and destination as nodes/i);
  assert.doesNotMatch(chartingInstructions, /Phase 3, Breadth-first Charting/);

  await firstManager.close();
  await firstStore.close();

  const secondStore = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const secondClient = new FakeChartingTransport(world);
  const secondManager = await ChartingManager.open({
    store: secondStore,
    projectName: "Wayfinder 流程验证",
    client: secondClient,
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await secondManager.close();
    await secondStore.close();
  });

  assert.equal(world.threadStarts, 1, "restart resumes the original charting thread");
  assert.equal(secondManager.getView(started.id)?.state, "awaiting_player");
  assert.equal(secondManager.getView(started.id)?.phase, "destination");
  await secondManager.sendMessage(
    started.id,
    "目的地是验证 Explorer 能从一个想法建立地图，并从多个 frontier 中选择一个继续探索。",
  );
  await waitFor(() => {
    const view = secondManager.getView(started.id);
    return view?.state === "awaiting_player" && view.messages.length === 3;
  });
  assert.equal(secondManager.getView(started.id)?.phase, "destination");
  const destinationDraft = secondManager.getView(started.id)!.destinationDraft!;
  await secondManager.confirmDestination(started.id, destinationDraft.id);
  await waitFor(() => {
    const view = secondManager.getView(started.id);
    return view?.phase === "starting_state" && view.state === "awaiting_player";
  });
  assert.equal(secondManager.getView(started.id)?.confirmedDestination?.content, destinationDraft.content);
  await assert.rejects(secondManager.formMapProposal(started.id), /建立起点/);

  await secondManager.sendMessage(
    started.id,
    "从空项目开始；只读取当前项目目录，不能写入或执行外部副作用。",
  );
  await waitFor(() => {
    const view = secondManager.getView(started.id);
    return view?.phase === "starting_state" && view.state === "awaiting_player";
  });
  const startingPointDraft = secondManager.getView(started.id)!.startingPointDraft!;
  await assert.rejects(secondManager.formMapProposal(started.id), /建立起点/);
  await secondManager.confirmStartingPoint(
    started.id,
    startingPointDraft.id,
    startingPointDraft.evidenceVersion,
  );
  assert.equal(secondManager.getView(started.id)?.phase, "ready_for_proposal");
  assert.equal(
    secondManager.getView(started.id)?.confirmedStartingPoint?.summary,
    startingPointDraft.summary,
  );

  await secondManager.formMapProposal(started.id);
  await waitFor(() => secondManager.getView(started.id)?.state === "returned");
  const returned = secondManager.getView(started.id)!;
  assert.equal(returned.proposal?.tickets.length, 3);
  assert.equal(returned.messages.length, 6, "structured Agent envelopes and map JSON stay out of visible chat");
  assert.equal(returned.proposal?.destination, destinationDraft.content);
  assert.equal(returned.proposal?.startingState, startingPointDraft.summary);

  const previewed = await secondManager.previewMap(
    started.id,
    secondStore.getSnapshot().campaign.revision,
  );
  assert.equal(previewed.state, "previewing");
  assert.equal(previewed.creationPlan?.files.length, 4);
  assert.deepEqual(
    previewed.creationPlan?.locations.map(({ id, status }) => [id, status]),
    [["01", "frontier"], ["02", "frontier"], ["03", "blocked"]],
  );
  await assert.rejects(readFile(path.join(campaignRoot, "map.md")), { code: "ENOENT" });

  const confirmed = await secondManager.confirmMap(
    previewed.creationPlan!.id,
    previewed.creationPlan!.expectedSourceRevision,
    previewed.creationPlan!.proposalHash,
  );
  assert.equal(confirmed.state, "confirmed");

  const campaign = await inspectCampaignAs(campaignRoot, secondStore.getSnapshot().campaign.id);
  assert.equal(campaign.summary.blockingDiagnostics, 0);
  assert.equal(campaign.summary.frontier, 2, "a frontier is a set, not the selected node");
  assert.equal(campaign.summary.blocked, 1);
  assert.deepEqual(
    campaign.locations.filter(({ status }) => status === "frontier").map(({ id }) => id),
    ["01", "02"],
  );
  const map = await readFile(path.join(campaignRoot, "map.md"), "utf8");
  assert.match(map, /## Decisions so far\n\n## Not yet specified/);
  assert.doesNotMatch(map, /issues\/01-lock/);

  const chartingLog = await readFile(
    chartingPathFor(secondStore.getSnapshot().campaign.id, dataRoot),
    "utf8",
  );
  assert.match(chartingLog, /"type":"charting_started"/);
  assert.match(chartingLog, /"type":"charting_turn_recorded"/);
  assert.match(chartingLog, /"type":"destination_confirmed"/);
  assert.match(chartingLog, /"type":"starting_point_confirmed"/);
  assert.match(chartingLog, /"type":"map_proposal_returned"/);
  assert.match(chartingLog, /"type":"map_creation_confirmed"/);
});

test("does not form a first-map proposal while the destination is still being clarified", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-gate-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-gate-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const world = new FakeChartingWorld();
  const manager = await ChartingManager.open({
    store,
    projectName: "首图阶段门控验证",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const started = await manager.startCharting();
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.sendMessage(started.id, "我想得到一张真实地图，但还没有说清楚怎样才算抵达。");
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");

  await assert.rejects(
    manager.formMapProposal(started.id),
    /建立目的地/,
  );
});

test("only the dedicated operation establishes the destination before the starting point", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-start-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-start-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const world = new FakeChartingWorld();
  const manager = await ChartingManager.open({
    store,
    projectName: "目的地后建立起点",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const started = await manager.startCharting();
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.sendMessage(started.id, "确认以这个可观察结果作为目的地。");
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");

  assert.equal(manager.getView(started.id)?.phase, "destination");
  assert.equal(manager.getView(started.id)?.confirmedDestination, undefined);
  await manager.confirmDestination(started.id, manager.getView(started.id)!.destinationDraft!.id);
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");

  const establishingStart = manager.getView(started.id)!;
  assert.equal(establishingStart.phase, "starting_state");
  assert.equal(establishingStart.error, undefined);
  await assert.rejects(manager.formMapProposal(started.id), /建立起点|确认起点/);
});

test("invalidates an unconfirmed starting-point draft when its evidence changes", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-version-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-version-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(campaignRoot, "README.md"), "# Initial evidence\n", "utf8");
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const world = new FakeChartingWorld();
  world.startingEvidencePaths = ["README.md"];
  const manager = await ChartingManager.open({
    store,
    projectName: "起点证据版本验证",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const started = await manager.startCharting();
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.confirmDestination(started.id, manager.getView(started.id)!.destinationDraft!.id);
  await waitFor(() => {
    const view = manager.getView(started.id);
    return view?.state === "awaiting_player" && Boolean(view.startingPointDraft);
  });
  const staleDraft = manager.getView(started.id)!.startingPointDraft!;

  await writeFile(path.join(campaignRoot, "README.md"), "# Changed evidence\n", "utf8");
  await manager.confirmStartingPoint(started.id, staleDraft.id, staleDraft.evidenceVersion);
  await waitFor(() => {
    const view = manager.getView(started.id);
    return view?.state === "awaiting_player" &&
      Boolean(view.startingPointDraft) &&
      view.startingPointDraft?.id !== staleDraft.id;
  });

  const rechecked = manager.getView(started.id)!;
  assert.equal(rechecked.phase, "starting_state");
  assert.equal(rechecked.confirmedStartingPoint, undefined);
  assert.notEqual(rechecked.startingPointDraft?.evidenceVersion, staleDraft.evidenceVersion);
  const chartingLog = await readFile(chartingPathFor(store.getSnapshot().campaign.id, dataRoot), "utf8");
  assert.match(chartingLog, /"type":"starting_point_draft_invalidated"/);
});

test("rejects an Agent starting-point draft before destination confirmation", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-skip-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-skip-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const world = new FakeChartingWorld();
  world.invalidStartingPointBeforeDestination = true;
  const manager = await ChartingManager.open({
    store,
    projectName: "首图阶段跳跃验证",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const started = await manager.startCharting();
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  const guarded = manager.getView(started.id)!;
  assert.equal(guarded.phase, "destination");
  assert.match(guarded.error ?? "", /目的地还没有建立完成/);
  assert.doesNotMatch(guarded.error ?? "", /阶段状态|schema|校验/i);
  await assert.rejects(manager.formMapProposal(started.id), /建立目的地/);
});

test("keeps the conversation usable without exposing proposal schema validation details", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-invalid-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-invalid-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const world = new FakeChartingWorld();
  world.invalidProposal = true;
  const manager = await ChartingManager.open({
    store,
    projectName: "首图错误呈现验证",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const started = await manager.startCharting();
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.confirmDestination(started.id, manager.getView(started.id)!.destinationDraft!.id);
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.sendMessage(started.id, "从空项目开始，取证只限当前项目目录。");
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  const startingPointDraft = manager.getView(started.id)!.startingPointDraft!;
  await manager.confirmStartingPoint(started.id, startingPointDraft.id, startingPointDraft.evidenceVersion);
  assert.equal(manager.getView(started.id)?.phase, "ready_for_proposal");

  await manager.formMapProposal(started.id);
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  const recovered = manager.getView(started.id)!;
  assert.match(recovered.error ?? "", /草案仍不完整/);
  assert.doesNotMatch(recovered.error ?? "", /至少一项取证范围|schema|结构校验/i);

  await manager.sendMessage(started.id, "请重新核对已确认的取证范围后再成稿。");
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  assert.equal(manager.getView(started.id)?.phase, "ready_for_proposal");
});

test("does not overwrite a map created after the charting preview", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-conflict-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-conflict-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const manager = await ChartingManager.open({
    store,
    projectName: "并发冲突验证",
    client: new FakeChartingTransport(new FakeChartingWorld()),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const started = await manager.startCharting();
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.sendMessage(started.id, "建立一张能验证并发保护的首张地图。");
  await waitFor(() => {
    const view = manager.getView(started.id);
    return view?.phase === "destination" && view.state === "awaiting_player";
  });
  await manager.confirmDestination(started.id, manager.getView(started.id)!.destinationDraft!.id);
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
  await manager.sendMessage(started.id, "从空目录开始，只读取当前项目目录作为证据。");
  await waitFor(() => {
    const view = manager.getView(started.id);
    return view?.phase === "starting_state" && view.state === "awaiting_player";
  });
  const startingPointDraft = manager.getView(started.id)!.startingPointDraft!;
  await manager.confirmStartingPoint(started.id, startingPointDraft.id, startingPointDraft.evidenceVersion);
  assert.equal(manager.getView(started.id)?.phase, "ready_for_proposal");
  await manager.formMapProposal(started.id);
  await waitFor(() => manager.getView(started.id)?.state === "returned");
  const previewed = await manager.previewMap(started.id, store.getSnapshot().campaign.revision);

  const externalMap = "# 外部地图\n\n## Destination\n\n保留外部创建的内容。\n\n## Decisions so far\n\n## Not yet specified\n\n## Out of scope\n";
  await writeFile(path.join(campaignRoot, "map.md"), externalMap, "utf8");
  await assert.rejects(
    manager.confirmMap(
      previewed.creationPlan!.id,
      previewed.creationPlan!.expectedSourceRevision,
      previewed.creationPlan!.proposalHash,
    ),
    /预览后|已经出现/,
  );
  assert.equal(await readFile(path.join(campaignRoot, "map.md"), "utf8"), externalMap);
  await assert.rejects(readFile(path.join(campaignRoot, "issues", "01-lock-acceptance.md")), {
    code: "ENOENT",
  });
});

test("persists confirmations queued behind a pending rechart in confirmation order", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-queue-data-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const campaign = await inspectCampaignAs(
    path.resolve("test/fixtures/personal-brain-v1"),
    "campaign-abcdef000001",
  );
  const first = await ChartingStore.open(campaign, { dataRoot });
  const chartingId = "charting-queue";
  await first.start(chartingId, "thread-queue");
  await first.confirmMap(chartingId, "initial-map", campaign.revision);
  await first.beginRechart(chartingId, "01", ["08"]);
  await first.enqueueRechart(chartingId, "02", ["08"]);
  await first.close();

  const reopened = await ChartingStore.open(campaign, { dataRoot });
  assert.equal(reopened.get(chartingId)?.pendingRechart?.confirmedLocationId, "01");
  assert.deepEqual(
    reopened.get(chartingId)?.rechartQueue.map(({ confirmedLocationId }) => confirmedLocationId),
    ["02"],
  );
  await reopened.completeRechart(chartingId, campaign.revision);
  await reopened.beginRechart(chartingId, "02", ["08"]);
  assert.equal(reopened.get(chartingId)?.pendingRechart?.confirmedLocationId, "02");
  assert.deepEqual(reopened.get(chartingId)?.rechartQueue, []);
  await reopened.completeRechart(chartingId, campaign.revision, {
    id: "rechart-change-persisted",
    confirmedLocationId: "02",
    sourceRevisionBefore: campaign.revision,
    sourceRevisionAfter: campaign.revision,
    createdAt: "2026-08-07T00:00:00.000Z",
    files: [{ locationId: "09", path: "issues/09-example.md", operation: "updated" }],
    restoredLocationIds: [],
  });
  await reopened.restoreRechartChange(
    chartingId,
    "rechart-change-persisted",
    "09",
    campaign.revision,
  );
  await reopened.close();

  const restored = await ChartingStore.open(campaign, { dataRoot });
  assert.deepEqual(restored.get(chartingId)?.rechartChanges[0]?.restoredLocationIds, ["09"]);
  await restored.close();
});

test("does not treat a former evidence-scope phase as endpoint confirmation", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-legacy-phase-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-legacy-phase-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const campaignStore = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const campaign = campaignStore.getSnapshot().campaign;
  const charting = await ChartingStore.open(campaign, { dataRoot });
  await charting.start("charting-legacy-phase", "thread-legacy-phase");
  await charting.close();

  const logPath = chartingPathFor(campaign.id, dataRoot);
  const existing = await readFile(logPath, "utf8");
  const legacyEvent = {
    id: "legacy-evidence-scope-event",
    timestamp: "2026-08-07T12:00:00.000Z",
    campaignId: campaign.id,
    sourceRevision: campaign.revision,
    type: "charting_turn_recorded",
    payload: {
      chartingId: "charting-legacy-phase",
      message: {
        id: "legacy-evidence-scope-message",
        role: "guide",
        text: "现在开始围绕目的地建立起点。",
        turnId: "turn-legacy-evidence-scope",
        createdAt: "2026-08-07T12:00:00.000Z",
      },
      phase: "evidence_scope",
    },
  };
  await writeFile(logPath, `${existing}${JSON.stringify(legacyEvent)}\n`, "utf8");

  const reopened = await ChartingStore.open(campaign, { dataRoot });
  assert.equal(reopened.get("charting-legacy-phase")?.phase, "destination");
  await reopened.close();
  await campaignStore.close();
});

test("reconciles a legacy conversation into starting-point establishment without showing JSON", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-legacy-reconcile-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-legacy-reconcile-campaign-"));
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const chartingStore = await ChartingStore.open(store.getSnapshot().campaign, { dataRoot });
  const chartingId = "charting-legacy-reconcile";
  const threadId = "thread-legacy-reconcile";
  await chartingStore.start(chartingId, threadId);
  await chartingStore.recordAgentTurn(chartingId, {
    id: "agent-destination",
    role: "guide",
    text: "是否确认以此作为本次地图的目的地？",
    turnId: "turn-destination",
    createdAt: "2026-08-07T12:00:00.000Z",
  }, "destination");
  await chartingStore.addMessage(chartingId, {
    id: "player-confirms-destination",
    role: "player",
    text: "是",
    createdAt: "2026-08-07T12:00:01.000Z",
  });
  const invalidLegacyProposal = JSON.stringify({
    title: "过早形成的旧草案",
    destination: "已建立的目的地",
    startingState: "尚未建立",
    evidenceScope: [],
    notes: [],
    tickets: [],
    fog: [],
    outOfScope: [],
    evidenceRefs: [],
  });
  await chartingStore.addMessage(chartingId, {
    id: "persisted-invalid-proposal",
    role: "guide",
    text: invalidLegacyProposal,
    turnId: "turn-invalid-proposal",
    createdAt: "2026-08-07T12:00:02.000Z",
  });
  await chartingStore.changeState(chartingId, "awaiting_player", {
    error: "地图 Agent 没有给出可确认的阶段状态；会话仍然保留，请继续说明当前问题或重试本轮。",
  });
  await chartingStore.close();

  const world = new FakeChartingWorld();
  world.threads.set(threadId, {
    id: threadId,
    turns: [
      completedFakeTurn("turn-destination", "agent-destination", JSON.stringify({
        message: "是否确认以此作为本次地图的目的地？",
        phase: "destination",
      })),
      completedFakeTurn("turn-legacy-scope", "agent-legacy-scope", JSON.stringify({
        message: "目的地已建立，现在围绕它建立起点。",
        phase: "evidence_scope",
      })),
      completedFakeTurn("turn-invalid-proposal", "agent-invalid-proposal", invalidLegacyProposal),
      completedFakeTurn("turn-starting-point", "agent-starting-point", JSON.stringify({
        message: "这次探索是从零开始，还是已有资料可以作为起点事实？",
        phase: "starting_state",
      })),
    ],
  });
  const manager = await ChartingManager.open({
    store,
    projectName: "旧会话恢复",
    client: new FakeChartingTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const recovered = manager.getView(chartingId)!;
  assert.equal(recovered.phase, "destination");
  assert.equal(recovered.error, undefined);
  assert.match(recovered.messages.at(-1)?.text ?? "", /从零开始/);
  assert.equal(
    recovered.messages.some(({ text }) => text.trim().startsWith("{")),
    false,
    "structured progress and rejected legacy proposals stay out of visible chat",
  );
});

test("startup adopts a committed rechart that crashed before its completion event", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-adopt-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-charting-adopt-campaign-"));
  await cp(path.resolve("test/fixtures/personal-brain-v1"), campaignRoot, { recursive: true });
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const before = store.getSnapshot().campaign;
  const chartingStore = await ChartingStore.open(before, { dataRoot });
  await chartingStore.start("charting-crash-adopt", "thread-crash-adopt");
  await chartingStore.confirmMap("charting-crash-adopt", "initial-map", before.revision);
  await chartingStore.beginRechart("charting-crash-adopt", "07", []);
  await chartingStore.close();

  const target = before.locations.find(({ id }) => id === "08")!;
  const rechart = new RechartService({ campaignRoot, campaignId: before.id, dataRoot });
  const change = await rechart.apply({
    id: "rechart-proposal-crash-adopt",
    sourceRevision: before.revision,
    sourceTurnId: "turn-crash-adopt",
    confirmedLocationId: "07",
    triggerKind: "answer_confirmed",
    createdAt: "2026-08-07T00:00:00.000Z",
    issueChanges: [{
      kind: "update",
      issueId: "08",
      title: `${target.title}（已协调）`,
      type: target.type === "unknown" ? "grilling" : target.type,
      question: target.question,
      blockedBy: target.blockers,
      reason: "Simulate a fully committed rechart before its event was appended.",
    }],
    fog: before.fog.map(({ title }) => title),
    outOfScope: before.outOfScope,
    reviewConflicts: [],
    explorationUpdates: [],
    summary: "Committed before process exit.",
    evidenceRefs: [`campaign:${before.revision}`, "location:07:answer"],
  }, new Set());

  const manager = await ChartingManager.open({
    store,
    projectName: "崩溃恢复验证",
    client: new FakeChartingTransport(new FakeChartingWorld()),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
    autoConnect: false,
  });
  context.after(async () => {
    await manager.close();
    await store.close();
  });

  const recovered = manager.getView("charting-crash-adopt")!;
  assert.equal(recovered.pendingRechart, undefined);
  assert.equal(recovered.state, "confirmed");
  assert.equal(recovered.rechartChanges.at(-1)?.id, change.id);
  assert.equal(store.getSnapshot().campaign.revision, change.sourceRevisionAfter);
});

class FakeChartingWorld {
  threadStarts = 0;
  turnStarts = 0;
  proposalTurns = 0;
  invalidProposal = false;
  invalidStartingPointBeforeDestination = false;
  startingEvidencePaths: string[] = [];
  threadStartParams: unknown[] = [];
  threads = new Map<string, FakeThread>();
}

interface FakeThread {
  id: string;
  turns: FakeTurn[];
}

interface FakeTurn {
  id: string;
  status: "inProgress" | "completed";
  items: Array<Record<string, unknown>>;
  kind: "dialogue" | "proposal";
  dialogueStage?: "destination" | "starting_state" | "ready_for_proposal";
}

function completedFakeTurn(id: string, itemId: string, text: string): FakeTurn {
  return {
    id,
    status: "completed",
    kind: "dialogue",
    items: [{
      type: "agentMessage",
      id: itemId,
      text,
      phase: "final_answer",
      memoryCitation: null,
    }],
  };
}

class FakeChartingTransport implements ChartingTransport {
  ready = false;
  #world: FakeChartingWorld;
  #loadedThreads = new Set<string>();
  #inbound = new Set<(event: AppServerInbound) => void>();
  #lifecycle = new Set<(event: AppServerLifecycleEvent) => void>();

  constructor(world: FakeChartingWorld) {
    this.#world = world;
  }

  async start(): Promise<void> {
    this.ready = true;
    for (const listener of this.#lifecycle) {
      listener({
        type: "ready",
        initialize: {
          userAgent: "fake",
          codexHome: "/tmp/fake",
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
    }
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    if (method === "thread/start") {
      this.#world.threadStartParams.push(structuredClone(params));
      const id = `thread-charting-${++this.#world.threadStarts}`;
      const thread: FakeThread = { id, turns: [] };
      this.#world.threads.set(id, thread);
      this.#loadedThreads.add(id);
      return { thread: this.#threadPayload(thread) } as Result;
    }
    const threadId = readString(params, "threadId");
    const thread = this.#world.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown fake thread ${threadId}.`);
    }
    if (method === "thread/read" || method === "thread/resume") {
      this.#loadedThreads.add(threadId);
      return { thread: this.#threadPayload(thread) } as Result;
    }
    if (method === "turn/start") {
      if (!this.#loadedThreads.has(threadId)) {
        throw new Error(`Fake thread ${threadId} was not resumed.`);
      }
      const turnId = `turn-charting-${++this.#world.turnStarts}`;
      const outputSchema = isRecord(params) ? params.outputSchema : undefined;
      const kind = isChartingProgressSchema(outputSchema)
        ? "dialogue"
        : "proposal";
      if (kind === "proposal") {
        this.#world.proposalTurns += 1;
      }
      const turn: FakeTurn = {
        id: turnId,
        status: "inProgress",
        items: [],
        kind,
        dialogueStage: kind === "dialogue" ? chartingStageFromSchema(outputSchema) : undefined,
      };
      thread.turns.push(turn);
      setTimeout(() => this.#completeTurn(thread, turn), 5);
      return { turn: this.#turnPayload(turn) } as Result;
    }
    if (method === "turn/interrupt") {
      return {} as Result;
    }
    throw new Error(`Unsupported fake method ${method}.`);
  }

  respond(_id: RequestId, _result: unknown): void {}

  respondError(_id: RequestId, _code: number, _message: string): void {}

  subscribe(listener: (event: AppServerInbound) => void): () => void {
    this.#inbound.add(listener);
    return () => this.#inbound.delete(listener);
  }

  subscribeLifecycle(listener: (event: AppServerLifecycleEvent) => void): () => void {
    this.#lifecycle.add(listener);
    return () => this.#lifecycle.delete(listener);
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  #completeTurn(thread: FakeThread, turn: FakeTurn): void {
    const text = turn.kind === "proposal"
      ? JSON.stringify({
        title: "Wayfinder Explorer 首版验证地图",
        notes: ["首版只验证绘图与推进地图的模式切换。"],
        tickets: [
          {
            key: "lock-acceptance",
            title: "锁定首版验收边界",
            type: "grilling",
            question: "哪一条完整可观察路径足以证明首版建图与探索流程已经成立？",
            blockedBy: [],
          },
          {
            key: "choose-frontier-semantics",
            title: "确认 frontier 的选择语义",
            type: "grilling",
            question: "当多个地点同时开放时，当前选择与 frontier 集合应如何分别表达？",
            blockedBy: [],
          },
          {
            key: "prototype-transition",
            title: "验证绘图到探索的界面切换",
            type: "prototype",
            question: "确认首张地图后，界面如何清楚地从绘图模式切换到推进地图模式？",
            blockedBy: ["lock-acceptance", "choose-frontier-semantics"],
          },
        ],
        fog: ["长期地图重绘与拆分策略"],
        outOfScope: ["在首版中自动解决任何候选 ticket"],
        evidenceRefs: this.#world.invalidProposal
          ? []
          : ["turn:turn-charting-1", "turn:turn-charting-2"],
      })
      : turn.dialogueStage === "destination"
        ? JSON.stringify(this.#world.invalidStartingPointBeforeDestination
          ? {
            message: "错误地跳过目的地。",
            startingPointDraft: {
              summary: "不应接受的起点。",
              evidenceScope: ["当前项目目录"],
              evidencePaths: [],
              evidenceRefs: [`turn:${turn.id}`],
            },
          }
          : {
            message: "目的地草案已经足够明确，请审阅后使用确认目的地操作。",
            destinationDraft: {
              content: "证明 Explorer 能从一个想法形成可审阅的首张地图，并让探索者从多个当前前沿议题中选择一处继续探索。",
            },
          })
        : turn.dialogueStage === "starting_state"
          ? JSON.stringify({
            message: "我已在约定范围内核对事实，请审阅起点草案后使用确认起点操作。",
            startingPointDraft: {
              summary: "从一个尚未包含地图文件的空项目目录开始。",
              evidenceScope: ["当前项目目录"],
              evidencePaths: this.#world.startingEvidencePaths,
              evidenceRefs: [`turn:${turn.id}`],
            },
          })
          : JSON.stringify({ message: "两个端点已经由 Explorer 保存，可以继续讨论首图内容。" });
    const item = {
      type: "agentMessage",
      id: `agent-${turn.id}`,
      text,
      phase: "final_answer",
      memoryCitation: null,
    };
    turn.status = "completed";
    turn.items.push(item);
    this.#emit("turn/started", {
      threadId: thread.id,
      turn: this.#turnPayload({ ...turn, status: "inProgress", items: [] }),
    });
    this.#emit("item/agentMessage/delta", {
      threadId: thread.id,
      turnId: turn.id,
      itemId: item.id,
      delta: text,
    });
    this.#emit("item/completed", {
      threadId: thread.id,
      turnId: turn.id,
      item,
      completedAtMs: Date.now(),
    });
    this.#emit("turn/completed", {
      threadId: thread.id,
      turn: this.#turnPayload(turn),
    });
  }

  #emit(method: string, params: unknown): void {
    const event: AppServerInbound = { kind: "notification", message: { method, params } };
    for (const listener of this.#inbound) {
      listener(event);
    }
  }

  #threadPayload(thread: FakeThread): Record<string, unknown> {
    return {
      id: thread.id,
      sessionId: `session-${thread.id}`,
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      isPinned: false,
      modelProvider: "fake",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp",
      cliVersion: "fake",
      source: "appServer",
      threadSource: "wayfinder_explorer",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: thread.turns.map((candidate) => this.#turnPayload(candidate)),
    };
  }

  #turnPayload(turn: FakeTurn): Record<string, unknown> {
    return {
      id: turn.id,
      items: structuredClone(turn.items),
      itemsView: { type: "full" },
      status: turn.status,
      error: null,
      startedAt: 1,
      completedAt: turn.status === "completed" ? 2 : null,
      durationMs: turn.status === "completed" ? 10 : null,
    };
  }
}

function readString(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string") {
    throw new Error(`Missing fake parameter ${key}.`);
  }
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChartingProgressSchema(value: unknown): boolean {
  return isRecord(value) &&
    isRecord(value.properties) &&
    "message" in value.properties &&
    !("tickets" in value.properties);
}

function chartingStageFromSchema(value: unknown): FakeTurn["dialogueStage"] {
  if (!isRecord(value) || !isRecord(value.properties)) {
    return undefined;
  }
  if ("destinationDraft" in value.properties) {
    return "destination";
  }
  if ("startingPointDraft" in value.properties) {
    return "starting_state";
  }
  return "ready_for_proposal";
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Charting state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
