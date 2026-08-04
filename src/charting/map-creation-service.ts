import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fsyncDirectory } from "../durability.ts";
import type { CampaignProjection, LocationType } from "../model.ts";
import { overlayPathFor } from "../overlay.ts";
import { inspectCampaignAs } from "../wayfinder.ts";
import type {
  MapCreationPlanView,
  MapProposal,
  MapProposalContent,
  MapTicketProposal,
} from "./model.ts";
import { parseMapProposalContent } from "./proposal.ts";

const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1_000;

interface MapCreationTarget {
  relativePath: string;
  absolutePath: string;
  after: Buffer;
  afterHash: string;
  temporaryPath: string;
  mode: number;
}

interface MapCreationPlan {
  view: MapCreationPlanView;
  targets: MapCreationTarget[];
}

type JournalPhase = "prepared" | "issues_created" | "map_created" | "verified" | "event_appended";

interface CreationJournal {
  schemaVersion: 1;
  campaignId: string;
  planId: string;
  chartingId: string;
  phase: JournalPhase;
  createdAt: string;
  targets: Array<{
    relativePath: string;
    temporaryRelativePath: string;
    afterBase64: string;
    afterHash: string;
    mode: number;
  }>;
}

export interface MapCreationServiceOptions {
  campaignRoot: string;
  campaignId: string;
  chartingLogPath: string;
  dataRoot?: string;
  now?: () => Date;
  planTtlMs?: number;
}

export interface CreateMapPlanInput {
  chartingId: string;
  proposal: MapProposal;
  expectedSourceRevision: string;
}

export interface ConfirmMapPlanInput {
  expectedSourceRevision: string;
  proposalHash: string;
  onConfirmed(plan: MapCreationPlanView): Promise<void>;
}

/** Creates the canonical first map only after a reviewed, revision-bound preview. */
export class MapCreationService {
  readonly campaignRoot: string;

  #campaignId: string;
  #chartingLogPath: string;
  #transactionsDirectory: string;
  #now: () => Date;
  #planTtlMs: number;
  #plans = new Map<string, MapCreationPlan>();

  private constructor(options: MapCreationServiceOptions) {
    this.campaignRoot = path.resolve(options.campaignRoot);
    this.#campaignId = options.campaignId;
    this.#chartingLogPath = options.chartingLogPath;
    const campaignDataDirectory = path.dirname(overlayPathFor(options.campaignId, options.dataRoot));
    this.#transactionsDirectory = path.join(campaignDataDirectory, "map-creation-transactions");
    this.#now = options.now ?? (() => new Date());
    this.#planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
  }

  static async open(options: MapCreationServiceOptions): Promise<MapCreationService> {
    const service = new MapCreationService(options);
    await service.recover();
    return service;
  }

