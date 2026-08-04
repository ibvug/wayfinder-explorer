import type { CampaignProjection, ExplorerOverlay } from "../model.ts";
import type { CodexServiceView, ExpeditionView } from "../expedition/model.ts";
import type { CampaignProjectIndex } from "../project/model.ts";
import type { ChartingView } from "../charting/model.ts";

export interface CampaignSnapshot {
  sequence: number;
  campaign: CampaignProjection;
  overlay: ExplorerOverlay;
}

export interface ExplorerSnapshot extends CampaignSnapshot {
  projects: CampaignProjectIndex;
  expeditions: ExpeditionView[];
  charting?: ChartingView;
  codex: CodexServiceView;
}

export interface CampaignStreamEvent {
  sequence: number;
  type: "campaign.updated";
  snapshot: CampaignSnapshot;
}
