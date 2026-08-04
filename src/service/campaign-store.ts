import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";

import {
  bindCampaignExpedition,
  openCampaignOverlay,
  setCampaignPlayerFocus,
} from "../overlay.ts";
import { inspectCampaignAs } from "../wayfinder.ts";
import type { CampaignSnapshot } from "./model.ts";

export interface CampaignStoreOptions {
  campaignRoot: string;
  campaignId?: string;
  dataRoot?: string;
  watch?: boolean;
  debounceMs?: number;
}

type SnapshotListener = (snapshot: CampaignSnapshot) => void;

/** Owns the authoritative M1 snapshot and serializes every source refresh. */
export class CampaignStore {
  readonly campaignRoot: string;
  readonly dataRoot?: string;

  #snapshot!: CampaignSnapshot;
  #listeners = new Set<SnapshotListener>();
  #watcher?: FSWatcher;
  #refreshTimer?: NodeJS.Timeout;
  #refreshChain: Promise<CampaignSnapshot | undefined> = Promise.resolve(undefined);
  #closed = false;
  #debounceMs: number;
  #campaignId?: string;

  private constructor(options: CampaignStoreOptions) {
    this.campaignRoot = path.resolve(options.campaignRoot);
    this.#campaignId = options.campaignId;
    this.dataRoot = options.dataRoot ? path.resolve(options.dataRoot) : undefined;
    this.#debounceMs = options.debounceMs ?? 140;
  }

  static async open(options: CampaignStoreOptions): Promise<CampaignStore> {
    const store = new CampaignStore(options);
    await store.#refresh(true);
    if (options.watch !== false) {
      await store.#startWatcher();
    }
    return store;
  }

  getSnapshot(): CampaignSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<CampaignSnapshot> {
    return this.#queueRefresh().then((snapshot) => snapshot ?? this.#snapshot);
  }

  bindExpedition(expeditionId: string, threadId: string): Promise<CampaignSnapshot> {
    this.#refreshChain = this.#refreshChain
      .catch(() => undefined)
      .then(async () => {
        if (this.#closed) {
          throw new Error("Campaign store is closed.");
        }
        const overlay = await bindCampaignExpedition(
          this.#snapshot.campaign,
          expeditionId,
          threadId,
          { dataRoot: this.dataRoot },
        );
        if (this.#snapshot.overlay.expeditionBindings[expeditionId] === threadId) {
          return this.#snapshot;
        }
        this.#snapshot = {
          ...this.#snapshot,
          sequence: this.#snapshot.sequence + 1,
          overlay,
        };
        this.#publish(this.#snapshot);
        return this.#snapshot;
      });
    return this.#refreshChain.then((snapshot) => snapshot ?? this.#snapshot);
  }

  setPlayerFocus(locationId: string): Promise<CampaignSnapshot> {
    this.#refreshChain = this.#refreshChain
      .catch(() => undefined)
      .then(async () => {
        if (this.#closed) {
          throw new Error("Campaign store is closed.");
        }
        if (!this.#snapshot.campaign.locations.some(({ id }) => id === locationId)) {
          throw new Error(`Campaign does not contain Location ${JSON.stringify(locationId)}.`);
        }
        const overlay = await setCampaignPlayerFocus(
          this.#snapshot.campaign,
          locationId,
          { dataRoot: this.dataRoot },
        );
        if (this.#snapshot.overlay.playerFocusId === locationId) {
          return this.#snapshot;
        }
        this.#snapshot = {
          ...this.#snapshot,
          sequence: this.#snapshot.sequence + 1,
          overlay,
        };
        this.#publish(this.#snapshot);
        return this.#snapshot;
      });
    return this.#refreshChain.then((snapshot) => snapshot ?? this.#snapshot);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    await this.#watcher?.close();
    this.#watcher = undefined;
    this.#listeners.clear();
    await this.#refreshChain.catch(() => undefined);
  }

  #queueRefresh(): Promise<CampaignSnapshot | undefined> {
    this.#refreshChain = this.#refreshChain
      .catch(() => undefined)
      .then(() => this.#refresh(false));
    return this.#refreshChain;
  }

  async #refresh(initial: boolean): Promise<CampaignSnapshot | undefined> {
    if (this.#closed) {
      return undefined;
    }
    const campaign = await inspectCampaignAs(this.campaignRoot, this.#campaignId);
    const overlayResult = await openCampaignOverlay(campaign, { dataRoot: this.dataRoot });
    if (!initial && campaign.revision === this.#snapshot.campaign.revision && !overlayResult.changed) {
      return this.#snapshot;
    }

    const snapshot: CampaignSnapshot = {
      sequence: initial ? 1 : this.#snapshot.sequence + 1,
      campaign,
      overlay: overlayResult.overlay,
    };
    this.#snapshot = snapshot;
    if (!initial) {
      this.#publish(snapshot);
    }
    return snapshot;
  }

  #publish(snapshot: CampaignSnapshot): void {
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken client must not interrupt source projection or other clients.
      }
    }
  }

  async #startWatcher(): Promise<void> {
    const watcher = chokidar.watch(
      [path.join(this.campaignRoot, "map.md"), path.join(this.campaignRoot, "issues")],
      {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,
          pollInterval: 20,
        },
      },
    );
    this.#watcher = watcher;

    watcher.on("all", () => {
      if (this.#closed) {
        return;
      }
      if (this.#refreshTimer) {
        clearTimeout(this.#refreshTimer);
      }
      this.#refreshTimer = setTimeout(() => {
        this.#refreshTimer = undefined;
        void this.#queueRefresh();
      }, this.#debounceMs);
    });

    await new Promise<void>((resolve, reject) => {
      watcher.once("ready", resolve);
      watcher.once("error", reject);
    });
  }
}
