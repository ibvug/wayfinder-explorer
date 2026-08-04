export type CampaignProjectStatus = "ready" | "empty" | "invalid" | "missing";

export interface CampaignProjectRecord {
  id: string;
  name: string;
  root: string;
  managed: boolean;
  createdAt: string;
  lastOpenedAt: string;
}

export interface CampaignProjectView extends CampaignProjectRecord {
  status: CampaignProjectStatus;
  campaignTitle?: string;
  resolved?: number;
  total?: number;
  frontier?: number;
  blockingDiagnostics?: number;
}

export interface CampaignProjectIndex {
  activeProjectId: string;
  projects: CampaignProjectView[];
}
