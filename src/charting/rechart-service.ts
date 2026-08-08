import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { fsyncDirectory } from "../durability.ts";
import { overlayPathFor } from "../overlay.ts";
import { inspectCampaignAs, inspectCampaignWithChanges } from "../wayfinder.ts";
import type { CampaignProjection, Location, LocationType } from "../model.ts";
import type {
  RechartChangeView,
  RechartFileChangeView,
  RechartIssueChange,
  RechartProposal,
} from "./model.ts";

export interface RechartServiceOptions {
  campaignRoot: string;
  campaignId: string;
  dataRoot?: string;
  now?: () => Date;
}

interface RechartChangeManifest {
  schemaVersion: 1;
  phase: "prepared" | "applied";
  id: string;
  campaignId: string;
  confirmedLocationId: string;
  sourceRevisionBefore: string;
  sourceRevisionAfter: string;
  createdAt: string;
  targets: RechartManifestTarget[];
}

interface RechartManifestTarget {
  locationId?: string;
  relativePath: string;
  beforeBase64: string | null;
  afterBase64: string | null;
  temporaryRelativePath?: string;
  backupRelativePath?: string;
}

/** Validates and atomically applies the derivable portion of one map-Agent rechart. */
export class RechartService {
  #campaignRoot: string;
  #campaignId: string;
  #changesDirectory: string;
  #now: () => Date;