  getPlanForCharting(chartingId: string): MapCreationPlanView | undefined {
    this.#discardExpiredPlans();
    const plan = [...this.#plans.values()].find(({ view }) => view.chartingId === chartingId);
    return plan ? structuredClone(plan.view) : undefined;
  }

  getPlan(planId: string): MapCreationPlanView | undefined {
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    return plan ? structuredClone(plan.view) : undefined;
  }

  discardPlan(planId: string): void {
    this.#plans.delete(planId);
  }

  async createPlan(input: CreateMapPlanInput): Promise<MapCreationPlanView> {
    this.#discardExpiredPlans();
    validateProposal(input.proposal);
    const before = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
    if (
      before.revision !== input.expectedSourceRevision ||
      input.proposal.sourceRevision !== input.expectedSourceRevision
    ) {
      throw new MapCreationConflictError("空项目在草案形成后已经变化，请重新审阅当前目录。");
    }
    assertBlankCampaign(before);

    const rendered = renderMapFiles(input.proposal);
    const after = await inspectRenderedMap(rendered, this.#campaignId);
    assertValidFirstMap(input.proposal, after, rendered);

    const createdAt = this.#now();
    const planId = `map-creation-${randomUUID()}`;
    const targets = rendered.map(({ relativePath, bytes }) => createTarget(
      this.campaignRoot,
      planId,
      relativePath,
      bytes,
    ));
    const view: MapCreationPlanView = {
      id: planId,
      chartingId: input.chartingId,
      expectedSourceRevision: before.revision,
      resultingSourceRevision: after.revision,
      proposalHash: hashProposal(input.proposal),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.#planTtlMs).toISOString(),
      files: targets.map((target) => ({
        path: target.relativePath,
        afterHash: target.afterHash,
        diff: renderNewFileDiff(target.relativePath, target.after.toString("utf8")),
      })),
      locations: after.locations.map((location) => ({
        id: location.id,
        title: location.title,
        type: location.type as LocationType,
        status: location.status,
        blockers: location.blockers,
      })),
    };

    for (const [id, existing] of this.#plans) {
      if (existing.view.chartingId === input.chartingId) {
        this.#plans.delete(id);
      }
    }
    this.#plans.set(planId, { view, targets });
    return structuredClone(view);
  }

  async confirm(planId: string, input: ConfirmMapPlanInput): Promise<MapCreationPlanView> {
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    if (!plan) {
      throw new MapCreationConflictError("首张地图预览已经失效，请重新预览。");
    }
    if (
      plan.view.expectedSourceRevision !== input.expectedSourceRevision ||
      plan.view.proposalHash !== input.proposalHash
    ) {
      throw new MapCreationConflictError("确认请求与已经审阅的首张地图预览不一致。");
    }

    const current = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
    if (current.revision !== plan.view.expectedSourceRevision) {
      throw new MapCreationConflictError("项目目录在预览后已经变化；Explorer 没有覆盖它。");
    }
    assertBlankCampaign(current);
    await assertTargetsAbsent(plan.targets);

    const issuesDirectory = path.join(this.campaignRoot, "issues");
    const issuesDirectoryExisted = await exists(issuesDirectory);
    await mkdir(issuesDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.#transactionsDirectory, { recursive: true, mode: 0o700 });
    const journalPath = path.join(this.#transactionsDirectory, `${planId}.json`);
    const journal = this.#journalFor(plan);
    const createdPaths = new Set<string>();
    let journalPersisted = false;
    let eventAppended = false;
    try {
      await writeJournalDurably(journalPath, journal);
      journalPersisted = true;
      for (const target of plan.targets) {
        await writeDurableFile(target.temporaryPath, target.after, target.mode, true);
      }

      const issueTargets = plan.targets.filter(({ relativePath }) => relativePath.startsWith("issues/"));
      for (const target of issueTargets) {
        await installWithoutOverwrite(target);
        createdPaths.add(target.absolutePath);
      }
      journal.phase = "issues_created";
      await writeJournalDurably(journalPath, journal);

      const mapTarget = plan.targets.find(({ relativePath }) => relativePath === "map.md");
      if (!mapTarget) {
        throw new Error("首张地图事务缺少 map.md。 ");
      }
      await installWithoutOverwrite(mapTarget);
      createdPaths.add(mapTarget.absolutePath);
      journal.phase = "map_created";
      await writeJournalDurably(journalPath, journal);
      await Promise.all([fsyncDirectory(issuesDirectory), fsyncDirectory(this.campaignRoot)]);

      const after = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
      if (after.revision !== plan.view.resultingSourceRevision || after.summary.blockingDiagnostics > 0) {
        throw new Error("创建后的首张地图与预览不一致。 ");
      }
      journal.phase = "verified";
      await writeJournalDurably(journalPath, journal);

      await input.onConfirmed(structuredClone(plan.view));
      eventAppended = true;
      journal.phase = "event_appended";
      await writeJournalDurably(journalPath, journal).catch(() => undefined);
      await unlink(journalPath).catch(ignoreMissing);
      await fsyncDirectory(this.#transactionsDirectory).catch(() => undefined);
      this.#plans.delete(planId);
      return structuredClone(plan.view);
    } catch (error) {
      if (!eventAppended) {
        await rollbackCreatedTargets(plan.targets, createdPaths);
        if (!issuesDirectoryExisted) {
          await rmdir(issuesDirectory).catch(ignoreNotEmptyOrMissing);
        }
        if (journalPersisted) {
          await unlink(journalPath).catch(ignoreMissing);
          await fsyncDirectory(this.#transactionsDirectory).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async recover(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.#transactionsDirectory))
        .filter((name) => name.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right, "en"));
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    for (const name of names) {
      const journalPath = path.join(this.#transactionsDirectory, name);
      const journal = parseJournal(await readFile(journalPath, "utf8"), this.#campaignId);
      const confirmed = journal.phase === "event_appended" || await this.#chartingContainsPlan(journal.planId);
      if (!confirmed) {
        await removeMatchingCreatedTargets(this.campaignRoot, journal);
      }
      await removeJournalTemps(this.campaignRoot, journal);
      await unlink(journalPath);
      await rmdir(path.join(this.campaignRoot, "issues")).catch(ignoreNotEmptyOrMissing);
    }
    if (names.length) {
      await fsyncDirectory(this.#transactionsDirectory);
    }
  }

  #journalFor(plan: MapCreationPlan): CreationJournal {
    return {
      schemaVersion: 1,
      campaignId: this.#campaignId,
      planId: plan.view.id,
      chartingId: plan.view.chartingId,
      phase: "prepared",
      createdAt: this.#now().toISOString(),
      targets: plan.targets.map((target) => ({
        relativePath: target.relativePath,
        temporaryRelativePath: toPosixPath(path.relative(this.campaignRoot, target.temporaryPath)),
        afterBase64: target.after.toString("base64"),
        afterHash: target.afterHash,
        mode: target.mode,
      })),
    };
  }

  async #chartingContainsPlan(planId: string): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.#chartingLogPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    return text.split("\n").some((line) => {
      if (!line.trim()) {
        return false;
      }
      try {
        const event = JSON.parse(line) as { type?: unknown; payload?: { planId?: unknown } };
        return event.type === "map_creation_confirmed" && event.payload?.planId === planId;
      } catch {
        return false;
      }
    });
  }

  #discardExpiredPlans(): void {
    const now = this.#now().getTime();
    for (const [id, plan] of this.#plans) {
      if (Date.parse(plan.view.expiresAt) <= now) {
        this.#plans.delete(id);
      }
    }
  }
}

export class MapCreationError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message.trim());
    this.name = "MapCreationError";
    this.statusCode = statusCode;
  }
}

export class MapCreationConflictError extends MapCreationError {
  constructor(message: string) {
    super(409, message);
    this.name = "MapCreationConflictError";
  }
}

interface RenderedFile {
  relativePath: string;
  bytes: Buffer;
}

function validateProposal(proposal: MapProposal): void {
  const content: MapProposalContent = {
    title: proposal.title,
    destination: proposal.destination,
    notes: proposal.notes,
    tickets: proposal.tickets,
    fog: proposal.fog,
    outOfScope: proposal.outOfScope,
    evidenceRefs: proposal.evidenceRefs,
  };
  parseMapProposalContent(JSON.stringify(content), new Set(proposal.evidenceRefs));
}

function assertBlankCampaign(campaign: CampaignProjection): void {
  if (
    !campaign.diagnostics.some(({ code }) => code === "map_missing") ||
    campaign.locations.length > 0
  ) {
    throw new MapCreationConflictError("项目中已经出现 map.md 或 issue；Explorer 不会覆盖现有地图内容。");
  }
}

function renderMapFiles(proposal: MapProposal): RenderedFile[] {
  const tickets = stableTopologicalTickets(proposal.tickets);
  const idByKey = new Map(tickets.map((ticket, index) => [ticket.key, String(index + 1).padStart(2, "0")]));
  const map = [
    `# ${proposal.title}`,
    "",
    "## Destination",
    "",
    proposal.destination,
    "",
    "## Notes",
    "",
    renderBullets(proposal.notes),
    "## Decisions so far",
    "",
    "## Not yet specified",
    "",
    renderBullets(proposal.fog),
    "## Out of scope",
    "",
    renderBullets(proposal.outOfScope),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  const files: RenderedFile[] = [{ relativePath: "map.md", bytes: Buffer.from(map, "utf8") }];
  for (const ticket of tickets) {
    const id = idByKey.get(ticket.key)!;
    const blockers = ticket.blockedBy.map((key) => idByKey.get(key)!);
    const metadata = [
      `Type: ${ticket.type}`,
      "Status: open",
      ...(blockers.length ? [`Blocked by: ${blockers.join(", ")}`] : []),
    ];
    const issue = [
      `# ${ticket.title}`,
      "",
      ...metadata,
      "",
      "## Question",
      "",
      ticket.question,
      "",
    ].join("\n");
    files.push({
      relativePath: `issues/${id}-${ticket.key}.md`,
      bytes: Buffer.from(issue, "utf8"),
    });
  }
  return files;
}

function renderBullets(items: string[]): string {
  return items.length ? `${items.map((item) => `- ${item}`).join("\n")}\n\n` : "";
}

function stableTopologicalTickets(tickets: MapTicketProposal[]): MapTicketProposal[] {
  const remaining = new Set(tickets.map(({ key }) => key));
  const emitted = new Set<string>();
  const ordered: MapTicketProposal[] = [];
  while (remaining.size) {
    const ready = tickets.filter((ticket) =>
      remaining.has(ticket.key) && ticket.blockedBy.every((key) => emitted.has(key)));
    if (!ready.length) {
      throw new MapCreationError(409, "地图草案的 ticket 依赖无法排序。 ");
    }
    for (const ticket of ready) {
      remaining.delete(ticket.key);
      emitted.add(ticket.key);
      ordered.push(ticket);
    }
  }
  return ordered;
}

async function inspectRenderedMap(files: RenderedFile[], campaignId: string): Promise<CampaignProjection> {
  const previewRoot = await mkdtemp(path.join(tmpdir(), "wayfinder-map-preview-"));
  try {
    await mkdir(path.join(previewRoot, "issues"), { recursive: true, mode: 0o700 });
    for (const file of files) {
      const absolutePath = resolveCampaignFile(previewRoot, file.relativePath);
      await writeFile(absolutePath, file.bytes, { mode: 0o600 });
    }
    return await inspectCampaignAs(previewRoot, campaignId);
  } finally {
    await rm(previewRoot, { recursive: true, force: true });
  }
}

function assertValidFirstMap(
  proposal: MapProposal,
  campaign: CampaignProjection,
  rendered: RenderedFile[],
): void {
  if (campaign.summary.blockingDiagnostics > 0) {
    throw new MapCreationError(409, "首张地图草案无法通过 Wayfinder 结构校验。 ");
  }
  if (campaign.locations.length !== proposal.tickets.length || campaign.summary.resolved !== 0) {
    throw new MapCreationError(409, "首张地图草案意外改变了 ticket 数量或预先解决了 ticket。 ");
  }
  if (campaign.summary.frontier < 2) {
    throw new MapCreationError(409, "首张地图必须提供至少两个当前可选的 frontier。 ");
  }
  if (rendered.length !== proposal.tickets.length + 1) {
    throw new MapCreationError(409, "首张地图没有为每个 ticket 生成唯一 issue。 ");
  }
}

function createTarget(
  root: string,
  planId: string,
  relativePath: string,
  after: Buffer,
): MapCreationTarget {
  const absolutePath = resolveCampaignFile(root, relativePath);
  return {
    relativePath,
    absolutePath,
    after,
    afterHash: hashBytes(after),
    temporaryPath: path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${planId}.tmp`),
    mode: 0o600,
  };
}

async function assertTargetsAbsent(targets: MapCreationTarget[]): Promise<void> {
  for (const target of targets) {
    if (await exists(target.absolutePath)) {
      throw new MapCreationConflictError(`${target.relativePath} 在预览后已经出现；Explorer 没有覆盖它。`);
    }
  }
}

async function installWithoutOverwrite(target: MapCreationTarget): Promise<void> {
  try {
    await link(target.temporaryPath, target.absolutePath);
  } catch (error) {
    if (isFileSystemError(error, "EEXIST")) {
      throw new MapCreationConflictError(`${target.relativePath} 在确认时已经出现；Explorer 没有覆盖它。`);
    }
    throw error;
  }
  await unlink(target.temporaryPath).catch(() => undefined);
}

async function rollbackCreatedTargets(
  targets: MapCreationTarget[],
  createdPaths: ReadonlySet<string>,
): Promise<void> {
  for (const target of [...targets].reverse()) {
    if (createdPaths.has(target.absolutePath)) {
      await unlink(target.absolutePath).catch(ignoreMissing);
    }
    await unlink(target.temporaryPath).catch(ignoreMissing);
  }
  const directories = [...new Set(targets.map(({ absolutePath }) => path.dirname(absolutePath)))];
  await Promise.all(directories.map((directory) => fsyncDirectory(directory).catch(() => undefined)));
}

async function removeMatchingCreatedTargets(root: string, journal: CreationJournal): Promise<void> {
  for (const target of [...journal.targets].reverse()) {
    const absolutePath = resolveCampaignFile(root, target.relativePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    if (hashBytes(bytes) === target.afterHash) {
      await unlink(absolutePath);
    }
  }
}

async function removeJournalTemps(root: string, journal: CreationJournal): Promise<void> {
  for (const target of journal.targets) {
    const temporaryPath = resolveTemporaryCampaignFile(root, target.temporaryRelativePath);
    await unlink(temporaryPath).catch(ignoreMissing);
  }
}

function hashProposal(proposal: MapProposal): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(proposal)).digest("hex")}`;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function renderNewFileDiff(relativePath: string, content: string): string {
  return [
    "--- /dev/null",
    `+++ b/${relativePath}`,
    "@@",
    ...content.replaceAll("\r\n", "\n").split("\n").map((line) => `+${line}`),
  ].join("\n");
}

function resolveCampaignFile(root: string, relativePath: string): string {
  if (relativePath !== "map.md" && !/^issues\/[0-9]{2}-[a-z0-9-]+\.md$/.test(relativePath)) {
    throw new Error(`Unsafe first-map target ${relativePath}.`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`First-map target escapes Campaign root: ${relativePath}.`);
  }
  return resolved;
}

function resolveTemporaryCampaignFile(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = toPosixPath(path.relative(root, resolved));
  if (
    relative.startsWith("../") ||
    path.isAbsolute(relative) ||
    !/^((issues\/)?\.)[^/]+\.tmp$/.test(relative)
  ) {
    throw new Error(`Unsafe first-map temporary path ${relativePath}.`);
  }
  return resolved;
}

async function writeDurableFile(
  targetPath: string,
  bytes: Buffer,
  mode: number,
  exclusive: boolean,
): Promise<void> {
  const handle = await open(targetPath, exclusive ? "wx" : "w", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJournalDurably(targetPath: string, journal: CreationJournal): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.next`;
  await unlink(temporaryPath).catch(ignoreMissing);
  await writeDurableFile(
    temporaryPath,
    Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"),
    0o600,
    true,
  );
  await rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

function parseJournal(text: string, campaignId: string): CreationJournal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("Map creation recovery journal is malformed.", { cause });
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.campaignId !== campaignId ||
    typeof value.planId !== "string" ||
    typeof value.chartingId !== "string" ||
    !isJournalPhase(value.phase) ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.targets) ||
    value.targets.length < 3 ||
    !value.targets.every(isJournalTarget)
  ) {
    throw new Error("Map creation recovery journal has an invalid shape.");
  }
  return value as unknown as CreationJournal;
}

function isJournalTarget(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.relativePath === "string" &&
    typeof value.temporaryRelativePath === "string" &&
    typeof value.afterBase64 === "string" &&
    typeof value.afterHash === "string" &&
    Number.isInteger(value.mode);
}

function isJournalPhase(value: unknown): value is JournalPhase {
  return value === "prepared" ||
    value === "issues_created" ||
    value === "map_created" ||
    value === "verified" ||
    value === "event_appended";
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function ignoreMissing(error: unknown): void {
  if (!isMissingFileError(error)) {
    throw error;
  }
}

function ignoreNotEmptyOrMissing(error: unknown): void {
  if (!isMissingFileError(error) && !isFileSystemError(error, "ENOTEMPTY")) {
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
