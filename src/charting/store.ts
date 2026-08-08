import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CampaignProjection } from "../model.ts";
import { overlayPathFor } from "../overlay.ts";
import type {
  ChartingMessage,
  ChartingRecord,
  ChartingState,
  MapProposal,
  RechartChangeView,
  RechartTriggerKind,
} from "./model.ts";

interface ChartingEventBase {
  id: string;
  timestamp: string;
  campaignId: string;
  sourceRevision: string;
}

interface ChartingStartedEvent extends ChartingEventBase {
  type: "charting_started";
  payload: { chartingId: string; threadId: string };
}

interface ChartingStateChangedEvent extends ChartingEventBase {
  type: "charting_state_changed";
  payload: {
    chartingId: string;
    state: ChartingState;
    activeTurnId: string | null;
    error: string | null;
  };
}

interface ChartingMessageRecordedEvent extends ChartingEventBase {
  type: "charting_message_recorded";
  payload: { chartingId: string; message: ChartingMessage };
}

interface MapProposalReturnedEvent extends ChartingEventBase {
  type: "map_proposal_returned";
  payload: { chartingId: string; proposal: MapProposal };
}

interface MapCreationConfirmedEvent extends ChartingEventBase {
  type: "map_creation_confirmed";
  payload: {
    chartingId: string;
    planId: string;
    resultingSourceRevision: string;
  };
}

interface RechartRequestedEvent extends ChartingEventBase {
  type: "rechart_requested";
  payload: {
    chartingId: string;
    confirmedLocationId: string;
    triggerKind?: RechartTriggerKind;
    activeLocationIds: string[];
  };
}

interface RechartCompletedEvent extends ChartingEventBase {
  type: "rechart_completed";
  payload: {
    chartingId: string;
    resultingSourceRevision: string;
    change?: RechartChangeView;
  };
}

interface RechartQueuedEvent extends ChartingEventBase {
  type: "rechart_queued";
  payload: {
    chartingId: string;
    confirmedLocationId: string;
    triggerKind?: RechartTriggerKind;
    activeLocationIds: string[];
  };
}

interface RechartChangeRestoredEvent extends ChartingEventBase {
  type: "rechart_change_restored";
  payload: {
    chartingId: string;
    changeId: string;
    locationId: string;
    resultingSourceRevision: string;
  };
}

export type ChartingEvent =
  | ChartingStartedEvent
  | ChartingStateChangedEvent
  | ChartingMessageRecordedEvent
  | MapProposalReturnedEvent
  | MapCreationConfirmedEvent
  | RechartRequestedEvent
  | RechartQueuedEvent
  | RechartCompletedEvent
  | RechartChangeRestoredEvent;

export interface ChartingStoreOptions {
  dataRoot?: string;
  now?: () => Date;
}

export function chartingPathFor(campaignId: string, dataRoot?: string): string {
  return path.join(path.dirname(overlayPathFor(campaignId, dataRoot)), "charting.jsonl");
}

/** Append-only recovery log for the one persistent first-map conversation. */
export class ChartingStore {
  readonly path: string;

  #campaignId: string;
  #sourceRevision: string;
  #now: () => Date;
  #records = new Map<string, ChartingRecord>();
  #appendChain: Promise<void> = Promise.resolve();

  private constructor(campaign: CampaignProjection, options: ChartingStoreOptions) {
    this.#campaignId = campaign.id;
    this.#sourceRevision = campaign.revision;
    this.#now = options.now ?? (() => new Date());
    this.path = chartingPathFor(campaign.id, options.dataRoot);
  }

  static async open(
    campaign: CampaignProjection,
    options: ChartingStoreOptions = {},
  ): Promise<ChartingStore> {
    const store = new ChartingStore(campaign, options);
    await store.#load();
    return store;
  }

  setSourceRevision(revision: string): void {
    this.#sourceRevision = revision;
  }

