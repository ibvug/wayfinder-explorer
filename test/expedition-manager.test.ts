import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RequestId } from "../schemas/codex-app-server/RequestId.ts";
import {
  AppServerRpcError,
  type AppServerInbound,
  type AppServerLifecycleEvent,
} from "../src/codex/app-server-client.ts";
import {
  ExpeditionManager,
  type CodexTransport,
} from "../src/expedition/manager.ts";
import { overlayPathFor } from "../src/overlay.ts";
import { CampaignStore } from "../src/service/campaign-store.ts";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PERSONAL_BRAIN_FIXTURE = path.resolve(TEST_DIRECTORY, "../../.scratch/personal-brain-v1");

test("persists a Codex thread binding and resumes the same Expedition after restart", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-expedition-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-expedition-campaign-"));
  await cp(PERSONAL_BRAIN_FIXTURE, campaignRoot, { recursive: true });
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const codexWorld = new FakeCodexWorld();

  const firstStore = await CampaignStore.open({
    campaignRoot,
    dataRoot,
    watch: false,
  });
  const firstClient = new FakeCodexTransport(codexWorld);
  const firstManager = await ExpeditionManager.open({
    store: firstStore,
    client: firstClient,
    grillingSkillPath: "/definitely/missing/grilling/SKILL.md",
  });
  assert.equal(firstManager.getServiceView().state, "ready");

  const started = await firstManager.startExpedition("08");
  await waitFor(() => firstManager.getView(started.id)?.state === "awaiting_player");
  const beforeRestart = firstManager.getView(started.id)!;
  assert.equal(beforeRestart.locationId, "08");
  assert.equal(beforeRestart.threadId, "thread-fake-1");
  assert.deepEqual(beforeRestart.messages.map(({ role }) => role), ["guide"]);
  assert.match(beforeRestart.messages[0].text, /最小验收场景/);

  const overlay = JSON.parse(await readFile(overlayPathFor(firstStore.getSnapshot().campaign.id, dataRoot), "utf8"));
  assert.equal(overlay.expeditionBindings[started.id], "thread-fake-1");

  await firstManager.close();
  await firstStore.close();

  const secondStore = await CampaignStore.open({
    campaignRoot,
    dataRoot,
    watch: false,
  });
  const secondClient = new FakeCodexTransport(codexWorld, true);
  const secondManager = await ExpeditionManager.open({
    store: secondStore,
    client: secondClient,
    grillingSkillPath: "/definitely/missing/grilling/SKILL.md",
  });
  context.after(async () => {
    await secondManager.close();
    await secondStore.close();
  });

  const resumed = secondManager.getView(started.id)!;
  assert.equal(resumed.threadId, beforeRestart.threadId);
  assert.equal(resumed.state, "awaiting_player");
  assert.equal(resumed.messages.length, 1);
  assert.equal(codexWorld.threadStarts, 1);

  await secondManager.sendMessage(started.id, "先覆盖一条写入、读取、召回的完整主路径。");
  await waitFor(() => {
    const view = secondManager.getView(started.id);
    return view?.state === "awaiting_player" && view.messages.length === 3;
  });
  assert.deepEqual(
    secondManager.getView(started.id)!.messages.map(({ role }) => role),
    ["guide", "player", "guide"],
  );

  await secondManager.formProposal(started.id);
  await waitFor(() => secondManager.getView(started.id)?.state === "returned");
  const returned = secondManager.getView(started.id)!;
  assert.equal(returned.proposal?.confidence, "high");
  assert.match(returned.proposal?.answerMarkdown ?? "", /端到端验收边界/);
  assert.equal(returned.proposal?.sourceRevision, secondStore.getSnapshot().campaign.revision);
  assert.equal(codexWorld.proposalTurns, 1);
  assert.equal(returned.messages.length, 3, "structured JSON is not copied into the visible transcript");

  const drafted = await secondManager.deferProposal(started.id);
  assert.equal(drafted.state, "drafted");
  assert.equal(drafted.proposal?.id, returned.proposal?.id, "deferring preserves the complete proposal");

  const resumedDraft = await secondManager.resumeProposal(started.id);
  assert.equal(resumedDraft.state, "awaiting_player");
  assert.equal(resumedDraft.threadId, returned.threadId, "revision continues in the same Codex task");
  await secondManager.sendMessage(started.id, "先保留这份草案；把验收原则拆成可审阅的小节后再整理一次。");
  await waitFor(() => secondManager.getView(started.id)?.state === "awaiting_player");
  await secondManager.formProposal(started.id);
  await waitFor(() => secondManager.getView(started.id)?.state === "returned");
  assert.equal(codexWorld.proposalTurns, 2);

  const previewed = await secondManager.previewWriteback(
    "08",
    started.id,
    secondStore.getSnapshot().campaign.revision,
  );
  assert.equal(previewed.state, "previewing");
  assert.deepEqual(previewed.writebackPlan?.impact.map(({ locationId }) => locationId), ["08", "09"]);
  const confirmed = await secondManager.confirmWriteback(
    previewed.writebackPlan!.id,
    previewed.writebackPlan!.expectedSourceRevision,
    previewed.writebackPlan!.proposalHash,
  );
  assert.equal(confirmed.state, "confirmed");
  assert.equal(secondStore.getSnapshot().campaign.locations.find(({ id }) => id === "08")?.status, "resolved");
  assert.equal(secondStore.getSnapshot().campaign.locations.find(({ id }) => id === "09")?.status, "frontier");
  assert.equal(secondStore.getSnapshot().campaign.locations.find(({ id }) => id === "11")?.status, "blocked");

  const journeyPath = path.join(path.dirname(overlayPathFor(secondStore.getSnapshot().campaign.id, dataRoot)), "journey.jsonl");
  const journey = await readFile(journeyPath, "utf8");
  assert.match(journey, /"type":"expedition_started"/);
  assert.match(journey, /"type":"expedition_message_recorded"/);
  assert.match(journey, /"type":"proposal_returned"/);
  assert.match(journey, /"type":"writeback_confirmed"/);
});

