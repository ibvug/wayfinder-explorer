import type {
  CampaignProjection,
  ExplorerOverlay,
  LayoutPoint,
  Location,
} from "../../src/model.ts";
import type {
  CodexServiceView,
  ExpeditionView,
  WritebackPlanView,
} from "../../src/expedition/model.ts";
import type { CampaignProjectIndex } from "../../src/project/model.ts";
import type { DirectoryPickerPurpose } from "../../src/project/directory-picker.ts";
import type {
  ChartingView,
  MapCreationPlanView,
} from "../../src/charting/model.ts";

export interface CampaignSnapshot {
  sequence: number;
  projects: CampaignProjectIndex;
  campaign: CampaignProjection;
  overlay: ExplorerOverlay;
  expeditions: ExpeditionView[];
  charting?: ChartingView;
  codex: CodexServiceView;
}

export interface ExplorerBootstrap {
  apiToken: string;
  campaignEndpoint: string;
  eventsEndpoint: string;
  apiRoot: string;
}

export interface ExpeditionActions {
  busyTarget?: string;
  error?: string;
  startCharting(): Promise<void>;
  sendChartingMessage(chartingId: string, message: string): Promise<void>;
  formMapProposal(chartingId: string): Promise<void>;
  resumeMapProposal(chartingId: string): Promise<void>;
  previewMap(chartingId: string, expectedSourceRevision: string): Promise<void>;
  confirmMap(plan: MapCreationPlanView): Promise<void>;
  interruptCharting(chartingId: string): Promise<void>;
  setPlayerFocus(locationId: string): Promise<void>;
  startExpedition(locationId: string): Promise<void>;
  sendMessage(expeditionId: string, message: string): Promise<void>;
  formProposal(expeditionId: string): Promise<void>;
  deferProposal(expeditionId: string): Promise<void>;
  resumeProposal(expeditionId: string): Promise<void>;
  previewWriteback(
    locationId: string,
    expeditionId: string,
    expectedSourceRevision: string,
  ): Promise<void>;
  confirmWriteback(plan: WritebackPlanView): Promise<void>;
  activateProject(projectId: string): Promise<void>;
  createProject(name: string, parentRoot: string): Promise<void>;
  addProject(root: string): Promise<void>;
  relinkProject(projectId: string, root: string): Promise<void>;
  selectDirectory(purpose: DirectoryPickerPurpose): Promise<string | undefined>;
  interrupt(expeditionId: string): Promise<void>;
  clearError(): void;
}

export type ConnectionState = "connecting" | "live" | "reconnecting";

export type Selection =
  | { kind: "location"; id: string }
  | { kind: "destination" }
  | { kind: "fog" };

export interface LocationWithPoint {
  location: Location;
  point: LayoutPoint;
}

declare global {
  interface Window {
    __WAYFINDER_BOOTSTRAP__?: ExplorerBootstrap;
  }
}
