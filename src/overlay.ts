import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CampaignLayout,
  CampaignProjection,
  ExplorerOverlay,
  LayoutBounds,
  LayoutPoint,
  LayoutRegion,
  OpenOverlayResult,
} from "./model.ts";

const SCHEMA_VERSION = 1;
const LAYOUT_VERSION = 1;
const X_START = 160;
const X_SPACING = 190;
const Y_CENTER = 420;
const Y_LANE_SPACING = 160;
const COLLISION_DISTANCE = 110;
const BOUNDS_PADDING = 140;

interface OpenOverlayOptions {
  dataRoot?: string;
  now?: () => Date;
}

export interface BindExpeditionOptions extends OpenOverlayOptions {}

export interface SetPlayerFocusOptions extends OpenOverlayOptions {}

/** Return the operating-system application-data location used by Explorer. */
export function defaultExplorerDataRoot(): string {
  if (platform() === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Wayfinder Explorer");
  }
  if (platform() === "win32") {
    return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Wayfinder Explorer");
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
    "wayfinder-explorer",
  );
}

/** Resolve a campaign-owned overlay path without allowing path traversal. */
export function overlayPathFor(
  campaignId: string,
  dataRoot = defaultExplorerDataRoot(),
): string {
  if (!/^campaign-[a-f0-9]{12}$/.test(campaignId)) {
    throw new Error(`Invalid campaign id ${JSON.stringify(campaignId)}.`);
  }
  return path.join(path.resolve(dataRoot), "campaigns", campaignId, "overlay.json");
}

/**
 * Open the replaceable Explorer overlay, preserving valid coordinates for every
 * existing Location and assigning deterministic coordinates only to new ones.
 */
export async function openCampaignOverlay(
  campaign: CampaignProjection,
  options: OpenOverlayOptions = {},
): Promise<OpenOverlayResult> {
  const overlayPath = overlayPathFor(campaign.id, options.dataRoot);
  const existingRead = await readOverlay(overlayPath, campaign.id);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const next = mergeOverlay(campaign, existingRead.overlay, now);
  const created = !existingRead.overlay && !existingRead.recovered;
  const changed = created || existingRead.recovered || !sameOverlay(existingRead.overlay!, next);

  if (changed) {
    next.updatedAt = now;
    await atomicWriteJson(overlayPath, next);
  }

  return {
    path: overlayPath,
    overlay: changed ? next : existingRead.overlay!,
    created,
    recovered: existingRead.recovered,
    changed,
  };
}

