import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { fsyncDirectory } from "../durability.ts";
import type { CampaignProjection, Location } from "../model.ts";
import { overlayPathFor } from "../overlay.ts";
import type {
  DecisionProposal,
  WritebackLocationImpact,
  WritebackPlanView,
} from "../expedition/model.ts";
import { validateSafeCommonMark } from "../expedition/proposal.ts";
import {
  inspectCampaignAs,
  inspectCampaignWithOverrides,
} from "../wayfinder.ts";

const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1_000;

interface WritebackTarget {
  relativePath: string;
  absolutePath: string;
  before: Buffer;
  after: Buffer;
  beforeHash: string;
  afterHash: string;
  mode: number;
  temporaryPath: string;
}

interface WritebackPlan {
  view: WritebackPlanView;
  targets: WritebackTarget[];
}

type JournalPhase = "prepared" | "issue_renamed" | "map_renamed" | "verified" | "event_appended";

interface RecoveryJournal {
  schemaVersion: 1;
  campaignId: string;
  planId: string;
  expeditionId: string;
  phase: JournalPhase;
  createdAt: string;
  targets: Array<{
    relativePath: string;
    temporaryRelativePath: string;
    beforeBase64: string;
    afterBase64: string;
    mode: number;
  }>;
}

export interface WritebackServiceOptions {
  campaignRoot: string;
  campaignId: string;
  dataRoot?: string;
  now?: () => Date;
  planTtlMs?: number;
}

export interface CreateWritebackPlanInput {
  expeditionId: string;
  locationId: string;
  proposal: DecisionProposal;
  expectedSourceRevision: string;
}

export interface ConfirmWritebackInput {
  expectedSourceRevision: string;
  proposalHash: string;
  onConfirmed(plan: WritebackPlanView): Promise<void>;
}

/** The sole module allowed to change canonical Wayfinder Markdown. */
export class WritebackService {
  readonly campaignRoot: string;

  #campaignId: string;
  #campaignDataDirectory: string;
  #transactionsDirectory: string;
  #now: () => Date;
  #planTtlMs: number;
  #plans = new Map<string, WritebackPlan>();

  private constructor(options: WritebackServiceOptions) {
    this.campaignRoot = path.resolve(options.campaignRoot);
    this.#campaignId = options.campaignId;
    this.#campaignDataDirectory = path.dirname(overlayPathFor(options.campaignId, options.dataRoot));
    this.#transactionsDirectory = path.join(this.#campaignDataDirectory, "transactions");
    this.#now = options.now ?? (() => new Date());
    this.#planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
  }

  static async open(options: WritebackServiceOptions): Promise<WritebackService> {
    const service = new WritebackService(options);
    await service.recover();
    return service;
  }

