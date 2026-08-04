import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  ExpeditionManager,
  ExpeditionOperationError,
  type ExpeditionService,
} from "../expedition/manager.ts";
import {
  ChartingManager,
  ChartingOperationError,
  type ChartingService,
} from "../charting/manager.ts";
import {
  DirectoryPickerError,
  SystemDirectoryPicker,
  type DirectoryPicker,
  type DirectoryPickerPurpose,
} from "../project/directory-picker.ts";
import type { CampaignProjectIndex, CampaignProjectRecord } from "../project/model.ts";
import {
  CampaignRegistry,
  CampaignRegistryError,
} from "../project/registry.ts";
import { CampaignStore, type CampaignStoreOptions } from "./campaign-store.ts";
import { ExplorerState } from "./explorer-state.ts";
import type { ExplorerSnapshot } from "./model.ts";

const API_TOKEN_HEADER = "x-wayfinder-token";
const BOOTSTRAP_MARKER = "__WAYFINDER_BOOTSTRAP_JSON__";
const NONCE_MARKER = "__WAYFINDER_NONCE__";

export interface ExplorerAppOptions {
  store: CampaignStore;
  assetsRoot: string;
  apiToken?: string;
  publicOrigin?: string;
  expeditions?: ExpeditionService;
  charting?: ChartingService;
  directoryPicker?: DirectoryPicker;
  projects?: {
    registry: CampaignRegistry;
    index: CampaignProjectIndex;
    open(record: CampaignProjectRecord): Promise<ProjectContext>;
  };
}

export interface ProjectContext {
  store: CampaignStore;
  expeditions: ExpeditionService;
  charting?: ChartingService;
}

export interface ExplorerApp {
  app: FastifyInstance;
  apiToken: string;
  setPublicOrigin(origin: string): void;
  getStore(): CampaignStore;
  getExpeditions(): ExpeditionService | undefined;
  getCharting(): ChartingService | undefined;
}

export interface StartExplorerServerOptions extends CampaignStoreOptions {
  assetsRoot: string;
  port?: number;
  grillingSkillPath?: string;
  wayfinderSkillPath?: string;
}

export interface RunningExplorerServer extends ExplorerApp {
  origin: string;
  readonly store: CampaignStore;
  readonly expeditions: ExpeditionService;
  readonly charting: ChartingService;
  close(): Promise<void>;
}

interface SecurityBoundary {
  host?: string;
  origin?: string;
}