/** Persist the replaceable Expedition-to-Codex thread lookup in overlay.json. */
export async function bindCampaignExpedition(
  campaign: CampaignProjection,
  expeditionId: string,
  threadId: string,
  options: BindExpeditionOptions = {},
): Promise<ExplorerOverlay> {
  if (!/^expedition-[0-9a-f-]{36}$/.test(expeditionId)) {
    throw new Error(`Invalid expedition id ${JSON.stringify(expeditionId)}.`);
  }
  if (!threadId.trim()) {
    throw new Error("A Codex thread id is required for an expedition binding.");
  }
  const opened = await openCampaignOverlay(campaign, options);
  if (opened.overlay.expeditionBindings[expeditionId] === threadId) {
    return opened.overlay;
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const overlay = structuredClone(opened.overlay);
  overlay.expeditionBindings[expeditionId] = threadId;
  overlay.expeditionBindings = validBindings(overlay.expeditionBindings);
  overlay.updatedAt = now;
  await atomicWriteJson(opened.path, overlay);
  return overlay;
}

/** Persist the one Location currently selected in the Explorer UI. */
export async function setCampaignPlayerFocus(
  campaign: CampaignProjection,
  locationId: string,
  options: SetPlayerFocusOptions = {},
): Promise<ExplorerOverlay> {
  if (!campaign.locations.some(({ id }) => id === locationId)) {
    throw new Error(`Campaign does not contain Location ${JSON.stringify(locationId)}.`);
  }
  const opened = await openCampaignOverlay(campaign, options);
  if (opened.overlay.playerFocusId === locationId) {
    return opened.overlay;
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const overlay = structuredClone(opened.overlay);
  overlay.playerFocusId = locationId;
  overlay.updatedAt = now;
  await atomicWriteJson(opened.path, overlay);
  return overlay;
}

/** Pure initial layout used when no persisted coordinate exists. */
export function createDeterministicLayout(campaign: CampaignProjection): CampaignLayout {
  const journeyRanks = deriveJourneyRanks(campaign);
  const locationsByRank = new Map<number, string[]>();
  for (const location of campaign.locations) {
    const rank = journeyRanks.get(location.id) ?? 0;
    const ids = locationsByRank.get(rank) ?? [];
    ids.push(location.id);
    ids.sort(compareLocationIds);
    locationsByRank.set(rank, ids);
  }

  const locations: Record<string, LayoutPoint> = {};
  for (const location of campaign.locations) {
    const rank = journeyRanks.get(location.id) ?? 0;
    const lane = locationsByRank.get(rank) ?? [location.id];
    const laneIndex = lane.indexOf(location.id);
    const centeredLane = laneIndex - (lane.length - 1) / 2;
    const trailDrift = location.status === "resolved" && lane.length === 1
      ? trailVerticalDrift(rank)
      : 0;
    locations[location.id] = {
      x: X_START + rank * X_SPACING,
      y: Math.round(Y_CENTER + centeredLane * Y_LANE_SPACING + trailDrift),
      region: regionFor(location.status),
    };
  }

  const maxRank = Math.max(0, ...journeyRanks.values());
  const destination: LayoutPoint = {
    x: X_START + (maxRank + 2) * X_SPACING,
    y: Y_CENTER,
    region: "destination",
  };
  const fogEntrance: LayoutPoint = {
    x: X_START + Math.max(2, maxRank - 1) * X_SPACING,
    y: Y_CENTER + 360,
    region: "fog",
  };

  return {
    version: LAYOUT_VERSION,
    locations,
    destination,
    fogEntrance,
    bounds: boundsFor([...Object.values(locations), destination, fogEntrance]),
  };
}

function mergeOverlay(
  campaign: CampaignProjection,
  existing: ExplorerOverlay | undefined,
  now: string,
): ExplorerOverlay {
  const generated = createDeterministicLayout(campaign);
  const occupied: LayoutPoint[] = [];
  const locations: Record<string, LayoutPoint> = {};

  for (const location of campaign.locations) {
    const generatedPoint = generated.locations[location.id];
    const persistedPoint = existing?.layout.locations[location.id];
    const candidate = isFinitePoint(persistedPoint)
      ? { ...persistedPoint, region: generatedPoint.region }
      : avoidCollision(generatedPoint, occupied);
    locations[location.id] = candidate;
    occupied.push(candidate);
  }

  const persistedDestination = isFinitePoint(existing?.layout.destination)
    ? { ...existing!.layout.destination, region: "destination" as const }
    : undefined;
  const destination = persistedDestination && !collidesWithAny(persistedDestination, occupied)
    ? persistedDestination
    : avoidCollision(generated.destination, occupied);
  const occupiedWithDestination = [...occupied, destination];
  const persistedFogEntrance = isFinitePoint(existing?.layout.fogEntrance)
    ? { ...existing!.layout.fogEntrance, region: "fog" as const }
    : undefined;
  const fogEntrance = persistedFogEntrance && !collidesWithAny(persistedFogEntrance, occupiedWithDestination)
    ? persistedFogEntrance
    : avoidCollision(generated.fogEntrance, occupiedWithDestination);
  const playerFocusId = validFocus(existing?.playerFocusId, campaign)
    ? existing!.playerFocusId
    : defaultFocus(campaign);

  const overlay: ExplorerOverlay = {
    schemaVersion: SCHEMA_VERSION,
    campaignId: campaign.id,
    lastObservedSourceRevision: campaign.revision,
    layout: {
      version: LAYOUT_VERSION,
      locations,
      destination,
      fogEntrance,
      bounds: boundsFor([...Object.values(locations), destination, fogEntrance]),
    },
    playerFocusId,
    expeditionBindings: validBindings(existing?.expeditionBindings),
    createdAt: validTimestamp(existing?.createdAt) ? existing!.createdAt : now,
    updatedAt: validTimestamp(existing?.updatedAt) ? existing!.updatedAt : now,
  };
  return overlay;
}

function deriveJourneyRanks(campaign: CampaignProjection): Map<string, number> {
  const locationsById = new Map(campaign.locations.map((location) => [location.id, location]));
  const trailRanks = new Map(
    campaign.trail.map((stop, index) => [stop.locationId, index] as const),
  );
  const memo = new Map(trailRanks);
  const visiting = new Set<string>();
  const untraveledStart = campaign.trail.length;

  function rank(id: string): number {
    const known = memo.get(id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(id)) {
      return untraveledStart;
    }
    visiting.add(id);
    const location = locationsById.get(id);
    const blockerRanks = (location?.blockers ?? [])
      .filter((blocker) => locationsById.has(blocker))
      .map(rank);
    visiting.delete(id);
    const value = blockerRanks.length
      ? Math.max(untraveledStart - 1, ...blockerRanks) + 1
      : untraveledStart + (location?.dependencyRank ?? 0);
    memo.set(id, value);
    return value;
  }

  for (const location of campaign.locations) {
    rank(location.id);
  }
  return memo;
}

function trailVerticalDrift(rank: number): number {
  return [0, -45, 35, -30, 45, -20][rank % 6];
}

function regionFor(status: "resolved" | "frontier" | "blocked"): LayoutRegion {
  if (status === "resolved") {
    return "trail";
  }
  if (status === "frontier") {
    return "frontier";
  }
  return "gates";
}

function avoidCollision(candidate: LayoutPoint, occupied: LayoutPoint[]): LayoutPoint {
  let point = { ...candidate };
  let attempts = 0;
  while (occupied.some((other) => distance(point, other) < COLLISION_DISTANCE)) {
    attempts += 1;
    const direction = attempts % 2 === 0 ? -1 : 1;
    point = {
      ...point,
      y: candidate.y + direction * Math.ceil(attempts / 2) * Y_LANE_SPACING,
    };
  }
  return point;
}

function distance(left: LayoutPoint, right: LayoutPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function collidesWithAny(point: LayoutPoint, occupied: LayoutPoint[]): boolean {
  return occupied.some((other) => distance(point, other) < COLLISION_DISTANCE);
}

function boundsFor(points: LayoutPoint[]): LayoutBounds {
  const xValues = points.map(({ x }) => x);
  const yValues = points.map(({ y }) => y);
  return {
    minX: Math.min(...xValues) - BOUNDS_PADDING,
    minY: Math.min(...yValues) - BOUNDS_PADDING,
    maxX: Math.max(...xValues) + BOUNDS_PADDING,
    maxY: Math.max(...yValues) + BOUNDS_PADDING,
  };
}

async function readOverlay(
  overlayPath: string,
  campaignId: string,
): Promise<{ overlay?: ExplorerOverlay; recovered: boolean }> {
  let text: string;
  try {
    text = await readFile(overlayPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { recovered: false };
    }
    throw error;
  }

  try {
    const candidate = JSON.parse(text) as unknown;
    if (isOverlay(candidate, campaignId)) {
      return { overlay: candidate, recovered: false };
    }
  } catch {
    // The overlay is replaceable. A malformed file is regenerated below.
  }
  return { recovered: true };
}

function isOverlay(value: unknown, campaignId: string): value is ExplorerOverlay {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    value.campaignId === campaignId &&
    typeof value.lastObservedSourceRevision === "string" &&
    isRecord(value.layout) &&
    value.layout.version === LAYOUT_VERSION &&
    isRecord(value.layout.locations) &&
    isFinitePoint(value.layout.destination) &&
    isFinitePoint(value.layout.fogEntrance) &&
    isRecord(value.expeditionBindings) &&
    (value.playerFocusId === null || typeof value.playerFocusId === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isFinitePoint(value: unknown): value is LayoutPoint {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.region === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validFocus(
  focus: string | null | undefined,
  campaign: CampaignProjection,
): focus is string {
  return typeof focus === "string" && campaign.locations.some(({ id }) => id === focus);
}

function defaultFocus(campaign: CampaignProjection): string | null {
  return (
    campaign.locations.find(({ status }) => status === "frontier")?.id ??
    campaign.trail.at(-1)?.locationId ??
    campaign.locations[0]?.id ??
    null
  );
}

function validBindings(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function sameOverlay(left: ExplorerOverlay, right: ExplorerOverlay): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function atomicWriteJson(targetPath: string, value: ExplorerOverlay): Promise<void> {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.overlay-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
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
