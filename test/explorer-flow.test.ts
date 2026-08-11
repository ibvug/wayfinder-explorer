import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  ExpeditionManager,
  type CodexTransport,
} from "../src/expedition/manager.ts";
import { CampaignStore } from "../src/service/campaign-store.ts";
import { createExplorerApp } from "../src/service/http-server.ts";

test("a player confirms a first map without inventing a route and keeps the same map Agent", async (context) => {
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-flow-campaign-"));
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-flow-data-"));
  const assetsRoot = await createBrowserAssets();
  const world = new FirstMapAgentWorld();
  const explorationWorld = new ExplorationAgentWorld();
  const store = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const charting = await ChartingManager.open({
    store,
    projectName: "小型 Agent 项目",
    client: new FirstMapAgentTransport(world),
    wayfinderSkillPath: "/definitely/missing/wayfinder/SKILL.md",
    rechartRetryDelaysMs: [150],
  });
  const expeditions = await ExpeditionManager.open({
    store,
    client: new ExplorationAgentTransport(explorationWorld),
    grillingSkillPath: "/definitely/missing/grilling/SKILL.md",
    autoConnect: false,
  });
  const explorer = await createExplorerApp({
    store,
    charting,
    expeditions,
    assetsRoot,
    apiToken: "flow-token",
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

  const started = await command(explorer, "/api/charting", { snapshotVersion: 1 });
  assert.equal(started.statusCode, 200);
  const chartingId = started.json().charting.id as string;
  const threadId = started.json().charting.threadId as string;
  await waitFor(() => charting.getView(chartingId)?.state === "awaiting_player");
  assert.equal(charting.getView(chartingId)?.phase, "destination");

  await command(explorer, `/api/charting/${chartingId}/messages`, {
    snapshotVersion: 1,
    message: "终点是得到一份可执行的小型 Agent 项目规划；所有关键技术决策明确，尚未执行现实开发。",
  });
  await waitForGuideMessages(charting, chartingId, 2);
  assert.equal(charting.getView(chartingId)?.phase, "destination");
  const destinationDraft = charting.getView(chartingId)!.destinationDraft!;
  const destinationConfirmed = await command(
    explorer,
    `/api/charting/${chartingId}/destination/confirm`,
    { snapshotVersion: 1, draftId: destinationDraft.id },
  );
  assert.equal(destinationConfirmed.statusCode, 200);
  await waitForGuideMessages(charting, chartingId, 3);
  assert.equal(charting.getView(chartingId)?.phase, "starting_state");
  assert.equal(
    charting.getView(chartingId)?.confirmedDestination?.content,
    destinationDraft.content,
  );

  await command(explorer, `/api/charting/${chartingId}/messages`, {
    snapshotVersion: 1,
    message: "从一个只有 README 的空目录开始。取证只限当前项目目录和 README，不允许修改项目文件。",
  });
  await waitForGuideMessages(charting, chartingId, 4);
  assert.equal(charting.getView(chartingId)?.phase, "starting_state");
  const startingPointDraft = charting.getView(chartingId)!.startingPointDraft!;

  const prematureProposal = await command(explorer, `/api/charting/${chartingId}/proposal`, {
    snapshotVersion: 1,
  });
  assert.equal(prematureProposal.statusCode, 409);
  assert.match(prematureProposal.json().error, /建立起点/);

  const startingPointConfirmed = await command(
    explorer,
    `/api/charting/${chartingId}/starting-point/confirm`,
    {
      snapshotVersion: 1,
      draftId: startingPointDraft.id,
      evidenceVersion: startingPointDraft.evidenceVersion,
    },
  );
  assert.equal(startingPointConfirmed.statusCode, 200);
  assert.equal(charting.getView(chartingId)?.phase, "ready_for_proposal");
  assert.equal(
    charting.getView(chartingId)?.confirmedStartingPoint?.summary,
    startingPointDraft.summary,
  );

  const proposalResponse = await command(explorer, `/api/charting/${chartingId}/proposal`, {
    snapshotVersion: 1,
  });
  assert.equal(proposalResponse.statusCode, 200);
  await waitFor(() => charting.getView(chartingId)?.state === "returned");

  const previewResponse = await command(explorer, `/api/charting/${chartingId}/map-preview`, {
    snapshotVersion: 1,
    expectedSourceRevision: store.getSnapshot().campaign.revision,
  });
  assert.equal(previewResponse.statusCode, 200);
  const plan = previewResponse.json().charting.creationPlan;
  assert.ok(plan);

  const confirmedResponse = await command(explorer, `/api/map-creations/${plan.id}/confirm`, {
    snapshotVersion: 1,
    expectedSourceRevision: plan.expectedSourceRevision,
    proposalHash: plan.proposalHash,
  });
  assert.equal(confirmedResponse.statusCode, 200);

  const snapshotResponse = await query(explorer, "/api/campaign");
  assert.equal(snapshotResponse.statusCode, 200);
  const snapshot = snapshotResponse.json();
  assert.equal(snapshot.charting.threadId, threadId, "the charting thread becomes the persistent map Agent");
  assert.equal(snapshot.charting.state, "confirmed");
  assert.equal(world.threadStarts, 1);
  assert.equal(world.closeCalls, 0, "confirming the first map must not close the map Agent runtime");
  assert.equal(world.threadStartParams?.sandbox, "read-only");

  assert.equal(
    snapshot.campaign.startingState,
    "项目目录中只有 README，尚未形成 Agent 架构或实施计划。",
  );
  assert.deepEqual(snapshot.campaign.evidenceScope, ["当前项目目录", "README"]);
  assert.deepEqual(
    snapshot.campaign.mapNodes.map((node: { id: string; kind: string }) => [node.id, node.kind]),
    [["start", "start"], ["destination", "destination"]],
  );
  assert.deepEqual(snapshot.campaign.determinedRoutes, [], "the first map must not connect start to destination");
  assert.deepEqual(
    snapshot.campaign.locations.map((location: { id: string; status: string }) => [location.id, location.status]),
    [["01", "frontier"], ["02", "frontier"]],
    "unconfirmed questions remain issues rather than map nodes",
  );

  const map = await readFile(path.join(campaignRoot, "map.md"), "utf8");
  assert.match(map, /## Starting state\n\n项目目录中只有 README/);
  assert.match(map, /## Evidence scope\n\n- 当前项目目录\n- README/);
  assert.doesNotMatch(map, /\[起点\].*\[目的地\]/s);

  const runtimeStarted = await command(explorer, "/api/locations/02/expeditions", {
    snapshotVersion: snapshot.sequence,
  });
  assert.equal(runtimeStarted.statusCode, 200);
  const runtimeExpeditionId = runtimeStarted.json().expedition.id as string;
  const runtimeThreadId = runtimeStarted.json().expedition.threadId as string;
  await waitFor(() => expeditions.getView(runtimeExpeditionId)?.state === "awaiting_player");

  const expeditionStarted = await command(explorer, "/api/locations/01/expeditions", {
    snapshotVersion: snapshot.sequence,
  });
  assert.equal(expeditionStarted.statusCode, 200);
  const expeditionId = expeditionStarted.json().expedition.id as string;
  await waitFor(() => expeditions.getView(expeditionId)?.state === "awaiting_player");

  await command(explorer, `/api/expeditions/${expeditionId}/messages`, {
    snapshotVersion: snapshot.sequence,
    message: "Agent 负责收集事实、提出方案并维护计划一致性；目标与最终技术判断必须由用户确认。",
  });
  await waitFor(() => {
    const view = expeditions.getView(expeditionId);
    return view?.state === "awaiting_player" && view.messages.length === 3;
  });

  await command(explorer, `/api/expeditions/${expeditionId}/proposal`, {
    snapshotVersion: snapshot.sequence,
  });
  await waitFor(() => expeditions.getView(expeditionId)?.state === "returned");

  const decisionPreview = await command(explorer, "/api/locations/01/writeback-preview", {
    snapshotVersion: snapshot.sequence,
    expeditionId,
    expectedSourceRevision: store.getSnapshot().campaign.revision,
  });
  assert.equal(decisionPreview.statusCode, 200);
  const writeback = decisionPreview.json().expedition.writebackPlan;

  const decisionConfirmed = await command(explorer, `/api/writebacks/${writeback.id}/confirm`, {
    snapshotVersion: snapshot.sequence,
    expectedSourceRevision: writeback.expectedSourceRevision,
    proposalHash: writeback.proposalHash,
  });
  assert.equal(decisionConfirmed.statusCode, 200);
  await waitFor(() => world.rechartTurns === 1 && charting.getView(chartingId)?.state === "rechart_failed");

  const pending = (await query(explorer, "/api/campaign")).json();
  assert.deepEqual(
    pending.campaign.mapNodes.map((node: { id: string }) => node.id),
    ["start", "01", "destination"],
    "the confirmed answer remains on the map when its derived rechart fails",
  );
  assert.equal(pending.charting.pendingRechart.confirmedLocationId, "01");
  const staleStart = await command(explorer, "/api/locations/02/expeditions", {
    snapshotVersion: pending.sequence,
  });
  assert.equal(staleStart.statusCode, 409, "a stale frontier cannot create a new claim");

  // The answer is not reconfirmed: the pending derived change retries itself.
  await waitFor(() => world.rechartTurns === 2 && charting.getView(chartingId)?.state === "confirmed");
  await waitFor(() => {
    const runtime = expeditions.getView(runtimeExpeditionId);
    return runtime?.state === "awaiting_player" && runtime.messages.some(({ text }) =>
      text.includes("运行时议题继续保留在原会话中"));
  });

  const advanced = (await query(explorer, "/api/campaign")).json();
  const confirmedBoundary = advanced.expeditions.find(
    ({ locationId }: { locationId: string }) => locationId === "01",
  );
  const coordinatedRuntime = advanced.expeditions.find(
    ({ locationId }: { locationId: string }) => locationId === "02",
  );
  assert.equal(confirmedBoundary.state, "confirmed");
  assert.equal(confirmedBoundary.threadId, explorationWorld.threadIds.get("01"));
  assert.equal(coordinatedRuntime.id, runtimeExpeditionId);
  assert.equal(coordinatedRuntime.threadId, runtimeThreadId);
  assert.equal(coordinatedRuntime.state, "awaiting_player");
  assert.equal(explorationWorld.threadStarts, 2);
  assert.equal(explorationWorld.threadStartParams?.sandbox, "read-only");
  assert.deepEqual(
    advanced.campaign.mapNodes.map((node: { id: string; kind: string }) => [node.id, node.kind]),
    [["start", "start"], ["01", "decision"], ["destination", "destination"]],
  );
  assert.deepEqual(advanced.campaign.determinedRoutes, [{ from: "start", to: "01" }]);
  assert.deepEqual(
    advanced.campaign.locations.filter(({ status }: { status: string }) => status === "frontier")
      .map(({ id }: { id: string }) => id),
    ["02"],
  );
  assert.deepEqual(
    advanced.campaign.fog.map(({ title }: { title: string }) => title),
    ["端到端验收形式尚未明确"],
    "unresolved fog remains until the map Agent can express it as a stable issue",
  );

  await completeIssue(
    explorer,
    expeditions,
    store,
    "02",
    "采用可恢复的持久任务运行时；Explorer 保存逻辑会话，运行时线程只作为可替换绑定。",
  );
  await waitFor(() => world.rechartTurns === 3 && charting.getView(chartingId)?.state === "confirmed");
  const afterRuntime = (await query(explorer, "/api/campaign")).json();
  assert.deepEqual(
    afterRuntime.campaign.locations.filter(({ status }: { status: string }) => status === "frontier")
      .map(({ id }: { id: string }) => id),
    ["03"],
  );

  const acceptanceStarted = await command(explorer, "/api/locations/03/expeditions", {
    snapshotVersion: store.getSnapshot().sequence,
  });
  assert.equal(acceptanceStarted.statusCode, 200);
  const acceptanceExpeditionId = acceptanceStarted.json().expedition.id as string;
  await waitFor(() => expeditions.getView(acceptanceExpeditionId)?.state === "awaiting_approval");
  const approval = expeditions.getView(acceptanceExpeditionId)?.approvalRequest;
  assert.ok(approval);
  assert.equal(approval.kind, "command");
  assert.match(approval.summary, /node --version/);
  const approved = await command(
    explorer,
    `/api/expeditions/${acceptanceExpeditionId}/approvals/${approval.id}`,
    { snapshotVersion: store.getSnapshot().sequence, decision: "approve" },
  );
  assert.equal(approved.statusCode, 200);
  await waitFor(() => expeditions.getView(acceptanceExpeditionId)?.state === "awaiting_player");
  assert.equal(explorationWorld.approvedToolRequests, 1);

  await completeIssue(
    explorer,
    expeditions,
    store,
    "03",
    "验收要真实走完起点、全部议题、重绘与目的地，不以按钮点击或测试替身假装现实工作完成。",
  );
  await waitFor(() => world.rechartTurns === 4 && charting.getView(chartingId)?.state === "confirmed");

  const arrived = (await query(explorer, "/api/campaign")).json();
  assert.equal(world.threadStarts, 1, "all rechart turns stay in the original map Agent session");
  assert.equal(explorationWorld.threadStarts, 3, "each claimed issue owns one exploration Agent session");
  assert.deepEqual(
    arrived.campaign.mapNodes.map((node: { id: string; state: string }) => [node.id, node.state]),
    [
      ["start", "current"],
      ["01", "current"],
      ["02", "current"],
      ["03", "current"],
      ["destination", "arrived"],
    ],
  );
  assert.deepEqual(arrived.campaign.determinedRoutes, [
    { from: "start", to: "01" },
    { from: "start", to: "02" },
    { from: "01", to: "03" },
    { from: "02", to: "03" },
    { from: "03", to: "destination" },
  ]);
  assert.deepEqual(arrived.campaign.summary, {
    total: 3,
    resolved: 3,
    frontier: 0,
    blocked: 0,
    fog: 0,
    blockingDiagnostics: 0,
    warnings: 0,
  });

  const node01Point = structuredClone(arrived.overlay.layout.locations["01"]);
  const node02Point = structuredClone(arrived.overlay.layout.locations["02"]);
  const revisionStarted = await command(explorer, "/api/locations/01/expeditions", {
    snapshotVersion: arrived.sequence,
  });
  assert.equal(revisionStarted.statusCode, 200);
  assert.equal(revisionStarted.json().expedition.id, expeditionId);
  assert.equal(revisionStarted.json().expedition.threadId, explorationWorld.threadIds.get("01"));
  assert.equal(revisionStarted.json().expedition.mode, "revision");
  const revising = (await query(explorer, "/api/campaign")).json();
  assert.equal(revising.campaign.mapNodes.at(-1).state, "open");
  assert.equal(
    revising.campaign.determinedRoutes.some(({ to }: { to: string }) => to === "destination"),
    false,
  );

  await command(explorer, `/api/expeditions/${expeditionId}/messages`, {
    snapshotVersion: arrived.sequence,
    message: "补充边界：Agent 只能规划和协调，不能把工具执行结果冒充成用户已确认的现实完成。",
  });
  await waitFor(() => expeditions.getView(expeditionId)?.state === "awaiting_player" &&
    expeditions.getView(expeditionId)!.messages.length === 5);
  await command(explorer, `/api/expeditions/${expeditionId}/proposal`, {
    snapshotVersion: arrived.sequence,
  });
  await waitFor(() => expeditions.getView(expeditionId)?.state === "returned");
  const revisionPreview = await command(explorer, "/api/locations/01/writeback-preview", {
    snapshotVersion: arrived.sequence,
    expeditionId,
    expectedSourceRevision: store.getSnapshot().campaign.revision,
  });
  assert.equal(revisionPreview.statusCode, 200);
  const revisionPlan = revisionPreview.json().expedition.writebackPlan;
  assert.equal(revisionPlan.changeKind, "revision");
  const revisionConfirmed = await command(explorer, `/api/writebacks/${revisionPlan.id}/confirm`, {
    snapshotVersion: arrived.sequence,
    expectedSourceRevision: revisionPlan.expectedSourceRevision,
    proposalHash: revisionPlan.proposalHash,
  });
  assert.equal(revisionConfirmed.statusCode, 200);
  await waitFor(() => world.rechartTurns === 5 && charting.getView(chartingId)?.state === "confirmed");

  const revised = (await query(explorer, "/api/campaign")).json();
  const revisedNode = revised.campaign.mapNodes.find(({ id }: { id: string }) => id === "01");
  assert.match(revisedNode.answerMarkdown, /不能把工具执行结果冒充/);
  assert.equal(revisedNode.answerHistory.length, 1);
  assert.match(revisedNode.answerHistory[0].answerMarkdown, /Agent 负责收集事实/);
  assert.deepEqual(revised.overlay.layout.locations["01"], node01Point);
  assert.deepEqual(
    revised.campaign.mapNodes.map(({ id }: { id: string }) => id),
    ["start", "01", "02", "03", "destination"],
  );
  assert.equal(
    revised.campaign.mapNodes.find(({ id }: { id: string }) => id === "02").state,
    "review_pending",
  );
  assert.equal(revised.campaign.mapNodes.at(-1).state, "open");
  assert.deepEqual(revised.campaign.determinedRoutes, [{ from: "start", to: "01" }]);
  assert.deepEqual(revised.overlay.layout.locations["02"], node02Point);
  assert.match(
    await readFile(path.join(campaignRoot, "issues/01-define-agent-boundary.md"), "utf8"),
    /## Answer history[\s\S]*### Replaced/,
  );

  const reviewStarted = await command(explorer, "/api/locations/02/expeditions", {
    snapshotVersion: revised.sequence,
  });
  assert.equal(reviewStarted.statusCode, 200);
  assert.equal(reviewStarted.json().expedition.id, runtimeExpeditionId);
  assert.equal(reviewStarted.json().expedition.threadId, runtimeThreadId);
  assert.equal(reviewStarted.json().expedition.mode, "revision");
  const runtimeMessagesBefore = expeditions.getView(runtimeExpeditionId)?.messages.length ?? 0;
  await command(explorer, `/api/expeditions/${runtimeExpeditionId}/messages`, {
    snapshotVersion: revised.sequence,
    message: "原运行时答案仍然成立：工具权限与领域确认是两层独立边界。",
  });
  await waitFor(() => {
    const view = expeditions.getView(runtimeExpeditionId);
    return view?.state === "awaiting_player" && view.messages.length >= runtimeMessagesBefore + 2;
  });
  await command(explorer, `/api/expeditions/${runtimeExpeditionId}/proposal`, {
    snapshotVersion: revised.sequence,
  });
  await waitFor(() => expeditions.getView(runtimeExpeditionId)?.state === "returned");
  const reviewPreview = await command(explorer, "/api/locations/02/writeback-preview", {
    snapshotVersion: revised.sequence,
    expeditionId: runtimeExpeditionId,
    expectedSourceRevision: store.getSnapshot().campaign.revision,
  });
  assert.equal(reviewPreview.statusCode, 200);
  const reviewPlan = reviewPreview.json().expedition.writebackPlan;
  assert.equal(reviewPlan.changeKind, "reaffirmation");
  const reviewConfirmed = await command(explorer, `/api/writebacks/${reviewPlan.id}/confirm`, {
    snapshotVersion: revised.sequence,
    expectedSourceRevision: reviewPlan.expectedSourceRevision,
    proposalHash: reviewPlan.proposalHash,
  });
  assert.equal(reviewConfirmed.statusCode, 200);
  await waitFor(() => world.rechartTurns === 6 && charting.getView(chartingId)?.state === "confirmed");

  const reviewed = (await query(explorer, "/api/campaign")).json();
  assert.equal(explorationWorld.threadStarts, 3, "review reuses the original node Agent session");
  assert.equal(
    reviewed.campaign.mapNodes.find(({ id }: { id: string }) => id === "02").state,
    "current",
  );
  assert.equal(reviewed.campaign.mapNodes.at(-1).state, "arrived");
  assert.deepEqual(reviewed.overlay.layout.locations["02"], node02Point);
  assert.doesNotMatch(
    await readFile(path.join(campaignRoot, "issues/02-choose-runtime.md"), "utf8"),
    /Review state: pending|## Review question/,
  );
});

async function command(
  explorer: Awaited<ReturnType<typeof createExplorerApp>>,
  url: string,
  payload: Record<string, unknown>,
) {
  return explorer.app.inject({
    method: "POST",
    url,
    headers: {
      host: "127.0.0.1:43210",
      origin: "http://127.0.0.1:43210",
      "x-wayfinder-token": "flow-token",
      "content-type": "application/json",
    },
    payload,
  });
}

async function query(
  explorer: Awaited<ReturnType<typeof createExplorerApp>>,
  url: string,
) {
  return explorer.app.inject({
    method: "GET",
    url,
    headers: {
      host: "127.0.0.1:43210",
      referer: "http://127.0.0.1:43210/",
      "x-wayfinder-token": "flow-token",
    },
  });
}

async function completeIssue(
  explorer: Awaited<ReturnType<typeof createExplorerApp>>,
  expeditions: ExpeditionManager,
  store: CampaignStore,
  locationId: string,
  answer: string,
): Promise<void> {
  const started = await command(explorer, `/api/locations/${locationId}/expeditions`, {
    snapshotVersion: store.getSnapshot().sequence,
  });
  assert.equal(started.statusCode, 200);
  const expeditionId = started.json().expedition.id as string;
  await waitFor(() => expeditions.getView(expeditionId)?.state === "awaiting_player");
  const messageCountBefore = expeditions.getView(expeditionId)?.messages.length ?? 0;
  await command(explorer, `/api/expeditions/${expeditionId}/messages`, {
    snapshotVersion: store.getSnapshot().sequence,
    message: answer,
  });
  await waitFor(() => {
    const view = expeditions.getView(expeditionId);
    return view?.state === "awaiting_player" && view.messages.length >= messageCountBefore + 2;
  });
  await command(explorer, `/api/expeditions/${expeditionId}/proposal`, {
    snapshotVersion: store.getSnapshot().sequence,
  });
  await waitFor(() => expeditions.getView(expeditionId)?.state === "returned");
  const preview = await command(explorer, `/api/locations/${locationId}/writeback-preview`, {
    snapshotVersion: store.getSnapshot().sequence,
    expeditionId,
    expectedSourceRevision: store.getSnapshot().campaign.revision,
  });
  assert.equal(preview.statusCode, 200);
  const plan = preview.json().expedition.writebackPlan;
  const confirmed = await command(explorer, `/api/writebacks/${plan.id}/confirm`, {
    snapshotVersion: store.getSnapshot().sequence,
    expectedSourceRevision: plan.expectedSourceRevision,
    proposalHash: plan.proposalHash,
  });
  assert.equal(confirmed.statusCode, 200);
}

async function createBrowserAssets(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-flow-assets-"));
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><div id=\"root\"></div><script nonce=\"__WAYFINDER_NONCE__\">window.__WAYFINDER_BOOTSTRAP__ = __WAYFINDER_BOOTSTRAP_JSON__;</script>",
  );
  await writeFile(path.join(root, "assets", "app.js"), "export {};\n");
  return root;
}

class FirstMapAgentWorld {
  threadStarts = 0;
  turnStarts = 0;
  rechartTurns = 0;
  failedFirstRechart = false;
  rechartByLocation = new Map<string, number>();
  closeCalls = 0;
  threadStartParams?: Record<string, unknown>;
  thread?: FakeThread;
}

interface FakeThread {
  id: string;
  turns: FakeTurn[];
}

interface FakeTurn {
  id: string;
  status: "inProgress" | "completed";
  items: Array<Record<string, unknown>>;
  structured: boolean;
  dialogue: boolean;
  dialogueStage?: "destination" | "starting_state" | "ready_for_proposal";
  rechart: boolean;
  confirmedLocationId?: string;
  invalidRechart: boolean;
  rechartOrdinal?: number;
}

class FirstMapAgentTransport implements ChartingTransport {
  ready = false;
  #world: FirstMapAgentWorld;
  #inbound = new Set<(event: AppServerInbound) => void>();
  #lifecycle = new Set<(event: AppServerLifecycleEvent) => void>();

  constructor(world: FirstMapAgentWorld) {
    this.#world = world;
  }

  async start(): Promise<void> {
    this.ready = true;
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    if (method === "thread/start") {
      this.#world.threadStarts += 1;
      this.#world.threadStartParams = structuredClone(params as Record<string, unknown>);
      this.#world.thread = { id: "thread-map-agent-1", turns: [] };
      return { thread: this.#threadPayload(this.#world.thread) } as Result;
    }
    const thread = this.#world.thread;
    if (!thread) {
      throw new Error("The fake map Agent thread has not started.");
    }
    if (method === "thread/read" || method === "thread/resume") {
      return { thread: this.#threadPayload(thread) } as Result;
    }
    if (method === "turn/start") {
      const structured = isRecord(params) && params.outputSchema !== undefined;
      const dialogue = structured && isChartingProgressSchema(params.outputSchema);
      const rechart = structured && isRechartSchema(params.outputSchema);
      if (rechart) {
        this.#world.rechartTurns += 1;
      }
      const confirmedLocationId = rechart ? rechartLocationId(params) : undefined;
      const rechartOrdinal = confirmedLocationId
        ? (this.#world.rechartByLocation.get(confirmedLocationId) ?? 0) + 1
        : undefined;
      if (confirmedLocationId && rechartOrdinal) {
        this.#world.rechartByLocation.set(confirmedLocationId, rechartOrdinal);
      }
      const invalidRechart = confirmedLocationId === "01" && !this.#world.failedFirstRechart;
      if (invalidRechart) {
        this.#world.failedFirstRechart = true;
      }
      const turn: FakeTurn = {
        id: `turn-map-agent-${++this.#world.turnStarts}`,
        status: "inProgress",
        items: [],
        structured,
        dialogue,
        dialogueStage: dialogue ? chartingStageFromSchema(params.outputSchema) : undefined,
        rechart,
        confirmedLocationId,
        invalidRechart,
        rechartOrdinal,
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
    this.#world.closeCalls += 1;
    this.ready = false;
  }

  #completeTurn(thread: FakeThread, turn: FakeTurn): void {
    const text = turn.rechart
      ? JSON.stringify({
          issueChanges: turn.confirmedLocationId === "02" && turn.rechartOrdinal === 1
            ? [{
                kind: "create",
                key: "define-end-to-end-acceptance",
                title: "定义端到端验收",
                type: "task",
                question: "怎样的真实用户旅程足以证明整张决策地图已经闭合？",
                blockedBy: ["01", "02"],
                reason: "职责边界和运行时都确认后，验收才成为一个稳定的独立议题。",
              }]
            : [],
          fog: turn.confirmedLocationId === "01" && (turn.rechartOrdinal ?? 0) <= 2
            ? ["端到端验收形式尚未明确"]
            : [],
          outOfScope: ["在本次探索中实际编写 Agent"],
          reviewConflicts: turn.confirmedLocationId === "01" && turn.rechartOrdinal === 3
            ? [{
                locationId: "02",
                question: "职责边界修订后，原来的可恢复运行时选择是否仍然成立？",
                reason: "运行时答案必须重新确认不会把工具执行冒充成用户确认。",
              }]
            : [],
          explorationUpdates: turn.confirmedLocationId === "01" && turn.rechartOrdinal === 2
            ? [{
                locationId: "02",
                reason: "职责边界已经确认，运行时方案必须继承用户最终判断权。",
                contextMarkdown: "运行时可以持续使用工具，但所有规范地图变化仍由 Explorer 预览并由用户确认。",
              }]
            : [],
          summary: "职责边界已确认，原有其他议题仍然必要；部署限制不再阻止继续规划。",
          evidenceRefs: [turn.invalidRechart
            ? "location:99:answer"
            : `location:${turn.confirmedLocationId}:answer`],
        })
      : !turn.dialogue
      ? JSON.stringify({
          title: "小型 Agent 项目规划地图",
          notes: ["先闭合规划决策，再进入现实实施。"],
          tickets: [
            {
              key: "define-agent-boundary",
              title: "确定 Agent 的职责边界",
              type: "grilling",
              question: "这个小型 Agent 必须自主完成什么，又必须把什么判断留给用户？",
              blockedBy: [],
            },
            {
              key: "choose-runtime",
              title: "选择 Agent 运行时",
              type: "grilling",
              question: "哪种运行时最符合持续会话、工具权限和可恢复性要求？",
              blockedBy: [],
            },
          ],
          fog: ["端到端验收形式尚未明确"],
          outOfScope: ["在本次探索中实际编写 Agent"],
          evidenceRefs: [
            "turn:turn-map-agent-1",
            "turn:turn-map-agent-2",
            "turn:turn-map-agent-3",
            "turn:turn-map-agent-4",
          ],
        })
      : turn.dialogueStage === "destination"
        ? JSON.stringify({
            message: "目的地草案已经足够明确，请审阅后使用确认目的地操作。",
            destinationDraft: {
              content: "形成一份可执行的小型 Agent 项目规划；关键技术决策全部明确，但不假装现实开发已经完成。",
            },
          })
        : turn.dialogueStage === "starting_state"
          ? JSON.stringify({
              message: "我已在约定范围内核对事实，请审阅起点草案后使用确认起点操作。",
              startingPointDraft: {
                summary: "项目目录中只有 README，尚未形成 Agent 架构或实施计划。",
                evidenceScope: ["当前项目目录", "README"],
                evidencePaths: [],
                evidenceRefs: [`turn:${turn.id}`],
              },
            })
          : JSON.stringify({ message: "目的地和起点已经由 Explorer 保存，可以继续形成首张地图提案。" });
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

class ExplorationAgentWorld {
  threadStarts = 0;
  turnStarts = 0;
  threadId = "";
  threadStartParams?: Record<string, unknown>;
  threads = new Map<string, ExplorationThread>();
  threadIds = new Map<string, string>();
  approvedToolRequests = 0;
}

interface ExplorationThread {
  id: string;
  locationId: string;
  turns: ExplorationTurn[];
}

interface ExplorationTurn {
  id: string;
  status: "inProgress" | "completed";
  items: Array<Record<string, unknown>>;
  proposal: boolean;
  coordination: boolean;
}

class ExplorationAgentTransport implements CodexTransport {
  ready = false;
  #world: ExplorationAgentWorld;
  #inbound = new Set<(event: AppServerInbound) => void>();
  #lifecycle = new Set<(event: AppServerLifecycleEvent) => void>();
  #pendingApprovals = new Map<RequestId, () => void>();

  constructor(world: ExplorationAgentWorld) {
    this.#world = world;
  }

  async start(): Promise<void> {
    this.ready = true;
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    if (method === "thread/start") {
      this.#world.threadStarts += 1;
      const locationId = explorationLocationId(params);
      this.#world.threadId = `thread-exploration-agent-${this.#world.threadStarts}`;
      this.#world.threadStartParams = structuredClone(params as Record<string, unknown>);
      const thread = { id: this.#world.threadId, locationId, turns: [] };
      this.#world.threads.set(thread.id, thread);
      this.#world.threadIds.set(locationId, thread.id);
      return { thread: this.#threadPayload(thread) } as Result;
    }
    const threadId = isRecord(params) && typeof params.threadId === "string" ? params.threadId : "";
    const thread = this.#world.threads.get(threadId);
    if (!thread) {
      throw new Error("The fake exploration Agent thread has not started.");
    }
    if (method === "thread/read" || method === "thread/resume") {
      return { thread: this.#threadPayload(thread) } as Result;
    }
    if (method === "turn/start") {
      const proposal = isRecord(params) && params.outputSchema !== undefined;
      const coordination = turnInputText(params).includes(
        "地图 Agent 已根据其他确认答案协调了",
      );
      const turn: ExplorationTurn = {
        id: `turn-exploration-${++this.#world.turnStarts}`,
        status: "inProgress",
        items: [],
        proposal,
        coordination,
      };
      thread.turns.push(turn);
      if (thread.locationId === "03" && thread.turns.length === 1 && !proposal) {
        const requestId = `approval-${turn.id}`;
        this.#pendingApprovals.set(requestId, () => this.#completeTurn(thread, turn));
        setTimeout(() => this.#emitRequest(requestId, "item/commandExecution/requestApproval", {
          threadId: thread.id,
          turnId: turn.id,
          itemId: `command-${turn.id}`,
          startedAtMs: Date.now(),
          environmentId: null,
          reason: "读取本机 Node 版本以验证验收环境。",
          command: "node --version",
          cwd: "/tmp",
          commandActions: [],
        }), 5);
      } else {
        setTimeout(() => this.#completeTurn(thread, turn), 5);
      }
      return { turn: this.#turnPayload(turn) } as Result;
    }
    if (method === "turn/interrupt") {
      return {} as Result;
    }
    throw new Error(`Unsupported fake exploration method ${method}.`);
  }

  respond(id: RequestId, result: unknown): void {
    const continueTurn = this.#pendingApprovals.get(id);
    if (!continueTurn) {
      return;
    }
    assert.deepEqual(result, { decision: "accept" });
    this.#pendingApprovals.delete(id);
    this.#world.approvedToolRequests += 1;
    setTimeout(continueTurn, 5);
  }

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

  #completeTurn(thread: ExplorationThread, turn: ExplorationTurn): void {
    const text = turn.proposal
      ? JSON.stringify({
          answerMarkdown: explorationAnswer(
            thread.locationId,
            thread.turns.filter(({ proposal }) => proposal).length,
          ),
          rationale: ["这个边界允许 Agent 自主推进证据工作，同时保留真实判断权。"],
          evidenceRefs: [
            `location:${thread.locationId}:question`,
            `turn:${thread.turns.filter(({ proposal }) => !proposal).at(-1)?.id}`,
          ],
          rejectedAlternatives: ["让 Agent 直接确认并改写规范地图。"],
          assumptions: ["Explorer 会校验并预览所有规范地图变化。"],
          revisitConditions: ["目标变为无需人工判断的全自动执行系统。"],
          confidence: "high",
        })
      : turn.coordination
        ? "运行时议题继续保留在原会话中；我已按新的职责边界更新前提，接下来只需比较可恢复性与权限模型。"
      : thread.turns.length === 1
        ? "如果 Agent 的建议与你的判断冲突，谁拥有最终决定权？"
        : "职责边界已经清楚，可以形成答案草案。";
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

  #emitRequest(id: RequestId, method: string, params: unknown): void {
    const event: AppServerInbound = { kind: "request", message: { id, method, params } };
    for (const listener of this.#inbound) {
      listener(event);
    }
  }

  #threadPayload(thread: ExplorationThread): Record<string, unknown> {
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

  #turnPayload(turn: ExplorationTurn): Record<string, unknown> {
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

async function waitForGuideMessages(
  charting: ChartingManager,
  chartingId: string,
  expected: number,
): Promise<void> {
  await waitFor(() => {
    const view = charting.getView(chartingId);
    return view?.state === "awaiting_player" &&
      view.messages.filter(({ role }) => role === "guide").length >= expected;
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for the Explorer flow.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRechartSchema(value: unknown): boolean {
  return isRecord(value) && isRecord(value.properties) && "issueChanges" in value.properties;
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

function rechartLocationId(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) {
    throw new Error("The fake rechart turn is missing input.");
  }
  const text = params.input
    .filter(isRecord)
    .map((entry) => entry.text)
    .find((value): value is string => typeof value === "string");
  const match = text ? /location:(\d+):answer/.exec(text) : undefined;
  if (!match) {
    throw new Error("The fake rechart turn cannot identify its confirmed answer.");
  }
  return match[1];
}

function turnInputText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) {
    return "";
  }
  return params.input
    .filter(isRecord)
    .map((entry) => typeof entry.text === "string" ? entry.text : "")
    .join("\n");
}

function explorationLocationId(params: unknown): string {
  if (!isRecord(params) || typeof params.developerInstructions !== "string") {
    throw new Error("The fake exploration thread is missing developer instructions.");
  }
  const match = /"currentTicket"\s*:\s*\{[\s\S]*?"id"\s*:\s*"(\d+)"/.exec(
    params.developerInstructions,
  );
  if (!match) {
    throw new Error("The fake exploration thread cannot identify its issue.");
  }
  return match[1];
}

function explorationAnswer(locationId: string, proposalOrdinal: number): string {
  if (locationId === "01") {
    if (proposalOrdinal > 1) {
      return "Agent 负责收集事实、提出方案并维护规划一致性，但不能把工具执行结果冒充成用户已确认的现实完成；目标、范围与最终判断始终由用户明确确认。";
    }
    return "Agent 负责收集事实、提出方案并维护规划一致性；目标、范围与最终技术判断始终由用户明确确认。";
  }
  if (locationId === "02") {
    return "采用可恢复的持久任务运行时；每个逻辑 Agent 会话绑定一个稳定线程，并由 Explorer 保存领域身份与运行时绑定。";
  }
  return "端到端验收必须从起点创建地图，逐个探索并确认全部议题，成功重绘后无开放议题和迷雾，目的地显示已抵达。";
}