  getPlanForExpedition(expeditionId: string): WritebackPlanView | undefined {
    this.#discardExpiredPlans();
    const plan = [...this.#plans.values()].find(({ view }) => view.expeditionId === expeditionId);
    return plan ? structuredClone(plan.view) : undefined;
  }

  getPlan(planId: string): WritebackPlanView | undefined {
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    return plan ? structuredClone(plan.view) : undefined;
  }

  discardPlan(planId: string): void {
    this.#plans.delete(planId);
  }

  async createPlan(input: CreateWritebackPlanInput): Promise<WritebackPlanView> {
    this.#discardExpiredPlans();
    validateSafeCommonMark(input.proposal.answerMarkdown);
    const before = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
    if (
      before.revision !== input.expectedSourceRevision ||
      input.proposal.sourceRevision !== input.expectedSourceRevision
    ) {
      throw new WritebackConflictError(
        "Wayfinder Markdown 在草案形成后已经变化，请先重新审阅当前地图。",
      );
    }
    if (before.summary.blockingDiagnostics > 0) {
      throw new WritebackError(409, "源地图有阻塞诊断，不能计算可靠的写回影响。");
    }
    const location = before.locations.find(({ id }) => id === input.locationId);
    if (!location) {
      throw new WritebackError(404, `地图上不存在地点 ${input.locationId}。`);
    }
    const sameAnswer = location.answerMarkdown?.trim() === input.proposal.answerMarkdown.trim();
    const changeKind = location.sourceStatus === "resolved"
      ? location.reviewState === "pending" && sameAnswer
        ? "reaffirmation" as const
        : "revision" as const
      : "confirmation" as const;
    if (changeKind === "confirmation") {
      if (location.status !== "frontier" || location.sourceStatus !== "open") {
        throw new WritebackConflictError("这个地点已经不是可确认的当前探索点。");
      }
      if (location.answerMarkdown || location.sourceRanges.answer) {
        throw new WritebackConflictError("开放议题意外包含 Answer，Explorer 不会覆盖它。");
      }
    } else {
      if (!location.answerMarkdown || !location.sourceRanges.answer) {
        throw new WritebackConflictError("已确认节点缺少可保留的当前答案，不能安全修订。");
      }
      if (changeKind === "revision" && sameAnswer) {
        throw new WritebackConflictError("答案内容没有变化；只有待复核节点可以原样确认仍然成立。");
      }
    }

    const sourcePaths = [location.sourcePath, "map.md"];
    const sourceFiles = await Promise.all(sourcePaths.map(async (relativePath) => {
      const absolutePath = resolveCampaignFile(this.campaignRoot, relativePath);
      const [bytes, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      return { relativePath, absolutePath, bytes, mode: metadata.mode & 0o777 };
    }));
    const issueFile = sourceFiles[0];
    const mapFile = sourceFiles[1];
    const issueAfter = Buffer.from(patchIssue(location, issueFile.bytes.toString("utf8"), input.proposal), "utf8");
    const mapAfter = Buffer.from(patchMap(mapFile.bytes.toString("utf8"), location, input.proposal), "utf8");
    const overrides = new Map<string, Buffer>([
      [location.sourcePath, issueAfter],
      ["map.md", mapAfter],
    ]);
    const after = await inspectCampaignWithOverrides(this.campaignRoot, overrides, this.#campaignId);
    assertValidProjection(before, after, location.id, changeKind);

    const createdAt = this.#now();
    const planId = `writeback-${randomUUID()}`;
    const targets = [
      createTarget(planId, sourceFiles[0], issueAfter),
      createTarget(planId, sourceFiles[1], mapAfter),
    ];
    const view: WritebackPlanView = {
      id: planId,
      expeditionId: input.expeditionId,
      locationId: location.id,
      changeKind,
      expectedSourceRevision: before.revision,
      resultingSourceRevision: after.revision,
      proposalHash: hashProposal(input.proposal),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.#planTtlMs).toISOString(),
      files: targets.map((target) => ({
        path: target.relativePath,
        beforeHash: target.beforeHash,
        afterHash: target.afterHash,
        diff: renderDiff(target.relativePath, target.before.toString("utf8"), target.after.toString("utf8")),
      })),
      impact: calculateImpact(before, after),
    };

    for (const [id, existing] of this.#plans) {
      if (existing.view.expeditionId === input.expeditionId) {
        this.#plans.delete(id);
      }
    }
    this.#plans.set(planId, { view, targets });
    return structuredClone(view);
  }

  async confirm(planId: string, input: ConfirmWritebackInput): Promise<WritebackPlanView> {
    this.#discardExpiredPlans();
    const plan = this.#plans.get(planId);
    if (!plan) {
      throw new WritebackConflictError("写回预览已经失效，请重新预览地图变化。");
    }
    if (
      plan.view.expectedSourceRevision !== input.expectedSourceRevision ||
      plan.view.proposalHash !== input.proposalHash
    ) {
      throw new WritebackConflictError("确认请求与已审阅的写回预览不一致。");
    }

    const current = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
    if (current.revision !== plan.view.expectedSourceRevision) {
      throw new WritebackConflictError(
        "Wayfinder Markdown 在预览后已被修改；你的版本已保留，请重新生成预览。",
      );
    }
    for (const target of plan.targets) {
      const bytes = await readFile(target.absolutePath);
      if (hashBytes(bytes) !== target.beforeHash) {
        throw new WritebackConflictError(
          `${target.relativePath} 在预览后已被修改；Explorer 没有覆盖它。`,
        );
      }
    }

    await mkdir(this.#transactionsDirectory, { recursive: true, mode: 0o700 });
    const journalPath = path.join(this.#transactionsDirectory, `${planId}.json`);
    const journal = this.#journalFor(plan);
    let journalPersisted = false;
    let eventAppended = false;
    try {
      for (const target of plan.targets) {
        await writeDurableFile(target.temporaryPath, target.after, target.mode, true);
      }
      await writeJournalDurably(journalPath, journal);
      journalPersisted = true;

      await rename(plan.targets[0].temporaryPath, plan.targets[0].absolutePath);
      journal.phase = "issue_renamed";
      await writeJournalDurably(journalPath, journal);
      await rename(plan.targets[1].temporaryPath, plan.targets[1].absolutePath);
      journal.phase = "map_renamed";
      await writeJournalDurably(journalPath, journal);
      await Promise.all(unique(plan.targets.map(({ absolutePath }) => path.dirname(absolutePath))).map(fsyncDirectory));

      const after = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
      if (after.revision !== plan.view.resultingSourceRevision) {
        throw new Error("写回后的 Campaign revision 与预览不一致。");
      }
      assertImpactMatches(plan.view.impact, calculateImpact(current, after));
      journal.phase = "verified";
      await writeJournalDurably(journalPath, journal);

      await input.onConfirmed(structuredClone(plan.view));
      eventAppended = true;
      journal.phase = "event_appended";
      await writeJournalDurably(journalPath, journal).catch(() => undefined);
      await unlink(journalPath).catch(() => undefined);
      await fsyncDirectory(this.#transactionsDirectory).catch(() => undefined);
      this.#plans.delete(planId);
      return structuredClone(plan.view);
    } catch (error) {
      if (!eventAppended) {
        await this.#restorePlan(plan, journalPath, journalPersisted).catch((restoreError) => {
          throw new AggregateError([error, restoreError], "写回失败，并且原始文件自动恢复失败。");
        });
      }
      throw error;
    }
  }

  async recover(): Promise<void> {
    let names: string[];
    try {
      const directory = await import("node:fs/promises").then(({ readdir }) => readdir(this.#transactionsDirectory));
      names = directory.filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    for (const name of names) {
      const journalPath = path.join(this.#transactionsDirectory, name);
      const journal = parseJournal(await readFile(journalPath, "utf8"), this.#campaignId);
      const confirmed = journal.phase === "event_appended" || await this.#journeyContainsPlan(journal.planId);
      if (!confirmed) {
        await restoreJournalTargets(this.campaignRoot, journal);
      }
      await removeJournalTemps(this.campaignRoot, journal);
      await unlink(journalPath);
    }
    if (names.length) {
      await fsyncDirectory(this.#transactionsDirectory);
    }
  }

  #journalFor(plan: WritebackPlan): RecoveryJournal {
    return {
      schemaVersion: 1,
      campaignId: this.#campaignId,
      planId: plan.view.id,
      expeditionId: plan.view.expeditionId,
      phase: "prepared",
      createdAt: this.#now().toISOString(),
      targets: plan.targets.map((target) => ({
        relativePath: target.relativePath,
        temporaryRelativePath: toPosixPath(path.relative(this.campaignRoot, target.temporaryPath)),
        beforeBase64: target.before.toString("base64"),
        afterBase64: target.after.toString("base64"),
        mode: target.mode,
      })),
    };
  }

  async #restorePlan(plan: WritebackPlan, journalPath: string, journalPersisted: boolean): Promise<void> {
    for (const target of plan.targets) {
      await writeAtomicReplacement(target.absolutePath, target.before, target.mode, plan.view.id);
      await unlink(target.temporaryPath).catch(ignoreMissing);
    }
    await Promise.all(unique(plan.targets.map(({ absolutePath }) => path.dirname(absolutePath))).map(fsyncDirectory));
    if (journalPersisted) {
      await unlink(journalPath).catch(ignoreMissing);
      await fsyncDirectory(this.#transactionsDirectory);
    }
  }

  async #journeyContainsPlan(planId: string): Promise<boolean> {
    const journeyPath = path.join(this.#campaignDataDirectory, "journey.jsonl");
    let text: string;
    try {
      text = await readFile(journeyPath, "utf8");
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
        return event.type === "writeback_confirmed" && event.payload?.planId === planId;
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

export class WritebackError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "WritebackError";
    this.statusCode = statusCode;
  }
}

export class WritebackConflictError extends WritebackError {
  constructor(message: string) {
    super(409, message);
    this.name = "WritebackConflictError";
  }
}

function patchIssue(location: Location, source: string, proposal: DecisionProposal): string {
  if (location.sourceStatus === "resolved") {
    const answerRange = location.sourceRanges.answer;
    if (!answerRange || !location.answerMarkdown) {
      throw new WritebackConflictError("无法定位需要保留的当前答案。");
    }
    if (location.reviewState === "pending" &&
      location.answerMarkdown.trim() === proposal.answerMarkdown.trim()) {
      return clearReviewState(source);
    }
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const nestedAnswer = normalizeNewlines(nestMarkdownUnderAnswer(proposal.answerMarkdown), newline);
    const answerPatched = `${source.slice(0, answerRange.startOffset)}${nestedAnswer}${source.slice(answerRange.endOffset)}`;
    return clearReviewState(appendAnswerHistory(
      answerPatched,
      normalizeNewlines(location.answerMarkdown, newline),
      proposal.createdAt,
      newline,
    ));
  }
  const range = location.sourceRanges.status;
  if (!range || range.path !== location.sourcePath) {
    throw new WritebackError(409, "无法定位 issue 的 Status 字段。");
  }
  const existing = source.slice(range.startOffset, range.endOffset);
  if (!/^Status:\s*open\s*$/.test(existing)) {
    throw new WritebackConflictError("issue 的 Status 已不再是 open。");
  }
  const statusPatched = `${source.slice(0, range.startOffset)}Status: resolved${source.slice(range.endOffset)}`;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const separator = statusPatched.endsWith(`${newline}${newline}`)
    ? ""
    : statusPatched.endsWith(newline)
      ? newline
      : `${newline}${newline}`;
  const nestedAnswer = nestMarkdownUnderAnswer(proposal.answerMarkdown);
  return `${statusPatched}${separator}## Answer${newline}${newline}${normalizeNewlines(nestedAnswer, newline)}${newline}`;
}

function appendAnswerHistory(
  source: string,
  previousAnswer: string,
  replacedAt: string,
  newline: string,
): string {
  const nestedHistory = nestMarkdownAtLevel(previousAnswer, 4);
  const entry = `### Replaced ${replacedAt}${newline}${newline}${nestedHistory}`;
  const heading = /^##\s+Answer history\s*$/gim;
  const match = heading.exec(source);
  if (!match) {
    const separator = source.endsWith(`${newline}${newline}`)
      ? ""
      : source.endsWith(newline)
        ? newline
        : `${newline}${newline}`;
    return `${source}${separator}## Answer history${newline}${newline}${entry}${newline}`;
  }
  const sectionStart = match.index + match[0].length;
  const nextHeading = /^##\s+/gm;
  nextHeading.lastIndex = sectionStart;
  const next = nextHeading.exec(source);
  const sectionEnd = next?.index ?? source.length;
  const body = source.slice(sectionStart, sectionEnd);
  const insertionOffset = sectionStart + body.trimEnd().length;
  const insertion = body.trim() ? `${newline}${newline}${entry}` : `${newline}${newline}${entry}`;
  return `${source.slice(0, insertionOffset)}${insertion}${source.slice(insertionOffset)}`;
}

function clearReviewState(source: string): string {
  let next = source.replace(/^Review state:\s*pending\s*\n?/mi, "");
  next = removeTopLevelSection(next, "Review question");
  next = removeTopLevelSection(next, "Review reason");
  return `${next.trimEnd()}\n`;
}

function removeTopLevelSection(source: string, heading: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) =>
    line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) {
    return source;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function nestMarkdownAtLevel(markdown: string, minimumLevel: number): string {
  return markdown.replaceAll("\r\n", "\n").split("\n").map((line) => {
    const heading = /^( {0,3})(#{1,6})([ \t]+)/.exec(line);
    if (!heading || heading[2].length >= minimumLevel) {
      return line;
    }
    return `${heading[1]}${"#".repeat(minimumLevel)}${heading[3]}${line.slice(heading[0].length)}`;
  }).join("\n");
}

/** Keep model-authored sections inside the canonical `## Answer` section. */
function nestMarkdownUnderAnswer(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const headingLevels: number[] = [];
  let fence: "`" | "~" | undefined;
  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      fence = fence === marker ? undefined : fence ?? marker;
      continue;
    }
    if (fence) {
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+/.exec(line);
    if (heading) {
      headingLevels.push(heading[1].length);
    }
  }
  const shallowest = headingLevels.length ? Math.min(...headingLevels) : 3;
  const shift = Math.max(0, 3 - shallowest);
  if (!shift) {
    return markdown;
  }

  fence = undefined;
  return lines.map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      fence = fence === marker ? undefined : fence ?? marker;
      return line;
    }
    if (fence) {
      return line;
    }
    return line.replace(/^( {0,3})(#{1,6})([ \t]+)/, (_match, indent: string, hashes: string, gap: string) =>
      `${indent}${"#".repeat(Math.min(6, hashes.length + shift))}${gap}`);
  }).join("\n");
}

function patchMap(source: string, location: Location, proposal: DecisionProposal): string {
  if (location.title.includes("]")) {
    throw new WritebackError(409, "地点标题不能安全写入 Decisions so far 链接。");
  }
  const existingReference = source.includes(`](${location.sourcePath})`);
  const summary = decisionSummary(proposal.answerMarkdown);
  const bullet = `- [${location.title}](${location.sourcePath}) — ${summary}`;
  if (existingReference) {
    const escapedPath = location.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const decisionLine = new RegExp(`^- \\[[^\\]]+\\]\\(${escapedPath}\\)(?:\\s+[—-]\\s+.*?)?$`, "m");
    if (!decisionLine.test(source)) {
      throw new WritebackConflictError("map.md 中的既有决定记录无法安全更新。");
    }
    return source.replace(decisionLine, bullet);
  }
  const heading = /^##\s+Decisions so far\s*$/gim;
  const match = heading.exec(source);
  if (!match) {
    throw new WritebackError(409, "map.md 缺少 Decisions so far 段落。");
  }
  const sectionStart = match.index + match[0].length;
  const nextHeading = /^##\s+/gm;
  nextHeading.lastIndex = sectionStart;
  const next = nextHeading.exec(source);
  const sectionEnd = next?.index ?? source.length;
  const body = source.slice(sectionStart, sectionEnd);
  const trimmedBodyLength = body.trimEnd().length;
  const insertionOffset = sectionStart + trimmedBodyLength;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const insertion = trimmedBodyLength ? `${newline}${bullet}` : `${newline}${newline}${bullet}`;
  return `${source.slice(0, insertionOffset)}${insertion}${source.slice(insertionOffset)}`;
}

function decisionSummary(markdown: string): string {
  const firstParagraph = markdown.split(/\n\s*\n/, 1)[0]
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const shortened = firstParagraph.length > 180
    ? `${firstParagraph.slice(0, 177).trimEnd()}…`
    : firstParagraph;
  return shortened || "已确认该地点的决策边界。";
}

function assertValidProjection(
  before: CampaignProjection,
  after: CampaignProjection,
  locationId: string,
  changeKind: "confirmation" | "revision" | "reaffirmation",
): void {
  if (after.summary.blockingDiagnostics > 0) {
    throw new WritebackError(409, "候选写回无法通过 Wayfinder 结构校验。");
  }
  if (before.locations.length !== after.locations.length) {
    throw new WritebackError(409, "候选写回意外改变了地点数量。");
  }
  const target = after.locations.find(({ id }) => id === locationId);
  if (target?.sourceStatus !== "resolved" || target.status !== "resolved" || !target.answerMarkdown) {
    throw new WritebackError(409, "候选写回没有把目标地点投影为已确认营地。");
  }
  const previousTarget = before.locations.find(({ id }) => id === locationId);
  if (
    changeKind === "revision" &&
    (!previousTarget?.answerMarkdown || target.answerMarkdown === previousTarget.answerMarkdown ||
      target.answerHistory.length !== previousTarget.answerHistory.length + 1)
  ) {
    throw new WritebackError(409, "候选修订没有保留旧答案历史并建立新的当前答案。");
  }
  if (
    changeKind === "reaffirmation" &&
    (!previousTarget?.answerMarkdown ||
      target.answerMarkdown !== previousTarget.answerMarkdown ||
      target.answerHistory.length !== previousTarget.answerHistory.length ||
      target.reviewState !== "current")
  ) {
    throw new WritebackError(409, "候选复核没有保留原答案并清除待复核状态。");
  }
  for (const location of before.locations) {
    const candidate = after.locations.find(({ id }) => id === location.id);
    if (!candidate) {
      throw new WritebackError(409, `候选写回丢失了地点 ${location.id}。`);
    }
    if (location.id !== locationId && candidate.sourceStatus !== location.sourceStatus) {
      throw new WritebackError(409, `候选写回意外修改了地点 ${location.id} 的源状态。`);
    }
  }
}

function calculateImpact(
  before: CampaignProjection,
  after: CampaignProjection,
): WritebackLocationImpact[] {
  const afterById = new Map(after.locations.map((location) => [location.id, location]));
  return before.locations.flatMap((location) => {
    const candidate = afterById.get(location.id);
    if (
      !candidate ||
      (candidate.status === location.status && candidate.sourceStatus === location.sourceStatus)
    ) {
      return [];
    }
    return [{
      locationId: location.id,
      title: location.title,
      beforeStatus: location.status,
      afterStatus: candidate.status,
      beforeSourceStatus: location.sourceStatus,
      afterSourceStatus: candidate.sourceStatus,
    }];
  });
}

function assertImpactMatches(
  expected: WritebackLocationImpact[],
  actual: WritebackLocationImpact[],
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("写回后的地图影响与预览不一致。");
  }
}

function createTarget(
  planId: string,
  source: { relativePath: string; absolutePath: string; bytes: Buffer; mode: number },
  after: Buffer,
): WritebackTarget {
  return {
    relativePath: source.relativePath,
    absolutePath: source.absolutePath,
    before: source.bytes,
    after,
    beforeHash: hashBytes(source.bytes),
    afterHash: hashBytes(after),
    mode: source.mode,
    temporaryPath: path.join(
      path.dirname(source.absolutePath),
      `.${path.basename(source.absolutePath)}.${planId}.tmp`,
    ),
  };
}

function hashProposal(proposal: DecisionProposal): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(proposal)).digest("hex")}`;
}

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function renderDiff(relativePath: string, before: string, after: string): string {
  const beforeLines = before.replace(/\r\n/g, "\n").split("\n");
  const afterLines = after.replace(/\r\n/g, "\n").split("\n");
  const table = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0));
  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      table[left][right] = beforeLines[left] === afterLines[right]
        ? table[left + 1][right + 1] + 1
        : Math.max(table[left + 1][right], table[left][right + 1]);
    }
  }
  const lines = [`--- a/${relativePath}`, `+++ b/${relativePath}`, "@@"];
  let left = 0;
  let right = 0;
  while (left < beforeLines.length || right < afterLines.length) {
    if (left < beforeLines.length && right < afterLines.length && beforeLines[left] === afterLines[right]) {
      lines.push(` ${beforeLines[left]}`);
      left += 1;
      right += 1;
    } else if (right < afterLines.length && (left === beforeLines.length || table[left][right + 1] >= table[left + 1][right])) {
      lines.push(`+${afterLines[right]}`);
      right += 1;
    } else {
      lines.push(`-${beforeLines[left]}`);
      left += 1;
    }
  }
  return lines.join("\n");
}

function resolveCampaignFile(root: string, relativePath: string): string {
  if (relativePath !== "map.md" && !/^issues\/[^/]+\.md$/.test(relativePath)) {
    throw new Error(`Unsafe writeback target ${relativePath}.`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Writeback target escapes Campaign root: ${relativePath}.`);
  }
  return resolved;
}

async function writeDurableFile(
  targetPath: string,
  bytes: Buffer,
  mode: number,
  exclusive: boolean,
): Promise<void> {
  const handle = await open(targetPath, exclusive ? "wx" : "w", mode || 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJournalDurably(targetPath: string, journal: RecoveryJournal): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.next`;
  await unlink(temporaryPath).catch(ignoreMissing);
  await writeDurableFile(temporaryPath, Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"), 0o600, true);
  await rename(temporaryPath, targetPath);
  await fsyncDirectory(path.dirname(targetPath));
}

async function writeAtomicReplacement(
  targetPath: string,
  bytes: Buffer,
  mode: number,
  transactionId: string,
): Promise<void> {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${transactionId}.restore`);
  await unlink(temporaryPath).catch(ignoreMissing);
  await writeDurableFile(temporaryPath, bytes, mode, true);
  await rename(temporaryPath, targetPath);
}

function parseJournal(text: string, campaignId: string): RecoveryJournal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("Writeback recovery journal is malformed.", { cause });
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.campaignId !== campaignId ||
    typeof value.planId !== "string" ||
    typeof value.expeditionId !== "string" ||
    !isJournalPhase(value.phase) ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.targets) ||
    value.targets.length !== 2 ||
    !value.targets.every(isJournalTarget)
  ) {
    throw new Error("Writeback recovery journal has an invalid shape.");
  }
  return value as unknown as RecoveryJournal;
}

