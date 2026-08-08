export type ExpeditionState =
  | "created"
  | "exploring"
  | "awaiting_player"
  | "awaiting_approval"
  | "reconciling"
  | "failed"
  | "returning"
  | "returned"
  | "drafted"
  | "previewing"
  | "ending"
  | "confirmed"
  | "abandoned"
  | "orphaned";

export type ExpeditionMessageRole = "player" | "guide";

export interface ExpeditionMessage {
  id: string;
  role: ExpeditionMessageRole;
  text: string;
  createdAt: string;
  turnId?: string;
}

export interface DecisionProposalContent {
  answerMarkdown: string;
  rationale: string[];
  evidenceRefs: string[];
  rejectedAlternatives: string[];
  assumptions: string[];
  revisitConditions: string[];
  confidence: "low" | "medium" | "high";
}

/** Model-authored content plus metadata trusted and attached by Explorer. */
export interface DecisionProposal extends DecisionProposalContent {
  id: string;
  sourceRevision: string;
  sourceTurnId: string;
  createdAt: string;
}

export interface WritebackLocationImpact {
  locationId: string;
  title: string;
  beforeStatus: "resolved" | "frontier" | "blocked";
  afterStatus: "resolved" | "frontier" | "blocked";
  beforeSourceStatus: "open" | "resolved" | "unknown";
  afterSourceStatus: "open" | "resolved" | "unknown";
}

export interface WritebackFilePreview {
  path: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
}

export interface WritebackPlanView {
  id: string;
  expeditionId: string;
  locationId: string;
  changeKind: "confirmation" | "revision" | "reaffirmation";
  expectedSourceRevision: string;
  resultingSourceRevision: string;
  proposalHash: string;
  createdAt: string;
  expiresAt: string;
  files: WritebackFilePreview[];
  impact: WritebackLocationImpact[];
}

export interface ExpeditionRecord {
  id: string;
  campaignId: string;
  locationId: string;
  threadId: string;
  mode: "initial" | "revision";
  state: ExpeditionState;
  activeTurnId?: string;
  messages: ExpeditionMessage[];
  pendingCoordinations: PendingExplorationCoordination[];
  proposal?: DecisionProposal;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface PendingExplorationCoordination {
  id: string;
  update: RechartExplorationUpdate;
  queuedAt: string;
}

export interface StreamingGuideMessage {
  id: string;
  turnId: string;
  text: string;
}

export interface ExpeditionView extends ExpeditionRecord {
  streamingMessage?: StreamingGuideMessage;
  writebackPlan?: WritebackPlanView;
  approvalRequest?: AgentApprovalRequestView;
}

export type CodexConnectionState = "connecting" | "ready" | "reconnecting" | "unavailable";

export interface CodexServiceView {
  state: CodexConnectionState;
  error?: string;
}

export function isTerminalExpeditionState(state: ExpeditionState): boolean {
  return state === "confirmed" || state === "abandoned" || state === "orphaned";
}
import type { AgentApprovalRequestView } from "../codex/approval.ts";
import type { RechartExplorationUpdate } from "../charting/model.ts";
