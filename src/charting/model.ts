import type { LocationStatus, LocationType } from "../model.ts";

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
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface StreamingChartingMessage {
  id: string;
  turnId: string;
  text: string;
}

export interface ChartingView extends ChartingRecord {
  streamingMessage?: StreamingChartingMessage;
  creationPlan?: MapCreationPlanView;
}

export function isTerminalChartingState(state: ChartingState): boolean {
  return state === "confirmed" || state === "orphaned";
}