test("loads the original Codex thread before continuing a draft after restart", async (context) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-drafted-restart-data-"));
  const campaignRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-drafted-restart-campaign-"));
  await cp(PERSONAL_BRAIN_FIXTURE, campaignRoot, { recursive: true });
  context.after(() => Promise.all([
    rm(dataRoot, { recursive: true, force: true }),
    rm(campaignRoot, { recursive: true, force: true }),
  ]));
  const codexWorld = new FakeCodexWorld();

  const firstStore = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const firstManager = await ExpeditionManager.open({
    store: firstStore,
    client: new FakeCodexTransport(codexWorld),
    grillingSkillPath: "/definitely/missing/grilling/SKILL.md",
  });
  const started = await firstManager.startExpedition("08");
  await waitFor(() => firstManager.getView(started.id)?.state === "awaiting_player");
  await firstManager.sendMessage(started.id, "先覆盖一条写入、读取、召回的完整主路径。");
  await waitFor(() => firstManager.getView(started.id)?.state === "awaiting_player");
  await firstManager.formProposal(started.id);
  await waitFor(() => firstManager.getView(started.id)?.state === "returned");
  await firstManager.deferProposal(started.id);
  const originalThreadId = firstManager.getView(started.id)!.threadId;
  await firstManager.close();
  await firstStore.close();

  const secondStore = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const secondClient = new FakeCodexTransport(codexWorld);
  const secondManager = await ExpeditionManager.open({
    store: secondStore,
    client: secondClient,
    grillingSkillPath: "/definitely/missing/grilling/SKILL.md",
  });

  assert.equal(secondManager.getView(started.id)?.state, "drafted");
  const visibleMessagesBeforeResume = secondManager.getView(started.id)!.messages.length;
  await secondManager.resumeProposal(started.id);
  assert.equal(
    secondManager.getView(started.id)!.messages.length,
    visibleMessagesBeforeResume,
    "loading a drafted thread must not expose the structured proposal JSON as chat",
  );
  assert.deepEqual(secondClient.resumedThreadIds, [originalThreadId]);
  await secondManager.close();
  await secondStore.close();

  const thirdStore = await CampaignStore.open({ campaignRoot, dataRoot, watch: false });
  const thirdClient = new FakeCodexTransport(codexWorld);
  const thirdManager = await ExpeditionManager.open({
    store: thirdStore,
    client: thirdClient,
    grillingSkillPath: "/definitely/missing/grilling/SKILL.md",
  });
  context.after(async () => {
    await thirdManager.close();
    await thirdStore.close();
  });
  assert.equal(thirdManager.getView(started.id)?.state, "awaiting_player");
  assert.equal(
    thirdManager.getView(started.id)!.messages.length,
    visibleMessagesBeforeResume,
    "startup reconciliation must keep proposal JSON out of the visible transcript",
  );
  const forming = await thirdManager.formProposal(started.id);
  assert.doesNotMatch(
    forming.error ?? "",
    /turn\/start failed \(-32600\): thread not found/,
    "continuing a persisted draft must load its original Codex thread before turn/start",
  );
  await waitFor(() => thirdManager.getView(started.id)?.state === "returned");
  assert.deepEqual(thirdClient.resumedThreadIds, [originalThreadId]);
  assert.equal(thirdManager.getView(started.id)?.threadId, originalThreadId);
});

