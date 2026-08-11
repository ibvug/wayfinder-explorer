import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { defaultExplorerDataRoot } from "../overlay.ts";
import { campaignIdForRoot, inspectCampaignAs } from "../wayfinder.ts";
import type {
  CampaignProjectIndex,
  CampaignProjectRecord,
  CampaignProjectStatus,
  CampaignProjectView,
} from "./model.ts";

interface RegistryDocument {
  schemaVersion: 1;
  activeProjectId: string | null;
  projects: CampaignProjectRecord[];
}

export interface CampaignRegistryOptions {
  dataRoot?: string;
  initialCampaignRoot?: string;
  now?: () => Date;
}

export interface RemoveCampaignProjectOptions {
  moveRootToTrash?: (root: string) => Promise<void>;
}

/** Persistent project library. Campaign identity survives path changes. */
export class CampaignRegistry {
  readonly path: string;

  #document: RegistryDocument;
  #now: () => Date;

  private constructor(
    registryPath: string,
    document: RegistryDocument,
    now: () => Date,
  ) {
    this.path = registryPath;
    this.#document = document;
    this.#now = now;
  }

  static async open(options: CampaignRegistryOptions = {}): Promise<CampaignRegistry> {
    const dataRoot = path.resolve(options.dataRoot ?? defaultExplorerDataRoot());
    const registryPath = path.join(dataRoot, "registry.json");
    const now = options.now ?? (() => new Date());
    const document = await readRegistry(registryPath);
    const startedWithoutProjects = document.projects.length === 0;
    const registry = new CampaignRegistry(
      registryPath,
      document,
      now,
    );
    let initialRecord: CampaignProjectRecord | undefined;
    if (options.initialCampaignRoot) {
      try {
        initialRecord = await registry.addExisting(options.initialCampaignRoot, {
          preserveLegacyIdentity: true,
        });
      } catch (error) {
        if (!(error instanceof CampaignRegistryError) || error.statusCode !== 404) {
          throw error;
        }
      }
    }

    const activeRecord = registry.getActiveRecord();
    const activeIsAvailable = activeRecord && (await projectView(activeRecord)).status !== "missing";
    if (activeRecord && !activeIsAvailable) {
      await registry.deactivate();
    } else if (!activeRecord && document.activeProjectId) {
      await registry.deactivate();
    } else if (!activeRecord && startedWithoutProjects && initialRecord) {
      await registry.activate(initialRecord.id);
    }
    return registry;
  }

  get activeProjectId(): string | undefined {
    return this.#document.activeProjectId ?? undefined;
  }

  getRecord(id: string): CampaignProjectRecord | undefined {
    const record = this.#document.projects.find((candidate) => candidate.id === id);
    return record ? structuredClone(record) : undefined;
  }

  getActiveRecord(): CampaignProjectRecord | undefined {
    return this.#document.activeProjectId
      ? this.getRecord(this.#document.activeProjectId)
      : undefined;
  }

  async getIndex(): Promise<CampaignProjectIndex> {
    const projects = await Promise.all(this.#document.projects.map((record) => projectView(record)));
    projects.sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt) || left.name.localeCompare(right.name));
    return {
      activeProjectId: this.#document.activeProjectId ?? undefined,
      projects,
    };
  }

