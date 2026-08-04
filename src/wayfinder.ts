import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CampaignProjection,
  Diagnostic,
  FogArea,
  Location,
  LocationSourceRanges,
  LocationStatus,
  LocationType,
  Route,
  SourceRange,
  SourceStatus,
  TrailStop,
} from "./model.ts";

const SUPPORTED_TYPES = new Set<LocationType>([
  "grilling",
  "prototype",
  "research",
  "task",
]);

interface SourceFile {
  absolutePath: string;
  relativePath: string;
  bytes: Buffer;
  text: string;
}

interface SourceLine {
  number: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

interface ParsedSection {
  name: string;
  body: string;
  range?: SourceRange;
  lines: SourceLine[];
}

interface ParsedDocument {
  file: SourceFile;
  lines: SourceLine[];
  title?: string;
  titleRange?: SourceRange;
  sections: Map<string, ParsedSection>;
  firstSectionLine: number;
}

interface ParsedDecision {
  title: string;
  referencePath: string;
  summary?: string;
  source: SourceRange;
}

interface ParsedMap {
  title: string;
  destination: string;
  decisions: ParsedDecision[];
  fog: FogArea[];
  outOfScope: string[];
}

interface ParsedIssue {
  id: string;
  sourcePath: string;
  title: string;
  type: LocationType | "unknown";
  sourceStatus: SourceStatus;
  blockers: string[];
  question: string;
  answerMarkdown?: string;
  sourceRanges: LocationSourceRanges;
}

interface CampaignFiles {
  map?: SourceFile;
  issues: SourceFile[];
  all: SourceFile[];
}

/**
 * Read a strict Wayfinder directory and return the single projection consumed by
 * future UI, Codex, and writeback layers. This function never mutates the source.
 */
export async function inspectCampaign(campaignRoot: string): Promise<CampaignProjection> {
  return inspectCampaignAs(campaignRoot);
}

/** Inspect a path while preserving a registry-owned Campaign identity across relinks. */
export async function inspectCampaignAs(
  campaignRoot: string,
  campaignId?: string,
): Promise<CampaignProjection> {
  const root = path.resolve(campaignRoot);
  const files = await readCampaignFiles(root);
  return projectCampaign(root, files, campaignId);
}

/**
 * Project a Campaign with exact in-memory file replacements. Writeback uses
 * this to prove graph impact before any canonical bytes are touched.
 */
export async function inspectCampaignWithOverrides(
  campaignRoot: string,
  overrides: ReadonlyMap<string, Buffer | string>,
  campaignId?: string,
): Promise<CampaignProjection> {
  const root = path.resolve(campaignRoot);
  const files = await readCampaignFiles(root);
  const normalized = new Map(
    [...overrides].map(([relativePath, value]) => [
      toPosixPath(path.normalize(relativePath)),
      Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"),
    ]),
  );
  const knownPaths = new Set(files.all.map(({ relativePath }) => relativePath));
  for (const relativePath of normalized.keys()) {
    if (!knownPaths.has(relativePath)) {
      throw new Error(`Cannot override unknown Campaign file ${relativePath}.`);
    }
  }
  const replace = (file: SourceFile): SourceFile => {
    const bytes = normalized.get(file.relativePath);
    return bytes
      ? { ...file, bytes, text: bytes.toString("utf8") }
      : file;
  };
  const mapFile = files.map ? replace(files.map) : undefined;
  const issues = files.issues.map(replace);
  return projectCampaign(root, {
    map: mapFile,
    issues,
    all: [...(mapFile ? [mapFile] : []), ...issues].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, "en"),
    ),
  }, campaignId);
}

