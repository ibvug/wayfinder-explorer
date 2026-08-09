import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CampaignSnapshot,
  ConnectionState,
  ExpeditionActions,
  ExplorerBootstrap,
} from "./app-types.ts";
import type { ExpeditionView } from "../../src/expedition/model.ts";
import type { ChartingView } from "../../src/charting/model.ts";
import type { DirectoryPickerPurpose } from "../../src/project/directory-picker.ts";

interface CampaignResource {
  snapshot?: CampaignSnapshot;
  connection: ConnectionState;
  error?: string;
  actions: ExpeditionActions;
}

interface CampaignState {
  snapshot?: CampaignSnapshot;
  connection: ConnectionState;
  error?: string;
  actionBusyTarget?: string;
  actionError?: string;
}

export function useCampaign(): CampaignResource {
  const [resource, setResource] = useState<CampaignState>({
    connection: "connecting",
  });
  const sequence = useRef(0);
  const bootstrapRef = useRef<ExplorerBootstrap | undefined>(undefined);

  const setActionState = useCallback((busyTarget?: string, error?: string) => {
    setResource((current) => ({
      ...current,
      actionBusyTarget: busyTarget,
      actionError: error,
    }));
  }, []);

  const applySnapshot = useCallback((snapshot: CampaignSnapshot) => {
    if (snapshot.sequence < sequence.current) {
      return;
    }
    sequence.current = snapshot.sequence;
    setResource((current) => ({
      ...current,
      snapshot,
      error: undefined,
    }));
  }, []);

  const mergeExpedition = useCallback((expedition: ExpeditionView) => {
    setResource((current) => {
      if (!current.snapshot) {
        return current;
      }
      const expeditions = current.snapshot.expeditions.some(({ id }) => id === expedition.id)
        ? current.snapshot.expeditions.map((candidate) => candidate.id === expedition.id ? expedition : candidate)
        : [...current.snapshot.expeditions, expedition];
      return {
        ...current,
        snapshot: { ...current.snapshot, expeditions },
      };
    });
  }, []);

  const mergeCharting = useCallback((charting: ChartingView) => {
    setResource((current) => current.snapshot
      ? { ...current, snapshot: { ...current.snapshot, charting } }
      : current);
  }, []);

  const postExpedition = useCallback(async (
    target: string,
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    const bootstrap = bootstrapRef.current ?? readBootstrap();
    setActionState(target);
    try {
      const response = await apiFetch(endpoint, bootstrap, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotVersion: sequence.current, ...body }),
      });
      const payload = await response.json() as { expedition?: ExpeditionView; error?: string };
      if (!response.ok || !payload.expedition) {
        throw new Error(payload.error ?? `探索请求失败（${response.status}）`);
      }
      mergeExpedition(payload.expedition);
      setActionState();
    } catch (error) {
      setActionState(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [mergeExpedition, setActionState]);

  const postCharting = useCallback(async (
    target: string,
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    const bootstrap = bootstrapRef.current ?? readBootstrap();
    setActionState(target);
    try {
      const response = await apiFetch(endpoint, bootstrap, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotVersion: sequence.current, ...body }),
      });
      const payload = await response.json() as { charting?: ChartingView; error?: string };
      if (!response.ok || !payload.charting) {
        throw new Error(payload.error ?? `绘图请求失败（${response.status}）`);
      }
      mergeCharting(payload.charting);
      setActionState();
    } catch (error) {
      setActionState(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [mergeCharting, setActionState]);

  const postProject = useCallback(async (
    target: string,
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    const bootstrap = bootstrapRef.current ?? readBootstrap();
    setActionState(target);
    try {
      const response = await apiFetch(endpoint, bootstrap, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotVersion: sequence.current, ...body }),
      });
      const payload = await response.json() as { snapshot?: CampaignSnapshot; error?: string };
      if (!response.ok || !payload.snapshot) {
        throw new Error(payload.error ?? `项目请求失败（${response.status}）`);
      }
      applySnapshot(payload.snapshot);
      setActionState();
    } catch (error) {
      setActionState(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [applySnapshot, setActionState]);

  const selectDirectory = useCallback(async (purpose: DirectoryPickerPurpose) => {
    const bootstrap = bootstrapRef.current ?? readBootstrap();
    setActionState(`directory:${purpose}`);
    try {
      const response = await apiFetch(`${bootstrap.apiRoot}/system/select-directory`, bootstrap, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotVersion: sequence.current, purpose }),
      });
      const payload = await response.json() as { root?: string | null; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `文件夹选择失败（${response.status}）`);
      }
      setActionState();
      return payload.root ?? undefined;
    } catch (error) {
      setActionState(undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [setActionState]);

  const actions: ExpeditionActions = useMemo(() => ({
    busyTarget: resource.actionBusyTarget,
    error: resource.actionError,
    startCharting: () => postCharting(
      "charting:start",
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting`,
      {},
    ),
    sendChartingMessage: (chartingId, message) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/messages`,
      { message },
    ),
    confirmDestination: (chartingId, draftId) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/destination/confirm`,
      { draftId },
    ),
    confirmStartingPoint: (chartingId, draftId, evidenceVersion) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/starting-point/confirm`,
      { draftId, evidenceVersion },
    ),
    formMapProposal: (chartingId) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/proposal`,
      {},
    ),
    resumeMapProposal: (chartingId) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/proposal/resume`,
      {},
    ),
    previewMap: (chartingId, expectedSourceRevision) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/map-preview`,
      { expectedSourceRevision },
    ),
    confirmMap: (plan) => postCharting(
      `charting:${plan.chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/map-creations/${encodeURIComponent(plan.id)}/confirm`,
      {
        expectedSourceRevision: plan.expectedSourceRevision,
        proposalHash: plan.proposalHash,
      },
    ),
    interruptCharting: (chartingId) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/interrupt`,
      {},
    ),
    retryRechart: (chartingId) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/rechart/retry`,
      {},
    ),
    restoreRechartChange: (chartingId, changeId, locationId) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/rechart-changes/${encodeURIComponent(changeId)}/restore`,
      { locationId },
    ),
    resolveChartingApproval: (chartingId, approvalId, decision) => postCharting(
      `charting:${chartingId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/charting/${encodeURIComponent(chartingId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision },
    ),
    setPlayerFocus: (locationId) => postProject(
      `focus:${locationId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/player-focus`,
      { locationId },
    ),
    startExpedition: (locationId) => postExpedition(
      `location:${locationId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/locations/${encodeURIComponent(locationId)}/expeditions`,
      {},
    ),
    sendMessage: (expeditionId, message) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/messages`,
      { message },
    ),
    formProposal: (expeditionId) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/proposal`,
      {},
    ),
    deferProposal: (expeditionId) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/proposal/defer`,
      {},
    ),
    resumeProposal: (expeditionId) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/proposal/resume`,
      {},
    ),
    previewWriteback: (locationId, expeditionId, expectedSourceRevision) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/locations/${encodeURIComponent(locationId)}/writeback-preview`,
      { expeditionId, expectedSourceRevision },
    ),
    confirmWriteback: (plan) => postExpedition(
      `expedition:${plan.expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/writebacks/${encodeURIComponent(plan.id)}/confirm`,
      {
        expectedSourceRevision: plan.expectedSourceRevision,
        proposalHash: plan.proposalHash,
      },
    ),
    activateProject: (projectId) => postProject(
      `project:${projectId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/projects/${encodeURIComponent(projectId)}/activate`,
      {},
    ),
    createProject: (name, parentRoot) => postProject(
      "project:create",
      `${bootstrapRef.current?.apiRoot ?? "/api"}/projects`,
      { name, parentRoot },
    ),
    addProject: (root) => postProject(
      "project:add",
      `${bootstrapRef.current?.apiRoot ?? "/api"}/projects/add`,
      { root },
    ),
    relinkProject: (projectId, root) => postProject(
      `project:${projectId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/projects/${encodeURIComponent(projectId)}/relink`,
      { root },
    ),
    selectDirectory,
    interrupt: (expeditionId) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/interrupt`,
      {},
    ),
    endExpedition: (expeditionId) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/end`,
      {},
    ),
    resolveExpeditionApproval: (expeditionId, approvalId, decision) => postExpedition(
      `expedition:${expeditionId}`,
      `${bootstrapRef.current?.apiRoot ?? "/api"}/expeditions/${encodeURIComponent(expeditionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision },
    ),
    clearError: () => setActionState(),
  }), [postCharting, postExpedition, postProject, resource.actionBusyTarget, resource.actionError, selectDirectory, setActionState]);

  useEffect(() => {
    let bootstrap: ExplorerBootstrap;
    try {
      bootstrap = readBootstrap();
      bootstrapRef.current = bootstrap;
    } catch (error) {
      setResource((current) => ({
        ...current,
        connection: "reconnecting",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    const abortController = new AbortController();
    let active = true;

    const fetchSnapshot = async () => {
      const response = await apiFetch(bootstrap.campaignEndpoint, bootstrap, {
        signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error(`地图快照读取失败（${response.status}）`);
      }
      if (active) {
        applySnapshot((await response.json()) as CampaignSnapshot);
      }
    };

    const connect = async () => {
      await fetchSnapshot();
      while (active && !abortController.signal.aborted) {
        try {
          setResource((current) => ({ ...current, connection: "connecting" }));
          const response = await apiFetch(bootstrap.eventsEndpoint, bootstrap, {
            signal: abortController.signal,
            headers: { Accept: "text/event-stream" },
          });
          if (!response.ok || !response.body) {
            throw new Error(`地图事件连接失败（${response.status}）`);
          }
          setResource((current) => ({ ...current, connection: "live", error: undefined }));

          for await (const event of readEventStream(response.body, abortController.signal)) {
            const snapshot = JSON.parse(event.data) as CampaignSnapshot;
            if (sequence.current && snapshot.sequence > sequence.current + 1) {
              await fetchSnapshot();
            } else {
              applySnapshot(snapshot);
            }
          }
          if (!abortController.signal.aborted) {
            throw new Error("地图事件连接已结束");
          }
        } catch (error) {
          if (abortController.signal.aborted) {
            return;
          }
          setResource((current) => ({
            ...current,
            connection: "reconnecting",
            error: error instanceof Error ? error.message : String(error),
          }));
          await delay(1_200, abortController.signal);
        }
      }
    };

    void connect().catch((error: unknown) => {
      if (!active || abortController.signal.aborted) {
        return;
      }
      setResource((current) => ({
        ...current,
        connection: "reconnecting",
        error: error instanceof Error ? error.message : String(error),
      }));
    });

    return () => {
      active = false;
      abortController.abort();
    };
  }, [applySnapshot]);

  return { ...resource, actions };
}

function readBootstrap(): ExplorerBootstrap {
  const bootstrap = window.__WAYFINDER_BOOTSTRAP__;
  if (
    !bootstrap ||
    typeof bootstrap.apiToken !== "string" ||
    typeof bootstrap.campaignEndpoint !== "string" ||
    typeof bootstrap.eventsEndpoint !== "string"
    || typeof bootstrap.apiRoot !== "string"
  ) {
    throw new Error("Wayfinder 安全启动信息缺失，请从本地服务打开页面。");
  }
  return bootstrap;
}

function apiFetch(
  input: string,
  bootstrap: ExplorerBootstrap,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Wayfinder-Token", bootstrap.apiToken);
  return fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
}

interface ParsedEvent {
  event: string;
  data: string;
}

async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ParsedEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEvent(block);
        if (parsed) {
          yield parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(block: string): ParsedEvent | undefined {
  if (!block || block.startsWith(":")) {
    return undefined;
  }
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
