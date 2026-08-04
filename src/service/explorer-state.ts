import type { ExpeditionService } from "../expedition/manager.ts";
import type { ChartingService } from "../charting/manager.ts";
import type { CampaignProjectIndex } from "../project/model.ts";
import type { CampaignStore } from "./campaign-store.ts";
import type { ExplorerSnapshot } from "./model.ts";

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
    const campaign = this.#store.getSnapshot();
    const charting = this.#charting?.getViews().at(-1);
    const emptyProject = campaign.campaign.diagnostics.some(({ code }) => code === "map_missing");
    return {
      sequence: this.#sequence,
      projects: structuredClone(this.#projects),
      campaign: campaign.campaign,
      overlay: campaign.overlay,
      expeditions: this.#expeditions?.getViews() ?? [],
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
