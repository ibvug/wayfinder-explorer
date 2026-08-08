import type { ExpeditionService } from "../expedition/manager.ts";
import type { ChartingService } from "../charting/manager.ts";
import type { CampaignProjectIndex } from "../project/model.ts";
import type { CampaignStore } from "./campaign-store.ts";
import type { ExplorerSnapshot } from "./model.ts";
import { isTerminalExpeditionState } from "../expedition/model.ts";
import type { CampaignProjection } from "../model.ts";

type ExplorerStateListener = (snapshot: ExplorerSnapshot) => void;

/** Combines source-map and Codex changes into one monotonic browser snapshot stream. */
export class ExplorerState {
  #store: CampaignStore;
  #expeditions?: ExpeditionService;
  #charting?: ChartingService;
  #projects: CampaignProjectIndex;
  #sequence = 1;
  #listeners = new Set<ExplorerStateListener>();
  #unsubscribeCampaign: () => void;
  #unsubscribeExpeditions?: () => void;
  #unsubscribeCharting?: () => void;

  constructor(
    store: CampaignStore,
    expeditions?: ExpeditionService,
    projects: CampaignProjectIndex = {
      activeProjectId: store.getSnapshot().campaign.id,
      projects: [],
    },
    charting?: ChartingService,
  ) {
    this.#store = store;
    this.#expeditions = expeditions;
    this.#projects = projects;
    this.#charting = charting;
    this.#unsubscribeCampaign = store.subscribe(() => this.#publish());
    this.#unsubscribeExpeditions = expeditions?.subscribe(() => this.#publish());
    this.#unsubscribeCharting = charting?.subscribe(() => this.#publish());
  }

  getSnapshot(): ExplorerSnapshot {
    const campaignSnapshot = this.#store.getSnapshot();
    const charting = this.#charting?.getViews().at(-1);
    const expeditions = this.#expeditions?.getViews() ?? [];
    const campaign = projectOperationalArrival(
      campaignSnapshot.campaign,
      expeditions.some(({ state }) => !isTerminalExpeditionState(state)),
      charting,
    );
    const emptyProject = campaign.diagnostics.some(({ code }) => code === "map_missing");
    return {
      sequence: this.#sequence,
      projects: structuredClone(this.#projects),
      campaign,
      overlay: campaignSnapshot.overlay,
      expeditions,
      charting,
      codex: (emptyProject ? this.#charting : this.#expeditions)?.getServiceView() ?? {
        state: "unavailable",
        error: emptyProject ? "Codex 绘图服务没有启用。" : "Codex 探索服务没有启用。",
      },
    };
  }

  subscribe(listener: ExplorerStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  switchContext(
    store: CampaignStore,
    expeditions: ExpeditionService | undefined,
    projects: CampaignProjectIndex,
    charting?: ChartingService,
  ): void {
    this.#unsubscribeCampaign();
    this.#unsubscribeExpeditions?.();
    this.#unsubscribeCharting?.();
    this.#store = store;
    this.#expeditions = expeditions;
    this.#projects = structuredClone(projects);
    this.#charting = charting;
    this.#unsubscribeCampaign = store.subscribe(() => this.#publish());
    this.#unsubscribeExpeditions = expeditions?.subscribe(() => this.#publish());
    this.#unsubscribeCharting = charting?.subscribe(() => this.#publish());
    this.#publish();
  }

  setProjects(projects: CampaignProjectIndex): void {
    this.#projects = structuredClone(projects);
    this.#publish();
  }

  close(): void {
    this.#unsubscribeCampaign();
    this.#unsubscribeExpeditions?.();
    this.#unsubscribeCharting?.();
    this.#listeners.clear();
  }

  #publish(): void {
    this.#sequence += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Browser subscribers are isolated from the canonical state stream.
      }
    }
  }
}

export function projectOperationalArrival(
  campaign: CampaignProjection,
  hasActiveExpedition: boolean,
  charting: ReturnType<NonNullable<ChartingService>["getViews"]>[number] | undefined,
): CampaignProjection {
  const hasPendingRechart = Boolean(
    charting?.pendingRechart || charting?.rechartQueue.length || charting?.state === "recharting",
  );
  const destination = campaign.mapNodes.find(({ kind }) => kind === "destination");
  const latestChange = charting?.rechartChanges.at(-1);
  const exhaustedAfterSuccessfulRechart = Boolean(
    !hasActiveExpedition &&
    !hasPendingRechart &&
    destination?.state === "open" &&
    campaign.locations.length === 0 &&
    campaign.fog.length === 0 &&
    campaign.summary.blockingDiagnostics === 0 &&
    latestChange?.sourceRevisionAfter === campaign.revision,
  );
  if (exhaustedAfterSuccessfulRechart) {
    return {
      ...campaign,
      mapNodes: campaign.mapNodes.map((node) =>
        node.kind === "destination" ? { ...node, state: "arrived" as const } : node),
      determinedRoutes: [{ from: "start", to: "destination" }],
    };
  }
  if (!hasActiveExpedition && !hasPendingRechart) {
    return campaign;
  }
  if (destination?.state !== "arrived") {
    return campaign;
  }
  return {
    ...campaign,
    mapNodes: campaign.mapNodes.map((node) =>
      node.kind === "destination" ? { ...node, state: "open" as const } : node),
    determinedRoutes: campaign.determinedRoutes.filter(({ to }) => to !== "destination"),
  };
}
