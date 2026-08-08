import type { LocationStatus, LocationType } from "../model.ts";
import type { AgentApprovalRequestView } from "../codex/approval.ts";

export type ChartingState =
  | "created"
  | "exploring"
  | "awaiting_player"
  | "awaiting_approval"
  | "reconciling"
  | "failed"
  | "returning"
  | "returned"
  | "previewing"
  | "confirmed"
  | "recharting"
  | "rechart_failed"
  | "orphaned";

export type ChartingMessageRole = "player" | "guide";

export interface ChartingMessage {
  id: string;
  role: ChartingMessageRole;
  text: string;
  createdAt: string;
  turnId?: string;
}

export interface MapTicketProposal {
  /** Stable proposal-local key used by blockedBy before numeric issue ids exist. */
  key: string;
  title: string;
  type: LocationType;
  question: string;
  blockedBy: string[];
}

export interface MapProposalContent {
  title: string;
  destination: string;
  startingState: string;
  evidenceScope: string[];
  notes: string[];
  tickets: MapTicketProposal[];
  fog: string[];
  outOfScope: string[];
  evidenceRefs: string[];
}

/** Model-authored map content plus metadata trusted and attached by Explorer. */
export interface MapProposal extends MapProposalContent {
  id: string;
  sourceRevision: string;
  sourceTurnId: string;
  createdAt: string;
}

export interface MapCreationFilePreview {
  path: string;
  afterHash: string;
  diff: string;
}

export interface MapCreationLocationPreview {
  id: string;
  title: string;
  type: LocationType;
  status: LocationStatus;
  blockers: string[];
}

export interface MapCreationPlanView {
  id: string;
  chartingId: string;
  expectedSourceRevision: string;
  resultingSourceRevision: string;
  proposalHash: string;
  createdAt: string;
  expiresAt: string;
  files: MapCreationFilePreview[];
  locations: MapCreationLocationPreview[];
}

export interface ChartingRecord {
  id: string;
  campaignId: string;
  threadId: string;
  state: ChartingState;
  activeTurnId?: string;
  messages: ChartingMessage[];
  proposal?: MapProposal;
  mapCreatedAt?: string;
  pendingRechart?: PendingRechartRecord;
  rechartQueue: QueuedRechartRecord[];
  rechartChanges: RechartChangeView[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface PendingRechartRecord {
  confirmedLocationId: string;
  triggerKind: RechartTriggerKind;
  activeLocationIds: string[];
  sourceRevision: string;
  requestedAt: string;
}

export interface QueuedRechartRecord {
  confirmedLocationId: string;
  triggerKind: RechartTriggerKind;
  activeLocationIds: string[];
  enqueuedAt: string;
}

export type RechartTriggerKind = "answer_confirmed" | "exploration_ended";

export interface RechartFileChangeView {
  locationId: string;
  path: string;
  operation: "created" | "updated" | "deleted" | "archived";
}

export interface RechartChangeView {
  id: string;
  confirmedLocationId: string;
  sourceRevisionBefore: string;
  sourceRevisionAfter: string;
  createdAt: string;
  files: RechartFileChangeView[];
  restoredLocationIds: string[];
}

export type RechartIssueChange =
  | {
      kind: "create";
      key: string;
      title: string;
      type: LocationType;
      question: string;
      blockedBy: string[];
      reason: string;
    }
  | {
      kind: "update";
      issueId: string;
      title: string;
      type: LocationType;
      question: string;
      blockedBy: string[];
      reason: string;
    }
  | {
      kind: "pending_delete";
      issueId: string;
      reason: string;
    }
  | {
      kind: "end";
      issueId: string;
      reason: string;
    };

export interface RechartReviewConflict {
  locationId: string;
  question: string;
  reason: string;
}

export interface RechartExplorationUpdate {
  locationId: string;
  contextMarkdown: string;
  reason: string;
}

export interface RechartProposalContent {
  issueChanges: RechartIssueChange[];
  fog: string[];
  outOfScope: string[];
  reviewConflicts: RechartReviewConflict[];
  explorationUpdates: RechartExplorationUpdate[];
  summary: string;
  evidenceRefs: string[];
}

export interface RechartProposal extends RechartProposalContent {
  id: string;
  sourceRevision: string;
  sourceTurnId: string;
  confirmedLocationId: string;
  triggerKind: RechartTriggerKind;
  createdAt: string;
}

export interface StreamingChartingMessage {
  id: string;
  turnId: string;
  text: string;
}

export interface ChartingView extends ChartingRecord {
  streamingMessage?: StreamingChartingMessage;
  creationPlan?: MapCreationPlanView;
  approvalRequest?: AgentApprovalRequestView;
}

export function isTerminalChartingState(state: ChartingState): boolean {
  return state === "confirmed" || state === "orphaned";
}