  async createEmpty(name: string, parentRoot: string): Promise<CampaignProjectRecord> {
    const normalizedName = normalizeName(name);
    const parent = await requireDirectory(parentRoot, "项目保存位置");
    const id = randomCampaignId(new Set(this.#document.projects.map(({ id: candidate }) => candidate)));
    const root = path.join(parent, directoryNameForProject(normalizedName));
    try {
      await mkdir(root, { recursive: false, mode: 0o700 });
    } catch (cause) {
      if (isFileSystemError(cause, "EEXIST")) {
        throw new CampaignRegistryError(409, "保存位置中已经存在同名文件夹，请更换项目名称或位置。");
      }
      throw cause;
    }
    const timestamp = this.#now().toISOString();
    const record: CampaignProjectRecord = {
      id,
      name: normalizedName,
      root,
      managed: true,
      createdAt: timestamp,
      lastOpenedAt: timestamp,
    };
    const previousActiveProjectId = this.#document.activeProjectId;
    this.#document.projects.push(record);
    this.#document.activeProjectId = id;
    try {
      await this.#persist();
    } catch (cause) {
      this.#document.projects.pop();
      this.#document.activeProjectId = previousActiveProjectId;
      await rmdir(root).catch(() => undefined);
      throw cause;
    }
    return structuredClone(record);
  }

  async addExisting(
    campaignRoot: string,
    options: { preserveLegacyIdentity?: boolean } = {},
  ): Promise<CampaignProjectRecord> {
    const root = await requireDirectory(campaignRoot);
    const existing = this.#document.projects.find((record) => samePath(record.root, root));
    if (existing) {
      return structuredClone(existing);
    }
    const usedIds = new Set(this.#document.projects.map(({ id }) => id));
    const legacyId = campaignIdForRoot(root);
    const id = options.preserveLegacyIdentity && !usedIds.has(legacyId)
      ? legacyId
      : randomCampaignId(usedIds);
    const view = await inspectProjectRoot(root, id);
    const timestamp = this.#now().toISOString();
    const record: CampaignProjectRecord = {
      id,
      name: view.campaignTitle || path.basename(root) || "未命名旅程",
      root,
      managed: false,
      createdAt: timestamp,
      lastOpenedAt: timestamp,
    };
    this.#document.projects.push(record);
    await this.#persist();
    return structuredClone(record);
  }

  async relink(id: string, campaignRoot: string): Promise<CampaignProjectRecord> {
    const record = this.#recordOrThrow(id);
    const root = await requireDirectory(campaignRoot);
    const conflict = this.#document.projects.find((candidate) =>
      candidate.id !== id && samePath(candidate.root, root));
    if (conflict) {
      throw new CampaignRegistryError(409, `这个目录已经属于项目「${conflict.name}」。`);
    }
    record.root = root;
    record.managed = false;
    record.lastOpenedAt = this.#now().toISOString();
    await this.#persist();
    return structuredClone(record);
  }

  async activate(id: string): Promise<CampaignProjectRecord> {
    const record = this.#recordOrThrow(id);
    if ((await projectView(record)).status === "missing") {
      throw new CampaignRegistryError(409, "项目目录已经移动，请先重新关联目录。");
    }
    record.lastOpenedAt = this.#now().toISOString();
    this.#document.activeProjectId = id;
    await this.#persist();
    return structuredClone(record);
  }

  async deactivate(): Promise<void> {
    if (this.#document.activeProjectId === null) {
      return;
    }
    const previousActiveProjectId = this.#document.activeProjectId;
    this.#document.activeProjectId = null;
    try {
      await this.#persist();
    } catch (cause) {
      this.#document.activeProjectId = previousActiveProjectId;
      throw cause;
    }
  }

  async remove(
    id: string,
    options: RemoveCampaignProjectOptions = {},
  ): Promise<CampaignProjectRecord> {
    const record = this.#recordOrThrow(id);
    const shouldMoveRootToTrash = options.moveRootToTrash
      ? await isDirectory(record.root)
      : false;
    const index = this.#document.projects.findIndex((candidate) => candidate.id === id);
    const previousActiveProjectId = this.#document.activeProjectId;
    this.#document.projects.splice(index, 1);
    if (record.id === previousActiveProjectId) {
      this.#document.activeProjectId = null;
    }
    try {
      await this.#persist();
    } catch (cause) {
      this.#document.projects.splice(index, 0, record);
      this.#document.activeProjectId = previousActiveProjectId;
      throw cause;
    }
    if (options.moveRootToTrash && shouldMoveRootToTrash) {
      try {
        await options.moveRootToTrash(record.root);
      } catch (cause) {
        this.#document.projects.splice(index, 0, record);
        this.#document.activeProjectId = previousActiveProjectId;
        try {
          await this.#persist();
        } catch (rollbackCause) {
          throw new CampaignRegistryError(
            500,
            "项目目录删除失败，项目库记录也未能自动恢复。",
            new AggregateError([cause, rollbackCause]),
          );
        }
        throw cause;
      }
    }
    return structuredClone(record);
  }

  #recordOrThrow(id: string): CampaignProjectRecord {
    const record = this.#document.projects.find((candidate) => candidate.id === id);
    if (!record) {
      throw new CampaignRegistryError(404, "项目不在 Wayfinder Explorer 的项目列表中。");
    }
    return record;
  }

  async #persist(): Promise<void> {
    await atomicWriteJson(this.path, this.#document);
  }
}

export class CampaignRegistryError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CampaignRegistryError";
    this.statusCode = statusCode;
  }
}

