import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { chartingPathFor } from "../src/charting/store.ts";
import { CampaignStore } from "../src/service/campaign-store.ts";
import { inspectCampaignAs } from "../src/wayfinder.ts";

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
  assert.match(firstManager.getView(started.id)!.messages[0].text, /目的地/);

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
  await secondManager.sendMessage(
    started.id,
    "目的地是验证 Explorer 能从一个想法建立地图，并从多个 frontier 中选择一个继续探索。",
  );
  await waitFor(() => {
    const view = secondManager.getView(started.id);
    return view?.state === "awaiting_player" && view.messages.length === 3;
  });

  await secondManager.formMapProposal(started.id);
  await waitFor(() => secondManager.getView(started.id)?.state === "returned");
  const returned = secondManager.getView(started.id)!;
  assert.equal(returned.proposal?.tickets.length, 3);
  assert.equal(returned.messages.length, 3, "structured map JSON stays out of visible chat");

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
  assert.match(chartingLog, /"type":"map_proposal_returned"/);
  assert.match(chartingLog, /"type":"map_creation_confirmed"/);
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
  await manager.sendMessage(started.id, "建立一张能验证并发保护的首版地图。");
  await waitFor(() => manager.getView(started.id)?.state === "awaiting_player");
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

class FakeChartingWorld {
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
    const normalTurns = thread.turns.filter(({ proposal }) => !proposal).length;
    const text = turn.proposal
      ? JSON.stringify({
        title: "Wayfinder Explorer 首版验证地图",
        destination: "证明 Explorer 能从一个想法形成可审阅的首张地图，并让用户从多个当前可走的 frontier 中选择一处继续探索。",
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
        evidenceRefs: ["turn:turn-charting-1", "turn:turn-charting-2"],
      })
      : normalTurns === 1
        ? "先确认目的地：这张地图最终要帮助你完成什么可观察的结果？"
        : "目的地已经有了。为了绘制第一层地图，你最不希望 frontier 与当前选中节点混淆成什么？";
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Charting state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
