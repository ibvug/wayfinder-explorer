import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CampaignProjection } from "../model.ts";
import { overlayPathFor } from "../overlay.ts";
import type {
  DecisionProposal,
  ExpeditionMessage,
  ExpeditionRecord,
  ExpeditionState,
  WritebackLocationImpact,
} from "./model.ts";

interface JourneyEventBase {
  id: string;
  timestamp: string;
  campaignId: string;
  sourceRevision: string;
}

interface ExpeditionStartedEvent extends JourneyEventBase {
  type: "expedition_started";
  payload: {
    expeditionId: string;
    locationId: string;
    threadId: string;
  };
}

interface ExpeditionStateChangedEvent extends JourneyEventBase {
  type: "expedition_state_changed";
  payload: {
    expeditionId: string;
    state: ExpeditionState;
    activeTurnId: string | null;
    error: string | null;
  };
}

interface ExpeditionMessageRecordedEvent extends JourneyEventBase {
  type: "expedition_message_recorded";
  payload: {
    expeditionId: string;
    message: ExpeditionMessage;
  };
}

interface ProposalReturnedEvent extends JourneyEventBase {
  type: "proposal_returned";
  payload: {
    expeditionId: string;
    proposal: DecisionProposal;
  };
}

interface WritebackConfirmedEvent extends JourneyEventBase {
  type: "writeback_confirmed";
  payload: {
    expeditionId: string;
    planId: string;
    resultingSourceRevision: string;
    impact: WritebackLocationImpact[];
  };
}

export type JourneyEvent =
  | ExpeditionStartedEvent
  | ExpeditionStateChangedEvent
  | ExpeditionMessageRecordedEvent
  | ProposalReturnedEvent
  | WritebackConfirmedEvent;

export interface JourneyStoreOptions {
  dataRoot?: string;
  now?: () => Date;
}

/** Append-only recovery log for Codex thread bindings and visible expedition history. */
export class JourneyStore {
  readonly path: string;

  #campaignId: string;
  #sourceRevision: string;
  #now: () => Date;
  #records = new Map<string, ExpeditionRecord>();
  #appendChain: Promise<void> = Promise.resolve();

  private constructor(campaign: CampaignProjection, options: JourneyStoreOptions) {
    this.#campaignId = campaign.id;
    this.#sourceRevision = campaign.revision;
    this.#now = options.now ?? (() => new Date());
    this.path = path.join(path.dirname(overlayPathFor(campaign.id, options.dataRoot)), "journey.jsonl");
  }

  static async open(
    campaign: CampaignProjection,
    options: JourneyStoreOptions = {},
  ): Promise<JourneyStore> {
    const store = new JourneyStore(campaign, options);
    await store.#load();
    return store;
  }

  setSourceRevision(revision: string): void {
    this.#sourceRevision = revision;
  }

  getAll(): ExpeditionRecord[] {
    return [...this.#records.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((record) => structuredClone(record));
  }

  get(id: string): ExpeditionRecord | undefined {
    const record = this.#records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async start(expeditionId: string, locationId: string, threadId: string): Promise<ExpeditionRecord> {
    if (this.#records.has(expeditionId)) {
      throw new Error(`Expedition ${expeditionId} already exists.`);
    }
    const event: ExpeditionStartedEvent = {
      ...this.#eventBase(),
      type: "expedition_started",
      payload: { expeditionId, locationId, threadId },
    };
    await this.#append(event);
    return this.get(expeditionId)!;
  }

  async changeState(
    expeditionId: string,
    state: ExpeditionState,
    options: { activeTurnId?: string; error?: string } = {},
  ): Promise<ExpeditionRecord> {
    if (!this.#records.has(expeditionId)) {
      throw new Error(`Unknown expedition ${expeditionId}.`);
    }
    const event: ExpeditionStateChangedEvent = {
      ...this.#eventBase(),
      type: "expedition_state_changed",
      payload: {
        expeditionId,
        state,
        activeTurnId: options.activeTurnId ?? null,
        error: options.error ?? null,
      },
    };
    await this.#append(event);
    return this.get(expeditionId)!;
  }

  async addMessage(expeditionId: string, message: ExpeditionMessage): Promise<ExpeditionRecord> {
    if (!this.#records.has(expeditionId)) {
      throw new Error(`Unknown expedition ${expeditionId}.`);
    }
    const event: ExpeditionMessageRecordedEvent = {
      ...this.#eventBase(),
      type: "expedition_message_recorded",
      payload: { expeditionId, message },
    };
    await this.#append(event);
    return this.get(expeditionId)!;
  }

  async addProposal(
    expeditionId: string,
    proposal: DecisionProposal,
  ): Promise<ExpeditionRecord> {
    if (!this.#records.has(expeditionId)) {
      throw new Error(`Unknown expedition ${expeditionId}.`);
    }
    const event: ProposalReturnedEvent = {
      ...this.#eventBase(),
      type: "proposal_returned",
      payload: { expeditionId, proposal },
    };
    await this.#append(event);
    return this.get(expeditionId)!;
  }

  async confirmWriteback(
    expeditionId: string,
    planId: string,
    resultingSourceRevision: string,
    impact: WritebackLocationImpact[],
  ): Promise<ExpeditionRecord> {
    if (!this.#records.has(expeditionId)) {
      throw new Error(`Unknown expedition ${expeditionId}.`);
    }
    const event: WritebackConfirmedEvent = {
      ...this.#eventBase(),
      type: "writeback_confirmed",
      payload: { expeditionId, planId, resultingSourceRevision, impact },
    };
    await this.#append(event);
    return this.get(expeditionId)!;
  }

  async close(): Promise<void> {
    await this.#appendChain;
  }

  #eventBase(): JourneyEventBase {
    return {
      id: randomUUID(),
      timestamp: this.#now().toISOString(),
      campaignId: this.#campaignId,
      sourceRevision: this.#sourceRevision,
    };
  }