async function isDirectory(root: string): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function projectView(record: CampaignProjectRecord): Promise<CampaignProjectView> {
  const inspected = await inspectProjectRoot(record.root, record.id);
  return { ...structuredClone(record), ...inspected };
}

async function inspectProjectRoot(
  root: string,
  campaignId: string,
): Promise<Pick<
  CampaignProjectView,
  "status" | "campaignTitle" | "resolved" | "total" | "frontier" | "blockingDiagnostics"
>> {
  try {
    const metadata = await stat(root);
    if (!metadata.isDirectory()) {
      return { status: "missing" };
    }
    try {
      await stat(path.join(root, "map.md"));
    } catch (error) {
      if (isMissingFileError(error)) {
        return { status: "empty" };
      }
      throw error;
    }
    const campaign = await inspectCampaignAs(root, campaignId);
    const status: CampaignProjectStatus = campaign.summary.blockingDiagnostics ? "invalid" : "ready";
    return {
      status,
      campaignTitle: campaign.title,
      resolved: campaign.summary.resolved,
      total: campaign.summary.total,
      frontier: campaign.summary.frontier,
      blockingDiagnostics: campaign.summary.blockingDiagnostics,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { status: "missing" };
    }
    throw error;
  }
}

async function requireDirectory(input: string, label = "项目目录"): Promise<string> {
  if (!input.trim()) {
    throw new CampaignRegistryError(400, `${label}不能为空。`);
  }
  const root = path.resolve(input);
  let metadata;
  try {
    metadata = await stat(root);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new CampaignRegistryError(404, `找不到这个${label}。`);
    }
    throw error;
  }
  if (!metadata.isDirectory()) {
    throw new CampaignRegistryError(400, `选择的${label}不是目录。`);
  }
  return root;
}

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > 80 ||
    /[\u0000-\u001F\u007F/:]/.test(normalized) ||
    !directoryNameForProject(normalized)
  ) {
    throw new CampaignRegistryError(400, "项目名称必须是 1 到 80 个字符，且不能包含 /、: 或只由句点组成。");
  }
  return normalized;
}

function directoryNameForProject(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[. ]+$/g, "");
}

function randomCampaignId(used: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `campaign-${randomBytes(6).toString("hex")}`;
    if (!used.has(id)) {
      return id;
    }
  }
  return `campaign-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function readRegistry(registryPath: string): Promise<RegistryDocument> {
  let text: string;
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { schemaVersion: 1, activeProjectId: null, projects: [] };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("Wayfinder Explorer project registry is malformed.", { cause });
  }
  if (!isRegistryDocument(value)) {
    throw new Error("Wayfinder Explorer project registry has an invalid shape.");
  }
  return value;
}

function isRegistryDocument(value: unknown): value is RegistryDocument {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.activeProjectId === null || typeof value.activeProjectId === "string") &&
    Array.isArray(value.projects) &&
    value.projects.every((project) =>
      isRecord(project) &&
      /^campaign-[a-f0-9]{12}$/.test(String(project.id)) &&
      typeof project.name === "string" &&
      typeof project.root === "string" &&
      typeof project.managed === "boolean" &&
      typeof project.createdAt === "string" &&
      typeof project.lastOpenedAt === "string")
  );
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isFileSystemError(error, "ENOENT");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
