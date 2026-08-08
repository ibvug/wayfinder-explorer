export type LocationType = "grilling" | "prototype" | "research" | "task";
export type SourceStatus = "open" | "resolved" | "unknown";
export type LocationStatus = "resolved" | "frontier" | "blocked";

export interface SourceRange {
  path: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

export type DiagnosticCode =
  | "map_missing"
  | "map_title_missing"
  | "destination_missing"
  | "location_id_missing"
  | "location_id_duplicate"
  | "location_title_missing"
  | "unsupported_type"
  | "unsupported_status"
  | "question_missing"
  | "dangling_blocker"
  | "dependency_cycle"
  | "resolved_depends_on_unresolved"
  | "map_decision_mismatch";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning";
  blocking: boolean;
  message: string;
  source?: SourceRange;
  locationIds?: string[];
}

export interface LocationSourceRanges {
  document: SourceRange;
  title?: SourceRange;
  type?: SourceRange;
  status?: SourceRange;
  blockers?: SourceRange;
  question?: SourceRange;
  answer?: SourceRange;
  answerHistory?: SourceRange;
}

export interface AnswerHistoryEntry {
  label: string;
  answerMarkdown: string;
}

export interface Location {
  id: string;
  sourcePath: string;
  title: string;
  type: LocationType | "unknown";
  sourceStatus: SourceStatus;
  status: LocationStatus;
  blockers: string[];
  question: string;
  answerMarkdown?: string;
  answerHistory: AnswerHistoryEntry[];
  reviewState: "current" | "pending";
  reviewQuestion?: string;
  reviewReason?: string;
  rechartState: "current" | "pending_delete";
  pendingDeletionReason?: string;
  dependencyRank: number;
  sourceRanges: LocationSourceRanges;
}

export interface Route {
  from: string;
  to: string;
  state: "traveled" | "available" | "locked";
}

export type MapNodeKind = "start" | "decision" | "destination";
export type MapNodeState = "current" | "review_pending" | "open" | "arrived";

/** A point that is allowed to appear on the canonical, determined map. */
export interface MapNode {
  id: string;
  kind: MapNodeKind;
  state: MapNodeState;
  title: string;
  locationId?: string;
  answerMarkdown?: string;
  answerHistory?: AnswerHistoryEntry[];
}

/** A route supported by current confirmed answers; open issue dependencies are excluded. */
export interface DeterminedRoute {
  from: string;
  to: string;
}

export interface TrailStop {
  order: number;
  locationId: string;
  title: string;
  summary?: string;
  source: SourceRange;
}

export interface FogArea {
  id: string;
  title: string;
  source: SourceRange;
}

export interface CampaignSummary {
  total: number;
  resolved: number;
  frontier: number;
  blocked: number;
  fog: number;
  blockingDiagnostics: number;
  warnings: number;
}

export interface CampaignProjection {
  id: string;
  root: string;
  revision: string;
  title: string;
  destination: string;
  startingState: string;
  evidenceScope: string[];
  outOfScope: string[];
  locations: Location[];
  routes: Route[];
  mapNodes: MapNode[];
  determinedRoutes: DeterminedRoute[];
  trail: TrailStop[];
  fog: FogArea[];
  diagnostics: Diagnostic[];
  summary: CampaignSummary;
}

export type LayoutRegion = "start" | "trail" | "frontier" | "gates" | "destination" | "fog";

export interface LayoutPoint {
  x: number;
  y: number;
  region: LayoutRegion;
}

export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CampaignLayout {
  version: 1;
  start: LayoutPoint;
  locations: Record<string, LayoutPoint>;
  destination: LayoutPoint;
  fogEntrance: LayoutPoint;
  bounds: LayoutBounds;
}

export interface ExplorerOverlay {
  schemaVersion: 1;
  campaignId: string;
  lastObservedSourceRevision: string;
  layout: CampaignLayout;
  playerFocusId: string | null;
  expeditionBindings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface OpenOverlayResult {
  path: string;
  overlay: ExplorerOverlay;
  created: boolean;
  recovered: boolean;
  changed: boolean;
}
