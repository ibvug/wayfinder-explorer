import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
let initialized = false;
let turnCounter = 0;

const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
input.on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number | string;
    method: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex/1",
        codexHome: "/tmp/fake-codex",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    if (mode === "malformed") {
      process.stdout.write("{definitely-not-json}\n");
    }
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32_000, message: "not initialized" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: fakeThread("thread-fake") } });
    send({ method: "thread/started", params: { thread: fakeThread("thread-fake") } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${++turnCounter}`;
    const turn = fakeTurn(turnId, "inProgress", []);
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: "thread-fake", turn } });
    setTimeout(() => {
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-fake", turnId, itemId: `agent-${turnId}`, delta: "先确定" },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-fake", turnId, itemId: `agent-${turnId}`, delta: "哪条验收边界？" },
      });
      const item = {
        type: "agentMessage",
        id: `agent-${turnId}`,
        text: "先确定哪条验收边界？",
        phase: "final_answer",
        memoryCitation: null,
      };
      send({
        method: "item/completed",
        params: { threadId: "thread-fake", turnId, item, completedAtMs: Date.now() },
      });
      send({
        method: "turn/completed",
        params: { threadId: "thread-fake", turn: fakeTurn(turnId, "completed", [item]) },
      });
    }, 5);
    return;
  }
  send({ id: message.id, error: { code: -32_601, message: "method not found" } });
});

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fakeThread(id: string): Record<string, unknown> {
  return {
    id,
    sessionId: "session-fake",
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
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function fakeTurn(id: string, status: string, items: unknown[]): Record<string, unknown> {
  return {
    id,
    items,
    itemsView: { type: "full" },
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 10,
  };
}