function projectCampaign(
  root: string,
  files: CampaignFiles,
  registeredCampaignId?: string,
): CampaignProjection {
  if (registeredCampaignId && !/^campaign-[a-f0-9]{12}$/.test(registeredCampaignId)) {
    throw new Error(`Invalid registered Campaign id ${JSON.stringify(registeredCampaignId)}.`);
  }
  const diagnostics: Diagnostic[] = [];
  const revision = sourceRevision(files.all);

  const parsedMap = files.map
    ? parseMap(files.map, diagnostics)
    : emptyMapWithDiagnostic(diagnostics);

  const parsedIssues = files.issues.map((file) => parseIssue(file, diagnostics));
  makeLocationIdsUnique(parsedIssues, diagnostics);

  const issuesById = new Map(parsedIssues.map((issue) => [issue.id, issue]));
  validateDependencies(parsedIssues, issuesById, diagnostics);
  const cycles = detectDependencyCycles(parsedIssues, issuesById, diagnostics);
  validateDecisionList(parsedMap.decisions, parsedIssues, diagnostics);

  const cycleIds = new Set(cycles.flat());
  const rankFor = createRankResolver(issuesById, cycleIds);
  const locations = parsedIssues
    .map<Location>((issue) => ({
      ...issue,
      status: projectStatus(issue, issuesById),
      dependencyRank: rankFor(issue.id),
    }))
    .sort(compareLocations);

  const locationsById = new Map(locations.map((location) => [location.id, location]));
  const routes = projectRoutes(locations, locationsById);
  const trail = projectTrail(parsedMap.decisions, parsedIssues);

  diagnostics.sort(compareDiagnostics);

  const resolved = locations.filter((location) => location.status === "resolved").length;
  const frontier = locations.filter((location) => location.status === "frontier").length;
  const blocked = locations.filter((location) => location.status === "blocked").length;

  return {
    id: registeredCampaignId ?? campaignIdForRoot(root),
    root,
    revision,
    title: parsedMap.title,
    destination: parsedMap.destination,
    outOfScope: parsedMap.outOfScope,
    locations,
    routes,
    trail,
    fog: parsedMap.fog,
    diagnostics,
    summary: {
      total: locations.length,
      resolved,
      frontier,
      blocked,
      fog: parsedMap.fog.length,
      blockingDiagnostics: diagnostics.filter((diagnostic) => diagnostic.blocking).length,
      warnings: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    },
  };
}