  getAll(): ChartingRecord[] {
    return [...this.#records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => structuredClone(record));
  }

  get(id: string): ChartingRecord | undefined {
    const record = this.#records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async start(chartingId: string, threadId: string): Promise<ChartingRecord> {
    if (this.#records.has(chartingId)) {
      throw new Error(`Charting session ${chartingId} already exists.`);
    }
    const event: ChartingStartedEvent = {
      ...this.#eventBase(),
      type: "charting_started",
      payload: { chartingId, threadId },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async changeState(
    chartingId: string,
    state: ChartingState,
    options: { activeTurnId?: string; error?: string } = {},
  ): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: ChartingStateChangedEvent = {
      ...this.#eventBase(),
      type: "charting_state_changed",
      payload: {
        chartingId,
        state,
        activeTurnId: options.activeTurnId ?? null,
        error: options.error ?? null,
      },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async addMessage(chartingId: string, message: ChartingMessage): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: ChartingMessageRecordedEvent = {
      ...this.#eventBase(),
      type: "charting_message_recorded",
      payload: { chartingId, message },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async addProposal(chartingId: string, proposal: MapProposal): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: MapProposalReturnedEvent = {
      ...this.#eventBase(),
      type: "map_proposal_returned",
      payload: { chartingId, proposal },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async confirmMap(
    chartingId: string,
    planId: string,
    resultingSourceRevision: string,
  ): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: MapCreationConfirmedEvent = {
      ...this.#eventBase(),
      type: "map_creation_confirmed",
      payload: { chartingId, planId, resultingSourceRevision },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async beginRechart(
    chartingId: string,
    confirmedLocationId: string,
    activeLocationIds: string[],
    triggerKind: RechartTriggerKind = "answer_confirmed",
  ): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: RechartRequestedEvent = {
      ...this.#eventBase(),
      type: "rechart_requested",
      payload: { chartingId, confirmedLocationId, triggerKind, activeLocationIds: [...activeLocationIds] },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async enqueueRechart(
    chartingId: string,
    confirmedLocationId: string,
    activeLocationIds: string[],
    triggerKind: RechartTriggerKind = "answer_confirmed",
  ): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: RechartQueuedEvent = {
      ...this.#eventBase(),
      type: "rechart_queued",
      payload: { chartingId, confirmedLocationId, triggerKind, activeLocationIds: [...activeLocationIds] },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async completeRechart(
    chartingId: string,
    resultingSourceRevision: string,
    change?: RechartChangeView,
  ): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: RechartCompletedEvent = {
      ...this.#eventBase(),
      type: "rechart_completed",
      payload: { chartingId, resultingSourceRevision, change },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async restoreRechartChange(
    chartingId: string,
    changeId: string,
    locationId: string,
    resultingSourceRevision: string,
  ): Promise<ChartingRecord> {
    this.#requireRecord(chartingId);
    const event: RechartChangeRestoredEvent = {
      ...this.#eventBase(),
      type: "rechart_change_restored",
      payload: { chartingId, changeId, locationId, resultingSourceRevision },
    };
    await this.#append(event);
    return this.get(chartingId)!;
  }

  async close(): Promise<void> {
    await this.#appendChain;
  }

  #requireRecord(chartingId: string): void {
    if (!this.#records.has(chartingId)) {
      throw new Error(`Unknown charting session ${chartingId}.`);
    }
  }

  #eventBase(): ChartingEventBase {
    return {
      id: randomUUID(),
      timestamp: this.#now().toISOString(),
      campaignId: this.#campaignId,
      sourceRevision: this.#sourceRevision,
    };
  }

  async #append(event: ChartingEvent): Promise<void> {
    this.#appendChain = this.#appendChain.then(async () => {
      await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      this.#apply(event);
    });
    return this.#appendChain;
  }

  async #load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) {
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch (cause) {
        throw new Error(`Charting log is malformed at line ${index + 1}.`, { cause });
      }
      if (!isChartingEvent(decoded, this.#campaignId)) {
        throw new Error(`Charting log has an invalid event at line ${index + 1}.`);
      }
      this.#apply(decoded);
    }
  }

  #apply(event: ChartingEvent): void {
    if (event.type === "charting_started") {
      if (!this.#records.has(event.payload.chartingId)) {
        this.#records.set(event.payload.chartingId, {
          id: event.payload.chartingId,
          campaignId: event.campaignId,
          threadId: event.payload.threadId,
          state: "created",
          messages: [],
          rechartQueue: [],
          rechartChanges: [],
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        });
      }
      return;
    }
    const record = this.#records.get(event.payload.chartingId);
    if (!record) {
      throw new Error(`Charting event ${event.id} refers to an unknown session.`);
    }
    if (event.type === "charting_state_changed") {
      record.state = event.payload.state;
      record.activeTurnId = event.payload.activeTurnId ?? undefined;
      record.error = event.payload.error ?? undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "map_proposal_returned") {
      record.proposal = structuredClone(event.payload.proposal);
      record.state = "returned";
      record.activeTurnId = undefined;
      record.error = undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "map_creation_confirmed") {
      record.state = "confirmed";
      record.mapCreatedAt = event.timestamp;
      record.activeTurnId = undefined;
      record.error = undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "rechart_requested") {
      if (record.rechartQueue[0]?.confirmedLocationId === event.payload.confirmedLocationId) {
        record.rechartQueue.shift();
      }
      record.pendingRechart = {
        confirmedLocationId: event.payload.confirmedLocationId,
        triggerKind: event.payload.triggerKind ?? "answer_confirmed",
        activeLocationIds: [...event.payload.activeLocationIds],
        sourceRevision: event.sourceRevision,
        requestedAt: event.timestamp,
      };
      record.state = "recharting";
      record.activeTurnId = undefined;
      record.error = undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "rechart_queued") {
      record.rechartQueue.push({
        confirmedLocationId: event.payload.confirmedLocationId,
        triggerKind: event.payload.triggerKind ?? "answer_confirmed",
        activeLocationIds: [...event.payload.activeLocationIds],
        enqueuedAt: event.timestamp,
      });
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "rechart_completed") {
      record.pendingRechart = undefined;
      record.state = "confirmed";
      record.activeTurnId = undefined;
      record.error = undefined;
      if (event.payload.change) {
        record.rechartChanges.push(structuredClone(event.payload.change));
      }
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "rechart_change_restored") {
      const change = record.rechartChanges.find(({ id }) => id === event.payload.changeId);
      if (!change) {
        throw new Error(`Rechart restoration ${event.id} refers to an unknown change.`);
      }
      if (!change.restoredLocationIds.includes(event.payload.locationId)) {
        change.restoredLocationIds.push(event.payload.locationId);
      }
      record.updatedAt = event.timestamp;
      return;
    }
    const message = event.payload.message;
    const duplicate = record.messages.some((candidate) =>
      candidate.id === message.id ||
      (
        message.role === "guide" &&
        candidate.role === "guide" &&
        message.turnId &&
        candidate.turnId === message.turnId &&
        candidate.text.trim() === message.text.trim()
      ));
    if (!duplicate) {
      record.messages.push(structuredClone(message));
      record.updatedAt = event.timestamp;
    }
  }
}

function isChartingEvent(value: unknown, campaignId: string): value is ChartingEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string" ||
    value.campaignId !== campaignId ||
    typeof value.sourceRevision !== "string" ||
    !isRecord(value.payload) ||
    typeof value.payload.chartingId !== "string"
  ) {
    return false;
  }
  if (value.type === "charting_started") {
    return typeof value.payload.threadId === "string";
  }
  if (value.type === "charting_state_changed") {
    return isChartingState(value.payload.state) &&
      (value.payload.activeTurnId === null || typeof value.payload.activeTurnId === "string") &&
      (value.payload.error === null || typeof value.payload.error === "string");
  }
  if (value.type === "charting_message_recorded") {
    return isChartingMessage(value.payload.message);
  }
  if (value.type === "map_proposal_returned") {
    return isRecord(value.payload.proposal);
  }
  if (value.type === "map_creation_confirmed") {
    return typeof value.payload.planId === "string" &&
      typeof value.payload.resultingSourceRevision === "string";
  }
  if (value.type === "rechart_requested") {
    return typeof value.payload.confirmedLocationId === "string" &&
      (value.payload.triggerKind === undefined || isRechartTriggerKind(value.payload.triggerKind)) &&
      Array.isArray(value.payload.activeLocationIds) &&
      value.payload.activeLocationIds.every((id) => typeof id === "string");
  }
  if (value.type === "rechart_queued") {
    return typeof value.payload.confirmedLocationId === "string" &&
      (value.payload.triggerKind === undefined || isRechartTriggerKind(value.payload.triggerKind)) &&
      Array.isArray(value.payload.activeLocationIds) &&
      value.payload.activeLocationIds.every((id) => typeof id === "string");
  }
  if (value.type === "rechart_completed") {
    return typeof value.payload.resultingSourceRevision === "string" &&
      (value.payload.change === undefined || isRechartChangeView(value.payload.change));
  }
  if (value.type === "rechart_change_restored") {
    return typeof value.payload.changeId === "string" &&
      typeof value.payload.locationId === "string" &&
      typeof value.payload.resultingSourceRevision === "string";
  }
  return false;
}