  async #append(event: JourneyEvent): Promise<void> {
    this.#appendChain = this.#appendChain.then(async () => {
      await mkdir(path.dirname(this.path), { recursive: true });
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
        throw new Error(`Journey log is malformed at line ${index + 1}.`, { cause });
      }
      if (!isJourneyEvent(decoded, this.#campaignId)) {
        throw new Error(`Journey log has an invalid event at line ${index + 1}.`);
      }
      this.#apply(decoded);
    }
  }

  #apply(event: JourneyEvent): void {
    if (event.type === "expedition_started") {
      if (this.#records.has(event.payload.expeditionId)) {
        return;
      }
      this.#records.set(event.payload.expeditionId, {
        id: event.payload.expeditionId,
        campaignId: event.campaignId,
        locationId: event.payload.locationId,
        threadId: event.payload.threadId,
        state: "created",
        messages: [],
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      return;
    }
    const record = this.#records.get(event.payload.expeditionId);
    if (!record) {
      throw new Error(`Journey event ${event.id} refers to an unknown expedition.`);
    }
    if (event.type === "expedition_state_changed") {
      record.state = event.payload.state;
      record.activeTurnId = event.payload.activeTurnId ?? undefined;
      record.error = event.payload.error ?? undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "proposal_returned") {
      record.proposal = structuredClone(event.payload.proposal);
      record.state = "returned";
      record.activeTurnId = undefined;
      record.error = undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    if (event.type === "writeback_confirmed") {
      record.state = "confirmed";
      record.activeTurnId = undefined;
      record.error = undefined;
      record.updatedAt = event.timestamp;
      return;
    }
    const message = event.payload.message;
    const duplicate = record.messages.some((candidate) =>
      candidate.id === message.id ||
      (
        message.role === "guide" &&
        Boolean(message.turnId) &&
        candidate.role === "guide" &&
        candidate.turnId === message.turnId &&
        candidate.text.trim() === message.text.trim()
      ));
    if (!duplicate) {
      record.messages.push(structuredClone(event.payload.message));
    }
    record.updatedAt = event.timestamp;
  }
}

function isJourneyEvent(value: unknown, campaignId: string): value is JourneyEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.timestamp !== "string" ||
    value.campaignId !== campaignId ||
    typeof value.sourceRevision !== "string" ||
    !isRecord(value.payload)
  ) {
    return false;
  }
  if (value.type === "expedition_started") {
    return (
      typeof value.payload.expeditionId === "string" &&
      typeof value.payload.locationId === "string" &&
      typeof value.payload.threadId === "string"
    );
  }
  if (value.type === "expedition_state_changed") {
    return (
      typeof value.payload.expeditionId === "string" &&
      isExpeditionState(value.payload.state) &&
      (value.payload.activeTurnId === null || typeof value.payload.activeTurnId === "string") &&
      (value.payload.error === null || typeof value.payload.error === "string")
    );
  }
  if (value.type === "proposal_returned") {
    return (
      typeof value.payload.expeditionId === "string" &&
      isDecisionProposal(value.payload.proposal)
    );
  }
  if (value.type === "writeback_confirmed") {
    return (
      typeof value.payload.expeditionId === "string" &&
      typeof value.payload.planId === "string" &&
      typeof value.payload.resultingSourceRevision === "string" &&
      Array.isArray(value.payload.impact) &&
      value.payload.impact.every(isWritebackImpact)
    );
  }
  return (
    value.type === "expedition_message_recorded" &&
    typeof value.payload.expeditionId === "string" &&
    isExpeditionMessage(value.payload.message)
  );
}

function isDecisionProposal(value: unknown): value is DecisionProposal {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.answerMarkdown === "string" &&
    isStringArray(value.rationale) &&
    isStringArray(value.evidenceRefs) &&
    isStringArray(value.rejectedAlternatives) &&
    isStringArray(value.assumptions) &&
    isStringArray(value.revisitConditions) &&
    (value.confidence === "low" || value.confidence === "medium" || value.confidence === "high") &&
    typeof value.sourceRevision === "string" &&
    typeof value.sourceTurnId === "string" &&
    typeof value.createdAt === "string"
  );
}

function isWritebackImpact(value: unknown): value is WritebackLocationImpact {
  return (
    isRecord(value) &&
    typeof value.locationId === "string" &&
    typeof value.title === "string" &&
    isProjectedStatus(value.beforeStatus) &&
    isProjectedStatus(value.afterStatus) &&
    isSourceStatus(value.beforeSourceStatus) &&
    isSourceStatus(value.afterSourceStatus)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isProjectedStatus(value: unknown): boolean {
  return value === "resolved" || value === "frontier" || value === "blocked";
}

function isSourceStatus(value: unknown): boolean {
  return value === "open" || value === "resolved" || value === "unknown";
}

function isExpeditionMessage(value: unknown): value is ExpeditionMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "player" || value.role === "guide") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string" &&
    (value.turnId === undefined || typeof value.turnId === "string")
  );
}

function isExpeditionState(value: unknown): value is ExpeditionState {
  return (
    value === "created" ||
    value === "exploring" ||
    value === "awaiting_player" ||
    value === "awaiting_approval" ||
    value === "reconciling" ||
    value === "failed" ||
    value === "returning" ||
    value === "returned" ||
    value === "drafted" ||
    value === "previewing" ||
    value === "confirmed" ||
    value === "abandoned" ||
    value === "orphaned"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