/** Build the same-origin M1 HTTP surface without opening a network port. */
export async function createExplorerApp(options: ExplorerAppOptions): Promise<ExplorerApp> {
  const assetsRoot = path.resolve(options.assetsRoot);
  const indexPath = path.join(assetsRoot, "index.html");
  const assetsDirectory = path.join(assetsRoot, "assets");
  const [indexTemplate] = await Promise.all([
    readFile(indexPath, "utf8"),
    stat(assetsDirectory),
  ]).catch((error) => {
    throw new Error(
      `Explorer browser assets are missing at ${assetsRoot}. Run the build before starting M1.`,
      { cause: error },
    );
  });
  if (!indexTemplate.includes(BOOTSTRAP_MARKER) || !indexTemplate.includes(NONCE_MARKER)) {
    throw new Error("Built index.html does not contain the secure bootstrap markers.");
  }

  const apiToken = options.apiToken ?? randomBytes(32).toString("hex");
  const boundary: SecurityBoundary = {};
  const app = Fastify({ logger: false, trustProxy: false });
  let activeStore = options.store;
  let activeExpeditions = options.expeditions;
  let activeCharting = options.charting;
  const state = new ExplorerState(
    activeStore,
    activeExpeditions,
    options.projects?.index ?? fallbackProjectIndex(activeStore),
    activeCharting,
  );
  let projectSwitchChain: Promise<void> = Promise.resolve();

  function setPublicOrigin(origin: string): void {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/") {
      throw new Error(`Explorer origin must be an http://127.0.0.1 origin, received ${origin}.`);
    }
    boundary.origin = parsed.origin;
    boundary.host = parsed.host;
  }

  if (options.publicOrigin) {
    setPublicOrigin(options.publicOrigin);
  }

  async function activateProject(projectId: string): Promise<ExplorerSnapshot> {
    if (!options.projects) {
      throw new CampaignRegistryError(503, "当前服务没有启用项目管理。");
    }
    return serializeProjectMutation(async () => {
      assertProjectSwitchSafe(activeExpeditions, activeCharting);
      const record = options.projects!.registry.getRecord(projectId);
      if (!record) {
        throw new CampaignRegistryError(404, "项目不在 Wayfinder Explorer 的项目列表中。");
      }
      if (activeStore.getSnapshot().campaign.id === projectId) {
        await options.projects!.registry.activate(projectId);
        state.setProjects(await options.projects!.registry.getIndex());
        return state.getSnapshot();
      }

      const next = await options.projects!.open(record);
      try {
        await options.projects!.registry.activate(projectId);
      } catch (error) {
        await Promise.allSettled([
          next.charting?.close() ?? Promise.resolve(),
          next.expeditions.close(),
          next.store.close(),
        ]);
        throw error;
      }
      const previousStore = activeStore;
      const previousExpeditions = activeExpeditions;
      const previousCharting = activeCharting;
      activeStore = next.store;
      activeExpeditions = next.expeditions;
      activeCharting = next.charting;
      state.switchContext(
        activeStore,
        activeExpeditions,
        await options.projects!.registry.getIndex(),
        activeCharting,
      );
      await Promise.allSettled([
        previousCharting?.close() ?? Promise.resolve(),
        previousExpeditions?.close() ?? Promise.resolve(),
        previousStore.close(),
      ]);
      return state.getSnapshot();
    });
  }

  function serializeProjectMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = projectSwitchChain.then(operation, operation);
    projectSwitchChain = result.then(() => undefined, () => undefined);
    return result;
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!boundary.host || !boundary.origin) {
      reply.code(503).send({ error: "Explorer origin is not ready." });
      return;
    }
    if (request.headers.host !== boundary.host) {
      reply.code(421).send({ error: "Host is not allowed." });
      return;
    }
    if (!request.url.startsWith("/api/")) {
      return;
    }
    if (!tokensMatch(request.headers[API_TOKEN_HEADER], apiToken)) {
      reply.code(401).send({ error: "API token is missing or invalid." });
      return;
    }
    if (!requestCameFromOrigin(request, boundary.origin)) {
      reply.code(403).send({ error: "Request origin is not allowed." });
      return;
    }
    if (request.method !== "GET" && !hasJsonContentType(request)) {
      reply.code(415).send({ error: "State-changing API requests require application/json." });
      return;
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    return payload;
  });

  app.get("/", async (_request, reply) => {
    const nonce = randomBytes(18).toString("base64url");
    const bootstrap = safeInlineJson({
      apiToken,
      campaignEndpoint: "/api/campaign",
      eventsEndpoint: "/api/events",
      apiRoot: "/api",
    });
    const html = indexTemplate
      .replace(BOOTSTRAP_MARKER, bootstrap)
      .replaceAll(NONCE_MARKER, nonce);
    reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
      )
      .type("text/html; charset=utf-8")
      .send(html);
  });

  app.get("/api/campaign", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return state.getSnapshot();
  });

  app.get("/api/events", async (request, reply) => {
    openEventStream(request, reply, state);
  });

  app.get("/api/projects", async () => state.getSnapshot().projects);

  app.post<{ Body: unknown }>(
    "/api/player-focus",
    async (request, reply) => runProjectAction(reply, request.body, async (body) => {
      if (typeof body.locationId !== "string") {
        throw new ExpeditionOperationError(400, "当前选中节点缺少有效的地点编号。");
      }
      if (!activeStore.getSnapshot().campaign.locations.some(({ id }) => id === body.locationId)) {
        throw new ExpeditionOperationError(404, `地图上不存在地点 ${body.locationId}。`);
      }
      await activeStore.setPlayerFocus(body.locationId);
      return { snapshot: state.getSnapshot() };
    }),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/projects/:id/activate",
    async (request, reply) => runProjectAction(reply, request.body, async () => ({
      snapshot: await activateProject(request.params.id),
    })),
  );

  app.post<{ Body: unknown }>(
    "/api/projects",
    async (request, reply) => runProjectAction(reply, request.body, async (body) => {
      if (!options.projects) {
        throw new CampaignRegistryError(503, "当前服务没有启用项目管理。");
      }
      if (typeof body.name !== "string") {
        throw new CampaignRegistryError(400, "创建空项目需要项目名称。");
      }
      if (typeof body.parentRoot !== "string") {
        throw new CampaignRegistryError(400, "创建空项目前需要选择保存位置。");
      }
      const record = await options.projects.registry.createEmpty(body.name, body.parentRoot);
      return { snapshot: await activateProject(record.id) };
    }),
  );

  app.post<{ Body: unknown }>(
    "/api/system/select-directory",
    async (request, reply) => runProjectAction(reply, request.body, async (body) => {
      if (!options.directoryPicker) {
        throw new DirectoryPickerError(503, "当前服务没有启用文件夹选择器，请手动输入绝对路径。");
      }
      const purpose = parseDirectoryPickerPurpose(body.purpose);
      return { root: await options.directoryPicker.selectDirectory(purpose) ?? null };
    }),
  );

  app.post<{ Body: unknown }>(
    "/api/projects/add",
    async (request, reply) => runProjectAction(reply, request.body, async (body) => {
      if (!options.projects) {
        throw new CampaignRegistryError(503, "当前服务没有启用项目管理。");
      }
      if (typeof body.root !== "string") {
        throw new CampaignRegistryError(400, "添加已有项目需要绝对目录路径。");
      }
      const record = await options.projects.registry.addExisting(body.root);
      return { snapshot: await activateProject(record.id) };
    }),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/projects/:id/relink",
    async (request, reply) => runProjectAction(reply, request.body, async (body) => {
      if (!options.projects) {
        throw new CampaignRegistryError(503, "当前服务没有启用项目管理。");
      }
      if (typeof body.root !== "string") {
        throw new CampaignRegistryError(400, "重新关联需要新的绝对目录路径。");
      }
      const record = await options.projects.registry.relink(request.params.id, body.root);
      return { snapshot: await activateProject(record.id) };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/charting/:id", async (request, reply) => {
    const charting = activeCharting?.getView(request.params.id);
    if (!charting) {
      reply.code(404);
      return { error: "这次绘图会话不在记录中。" };
    }
    return { charting };
  });

  app.post<{ Body: unknown }>(
    "/api/charting",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, (service) =>
      service.startCharting()),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/charting/:id/messages",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, (service, body) => {
      if (typeof body.message !== "string") {
        throw new ChartingOperationError(400, "回答字段缺失。");
      }
      return service.sendMessage(request.params.id, body.message);
    }),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/charting/:id/interrupt",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, (service) =>
      service.interrupt(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/charting/:id/proposal",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, (service) =>
      service.formMapProposal(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/charting/:id/proposal/resume",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, (service) =>
      service.resumeProposal(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/charting/:id/map-preview",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, (service, body) => {
      if (typeof body.expectedSourceRevision !== "string") {
        throw new ChartingOperationError(400, "首张地图预览请求缺少源版本。");
      }
      return service.previewMap(request.params.id, body.expectedSourceRevision);
    }),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/map-creations/:id/confirm",
    async (request, reply) => runChartingAction(reply, activeCharting, request.body, async (service, body) => {
      if (typeof body.expectedSourceRevision !== "string" || typeof body.proposalHash !== "string") {
        throw new ChartingOperationError(400, "首张地图确认请求与预览不完整。");
      }
      const charting = await service.confirmMap(
        request.params.id,
        body.expectedSourceRevision,
        body.proposalHash,
      );
      if (options.projects) {
        state.setProjects(await options.projects.registry.getIndex());
      }
      return charting;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/expeditions/:id", async (request, reply) => {
    const expedition = activeExpeditions?.getView(request.params.id);
    if (!expedition) {
      reply.code(404);
      return { error: "这次探索不在旅程记录中。" };
    }
    return { expedition };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/locations/:id/expeditions",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service) =>
      service.startExpedition(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/expeditions/:id/messages",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service, body) => {
      if (typeof body.message !== "string") {
        throw new ExpeditionOperationError(400, "回答字段缺失。");
      }
      return service.sendMessage(request.params.id, body.message);
    }),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/expeditions/:id/interrupt",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service) =>
      service.interrupt(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/expeditions/:id/proposal",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service) =>
      service.formProposal(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/expeditions/:id/proposal/defer",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service) =>
      service.deferProposal(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/expeditions/:id/proposal/resume",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service) =>
      service.resumeProposal(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/locations/:id/writeback-preview",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service, body) => {
      if (typeof body.expeditionId !== "string" || typeof body.expectedSourceRevision !== "string") {
        throw new ExpeditionOperationError(400, "写回预览请求缺少探索任务或源版本。");
      }
      return service.previewWriteback(
        request.params.id,
        body.expeditionId,
        body.expectedSourceRevision,
      );
    }),
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/writebacks/:id/confirm",
    async (request, reply) => runExpeditionAction(reply, activeExpeditions, request.body, (service, body) => {
      if (typeof body.expectedSourceRevision !== "string" || typeof body.proposalHash !== "string") {
        throw new ExpeditionOperationError(400, "写回确认请求与预览不完整。");
      }
      return service.confirmWriteback(
        request.params.id,
        body.expectedSourceRevision,
        body.proposalHash,
      );
    }),
  );

  await app.register(fastifyStatic, {
    root: assetsDirectory,
    prefix: "/assets/",
    decorateReply: false,
    immutable: true,
    maxAge: "1y",
  });

  app.addHook("onClose", async () => {
    state.close();
    await activeCharting?.close();
    await activeExpeditions?.close();
    await activeStore.close();
  });

  return {
    app,
    apiToken,
    setPublicOrigin,
    getStore: () => activeStore,
    getExpeditions: () => activeExpeditions,
    getCharting: () => activeCharting,
  };
}

/** Start the production-like local service on 127.0.0.1 only. */
export async function startExplorerServer(
  options: StartExplorerServerOptions,
): Promise<RunningExplorerServer> {
  const registry = await CampaignRegistry.open({
    dataRoot: options.dataRoot,
    initialCampaignRoot: options.campaignRoot,
  });
  const activeRecord = registry.getActiveRecord();
  if (!activeRecord) {
    throw new Error("Wayfinder Explorer does not have an active project.");
  }
  const initialContext = await openProjectContext(activeRecord, options);
  let explorer: ExplorerApp;
  try {
    explorer = await createExplorerApp({
      store: initialContext.store,
      assetsRoot: options.assetsRoot,
      expeditions: initialContext.expeditions,
      charting: initialContext.charting,
      projects: {
        registry,
        index: await registry.getIndex(),
        open: (record) => openProjectContext(record, options),
      },
      directoryPicker: new SystemDirectoryPicker(),
    });
  } catch (error) {
    await initialContext.charting?.close();
    await initialContext.expeditions.close();
    await initialContext.store.close();
    throw error;
  }

  try {
    const address = await explorer.app.listen({
      host: "127.0.0.1",
      port: options.port ?? 44993,
    });
    const origin = new URL(address).origin;
    explorer.setPublicOrigin(origin);
    return {
      ...explorer,
      origin,
      get store() {
        return explorer.getStore();
      },
      get expeditions() {
        const expeditions = explorer.getExpeditions();
        if (!expeditions) {
          throw new Error("The active project does not have an Expedition service.");
        }
        return expeditions;
      },
      get charting() {
        const charting = explorer.getCharting();
        if (!charting) {
          throw new Error("The active project does not have a Charting service.");
        }
        return charting;
      },
      close: () => explorer.app.close(),
    };
  } catch (error) {
    await explorer.app.close().catch(() => undefined);
    throw error;
  }
}

async function openProjectContext(
  record: CampaignProjectRecord,
  options: StartExplorerServerOptions,
): Promise<{ store: CampaignStore; expeditions: ExpeditionManager; charting: ChartingManager }> {
  const store = await CampaignStore.open({
    campaignRoot: record.root,
    campaignId: record.id,
    dataRoot: options.dataRoot,
    watch: options.watch,
    debounceMs: options.debounceMs,
  });
  try {
    const emptyProject = store.getSnapshot().campaign.diagnostics.some(({ code }) => code === "map_missing");
    const expeditions = await ExpeditionManager.open({
      store,
      grillingSkillPath: options.grillingSkillPath,
      autoConnect: !emptyProject,
    });
    try {
      const charting = await ChartingManager.open({
        store,
        projectName: record.name,
        autoConnect: emptyProject,
        wayfinderSkillPath: options.wayfinderSkillPath,
      });
      return { store, expeditions, charting };
    } catch (error) {
      await expeditions.close();
      throw error;
    }
  } catch (error) {
    await store.close();
    throw error;
  }
}

function requestCameFromOrigin(request: FastifyRequest, expectedOrigin: string): boolean {
  const origin = singleHeader(request.headers.origin);
  if (origin) {
    return origin === expectedOrigin;
  }
  const referer = singleHeader(request.headers.referer);
  if (!referer) {
    return false;
  }
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function hasJsonContentType(request: FastifyRequest): boolean {
  const contentType = singleHeader(request.headers["content-type"]);
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function tokensMatch(candidate: string | string[] | undefined, expected: string): boolean {
  const value = singleHeader(candidate);
  if (!value) {
    return false;
  }
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function openEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  state: ExplorerState,
): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.write(encodeEvent("explorer.snapshot", state.getSnapshot()));

  const unsubscribe = state.subscribe((snapshot) => {
    response.write(encodeEvent("explorer.updated", snapshot));
  });
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 20_000);

  request.raw.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  });
}