async function readCampaignFiles(root: string): Promise<CampaignFiles> {
  const mapPath = path.join(root, "map.md");
  let mapFile: SourceFile | undefined;

  try {
    mapFile = await loadSourceFile(root, mapPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const issueDirectory = path.join(root, "issues");
  let issueNames: string[] = [];
  try {
    issueNames = (await readdir(issueDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en"));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const issues = await Promise.all(
    issueNames.map((name) => loadSourceFile(root, path.join(issueDirectory, name))),
  );
  const all = [...(mapFile ? [mapFile] : []), ...issues].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );

  return { map: mapFile, issues, all };
}

async function loadSourceFile(root: string, absolutePath: string): Promise<SourceFile> {
  const bytes = await readFile(absolutePath);
  return {
    absolutePath,
    relativePath: toPosixPath(path.relative(root, absolutePath)),
    bytes,
    text: bytes.toString("utf8"),
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function sourceRevision(files: SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function campaignIdForRoot(root: string): string {
  return `campaign-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}`;
}

function emptyMapWithDiagnostic(diagnostics: Diagnostic[]): ParsedMap {
  diagnostics.push({
    code: "map_missing",
    severity: "error",
    blocking: true,
    message: "Campaign root does not contain map.md.",
  });
  return { title: "Untitled campaign", destination: "", decisions: [], fog: [], outOfScope: [] };
}

function parseMap(file: SourceFile, diagnostics: Diagnostic[]): ParsedMap {
  const document = parseDocument(file);
  if (!document.title) {
    diagnostics.push({
      code: "map_title_missing",
      severity: "error",
      blocking: true,
      message: "map.md must start with an H1 campaign title.",
      source: documentRange(file, document.lines),
    });
  }

  const destinationSection = document.sections.get("destination");
  const destination = destinationSection?.body ?? "";
  if (!destination) {
    diagnostics.push({
      code: "destination_missing",
      severity: "error",
      blocking: true,
      message: "map.md must contain a non-empty Destination section.",
      source: destinationSection?.range ?? documentRange(file, document.lines),
    });
  }

  const decisions = parseDecisionLines(document.sections.get("decisions so far"));
  const fog = parseBulletLines(document.sections.get("not yet specified")).map(
    ({ text, source }, index) => ({
      id: `fog-${String(index + 1).padStart(2, "0")}`,
      title: text,
      source,
    }),
  );
  const outOfScope = parseBulletLines(document.sections.get("out of scope")).map(
    ({ text }) => text,
  );

  return {
    title: document.title ?? "Untitled campaign",
    destination,
    decisions,
    fog,
    outOfScope,
  };
}

function parseIssue(file: SourceFile, diagnostics: Diagnostic[]): ParsedIssue {
  const document = parseDocument(file);
  const filename = path.basename(file.relativePath);
  const idMatch = /^(\d+)-/.exec(filename);
  const id = idMatch ? normalizeLocationId(idMatch[1]) : `invalid:${filename}`;
  const wholeDocument = documentRange(file, document.lines);

  if (!idMatch) {
    diagnostics.push({
      code: "location_id_missing",
      severity: "error",
      blocking: true,
      message: `${file.relativePath} must start with a numeric location id followed by a hyphen.`,
      source: wholeDocument,
      locationIds: [id],
    });
  }

  if (!document.title) {
    diagnostics.push({
      code: "location_title_missing",
      severity: "error",
      blocking: true,
      message: `${file.relativePath} must start with an H1 location title.`,
      source: wholeDocument,
      locationIds: [id],
    });
  }

  const metadata = parseMetadata(document);
  const rawType = metadata.get("type")?.value.toLowerCase();
  const type = rawType && SUPPORTED_TYPES.has(rawType as LocationType)
    ? (rawType as LocationType)
    : "unknown";
  if (type === "unknown") {
    diagnostics.push({
      code: "unsupported_type",
      severity: "error",
      blocking: true,
      message: `${id} has unsupported Type ${JSON.stringify(rawType ?? "(missing)")}.`,
      source: metadata.get("type")?.range ?? wholeDocument,
      locationIds: [id],
    });
  }

  const rawStatus = metadata.get("status")?.value.toLowerCase();
  const sourceStatus: SourceStatus =
    rawStatus === "open" || rawStatus === "resolved" ? rawStatus : "unknown";
  if (sourceStatus === "unknown") {
    diagnostics.push({
      code: "unsupported_status",
      severity: "error",
      blocking: true,
      message: `${id} has unsupported Status ${JSON.stringify(rawStatus ?? "(missing)")}.`,
      source: metadata.get("status")?.range ?? wholeDocument,
      locationIds: [id],
    });
  }

  const blockers = unique(
    (metadata.get("blocked by")?.value ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(normalizeLocationId),
  );

  const questionSection = document.sections.get("question");
  const question = questionSection?.body ?? "";
  if (!question) {
    diagnostics.push({
      code: "question_missing",
      severity: "error",
      blocking: true,
      message: `${id} must contain a non-empty Question section.`,
      source: questionSection?.range ?? wholeDocument,
      locationIds: [id],
    });
  }

  const answerSection = document.sections.get("answer");
  return {
    id,
    sourcePath: file.relativePath,
    title: document.title ?? filename,
    type,
    sourceStatus,
    blockers,
    question,
    answerMarkdown: answerSection?.body || undefined,
    sourceRanges: {
      document: wholeDocument,
      title: document.titleRange,
      type: metadata.get("type")?.range,
      status: metadata.get("status")?.range,
      blockers: metadata.get("blocked by")?.range,
      question: questionSection?.range,
      answer: answerSection?.range,
    },
  };
}

function parseDocument(file: SourceFile): ParsedDocument {
  const lines = splitLines(file.text);
  let title: string | undefined;
  let titleRange: SourceRange | undefined;

  for (const line of lines) {
    const match = /^#\s+(.+?)\s*$/.exec(line.text);
    if (match) {
      title = match[1];
      titleRange = rangeForLine(file.relativePath, line);
      break;
    }
  }

  const sectionStarts: Array<{ index: number; name: string }> = [];
  lines.forEach((line, index) => {
    const match = /^##\s+(.+?)\s*$/.exec(line.text);
    if (match) {
      sectionStarts.push({ index, name: match[1] });
    }
  });

  const sections = new Map<string, ParsedSection>();
  sectionStarts.forEach((start, sectionIndex) => {
    const nextIndex = sectionStarts[sectionIndex + 1]?.index ?? lines.length;
    const contentLines = trimBlankLines(lines.slice(start.index + 1, nextIndex));
    sections.set(start.name.toLowerCase(), {
      name: start.name,
      body: sliceLines(file.text, contentLines),
      range: contentLines.length
        ? rangeForLines(file.relativePath, contentLines)
        : rangeForLine(file.relativePath, lines[start.index]),
      lines: contentLines,
    });
  });

  return {
    file,
    lines,
    title,
    titleRange,
    sections,
    firstSectionLine: sectionStarts[0]?.index ?? lines.length,
  };
}

function parseMetadata(
  document: ParsedDocument,
): Map<string, { value: string; range: SourceRange }> {
  const metadata = new Map<string, { value: string; range: SourceRange }>();
  for (const line of document.lines.slice(0, document.firstSectionLine)) {
    const match = /^([A-Za-z][A-Za-z ]*):\s*(.*?)\s*$/.exec(line.text);
    if (!match) {
      continue;
    }
    metadata.set(match[1].toLowerCase(), {
      value: match[2],
      range: rangeForLine(document.file.relativePath, line),
    });
  }
  return metadata;
}

function parseDecisionLines(section?: ParsedSection): ParsedDecision[] {
  if (!section) {
    return [];
  }

  const decisions: ParsedDecision[] = [];
  for (const line of section.lines) {
    const match = /^- \[([^\]]+)\]\(([^)]+)\)(?:\s+[—-]\s+(.+?))?\s*$/.exec(line.text);
    if (!match) {
      continue;
    }
    decisions.push({
      title: match[1],
      referencePath: normalizeReferencePath(match[2]),
      summary: match[3],
      source: rangeForLine(section.range?.path ?? "map.md", line),
    });
  }
  return decisions;
}

function parseBulletLines(
  section?: ParsedSection,
): Array<{ text: string; source: SourceRange }> {
  if (!section) {
    return [];
  }
  return section.lines.flatMap((line) => {
    const match = /^-\s+(.+?)\s*$/.exec(line.text);
    return match
      ? [{ text: match[1], source: rangeForLine(section.range?.path ?? "map.md", line) }]
      : [];
  });
}

function makeLocationIdsUnique(issues: ParsedIssue[], diagnostics: Diagnostic[]): void {
  const seen = new Map<string, number>();
  for (const issue of issues) {
    const count = seen.get(issue.id) ?? 0;
    seen.set(issue.id, count + 1);
    if (count === 0) {
      continue;
    }

    const duplicateId = issue.id;
    issue.id = `${duplicateId}#duplicate-${count + 1}`;
    diagnostics.push({
      code: "location_id_duplicate",
      severity: "error",
      blocking: true,
      message: `${issue.sourcePath} duplicates location id ${duplicateId}.`,
      source: issue.sourceRanges.document,
      locationIds: [duplicateId, issue.id],
    });
  }
}

function validateDependencies(
  issues: ParsedIssue[],
  issuesById: Map<string, ParsedIssue>,
  diagnostics: Diagnostic[],
): void {
  for (const issue of issues) {
    for (const blocker of issue.blockers) {
      if (!issuesById.has(blocker)) {
        diagnostics.push({
          code: "dangling_blocker",
          severity: "error",
          blocking: true,
          message: `${issue.id} is blocked by missing location ${blocker}.`,
          source: issue.sourceRanges.blockers ?? issue.sourceRanges.document,
          locationIds: [issue.id, blocker],
        });
      }
    }

    if (issue.sourceStatus !== "resolved") {
      continue;
    }
    const unresolved = issue.blockers.filter(
      (blocker) => issuesById.get(blocker)?.sourceStatus !== "resolved",
    );
    if (unresolved.length) {
      diagnostics.push({
        code: "resolved_depends_on_unresolved",
        severity: "error",
        blocking: true,
        message: `${issue.id} is resolved but still depends on unresolved ${unresolved.join(", ")}.`,
        source: issue.sourceRanges.blockers ?? issue.sourceRanges.document,
        locationIds: [issue.id, ...unresolved],
      });
    }
  }
}

function detectDependencyCycles(
  issues: ParsedIssue[],
  issuesById: Map<string, ParsedIssue>,
  diagnostics: Diagnostic[],
): string[][] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const cycles: string[][] = [];

  function visit(id: string): void {
    state.set(id, "visiting");
    stack.push(id);

    for (const blocker of issuesById.get(id)?.blockers ?? []) {
      if (!issuesById.has(blocker)) {
        continue;
      }
      const blockerState = state.get(blocker);
      if (!blockerState) {
        visit(blocker);
      } else if (blockerState === "visiting") {
        const cycleStart = stack.lastIndexOf(blocker);
        const cycle = unique(stack.slice(cycleStart));
        const key = [...cycle].sort(compareLocationIds).join("|");
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          cycles.push(cycle);
          const sourceIssue = issuesById.get(id);
          diagnostics.push({
            code: "dependency_cycle",
            severity: "error",
            blocking: true,
            message: `Dependency cycle detected: ${[...cycle, cycle[0]].join(" -> ")}.`,
            source: sourceIssue?.sourceRanges.blockers ?? sourceIssue?.sourceRanges.document,
            locationIds: cycle,
          });
        }
      }
    }

    stack.pop();
    state.set(id, "visited");
  }

  for (const issue of issues) {
    if (!state.has(issue.id)) {
      visit(issue.id);
    }
  }
  return cycles;
}

function validateDecisionList(
  decisions: ParsedDecision[],
  issues: ParsedIssue[],
  diagnostics: Diagnostic[],
): void {
  const issuesByPath = new Map(issues.map((issue) => [issue.sourcePath, issue]));
  const decisionPaths = new Set<string>();

  for (const decision of decisions) {
    const issue = issuesByPath.get(decision.referencePath);
    decisionPaths.add(decision.referencePath);
    if (!issue) {
      diagnostics.push({
        code: "map_decision_mismatch",
        severity: "error",
        blocking: true,
        message: `map.md decision points to missing issue ${decision.referencePath}.`,
        source: decision.source,
      });
      continue;
    }
    if (issue.sourceStatus !== "resolved") {
      diagnostics.push({
        code: "map_decision_mismatch",
        severity: "error",
        blocking: true,
        message: `map.md lists ${issue.id} as a decision, but its Status is not resolved.`,
        source: decision.source,
        locationIds: [issue.id],
      });
    }
    if (decision.title !== issue.title) {
      diagnostics.push({
        code: "map_decision_mismatch",
        severity: "error",
        blocking: true,
        message: `map.md title for ${issue.id} disagrees with the issue H1 title.`,
        source: decision.source,
        locationIds: [issue.id],
      });
    }
  }

  for (const issue of issues) {
    if (issue.sourceStatus === "resolved" && !decisionPaths.has(issue.sourcePath)) {
      diagnostics.push({
        code: "map_decision_mismatch",
        severity: "error",
        blocking: true,
        message: `${issue.id} is resolved but is absent from map.md Decisions so far.`,
        source: issue.sourceRanges.status ?? issue.sourceRanges.document,
        locationIds: [issue.id],
      });
    }
  }
}

function projectStatus(
  issue: ParsedIssue,
  issuesById: Map<string, ParsedIssue>,
): LocationStatus {
  if (issue.sourceStatus === "resolved") {
    return "resolved";
  }
  if (issue.sourceStatus !== "open") {
    return "blocked";
  }
  const allBlockersResolved = issue.blockers.every(
    (blocker) => issuesById.get(blocker)?.sourceStatus === "resolved",
  );
  return allBlockersResolved ? "frontier" : "blocked";
}

function createRankResolver(
  issuesById: Map<string, ParsedIssue>,
  cycleIds: Set<string>,
): (id: string) => number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function rank(id: string): number {
    if (memo.has(id)) {
      return memo.get(id)!;
    }
    if (cycleIds.has(id) || visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    const issue = issuesById.get(id);
    const blockerRanks = (issue?.blockers ?? [])
      .filter((blocker) => issuesById.has(blocker))
      .map((blocker) => rank(blocker));
    visiting.delete(id);
    const value = blockerRanks.length ? Math.max(...blockerRanks) + 1 : 0;
    memo.set(id, value);
    return value;
  }

  return rank;
}

function projectRoutes(
  locations: Location[],
  locationsById: Map<string, Location>,
): Route[] {
  return locations
    .flatMap((location) =>
      location.blockers.flatMap((blocker) => {
        if (!locationsById.has(blocker)) {
          return [];
        }
        const state: Route["state"] =
          location.status === "resolved"
            ? "traveled"
            : location.status === "frontier"
              ? "available"
              : "locked";
        return [{ from: blocker, to: location.id, state }];
      }),
    )
    .sort((left, right) => {
      const fromOrder = compareLocationIds(left.from, right.from);
      return fromOrder || compareLocationIds(left.to, right.to);
    });
}

function projectTrail(decisions: ParsedDecision[], issues: ParsedIssue[]): TrailStop[] {
  const issuesByPath = new Map(issues.map((issue) => [issue.sourcePath, issue]));
  return decisions.flatMap((decision, index) => {
    const issue = issuesByPath.get(decision.referencePath);
    if (!issue || issue.sourceStatus !== "resolved") {
      return [];
    }
    return [
      {
        order: index + 1,
        locationId: issue.id,
        title: decision.title,
        summary: decision.summary,
        source: decision.source,
      },
    ];
  });
}

function splitLines(text: string): SourceLine[] {
  if (!text) {
    return [{ number: 1, text: "", startOffset: 0, endOffset: 0 }];
  }

  const lines: SourceLine[] = [];
  let startOffset = 0;
  let number = 1;
  while (startOffset < text.length) {
    const newlineOffset = text.indexOf("\n", startOffset);
    const rawEnd = newlineOffset === -1 ? text.length : newlineOffset;
    const endOffset = text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({
      number,
      text: text.slice(startOffset, endOffset),
      startOffset,
      endOffset,
    });
    if (newlineOffset === -1) {
      break;
    }
    startOffset = newlineOffset + 1;
    number += 1;
  }
  return lines;
}

function trimBlankLines(lines: SourceLine[]): SourceLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].text.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1].text.trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}