  constructor(options: RechartServiceOptions) {
    this.#campaignRoot = path.resolve(options.campaignRoot);
    this.#campaignId = options.campaignId;
    this.#changesDirectory = path.join(
      path.dirname(overlayPathFor(options.campaignId, options.dataRoot)),
      "rechart-changes",
    );
    this.#now = options.now ?? (() => new Date());
  }

  static async open(options: RechartServiceOptions): Promise<RechartService> {
    const service = new RechartService(options);
    await service.recover();
    return service;
  }

  async recover(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.#changesDirectory))
        .filter((name) => /^rechart-change-[a-z0-9-]+\.json$/i.test(name))
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    for (const name of names) {
      const manifestPath = path.join(this.#changesDirectory, name);
      const changeId = name.slice(0, -".json".length);
      const manifest = parseManifest(
        await readFile(manifestPath, "utf8"),
        this.#campaignId,
        changeId,
      );
      if (manifest.phase === "prepared") {
        const allApplied = await manifestMatches(manifest, this.#campaignRoot, "after");
        if (allApplied) {
          manifest.phase = "applied";
          await writeManifestDurably(manifestPath, manifest);
        } else {
          await restorePreparedManifest(manifest, this.#campaignRoot);
          await unlink(manifestPath).catch(ignoreMissing);
          await fsyncDirectory(this.#changesDirectory).catch(() => undefined);
          continue;
        }
      }
      await cleanupManifestArtifacts(manifest, this.#campaignRoot);
    }
  }

  async recoverAppliedChange(
    confirmedLocationId: string,
    sourceRevisionBefore: string,
  ): Promise<RechartChangeView | undefined> {
    let names: string[];
    try {
      names = (await readdir(this.#changesDirectory))
        .filter((name) => /^rechart-change-[a-z0-9-]+\.json$/i.test(name))
        .sort()
        .reverse();
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      const manifest = parseManifest(
        await readFile(path.join(this.#changesDirectory, name), "utf8"),
        this.#campaignId,
        id,
      );
      if (
        manifest.phase !== "applied" ||
        manifest.confirmedLocationId !== confirmedLocationId ||
        manifest.sourceRevisionBefore !== sourceRevisionBefore ||
        !await manifestMatches(manifest, this.#campaignRoot, "after")
      ) {
        continue;
      }
      return changeViewFromManifest(manifest);
    }
    return undefined;
  }

  async apply(
    proposal: RechartProposal,
    activeLocationIds: ReadonlySet<string>,
  ): Promise<RechartChangeView> {
    const before = await inspectCampaignAs(this.#campaignRoot, this.#campaignId);
    if (before.revision !== proposal.sourceRevision) {
      throw new RechartConflictError("地图在重绘提案形成期间已经变化；已确认答案保留，重绘需要重试。");
    }
    for (const conflict of proposal.reviewConflicts) {
      const location = before.locations.find(({ id }) => id === conflict.locationId);
      if (!location || location.sourceStatus !== "resolved") {
        throw new RechartValidationError(`复核冲突 ${conflict.locationId} 不是既有确认答案。`);
      }
    }
    for (const update of proposal.explorationUpdates) {
      if (!activeLocationIds.has(update.locationId)) {
        throw new RechartValidationError(`探索上下文更新 ${update.locationId} 没有对应的正在探索会话。`);
      }
    }
    const endChanges = proposal.issueChanges.filter((change) => change.kind === "end");
    if (proposal.triggerKind === "exploration_ended") {
      if (
        endChanges.length !== 1 ||
        endChanges[0].issueId !== proposal.confirmedLocationId ||
        proposal.explorationUpdates.some(({ locationId }) => locationId === proposal.confirmedLocationId) ||
        proposal.reviewConflicts.some(({ locationId }) => locationId === proposal.confirmedLocationId)
      ) {
        throw new RechartValidationError("结束探索的重绘必须且只能关闭认领者明确结束的那个议题。");
      }
      const ending = before.locations.find(({ id }) => id === proposal.confirmedLocationId);
      if (!ending || ending.sourceStatus !== "open") {
        throw new RechartValidationError("结束探索的重绘目标已经不是开放议题。");
      }
    } else if (endChanges.length) {
      throw new RechartValidationError("答案确认触发的重绘不能替认领者结束探索。");
    }

    const mapPath = path.join(this.#campaignRoot, "map.md");
    const source = await readFile(mapPath, "utf8");
    const next = replaceSection(
      replaceSection(source, "Not yet specified", renderBullets(proposal.fog)),
      "Out of scope",
      renderBullets(proposal.outOfScope),
    );
    const changes = await this.#renderChanges(before, proposal.issueChanges);
    for (const conflict of proposal.reviewConflicts) {
      const location = before.locations.find(({ id }) => id === conflict.locationId)!;
      const source = await readFile(path.join(this.#campaignRoot, location.sourcePath), "utf8");
      changes.set(
        location.sourcePath,
        setReviewPending(source, conflict.question, conflict.reason),
      );
    }
    if (next !== source) {
      changes.set("map.md", next);
    }
    if (!changes.size) {
      return {
        id: `rechart-change-${randomUUID()}`,
        confirmedLocationId: proposal.confirmedLocationId,
        sourceRevisionBefore: before.revision,
        sourceRevisionAfter: before.revision,
        createdAt: this.#now().toISOString(),
        files: [],
        restoredLocationIds: [],
      };
    }

    const canonicalChanges = new Map([...changes].filter(([relativePath]) =>
      relativePath === "map.md" || relativePath.startsWith("issues/")));
    const projected = await inspectCampaignWithChanges(
      this.#campaignRoot,
      canonicalChanges,
      this.#campaignId,
    );
    if (projected.summary.blockingDiagnostics > 0) {
      throw new RechartValidationError("重绘提案会使规范地图产生阻塞诊断。");
    }
    if (
      projected.title !== before.title ||
      projected.destination !== before.destination ||
      projected.startingState !== before.startingState ||
      JSON.stringify(projected.evidenceScope) !== JSON.stringify(before.evidenceScope)
    ) {
      throw new RechartValidationError("重绘提案改变了本轮不允许变化的地图内容。");
    }
    assertProtectedLocationsUnchanged(before, projected, activeLocationIds);

    const targets = await Promise.all([...changes].map(([relativePath, after]) =>
      createTarget(this.#campaignRoot, relativePath, after)));
    const change = changeViewFor(
      proposal,
      before.revision,
      projected.revision,
      targets,
      this.#now,
    );
    const manifest = manifestFor(this.#campaignId, this.#campaignRoot, change, targets);
    const manifestPath = this.#manifestPath(change.id);
    for (const target of targets) {
      if (target.after !== null) {
        await writeDurableFile(target.temporaryPath, target.after);
      }
    }
    try {
      const latest = await inspectCampaignAs(this.#campaignRoot, this.#campaignId);
      if (latest.revision !== proposal.sourceRevision) {
        throw new RechartConflictError("地图在重绘写入前已经变化；Explorer 没有覆盖外部内容。");
      }
      await writeManifestDurably(manifestPath, manifest);
      await commitTargets(targets);
      const committed = await inspectCampaignAs(this.#campaignRoot, this.#campaignId);
      if (committed.revision !== projected.revision) {
        throw new RechartValidationError("重绘写入结果与验证过的投影不一致。");
      }
      manifest.phase = "applied";
      await writeManifestDurably(manifestPath, manifest);
      await finishTargets(targets);
      return change;
    } catch (error) {
      await rollbackTargets(targets);
      await unlink(manifestPath).catch(ignoreMissing);
      throw error;
    }
  }

  async restore(
    changeId: string,
    locationId: string,
    activeLocationIds: ReadonlySet<string> = new Set(),
  ): Promise<string> {
    if (activeLocationIds.has(locationId)) {
      throw new RechartValidationError("正在探索的议题不能恢复重绘变化；请先结束当前探索。");
    }
    const manifest = parseManifest(
      await readFile(this.#manifestPath(changeId), "utf8").catch((error) => {
        if (isMissingFileError(error)) {
          throw new RechartValidationError("这次重绘变化的恢复记录不存在。");
        }
        throw error;
      }),
      this.#campaignId,
      changeId,
    );
    const selected = manifest.targets.filter((target) => target.locationId === locationId);
    if (!selected.length) {
      throw new RechartValidationError(`这次重绘没有改变议题 ${locationId}。`);
    }
    if (selected.some(({ relativePath }) => relativePath.startsWith("history/unfinished/"))) {
      throw new RechartValidationError("主动结束探索不是可恢复的机械重绘变化。");
    }
    for (const target of selected) {
      const current = await readOptionalFile(resolveSafeTarget(this.#campaignRoot, target.relativePath));
      const expected = decodeOptionalBase64(target.afterBase64);
      if (!optionalBuffersEqual(current, expected)) {
        throw new RechartValidationError(
          `议题 ${locationId} 已经不再是这次重绘后的版本；Explorer 不会覆盖后续变化。`,
        );
      }
    }

    const currentCampaign = await inspectCampaignAs(this.#campaignRoot, this.#campaignId);
    const currentLocation = currentCampaign.locations.find(({ id }) => id === locationId);
      if (currentLocation?.sourceStatus === "resolved") {
      throw new RechartValidationError("已经确认的地图节点不能通过重绘恢复入口修改。");
    }
    const canonicalChanges = new Map<string, string | null>();
    for (const target of selected) {
      if (!target.relativePath.startsWith("issues/")) {
        continue;
      }
      const beforeBytes = decodeOptionalBase64(target.beforeBase64);
      canonicalChanges.set(target.relativePath, beforeBytes?.toString("utf8") ?? null);
    }
    const projected = await inspectCampaignWithChanges(
      this.#campaignRoot,
      canonicalChanges,
      this.#campaignId,
    );
    if (projected.summary.blockingDiagnostics > 0) {
      throw new RechartValidationError("恢复这次变化会使规范地图产生阻塞诊断。");
    }
    if (
      projected.title !== currentCampaign.title ||
      projected.destination !== currentCampaign.destination ||
      projected.startingState !== currentCampaign.startingState ||
      JSON.stringify(projected.evidenceScope) !== JSON.stringify(currentCampaign.evidenceScope)
    ) {
      throw new RechartValidationError("恢复这次变化会改变不属于该议题的地图边界。");
    }

    const targets = await Promise.all(selected.map((target) =>
      createTarget(
        this.#campaignRoot,
        target.relativePath,
        decodeOptionalBase64(target.beforeBase64),
      )));
    for (const target of targets) {
      if (target.after !== null) {
        await writeDurableFile(target.temporaryPath, target.after);
      }
    }
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const expected = decodeOptionalBase64(selected[index].afterBase64);
        if (!optionalBuffersEqual(targets[index].before, expected)) {
          throw new RechartConflictError("恢复写入前议题又发生了变化；Explorer 没有覆盖它。");
        }
      }
      await commitTargets(targets);
      const committed = await inspectCampaignAs(this.#campaignRoot, this.#campaignId);
      if (committed.revision !== projected.revision) {
        throw new RechartValidationError("恢复写入结果与验证过的投影不一致。");
      }
      await finishTargets(targets);
      return committed.revision;
    } catch (error) {
      await rollbackTargets(targets);
      throw error;
    }
  }

  #manifestPath(changeId: string): string {
    if (!/^rechart-change-[a-z0-9-]+$/i.test(changeId)) {
      throw new RechartValidationError("重绘变化标识无效。");
    }
    return path.join(this.#changesDirectory, `${changeId}.json`);
  }

  async #renderChanges(
    campaign: CampaignProjection,
    issueChanges: RechartIssueChange[],
  ): Promise<Map<string, string | null>> {
    const reassessedIds = new Set(issueChanges.flatMap((change) =>
      change.kind === "create" ? [] : [change.issueId]));
    for (const location of campaign.locations) {
      if (location.rechartState === "pending_delete" && !reassessedIds.has(location.id)) {
        throw new RechartValidationError(
          `待删除议题 ${location.id} 必须在本轮依据最新答案重新评估。`,
        );
      }
    }
    const rendered = new Map<string, string | null>();
    const touched = new Set<string>();
    const knownIds = new Set(campaign.locations.map(({ id }) => id));
    let nextId = Math.max(0, ...campaign.locations.map(({ id }) => Number(id)).filter(Number.isFinite)) + 1;
    for (const change of issueChanges) {
      if (change.kind === "create") {
        validateBlockers(change.blockedBy, knownIds, `新议题 ${change.key}`);
        const id = String(nextId++).padStart(2, "0");
        const relativePath = `issues/${id}-${change.key}.md`;
        if (rendered.has(relativePath)) {
          throw new RechartValidationError(`重绘提案重复创建 ${relativePath}。`);
        }
        rendered.set(relativePath, renderIssue(change.title, change.type, change.question, change.blockedBy));
        knownIds.add(id);
        continue;
      }
      if (touched.has(change.issueId)) {
        throw new RechartValidationError(`重绘提案多次修改议题 ${change.issueId}。`);
      }
      touched.add(change.issueId);
      const location = campaign.locations.find(({ id }) => id === change.issueId);
      if (!location) {
        throw new RechartValidationError(`重绘提案引用了不存在的议题 ${change.issueId}。`);
      }
      if (location.sourceStatus !== "open") {
        throw new RechartValidationError(`重绘不能修改已经确认的议题 ${change.issueId}。`);
      }
      const source = await readFile(path.join(this.#campaignRoot, location.sourcePath), "utf8");
      if (change.kind === "end") {
        const archivePath = `history/unfinished/${path.basename(location.sourcePath)}`;
        await assertArchiveMissing(this.#campaignRoot, archivePath);
        rendered.set(archivePath, renderUnfinishedHistory(source, change.reason));
        rendered.set(location.sourcePath, null);
        continue;
      }
      if (change.kind === "pending_delete") {
        if (/^Rechart state:\s*pending-delete\s*$/mi.test(source)) {
          const archivePath = `history/unexplored/${path.basename(location.sourcePath)}`;
          await assertArchiveMissing(this.#campaignRoot, archivePath);
          rendered.set(archivePath, renderUnexploredHistory(source, change.reason));
          rendered.set(location.sourcePath, null);
        } else {
          rendered.set(location.sourcePath, setPendingDeletion(source, change.reason));
        }
        continue;
      }
      validateBlockers(change.blockedBy, knownIds, `议题 ${change.issueId}`);
      if (change.blockedBy.includes(change.issueId)) {
        throw new RechartValidationError(`议题 ${change.issueId} 不能依赖自身。`);
      }
      rendered.set(location.sourcePath, patchOpenIssue(source, change));
    }
    return rendered;
  }
}

export class RechartError extends Error {
  constructor(message: string) {
    super(message.trim());
    this.name = "RechartError";
  }
}

export class RechartConflictError extends RechartError {
  constructor(message: string) {
    super(message);
    this.name = "RechartConflictError";
  }
}

export class RechartValidationError extends RechartError {
  constructor(message: string) {
    super(message);
    this.name = "RechartValidationError";
  }
}

interface RechartTarget {
  relativePath: string;
  absolutePath: string;
  before: Buffer | null;
  after: Buffer | null;
  temporaryPath: string;
  backupPath: string;
  backupCreated: boolean;
  installed: boolean;
}

async function createTarget(
  root: string,
  relativePath: string,
  after: string | Buffer | null,
): Promise<RechartTarget> {
  if (
    relativePath !== "map.md" &&
    !/^issues\/\d+-[a-z0-9-]+\.md$/.test(relativePath) &&
    !/^history\/(?:unexplored|unfinished)\/\d+-[a-z0-9-]+\.md$/.test(relativePath)
  ) {
    throw new RechartValidationError(`不安全的重绘目标 ${relativePath}。`);
  }
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RechartValidationError(`重绘目标越出项目目录 ${relativePath}。`);
  }
  let before: Buffer | null;
  try {
    before = await readFile(absolutePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    before = null;
  }
  const transactionId = randomUUID();
  await mkdir(path.dirname(absolutePath), { recursive: true });
  return {
    relativePath,
    absolutePath,
    before,
    after: after === null ? null : Buffer.isBuffer(after) ? Buffer.from(after) : Buffer.from(after, "utf8"),
    temporaryPath: path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${transactionId}.tmp`),
    backupPath: path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${transactionId}.bak`),
    backupCreated: false,
    installed: false,
  };
}

function changeViewFor(
  proposal: RechartProposal,
  sourceRevisionBefore: string,
  sourceRevisionAfter: string,
  targets: RechartTarget[],
  now: () => Date,
): RechartChangeView {
  const files: RechartFileChangeView[] = targets.flatMap((target) => {
    const locationId = locationIdForPath(target.relativePath);
    if (!locationId) {
      return [];
    }
    const operation: RechartFileChangeView["operation"] = target.relativePath.startsWith("history/")
      ? "archived"
      : target.before === null
        ? "created"
        : target.after === null
          ? "deleted"
          : "updated";
    return [{ locationId, path: target.relativePath, operation }];
  });
  return {
    id: `rechart-change-${randomUUID()}`,
    confirmedLocationId: proposal.confirmedLocationId,
    sourceRevisionBefore,
    sourceRevisionAfter,
    createdAt: now().toISOString(),
    files,
    restoredLocationIds: [],
  };
}

function manifestFor(
  campaignId: string,
  campaignRoot: string,
  change: RechartChangeView,
  targets: RechartTarget[],
): RechartChangeManifest {
  return {
    schemaVersion: 1,
    phase: "prepared",
    id: change.id,
    campaignId,
    confirmedLocationId: change.confirmedLocationId,
    sourceRevisionBefore: change.sourceRevisionBefore,
    sourceRevisionAfter: change.sourceRevisionAfter,
    createdAt: change.createdAt,
    targets: targets.map((target) => ({
      locationId: locationIdForPath(target.relativePath),
      relativePath: target.relativePath,
      beforeBase64: target.before?.toString("base64") ?? null,
      afterBase64: target.after?.toString("base64") ?? null,
      temporaryRelativePath: toPosixPath(path.relative(campaignRoot, target.temporaryPath)),
      backupRelativePath: toPosixPath(path.relative(campaignRoot, target.backupPath)),
    })),
  };
}

function locationIdForPath(relativePath: string): string | undefined {
  return /^(?:issues|history\/(?:unexplored|unfinished))\/(\d+)-[a-z0-9-]+\.md$/.exec(relativePath)?.[1];
}

async function writeManifestDurably(
  manifestPath: string,
  manifest: RechartChangeManifest,
): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  await writeDurableFile(temporaryPath, Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"));
  await rename(temporaryPath, manifestPath);
  await fsyncDirectory(path.dirname(manifestPath));
}

function parseManifest(
  source: string,
  campaignId: string,
  changeId: string,
): RechartChangeManifest {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new RechartValidationError(`重绘变化记录 ${changeId} 无法解析。`);
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.phase !== undefined && value.phase !== "prepared" && value.phase !== "applied") ||
    value.id !== changeId ||
    value.campaignId !== campaignId ||
    typeof value.confirmedLocationId !== "string" ||
    typeof value.sourceRevisionBefore !== "string" ||
    typeof value.sourceRevisionAfter !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.targets) ||
    !value.targets.every(isManifestTarget)
  ) {
    throw new RechartValidationError(`重绘变化记录 ${changeId} 无效。`);
  }
  const manifest = value as unknown as RechartChangeManifest;
  manifest.phase ??= "applied";
  return manifest;
}

function isManifestTarget(value: unknown): value is RechartManifestTarget {
  return isRecord(value) &&
    (value.locationId === undefined || typeof value.locationId === "string") &&
    typeof value.relativePath === "string" &&
    (value.beforeBase64 === null || isBase64(value.beforeBase64)) &&
    (value.afterBase64 === null || isBase64(value.afterBase64)) &&
    (value.temporaryRelativePath === undefined || typeof value.temporaryRelativePath === "string") &&
    (value.backupRelativePath === undefined || typeof value.backupRelativePath === "string");
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeOptionalBase64(value: string | null): Buffer | null {
  return value === null ? null : Buffer.from(value, "base64");
}

async function readOptionalFile(absolutePath: string): Promise<Buffer | null> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function optionalBuffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}

async function manifestMatches(
  manifest: RechartChangeManifest,
  campaignRoot: string,
  version: "before" | "after",
): Promise<boolean> {
  for (const target of manifest.targets) {
    const current = await readOptionalFile(resolveSafeTarget(campaignRoot, target.relativePath));
    const expected = decodeOptionalBase64(
      version === "before" ? target.beforeBase64 : target.afterBase64,
    );
    if (!optionalBuffersEqual(current, expected)) {
      return false;
    }
  }
  return true;
}

async function restorePreparedManifest(
  manifest: RechartChangeManifest,
  campaignRoot: string,
): Promise<void> {
  const directories = new Set<string>();
  for (const target of manifest.targets) {
    const absolutePath = resolveSafeTarget(campaignRoot, target.relativePath);
    directories.add(path.dirname(absolutePath));
    const before = decodeOptionalBase64(target.beforeBase64);
    if (before === null) {
      await unlink(absolutePath).catch(ignoreMissing);
      continue;
    }
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(absolutePath),
      `.${path.basename(absolutePath)}.${randomUUID()}.recover`,
    );
    await writeDurableFile(temporaryPath, before);
    await rename(temporaryPath, absolutePath);
  }
  await Promise.all([...directories].map((directory) => fsyncDirectory(directory)));
  await cleanupManifestArtifacts(manifest, campaignRoot);
}

async function cleanupManifestArtifacts(
  manifest: RechartChangeManifest,
  campaignRoot: string,
): Promise<void> {
  const directories = new Set<string>();
  for (const target of manifest.targets) {
    for (const relativePath of [target.temporaryRelativePath, target.backupRelativePath]) {
      if (!relativePath) {
        continue;
      }
      const absolutePath = resolveSafeArtifact(campaignRoot, relativePath);
      directories.add(path.dirname(absolutePath));
      await unlink(absolutePath).catch(ignoreMissing);
    }
  }
  await Promise.all([...directories].map((directory) => fsyncDirectory(directory).catch(() => undefined)));
}

function changeViewFromManifest(manifest: RechartChangeManifest): RechartChangeView {
  const files: RechartFileChangeView[] = manifest.targets.flatMap((target) => {
    const locationId = target.locationId ?? locationIdForPath(target.relativePath);
    if (!locationId) {
      return [];
    }
    const before = decodeOptionalBase64(target.beforeBase64);
    const after = decodeOptionalBase64(target.afterBase64);
    const operation: RechartFileChangeView["operation"] = target.relativePath.startsWith("history/")
      ? "archived"
      : before === null
        ? "created"
        : after === null
          ? "deleted"
          : "updated";
    return [{ locationId, path: target.relativePath, operation }];
  });
  return {
    id: manifest.id,
    confirmedLocationId: manifest.confirmedLocationId,
    sourceRevisionBefore: manifest.sourceRevisionBefore,
    sourceRevisionAfter: manifest.sourceRevisionAfter,
    createdAt: manifest.createdAt,
    files,
    restoredLocationIds: [],
  };
}

function resolveSafeArtifact(root: string, relativePath: string): string {
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(absolutePath).startsWith(".") ||
    !/\.(?:tmp|bak)$/.test(absolutePath)
  ) {
    throw new RechartValidationError(`重绘事务记录包含不安全临时目标 ${relativePath}。`);
  }
  return absolutePath;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveSafeTarget(root: string, relativePath: string): string {
  if (
    relativePath !== "map.md" &&
    !/^issues\/\d+-[a-z0-9-]+\.md$/.test(relativePath) &&
    !/^history\/(?:unexplored|unfinished)\/\d+-[a-z0-9-]+\.md$/.test(relativePath)
  ) {
    throw new RechartValidationError(`重绘变化记录包含不安全目标 ${relativePath}。`);
  }
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RechartValidationError(`重绘变化记录越出项目目录 ${relativePath}。`);
  }
  return absolutePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeDurableFile(targetPath: string, bytes: Buffer): Promise<void> {
  const handle = await open(targetPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function commitTargets(targets: RechartTarget[]): Promise<void> {
  for (const target of targets) {
    if (target.before !== null) {
      await link(target.absolutePath, target.backupPath);
      target.backupCreated = true;
    }
  }
  for (const target of targets) {
    if (target.after === null) {
      await unlink(target.absolutePath);
    } else if (target.before === null) {
      await link(target.temporaryPath, target.absolutePath);
      await unlink(target.temporaryPath);
    } else {
      await rename(target.temporaryPath, target.absolutePath);
    }
    target.installed = true;
  }
  await syncTargetDirectories(targets);
}

async function finishTargets(targets: RechartTarget[]): Promise<void> {
  for (const target of targets) {
    await unlink(target.backupPath).catch(ignoreMissing);
    await unlink(target.temporaryPath).catch(ignoreMissing);
    target.backupCreated = false;
  }
  await syncTargetDirectories(targets);
}

async function rollbackTargets(targets: RechartTarget[]): Promise<void> {
  for (const target of [...targets].reverse()) {
    if (target.installed) {
      await unlink(target.absolutePath).catch(ignoreMissing);
    }
    if (target.backupCreated) {
      await rename(target.backupPath, target.absolutePath).catch(() => undefined);
    }
    await unlink(target.temporaryPath).catch(ignoreMissing);
    await unlink(target.backupPath).catch(ignoreMissing);
  }
  await syncTargetDirectories(targets).catch(() => undefined);
}

async function syncTargetDirectories(targets: RechartTarget[]): Promise<void> {
  const directories = new Set(targets.map(({ absolutePath }) => path.dirname(absolutePath)));
  await Promise.all([...directories].map((directory) => fsyncDirectory(directory)));
}

function assertProtectedLocationsUnchanged(
  before: CampaignProjection,
  after: CampaignProjection,
  activeLocationIds: ReadonlySet<string>,
): void {
  const protectedIds = new Set([
    ...before.locations.filter(({ sourceStatus }) => sourceStatus === "resolved").map(({ id }) => id),
    ...activeLocationIds,
  ]);
  for (const id of protectedIds) {
    const previous = before.locations.find((location) => location.id === id);
    const next = after.locations.find((location) => location.id === id);
    if (!previous || !next || locationFingerprint(previous) !== locationFingerprint(next)) {
      throw new RechartValidationError(`重绘提案改变了已确认或正在探索的议题 ${id}。`);
    }
  }
}

function locationFingerprint(location: Location): string {
  return JSON.stringify({
    id: location.id,
    sourcePath: location.sourcePath,
    title: location.title,
    type: location.type,
    sourceStatus: location.sourceStatus,
    blockers: location.blockers,
    question: location.question,
    answerMarkdown: location.answerMarkdown,
    rechartState: location.rechartState,
  });
}

function validateBlockers(blockers: string[], knownIds: ReadonlySet<string>, subject: string): void {
  if (new Set(blockers).size !== blockers.length) {
    throw new RechartValidationError(`${subject} 包含重复依赖。`);
  }
  for (const blocker of blockers) {
    if (!knownIds.has(blocker)) {
      throw new RechartValidationError(`${subject} 依赖不存在的议题 ${blocker}。`);
    }
  }
}

function renderIssue(
  title: string,
  type: LocationType,
  question: string,
  blockedBy: string[],
): string {
  return [
    `# ${title}`,
    "",
    `Type: ${type}`,
    "Status: open",
    ...(blockedBy.length ? [`Blocked by: ${blockedBy.join(", ")}`] : []),
    "",
    "## Question",
    "",
    question,
    "",
  ].join("\n");
}

function patchOpenIssue(
  source: string,
  change: Extract<RechartIssueChange, { kind: "update" }>,
): string {
  let next = source.replace(/^#\s+.*$/m, `# ${change.title}`)
    .replace(/^Type:\s*.*$/mi, `Type: ${change.type}`)
    .replace(/^Rechart state:\s*pending-delete\s*\n?/mi, "");
  const blockedLine = `Blocked by: ${change.blockedBy.join(", ")}`;
  if (/^Blocked by:\s*.*$/mi.test(next)) {
    next = change.blockedBy.length
      ? next.replace(/^Blocked by:\s*.*$/mi, blockedLine)
      : next.replace(/^Blocked by:\s*.*\n?/mi, "");
  } else if (change.blockedBy.length) {
    next = next.replace(/^(Status:[^\S\r\n]*open[^\S\r\n]*)$/mi, `$1\n${blockedLine}`);
  }
  return replaceSection(next, "Question", change.question);
}

function setPendingDeletion(source: string, reason: string): string {
  const withState = source.replace(
    /^(Status:[^\S\r\n]*open[^\S\r\n]*)$/mi,
    "$1\nRechart state: pending-delete",
  );
  const withoutOldReason = removeSection(withState, "Pending deletion");
  return `${withoutOldReason.trimEnd()}\n\n## Pending deletion\n\n${reason}\n`;
}

function renderUnexploredHistory(source: string, reason: string): string {
  return `${source.trimEnd()}\n\n## Archived without exploration\n\n${reason}\n`;
}

function renderUnfinishedHistory(source: string, reason: string): string {
  return `${source.trimEnd()}\n\n## Exploration ended\n\n${reason}\n`;
}

async function assertArchiveMissing(root: string, relativePath: string): Promise<void> {
  try {
    await readFile(path.join(root, relativePath));
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }
  throw new RechartValidationError(`未探索历史 ${relativePath} 已存在，Explorer 不会覆盖它。`);
}

function setReviewPending(source: string, question: string, reason: string): string {
  let next = removeSection(removeSection(source, "Review question"), "Review reason");
  if (/^Review state:\s*.*$/mi.test(next)) {
    next = next.replace(/^Review state:\s*.*$/mi, "Review state: pending");
  } else {
    next = next.replace(
      /^(Status:[^\S\r\n]*resolved[^\S\r\n]*)$/mi,
      "$1\nReview state: pending",
    );
  }
  return `${next.trimEnd()}\n\n## Review question\n\n${question}\n\n## Review reason\n\n${reason}\n`;
}

function removeSection(markdown: string, heading: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) {
    return markdown;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return `${[...lines.slice(0, start), ...lines.slice(end)].join("\n").trimEnd()}\n`;
}

function replaceSection(markdown: string, heading: string, body: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (headingIndex < 0) {
    throw new RechartValidationError(`map.md 缺少 ${heading} 段落。`);
  }
  let nextHeading = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      nextHeading = index;
      break;
    }
  }
  const replacement = [`## ${heading}`, "", ...body.split("\n")];
  while (replacement.at(-1) === "") {
    replacement.pop();
  }
  replacement.push("");
  const result = [
    ...lines.slice(0, headingIndex),
    ...replacement,
    ...lines.slice(nextHeading),
  ].join("\n").replace(/\n{3,}/g, "\n\n");
  return `${result.trimEnd()}\n`;
}

function renderBullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function ignoreMissing(error: unknown): void {
  if (!isMissingFileError(error)) {
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