function encodeEvent(event: string, snapshot: ExplorerSnapshot): string {
  return `id: ${snapshot.sequence}\nevent: ${event}\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

async function runExpeditionAction(
  reply: FastifyReply,
  service: ExpeditionService | undefined,
  rawBody: unknown,
  action: (service: ExpeditionService, body: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  if (!service) {
    reply.code(503);
    return { error: "Codex 探索服务没有启用。" };
  }
  if (!isRecord(rawBody) || !Number.isInteger(rawBody.snapshotVersion)) {
    reply.code(400);
    return { error: "请求缺少有效的地图快照版本。" };
  }
  try {
    const expedition = await action(service, rawBody);
    return { expedition };
  } catch (error) {
    if (error instanceof ExpeditionOperationError) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    reply.code(500);
    return { error: error instanceof Error ? error.message : "探索操作失败。" };
  }
}

async function runChartingAction(
  reply: FastifyReply,
  service: ChartingService | undefined,
  rawBody: unknown,
  action: (service: ChartingService, body: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  if (!service) {
    reply.code(503);
    return { error: "Codex 绘图服务没有启用。" };
  }
  if (!isRecord(rawBody) || !Number.isInteger(rawBody.snapshotVersion)) {
    reply.code(400);
    return { error: "请求缺少有效的地图快照版本。" };
  }
  try {
    const charting = await action(service, rawBody);
    return { charting };
  } catch (error) {
    if (error instanceof ChartingOperationError) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    reply.code(500);
    return { error: error instanceof Error ? error.message : "绘图操作失败。" };
  }
}

async function runProjectAction(
  reply: FastifyReply,
  rawBody: unknown,
  action: (body: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  if (!isRecord(rawBody) || !Number.isInteger(rawBody.snapshotVersion)) {
    reply.code(400);
    return { error: "请求缺少有效的项目快照版本。" };
  }
  try {
    return await action(rawBody);
  } catch (error) {
    if (
      error instanceof CampaignRegistryError ||
      error instanceof DirectoryPickerError ||
      error instanceof ExpeditionOperationError ||
      error instanceof ChartingOperationError
    ) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    reply.code(500);
    return { error: error instanceof Error ? error.message : "项目操作失败。" };
  }
}

function parseDirectoryPickerPurpose(value: unknown): DirectoryPickerPurpose {
  if (value === "create-parent" || value === "add-project" || value === "relink-project") {
    return value;
  }
  throw new DirectoryPickerError(400, "文件夹选择请求缺少有效用途。");
}

function assertProjectSwitchSafe(
  expeditions: ExpeditionService | undefined,
  charting?: ChartingService,
): void {
  const busy = expeditions?.getViews().find(({ state }) =>
    state === "created" ||
    state === "exploring" ||
    state === "awaiting_approval" ||
    state === "reconciling" ||
    state === "returning" ||
    state === "previewing");
  if (busy) {
    throw new CampaignRegistryError(
      409,
      `项目「${busy.locationId}」仍有进行中的探索或写回，请等本轮结束后再切换。`,
    );
  }
  const busyCharting = charting?.getViews().find(({ state }) =>
    state === "created" ||
    state === "exploring" ||
    state === "awaiting_approval" ||
    state === "reconciling" ||
    state === "returning" ||
    state === "previewing");
  if (busyCharting) {
    throw new CampaignRegistryError(
      409,
      "当前项目仍有进行中的绘图或首张地图写入，请等本轮结束后再切换。",
    );
  }
}

function fallbackProjectIndex(store: CampaignStore): CampaignProjectIndex {
  const campaign = store.getSnapshot().campaign;
  return {
    activeProjectId: campaign.id,
    projects: [{
      id: campaign.id,
      name: campaign.title,
      root: campaign.root,
      managed: false,
      createdAt: "",
      lastOpenedAt: "",
      status: campaign.summary.blockingDiagnostics ? "invalid" : "ready",
      campaignTitle: campaign.title,
      resolved: campaign.summary.resolved,
      total: campaign.summary.total,
      frontier: campaign.summary.frontier,
      blockingDiagnostics: campaign.summary.blockingDiagnostics,
    }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
