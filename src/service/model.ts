import type { CampaignProjection, ExplorerOverlay } from "../model.ts";
import type { CodexServiceView, ExpeditionView } from "../expedition/model.ts";
import type { CampaignProjectIndex } from "../project/model.ts";
import type { ChartingView } from "../charting/model.ts";

export interface CampaignSnapshot {
  sequence: number;
  campaign: CampaignProjection;
  overlay: ExplorerOverlay;
}

interface ExplorerSnapshotBase {
  sequence: number;
  projects: CampaignProjectIndex;
  expeditions: ExpeditionView[];
  codex: CodexServiceView;
}

export interface ActiveExplorerSnapshot extends ExplorerSnapshotBase {
  mode: "campaign";
  campaign: CampaignProjection;
  overlay: ExplorerOverlay;
  charting?: ChartingView;
}

export interface ProjectLibrarySnapshot extends ExplorerSnapshotBase {
  mode: "library";
  expeditions: [];
  campaign?: never;
  overlay?: never;
  charting?: never;
}

export type ExplorerSnapshot = ActiveExplorerSnapshot | ProjectLibrarySnapshot;

export interface CampaignStreamEvent {
  sequence: number;
  type: "campaign.updated";
  snapshot: CampaignSnapshot;
}