class FakeCodexWorld {
  threadStarts = 0;
  turnStarts = 0;
  proposalTurns = 0;
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
  proposal: boolean;
}

class FakeCodexTransport implements CodexTransport {
  ready = false;
  readonly resumedThreadIds: string[] = [];
  #world: FakeCodexWorld;
  #loadedThreads = new Set<string>();
  #inbound = new Set<(event: AppServerInbound) => void>();
  #lifecycle = new Set<(event: AppServerLifecycleEvent) => void>();
  #rekeyHistory: boolean;

  constructor(world: FakeCodexWorld, rekeyHistory = false) {
    this.#world = world;
    this.#rekeyHistory = rekeyHistory;
  }

  async start(): Promise<void> {
    this.ready = true;
    const event: AppServerLifecycleEvent = {
      type: "ready",
      initialize: {
        userAgent: "fake",
        codexHome: "/tmp/fake",
        platformFamily: "unix",
        platformOs: "macos",
      },
    };
    for (const listener of this.#lifecycle) {
      listener(event);
    }
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    if (method === "thread/start") {
      const id = `thread-fake-${++this.#world.threadStarts}`;
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
    if (method === "thread/read") {
      return { thread: this.#threadPayload(thread) } as Result;
    }
    if (method === "thread/resume") {
      this.#loadedThreads.add(threadId);
      this.resumedThreadIds.push(threadId);
      return { thread: this.#threadPayload(thread) } as Result;
    }
    if (method === "turn/start") {
      if (!this.#loadedThreads.has(threadId)) {
        throw new AppServerRpcError("turn/start", -32_600, `thread not found: ${threadId}`);
      }
      const turnId = `turn-fake-${++this.#world.turnStarts}`;
      const proposal = isRecord(params) && params.outputSchema !== undefined;
      if (proposal) {
        this.#world.proposalTurns += 1;
      }
      const turn: FakeTurn = { id: turnId, status: "inProgress", items: [], proposal };
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
    const first = thread.turns.length === 1;
    const item = {
      type: "agentMessage",
      id: `agent-${turn.id}`,
      text: turn.proposal
        ? JSON.stringify({
          answerMarkdown: "## 验收原则\n\nV1 的端到端验收边界必须证明从输入、形成记忆到按当前需要返回上下文的一条完整主路径。\n\n## 最小场景集\n\n### 对话来源\n\n必须形成可追溯的长期记忆。",
          rationale: ["完整主路径能够验证各层契约协同。"],
          evidenceRefs: ["location:08:question", "turn:turn-fake-2"],
          rejectedAlternatives: ["只验收单个接口。"],
          assumptions: ["测试使用固定输入。"],
          revisitConditions: ["真实集成暴露新的必要主路径。"],
          confidence: "high",
        })
        : first
        ? "你认为最小验收场景必须证明哪一种能力，缺少它就不能称为 V1？"
        : "这条主路径里，最先必须可观察到的结果是什么？",
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
      delta: item.text,
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
      cwd: PERSONAL_BRAIN_FIXTURE,
      cliVersion: "fake",
      source: "appServer",
      threadSource: "wayfinder_explorer",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: thread.turns.map((turn) => this.#turnPayload(turn)),
    };
  }

  #turnPayload(turn: FakeTurn): Record<string, unknown> {
    return {
      id: turn.id,
      items: structuredClone(turn.items).map((item) =>
        this.#rekeyHistory && item.type === "agentMessage"
          ? { ...item, id: `history-${String(item.id)}` }
          : item),
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
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`Missing fake parameter ${key}.`);
  }
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") {
    throw new Error(`Invalid fake parameter ${key}.`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Expedition state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