function isRechartTriggerKind(value: unknown): value is RechartTriggerKind {
  return value === "answer_confirmed" || value === "exploration_ended";
}

function isRechartChangeView(value: unknown): value is RechartChangeView {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.confirmedLocationId === "string" &&
    typeof value.sourceRevisionBefore === "string" &&
    typeof value.sourceRevisionAfter === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.restoredLocationIds) &&
    value.restoredLocationIds.every((id) => typeof id === "string") &&
    Array.isArray(value.files) &&
    value.files.every((file) => isRecord(file) &&
      typeof file.locationId === "string" &&
      typeof file.path === "string" &&
      (file.operation === "created" || file.operation === "updated" ||
        file.operation === "deleted" || file.operation === "archived"));
}

function isChartingMessage(value: unknown): value is ChartingMessage {
  return isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "player" || value.role === "guide") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string" &&
    (value.turnId === undefined || typeof value.turnId === "string");
}

function isChartingState(value: unknown): value is ChartingState {
  return value === "created" ||
    value === "exploring" ||
    value === "awaiting_player" ||
    value === "awaiting_approval" ||
    value === "reconciling" ||
    value === "failed" ||
    value === "returning" ||
    value === "returned" ||
    value === "previewing" ||
    value === "confirmed" ||
    value === "recharting" ||
    value === "rechart_failed" ||
    value === "orphaned";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