function isJournalTarget(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.relativePath === "string" &&
    typeof value.temporaryRelativePath === "string" &&
    typeof value.beforeBase64 === "string" &&
    typeof value.afterBase64 === "string" &&
    Number.isInteger(value.mode)
  );
}

function isJournalPhase(value: unknown): value is JournalPhase {
  return (
    value === "prepared" ||
    value === "issue_renamed" ||
    value === "map_renamed" ||
    value === "verified" ||
    value === "event_appended"
  );
}

async function restoreJournalTargets(root: string, journal: RecoveryJournal): Promise<void> {
  for (const target of journal.targets) {
    const absolutePath = resolveCampaignFile(root, target.relativePath);
    await writeAtomicReplacement(
      absolutePath,
      Buffer.from(target.beforeBase64, "base64"),
      target.mode,
      journal.planId,
    );
  }
  await Promise.all(unique(journal.targets.map(({ relativePath }) =>
    path.dirname(resolveCampaignFile(root, relativePath)))).map(fsyncDirectory));
}

async function removeJournalTemps(root: string, journal: RecoveryJournal): Promise<void> {
  for (const target of journal.targets) {
    const temporaryPath = resolveTemporaryCampaignFile(root, target.temporaryRelativePath);
    await unlink(temporaryPath).catch(ignoreMissing);
  }
}

function resolveTemporaryCampaignFile(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !/^((issues\/)?\.)[^/]+\.tmp$/.test(toPosixPath(relative))
  ) {
    throw new Error(`Unsafe recovery temporary path ${relativePath}.`);
  }
  return resolved;
}

function normalizeNewlines(text: string, newline: string): string {
  return text.replace(/\r\n|\r|\n/g, newline);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function unique<Value>(values: Value[]): Value[] {
  return [...new Set(values)];
}

function ignoreMissing(error: unknown): void {
  if (!isMissingFileError(error)) {
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
