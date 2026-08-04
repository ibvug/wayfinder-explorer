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
  dependencyRank: number;
  sourceRanges: LocationSourceRanges;
}

export interface Route {
  from: string;
  to: string;
  state: "traveled" | "available" | "locked";
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
  outOfScope: string[];
  locations: Location[];
  routes: Route[];
  trail: TrailStop[];
  fog: FogArea[];
  diagnostics: Diagnostic[];
  summary: CampaignSummary;
}

export type LayoutRegion = "trail" | "frontier" | "gates" | "destination" | "fog";

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