function sliceLines(text: string, lines: SourceLine[]): string {
  if (!lines.length) {
    return "";
  }
  return text.slice(lines[0].startOffset, lines[lines.length - 1].endOffset);
}

function documentRange(file: SourceFile, lines: SourceLine[]): SourceRange {
  return {
    path: file.relativePath,
    startLine: 1,
    endLine: lines.at(-1)?.number ?? 1,
    startOffset: 0,
    endOffset: file.text.length,
  };
}

function rangeForLine(relativePath: string, line: SourceLine): SourceRange {
  return {
    path: relativePath,
    startLine: line.number,
    endLine: line.number,
    startOffset: line.startOffset,
    endOffset: line.endOffset,
  };
}

function rangeForLines(relativePath: string, lines: SourceLine[]): SourceRange {
  return {
    path: relativePath,
    startLine: lines[0].number,
    endLine: lines[lines.length - 1].number,
    startOffset: lines[0].startOffset,
    endOffset: lines[lines.length - 1].endOffset,
  };
}

function normalizeLocationId(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^0+(?=\d)/, "").padStart(2, "0");
}

function normalizeReferencePath(reference: string): string {
  const withoutFragment = reference.split("#", 1)[0].replaceAll("\\", "/");
  return path.posix.normalize(withoutFragment.replace(/^\.\//, ""));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compareLocations(left: Location, right: Location): number {
  return compareLocationIds(left.id, right.id);
}

function compareLocationIds(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : Number.NaN;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : Number.NaN;
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
    return leftNumber - rightNumber || left.localeCompare(right, "en");
  }
  if (!Number.isNaN(leftNumber)) {
    return -1;
  }
  if (!Number.isNaN(rightNumber)) {
    return 1;
  }
  return left.localeCompare(right, "en");
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const pathOrder = (left.source?.path ?? "").localeCompare(right.source?.path ?? "", "en");
  if (pathOrder) {
    return pathOrder;
  }
  const lineOrder = (left.source?.startLine ?? 0) - (right.source?.startLine ?? 0);
  if (lineOrder) {
    return lineOrder;
  }
  return left.code.localeCompare(right.code, "en");
}
