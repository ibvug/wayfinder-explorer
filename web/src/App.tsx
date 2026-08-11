import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  CodexServiceView,
  CodexConnectionState,
  ExpeditionState,
  ExpeditionView,
} from "../../src/expedition/model.ts";
import type { CampaignProjection, Location } from "../../src/model.ts";
import type {
  ChartingState,
  ChartingView,
} from "../../src/charting/model.ts";
import { canFormFirstMapProposal } from "../../src/charting/model.ts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequestView,
} from "../../src/codex/approval.ts";
import type {
  CampaignProjectIndex,
  CampaignProjectView,
} from "../../src/project/model.ts";
import { JourneyLog } from "./JourneyLog.tsx";
import { MarkdownText } from "./MarkdownText.ts";
import { MapWorld } from "./MapWorld.tsx";
import {
  chartingPhaseHeading,
  ChartingProgressSteps,
  START_CHARTING_ACTION_LABEL,
} from "./ChartingProgress.ts";
import { MessageComposer } from "./MessageComposer.ts";
import dialTicksUrl from "./dial-ticks.svg";
import type { ConnectionState, ExpeditionActions, Selection } from "./app-types.ts";
import {
  consumeProjectWheel,
  openableProjects,
  projectAfterStep,
  projectDialStep,
  wrapProjectIndex,
} from "./project-selector.ts";
import { useCampaign } from "./use-campaign.ts";
import { useModalDialog } from "./use-modal-dialog.ts";

export function App() {
  const { snapshot, connection, error, actions } = useCampaign();
  const [selection, setSelection] = useState<Selection>();
  const [logOpen, setLogOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectDrawerMode, setProjectDrawerMode] = useState<"create" | "add">();
  const [mobilePanel, setMobilePanel] = useState<"map" | "detail">("map");
  const lastCampaignId = useRef<string | undefined>(undefined);
  const lastLocationCount = useRef<number | undefined>(undefined);
  const closeLog = useCallback(() => setLogOpen(false), []);
  const closeProjects = useCallback(() => {
    setProjectsOpen(false);
    setProjectDrawerMode(undefined);
  }, []);
  const openProjects = useCallback((mode?: "create" | "add") => {
    setProjectDrawerMode(mode);
    setProjectsOpen(true);
  }, []);
  const select = useCallback((next: Selection) => {
    setSelection(next);
    setMobilePanel("detail");
    if (next.kind === "location") {
      void actions.setPlayerFocus(next.id).catch(() => undefined);
    }
  }, [actions]);

  useEffect(() => {
    if (!snapshot || snapshot.mode !== "campaign") {
      lastCampaignId.current = undefined;
      lastLocationCount.current = undefined;
      setSelection(undefined);
      setMobilePanel("map");
      return;
    }
    const campaignChanged = lastCampaignId.current !== snapshot.campaign.id;
    const mapWasJustCreated = lastLocationCount.current === 0 && snapshot.campaign.locations.length > 0;
    lastCampaignId.current = snapshot.campaign.id;
    lastLocationCount.current = snapshot.campaign.locations.length;
    if (campaignChanged || mapWasJustCreated) {
      setMobilePanel("map");
    }
    setSelection((current) => {
      if (campaignChanged || mapWasJustCreated) {
        return defaultSelection(snapshot.overlay.playerFocusId, snapshot.campaign);
      }
      if (
        current?.kind !== "location" ||
        snapshot.campaign.locations.some(({ id }) => id === current.id)
      ) {
        return current ?? defaultSelection(snapshot.overlay.playerFocusId, snapshot.campaign);
      }
      return defaultSelection(snapshot.overlay.playerFocusId, snapshot.campaign);
    });
  }, [snapshot]);

  if (!snapshot) {
    return <LoadingWorld error={error} />;
  }

  if (snapshot.mode === "library") {
    return (
      <main className="explorer-app explorer-app--library">
        <ProjectLaunchpad
          index={snapshot.projects}
          actions={actions}
          connection={connection}
          onContinue={(project) => {
            actions.clearError();
            void actions.activateProject(project.id).catch(() => undefined);
          }}
          onCreate={() => openProjects("create")}
          onOpenLibrary={() => openProjects()}
        />
        {projectsOpen ? (
          <ProjectDrawer
            index={snapshot.projects}
            actions={actions}
            initialMode={projectDrawerMode}
            onClose={closeProjects}
          />
        ) : null}
      </main>
    );
  }

  if (!selection) {
    return <LoadingWorld error={error} />;
  }

  const { campaign, overlay, expeditions, codex } = snapshot;
  const activeProject = snapshot.projects.projects.find(
    ({ id }) => id === snapshot.projects.activeProjectId,
  );
  const emptyProject = activeProject?.status === "empty";
  const pendingRechart = snapshot.charting?.pendingRechart ?? snapshot.charting?.rechartQueue[0];
  const destinationSummary = emptyProject
    ? snapshot.charting?.confirmedDestination?.content ??
      (snapshot.charting?.destinationDraft ? "目的地草案待确认" : "等待建立目的地")
    : campaign.destination;
  const progress = campaign.summary.total
    ? Math.round((campaign.summary.resolved / campaign.summary.total) * 100)
    : 0;

  return (
    <main className="explorer-app explorer-app--campaign">
      <header className="topbar">
        <button
          type="button"
          className="brand-block project-trigger"
          onClick={() => openProjects()}
          aria-haspopup="dialog"
          aria-expanded={projectsOpen}
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
          </span>
          <div>
            <p className="ui-eyebrow">WAYFINDER EXPLORER · 目标探索</p>
            <h1>{activeProject?.name ?? campaign.title}<i aria-hidden="true">⌄</i></h1>
          </div>
        </button>

        <button
          type="button"
          className="destination-summary"
          onClick={() => select({ kind: "destination" })}
          aria-label="查看完整目的地"
        >
          <span>目的地</span>
          <strong>{destinationSummary}</strong>
        </button>

        <div className="topbar__actions">
          <div className="progress-readout" aria-label={`目标探索进度 ${campaign.summary.resolved} / ${campaign.summary.total}`}>
            <span
              className="progress-readout__ring"
              style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}
              aria-hidden="true"
            />
            <span>
              <strong>{campaign.summary.resolved}</strong>
              <small>/ {campaign.summary.total}</small>
            </span>
          </div>
          <button type="button" className="log-button" onClick={() => setLogOpen(true)}>
            <span className="log-button__glyph" aria-hidden="true">≡</span>
            探索总览
          </button>
        </div>
      </header>

      <div className="campaign-status-stack">
        {campaign.summary.blockingDiagnostics > 0 && !emptyProject ? (
          <div className="diagnostic-banner" role="status">
            源地图有 {campaign.summary.blockingDiagnostics} 个阻塞诊断；地图仍可查看，但语义操作已冻结。
          </div>
        ) : null}

        {pendingRechart && snapshot.charting ? (
          <div className="rechart-status" role="status">
            <div className="rechart-banner">
              <span>
                {pendingRechart.triggerKind === "exploration_ended"
                  ? `议题 ${pendingRechart.confirmedLocationId} 已由认领者结束；Map Agent 正在保留未完成历史并协调其余地图。`
                  : `答案 ${pendingRechart.confirmedLocationId} 已确认；Map Agent 正在按顺序更新其余地图。`}
                在重绘成功前不能从旧前沿开始新探索；后续确认会按顺序排队。
                {snapshot.charting.rechartQueue.length
                  ? `另有 ${snapshot.charting.rechartQueue.length} 个已确认答案正在排队。`
                  : ""}
              </span>
              {snapshot.charting.state === "rechart_failed" ? (
                <button
                  type="button"
                  onClick={() => void actions.retryRechart(snapshot.charting!.id).catch(() => undefined)}
                  disabled={actions.busyTarget === `charting:${snapshot.charting.id}`}
                >
                  {actions.busyTarget === `charting:${snapshot.charting.id}` ? "正在重试…" : "重试重绘"}
                </button>
              ) : null}
            </div>
            {snapshot.charting.approvalRequest ? (
              <ToolApprovalCard
                request={snapshot.charting.approvalRequest}
                busy={actions.busyTarget === `charting:${snapshot.charting.id}`}
                onDecision={(decision) => void actions.resolveChartingApproval(
                  snapshot.charting!.id,
                  snapshot.charting!.approvalRequest!.id,
                  decision,
                ).catch(() => undefined)}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {emptyProject && activeProject ? (
        <EmptyProjectStage
          project={activeProject}
          campaign={campaign}
          charting={snapshot.charting}
          codex={codex}
          actions={actions}
        />
      ) : (
        <div className={`workspace workspace--${mobilePanel}`}>
          <nav className="workspace-switcher" aria-label="工作区视图">
            <button
              type="button"
              className={mobilePanel === "map" ? "is-active" : ""}
              aria-pressed={mobilePanel === "map"}
              onClick={() => setMobilePanel("map")}
            >
              地图
            </button>
            <button
              type="button"
              className={mobilePanel === "detail" ? "is-active" : ""}
              aria-pressed={mobilePanel === "detail"}
              onClick={() => setMobilePanel("detail")}
            >
              当前详情
            </button>
            <button
              type="button"
              className="workspace-switcher__destination"
              onClick={() => select({ kind: "destination" })}
            >
              目的地
            </button>
          </nav>
          <MapWorld
            campaign={campaign}
            overlay={overlay}
            selection={selection}
            onSelect={select}
          />
          <ThinkingStage
            campaign={campaign}
            selection={selection}
            connection={connection}
            connectionError={error}
            expeditions={expeditions}
            charting={snapshot.charting}
            codex={codex}
            actions={actions}
            explorationBlocked={pendingRechart ? "Map Agent 尚未完成上一次确认后的重绘。" : undefined}
            onSelect={select}
          />
        </div>
      )}

      {logOpen ? (
        <JourneyLog campaign={campaign} onClose={closeLog} onSelect={select} />
      ) : null}
      {projectsOpen ? (
        <ProjectDrawer
          index={snapshot.projects}
          actions={actions}
          initialMode={projectDrawerMode}
          onClose={closeProjects}
        />
      ) : null}
    </main>
  );
}

export function ProjectLaunchpad({
  index,
  actions,
  connection,
  onContinue,
  onOpenLibrary,
}: {
  index: CampaignProjectIndex;
  actions: ExpeditionActions;
  connection: ConnectionState;
  onContinue(project: CampaignProjectView): void;
  onCreate(): void;
  onOpenLibrary(): void;
}) {
  const projects = useMemo(
    () => openableProjects(index.projects),
    [index.projects],
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(() => projects[0]?.id);
  const [dialStep, setDialStep] = useState(0);
  const [motionDirection, setMotionDirection] = useState<-1 | 0 | 1>(0);
  const [motionRevision, setMotionRevision] = useState(0);
  const selector = useRef<HTMLDivElement>(null);
  const wheelAccumulator = useRef(0);
  const wheelResetTimer = useRef<number | undefined>(undefined);
  const touchStartY = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);

  useEffect(() => {
    if (selectedProjectId && projects.some(({ id }) => id === selectedProjectId)) {
      return;
    }
    setSelectedProjectId(projects[0]?.id);
  }, [projects, selectedProjectId]);

  const selectedIndex = Math.max(0, projects.findIndex(({ id }) => id === selectedProjectId));
  const selectedProject = projects[selectedIndex];
  const busy = Boolean(actions.busyTarget?.startsWith("project:"));

  const stepSelection = useCallback((delta: number) => {
    if (projects.length < 2 || delta === 0) {
      return;
    }
    setSelectedProjectId((currentId) => {
      return projectAfterStep(projects, currentId, delta)?.id;
    });
    setDialStep((current) => current + projectDialStep(delta));
    setMotionDirection(delta > 0 ? 1 : -1);
    setMotionRevision((current) => current + 1);
  }, [projects]);

  useEffect(() => {
    const element = selector.current;
    if (!element || projects.length < 2) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        return;
      }
      event.preventDefault();
      const normalizedDelta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * element.clientHeight
          : event.deltaY;
      const wheel = consumeProjectWheel(wheelAccumulator.current, normalizedDelta);
      wheelAccumulator.current = wheel.accumulator;
      if (wheel.steps !== 0) {
        stepSelection(wheel.steps);
      }
      window.clearTimeout(wheelResetTimer.current);
      wheelResetTimer.current = window.setTimeout(() => {
        wheelAccumulator.current = 0;
      }, 160);
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      window.clearTimeout(wheelResetTimer.current);
    };
  }, [projects.length, stepSelection]);

  const handleSelectorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      stepSelection(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      stepSelection(1);
    } else if (event.key === "PageUp") {
      event.preventDefault();
      stepSelection(-Math.min(3, projects.length - 1));
    } else if (event.key === "PageDown") {
      event.preventDefault();
      stepSelection(Math.min(3, projects.length - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      stepSelection(-selectedIndex);
    } else if (event.key === "End") {
      event.preventDefault();
      stepSelection(projects.length - selectedIndex - 1);
    } else if ((event.key === "Enter" || event.key === " ") && selectedProject && !busy) {
      event.preventDefault();
      onContinue(selectedProject);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || projects.length < 2) {
      return;
    }
    touchStartY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const startY = touchStartY.current;
    touchStartY.current = undefined;
    if (startY === undefined) {
      return;
    }
    const distance = startY - event.clientY;
    if (Math.abs(distance) < 32) {
      return;
    }
    suppressClick.current = true;
    stepSelection(distance > 0 ? 1 : -1);
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const slotOffsets = projects.length > 2 ? [-1, 0, 1] : projects.length === 2 ? [0, 1] : [0];
  const activeOptionId = selectedProject ? `project-launchpad-option-${selectedIndex}` : undefined;
  const dialStyle = {
    "--project-tick-turn": `${dialStep * -0.75}deg`,
    "--project-gear-turn": `${dialStep * 4.25}deg`,
    "--project-turn": `${dialStep * 3}deg`,
    "--project-counter-turn": `${dialStep * -1.75}deg`,
    "--project-inner-turn": `${dialStep}deg`,
  } as React.CSSProperties;

  return (
    <section className="project-launchpad" aria-label="Wayfinder 目标探索入口">
      <header className="project-launchpad__header">
        <button
          type="button"
          className="project-launchpad__brand"
          onClick={onOpenLibrary}
          aria-label="管理目标探索"
        >
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <p className="ui-eyebrow" aria-label="WAYFINDER">
            {[..."WAYFINDER"].map((letter, index) => (
              <span key={`${letter}-${index}`} aria-hidden="true">{letter}</span>
            ))}
          </p>
        </button>
        {connection !== "live" ? (
          <div className={`project-launchpad__status project-launchpad__status--${connection}`}>
            <i aria-hidden="true" />正在连接
          </div>
        ) : null}
      </header>

      <div className="project-launchpad__content" style={dialStyle}>
        <div className="project-launchpad__beacon" aria-hidden="true">
          <img className="project-launchpad__gear-ticks" src={dialTicksUrl} alt="" />
          <span className="project-launchpad__gear-drive" />
          <span className="project-launchpad__axis project-launchpad__axis--north"><i /></span>
          <span className="project-launchpad__axis project-launchpad__axis--south"><i /></span>
          <span className="project-launchpad__orbit project-launchpad__orbit--outer"><i /></span>
          <span className="project-launchpad__orbit project-launchpad__orbit--middle"><i /></span>
          <span className="project-launchpad__orbit project-launchpad__orbit--inner"><i /></span>
          <span className="project-launchpad__cardinals" />
          <span className="project-launchpad__dial-index"><i /></span>
          <b><i /></b>
        </div>

        <div className="project-launchpad__mission">
          {selectedProject ? (
            <>
              <div
                ref={selector}
                className="project-launchpad__reel"
                role="listbox"
                tabIndex={0}
                aria-activedescendant={activeOptionId}
                aria-label={`目标探索选择器，当前 ${selectedProject.name}`}
                aria-busy={busy}
                data-direction={motionDirection > 0 ? "next" : motionDirection < 0 ? "previous" : "idle"}
                onKeyDown={handleSelectorKeyDown}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerCancel={() => {
                  touchStartY.current = undefined;
                }}
              >
                {slotOffsets.map((offset) => {
                  const projectIndex = wrapProjectIndex(selectedIndex + offset, projects.length);
                  const project = projects[projectIndex]!;
                  const current = offset === 0;
                  const position = current ? "current" : offset < 0 ? "previous" : "next";
                  const resolved = project.resolved ?? 0;
                  return (
                    <button
                      key={`${motionRevision}:${position}:${project.id}`}
                      id={`project-launchpad-option-${projectIndex}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={current}
                      aria-label={current ? `打开目标探索 ${project.name}` : `选择目标探索 ${project.name}`}
                      className="project-launchpad__reel-item"
                      data-position={position}
                      disabled={busy}
                      onClick={() => {
                        if (suppressClick.current) {
                          return;
                        }
                        if (current) {
                          onContinue(project);
                        } else {
                          selector.current?.focus();
                          stepSelection(offset);
                        }
                      }}
                    >
                      <span className={`project-launchpad__reel-sigil project-launchpad__reel-sigil--${project.status}`} aria-hidden="true"><i /></span>
                      <span className="project-launchpad__reel-copy">
                        <strong>{project.name}</strong>
                        {current ? (
                          <small>
                            <span>{projectStatusLabel(project)}</span>
                            <span>{project.total !== undefined ? `${resolved} / ${project.total}` : "可继续"}</span>
                          </small>
                        ) : null}
                      </span>
                      {current ? (
                        <span className="project-launchpad__reel-arrow" aria-hidden="true">
                          {actions.busyTarget === `project:${project.id}` ? "…" : "→"}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div className="project-launchpad__position" aria-live="polite">
                <i aria-hidden="true" />
                <span>{selectedIndex + 1} / {projects.length}</span>
                <i aria-hidden="true" />
              </div>
            </>
          ) : (
            <div className="project-launchpad__empty-selector">
              <span aria-hidden="true"><i /></span>
              <strong>还没有可打开的目标探索</strong>
              <small>新建目标探索，或重新关联已有目录。</small>
            </div>
          )}

          {actions.error ? (
            <button type="button" className="project-launchpad__error" onClick={actions.clearError}>
              {actions.error}<span>关闭</span>
            </button>
          ) : null}
        </div>

      </div>

    </section>
  );
}

function ProjectDrawer({
  index,
  actions,
  initialMode,
  onClose,
}: {
  index: CampaignProjectIndex;
  actions: ExpeditionActions;
  initialMode?: "create" | "add";
  explorationBlocked?: string;
  onClose(): void;
}) {
  const [mode, setMode] = useState<"create" | "add" | "relink" | undefined>(initialMode);
  const [targetProject, setTargetProject] = useState<CampaignProjectView>();
  const [releaseProject, setReleaseProject] = useState<CampaignProjectView>();
  const [releasedProject, setReleasedProject] = useState<CampaignProjectView>();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const rootInput = useRef<HTMLInputElement>(null);
  const dialog = useModalDialog<HTMLElement>({ onClose, initialFocus: closeButton });
  const busy = Boolean(
    actions.busyTarget?.startsWith("project:") ||
    actions.busyTarget?.startsWith("directory:"),
  );
  const choosingDirectory = actions.busyTarget?.startsWith("directory:");

  useEffect(() => {
    if (!releasedProject) {
      return;
    }
    const timer = setTimeout(() => setReleasedProject(undefined), 4_200);
    return () => clearTimeout(timer);
  }, [releasedProject]);

  useEffect(() => {
    if (mode === "create") {
      nameInput.current?.focus();
    } else if (mode === "add" || mode === "relink") {
      rootInput.current?.focus();
    } else {
      closeButton.current?.focus();
    }
  }, [mode]);

  const resetForm = () => {
    setMode(undefined);
    setTargetProject(undefined);
    setReleaseProject(undefined);
    setReleasedProject(undefined);
    setName("");
    setRoot("");
  };

  const chooseDirectory = async (purpose: "create-parent" | "add-project" | "relink-project") => {
    actions.clearError();
    try {
      const selected = await actions.selectDirectory(purpose);
      if (selected) {
        setRoot(selected);
      }
      return selected;
    } catch {
      return undefined;
    }
  };

  const beginAdd = () => {
    setMode("add");
    setTargetProject(undefined);
    setReleaseProject(undefined);
    setReleasedProject(undefined);
    setName("");
    setRoot("");
    void (async () => {
      const selected = await chooseDirectory("add-project");
      if (!selected) {
        return;
      }
      try {
        await actions.addProject(selected);
        onClose();
      } catch {
        // The project form remains open with the selected path and the shared error message.
      }
    })();
  };

  const selectProject = (project: CampaignProjectView) => {
    if (project.id === index.activeProjectId) {
      onClose();
      return;
    }
    if (project.status === "missing") {
      setMode("relink");
      setTargetProject(project);
      setName("");
      setRoot(project.root);
      return;
    }
    actions.clearError();
    void actions.activateProject(project.id).then(onClose).catch(() => undefined);
  };

  const beginRelease = (project: CampaignProjectView) => {
    actions.clearError();
    setMode(undefined);
    setTargetProject(undefined);
    setReleaseProject(project);
    setReleasedProject(undefined);
    setName("");
    setRoot("");
  };

  const release = async (project: CampaignProjectView) => {
    const wasActive = project.id === index.activeProjectId;
    await actions.removeProject(project.id);
    if (wasActive) {
      onClose();
      return;
    }
    setReleaseProject(undefined);
    setReleasedProject(project);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedRoot = root.trim();
    if (
      !mode ||
      !normalizedRoot ||
      (mode === "create" && !normalizedName) ||
      busy
    ) {
      return;
    }
    actions.clearError();
    const operation = mode === "create"
      ? actions.createProject(normalizedName, normalizedRoot)
      : mode === "add"
        ? actions.addProject(normalizedRoot)
        : targetProject
          ? actions.relinkProject(targetProject.id, normalizedRoot)
          : Promise.reject(new Error("没有需要重新关联的目标探索。"));
    void operation.then(onClose).catch(() => undefined);
  };

  const drawerTitle = mode === "create"
    ? "新建目标探索"
    : mode === "add"
      ? "打开本地目标探索"
      : mode === "relink"
        ? "重新关联目标探索"
        : index.activeProjectId
          ? "切换目标探索"
          : "选择目标探索";

  return (
    <div className="project-drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) {
        onClose();
      }
    }}>
      <section
        ref={dialog}
        className={`project-drawer${mode ? " project-drawer--form" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={drawerTitle}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="ui-eyebrow">WAYFINDER</p>
            <h2>{drawerTitle}</h2>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭目标探索">×</button>
        </header>

        {!mode ? <div className="project-list">
          {index.projects.map((project) => {
            const active = project.id === index.activeProjectId;
            const armed = releaseProject?.id === project.id;
            return (
              <div
                className={`project-list__item${active ? " is-active" : ""}${armed ? " is-armed" : ""}`}
                key={project.id}
              >
                {armed ? (
                  <ProjectReleaseConsole
                    project={project}
                    busy={actions.busyTarget === `project:${project.id}:remove`}
                    returnToLibrary={active}
                    onCancel={() => setReleaseProject(undefined)}
                    onConfirm={() => release(project)}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="project-list__open"
                      onClick={() => selectProject(project)}
                      disabled={busy}
                    >
                      <span className={`project-list__sigil project-list__sigil--${project.status}`} aria-hidden="true"><i /></span>
                      <span className="project-list__copy">
                        <strong>{project.name}</strong>
                        <small>{project.root}</small>
                      </span>
                      <span className="project-list__meta">
                        <b>{projectStatusLabel(project)}</b>
                        {project.total !== undefined ? <small>{project.resolved ?? 0}/{project.total}</small> : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="project-list__release-trigger"
                      onClick={() => beginRelease(project)}
                      disabled={busy}
                      aria-label={active
                        ? `删除当前目标探索「${project.name}」并返回目标探索入口`
                        : `删除目标探索「${project.name}」并移到废纸篓`}
                      title={active
                        ? "删除并返回目标探索入口"
                        : "删除并移到废纸篓"}
                    >
                      <span aria-hidden="true"><i /><b /></span>
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div> : null}

        {!mode && releasedProject ? (
          <div className="project-release-toast" role="status">
            <span aria-hidden="true"><i /></span>
            <p>
              <strong>目标探索已移入废纸篓</strong>
              「{releasedProject.name}」的目录已移入系统废纸篓。
            </p>
          </div>
        ) : null}

        {!mode && actions.error ? <p className="project-drawer__error">{actions.error}</p> : null}

        {mode ? (
          <form className="project-create-form" onSubmit={submit}>
            {actions.error ? <p className="project-drawer__error">{actions.error}</p> : null}
            {mode === "create" ? (
              <div className="project-create-form__field">
                <label htmlFor="project-name">目标探索名称</label>
                <input
                  ref={nameInput}
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：新产品决策地图"
                  autoFocus
                  disabled={busy}
                />
              </div>
            ) : null}

            <div className="project-create-form__field">
              <label htmlFor="project-root">
                {mode === "create"
                  ? "保存位置"
                  : mode === "add"
                    ? "目标探索文件夹"
                    : `「${targetProject?.name}」的新位置`}
              </label>
              <div className="project-path-picker">
                <input
                  ref={rootInput}
                  id="project-root"
                  value={root}
                  onChange={(event) => setRoot(event.target.value)}
                  placeholder="输入父目录的绝对路径"
                  autoFocus={mode !== "create"}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="project-path-picker__button"
                  onClick={() => void chooseDirectory(
                    mode === "create" ? "create-parent" : mode === "add" ? "add-project" : "relink-project",
                  )}
                  disabled={busy}
                >
                  {choosingDirectory ? "等待选择…" : "选择文件夹"}
                </button>
              </div>
              {mode === "create" && root.trim() && name.trim() ? (
                <small className="project-create-form__preview">
                  将创建：{projectPreviewPath(root, name)}
                </small>
              ) : (
                <small className="project-create-form__hint">
                  {mode === "create"
                    ? "地图与探索记录保存在新建目录；目标探索列表保存在本机。"
                    : "选择包含 map.md 与 issues/ 的 Wayfinder 目标探索文件夹，也可以手动输入路径。"}
                </small>
              )}
            </div>
            <div className="project-create-form__actions">
              <button type="button" onClick={resetForm}>取消</button>
              <button
                type="submit"
                disabled={!root.trim() || (mode === "create" && !name.trim()) || busy}
              >
                {busy && !choosingDirectory
                  ? "正在打开…"
                  : mode === "create"
                    ? "创建并打开"
                    : mode === "add"
                      ? "添加并打开"
                      : "重新关联"}
              </button>
            </div>
          </form>
        ) : (
          <footer>
            <button type="button" onClick={() => {
              setMode("create");
              setReleaseProject(undefined);
              setName("");
              setRoot("");
            }}>
              <span aria-hidden="true">＋</span> 新建目标探索
            </button>
            <button type="button" onClick={beginAdd} disabled={busy}>
              打开本地目标探索
            </button>
            {index.activeProjectId ? (
              <button
                type="button"
                className="project-drawer__stand-down"
                onClick={() => {
                  actions.clearError();
                  void actions.deactivateProject().then(onClose).catch(() => undefined);
                }}
                disabled={busy}
              >
                返回目标探索入口
              </button>
            ) : null}
          </footer>
        )}
      </section>
    </div>
  );
}

const PROJECT_RELEASE_HOLD_MS = 1_200;
const PROJECT_RELEASE_SEQUENCE_MS = 460;

function ProjectReleaseConsole({
  project,
  busy,
  returnToLibrary,
  onCancel,
  onConfirm,
}: {
  project: CampaignProjectView;
  busy: boolean;
  returnToLibrary: boolean;
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "holding" | "releasing">("idle");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const committed = useRef(false);

  const cancelHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
    }
    if (!committed.current) {
      setPhase("idle");
    }
  };

  const commit = async () => {
    if (committed.current || busy) {
      return;
    }
    committed.current = true;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
    }
    setPhase("releasing");
    try {
      await new Promise((resolve) => setTimeout(resolve, PROJECT_RELEASE_SEQUENCE_MS));
      await onConfirm();
    } catch {
      committed.current = false;
      setPhase("idle");
    }
  };

  const startHold = () => {
    if (phase !== "idle" || busy || committed.current) {
      return;
    }
    setPhase("holding");
    holdTimer.current = setTimeout(() => void commit(), PROJECT_RELEASE_HOLD_MS);
  };

  useEffect(() => () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
    }
  }, []);

  return (
    <div
      className={`project-release-console project-release-console--${phase} project-release-console--trash`}
      aria-label={`删除目标探索「${project.name}」并移到废纸篓`}
    >
      <div className="project-release-console__radar" aria-hidden="true">
        <i />
        <b />
        <span />
      </div>
      <div className="project-release-console__copy">
        <small>DELETE · 移入系统废纸篓</small>
        <strong>删除「{project.name}」？</strong>
        <p>{returnToLibrary
          ? "系统会关闭当前会话并返回目标探索入口；随后整个目录将移入废纸篓。"
          : "该目录、地图与探索记录将一起移入系统废纸篓，之后仍可恢复。"}</p>
        <code>{project.root}</code>
      </div>
      <div className="project-release-console__actions">
        <button
          type="button"
          className="project-release-console__cancel"
          onClick={() => { cancelHold(); onCancel(); }}
          disabled={busy || phase === "releasing"}
        >
          取消
        </button>
        <button
          type="button"
          className={`project-release-console__hold${phase === "holding" ? " is-holding" : ""}`}
          style={{ "--release-hold": `${PROJECT_RELEASE_HOLD_MS}ms` } as React.CSSProperties}
          onPointerDown={(event) => { event.preventDefault(); startHold(); }}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === " ") {
              event.preventDefault();
              startHold();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === " ") {
              event.preventDefault();
              cancelHold();
            }
          }}
          disabled={busy || phase === "releasing"}
          aria-label="鼠标或触控按住 1.2 秒删除并移到废纸篓；键盘按 Enter 确认"
          aria-busy={busy || phase === "releasing"}
        >
          <span className="project-release-console__hold-track" aria-hidden="true"><i /></span>
          <span className="project-release-console__hold-label">
            {phase === "releasing" || busy
              ? "正在移入废纸篓…"
              : phase === "holding"
                ? "保持按住…"
                : "按住删除 · 1.2s"}
          </span>
        </button>
      </div>
      <p className="project-release-console__hint">鼠标或触控按住完成 · 键盘按 Enter 确认</p>
    </div>
  );
}

function EmptyProjectStage({
  project,
  campaign,
  charting,
  codex,
  actions,
}: {
  project: CampaignProjectView;
  campaign: CampaignProjection;
  charting?: ChartingView;
  codex: CodexServiceView;
  actions: ExpeditionActions;
}) {
  return (
    <section className="empty-project-stage">
      <div className="empty-project-stage__intro">
        <div className="empty-project-stage__compass" aria-hidden="true"><i /></div>
        <p className="ui-eyebrow">MAP AGENT · 初始绘图</p>
        <h2>先建立目的地，再建立起点</h2>
        <p>
          这里还没有 `map.md`。地图 Agent 会先与你建立目的地，再围绕目的地建立起点；探索背景、可作为证据的资料和必要的定向核对都属于建立起点的连续对话。两端建立后，才会记录当前能够明确表达的待探索议题、迷雾与范围边界。首张地图只有起点和目的地两个节点，不会预先虚构路线。
        </p>
        <div className="empty-project-stage__path">
          <span>目标探索目录</span>
          <code>{project.root}</code>
        </div>
        <ChartingProgressSteps phase={charting?.phase ?? "destination"} />
      </div>
      <ChartingPanel
        campaign={campaign}
        charting={charting}
        codex={codex}
        actions={actions}
      />
    </section>
  );
}

function ChartingPanel({
  campaign,
  charting,
  codex,
  actions,
}: {
  campaign: CampaignProjection;
  charting?: ChartingView;
  codex: CodexServiceView;
  actions: ExpeditionActions;
}) {
  const [draft, setDraft] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const busyTarget = charting ? `charting:${charting.id}` : "charting:start";
  const busy = actions.busyTarget === busyTarget;
  const canReply = charting?.state === "awaiting_player" || charting?.state === "failed";
  const canFormProposal = Boolean(charting && canFormFirstMapProposal(charting));

  useEffect(() => {
    const element = transcript.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [charting?.messages.length, charting?.streamingMessage?.text]);

  const submit = () => {
    const message = draft.trim();
    if (!charting || !message || busy) {
      return;
    }
    setDraft("");
    actions.clearError();
    void actions.sendChartingMessage(charting.id, message).catch(() => setDraft(message));
  };

  return (
    <article className="charting-panel" aria-label="Wayfinder 地图 Agent 会话">
      <header className="expedition-panel__header">
        <div>
          <p className="expedition-panel__eyebrow"><span aria-hidden="true" /> MAP AGENT · CHARTING</p>
          <h3>{charting ? chartingPhaseHeading(charting.phase) : "从一个目标开始探索"}</h3>
        </div>
        <ChartingStateBadge codex={codex} charting={charting} />
      </header>

      {!charting ? (
        <div className="expedition-launch">
          <p>开始后会建立一个可持续、可恢复的地图 Agent 会话。只有你审阅草案、预览地图变化并明确确认后，Explorer 才会创建 Markdown。</p>
          <button
            type="button"
            className="expedition-launch__button"
            onClick={() => void actions.startCharting().catch(() => undefined)}
            disabled={busy}
          >
            <span aria-hidden="true">✦</span>{busy ? "正在连接地图 Agent…" : START_CHARTING_ACTION_LABEL}
          </button>
          {codex.state !== "ready" ? <small>{codex.error ?? "点击后会尝试连接本机 Codex。"}</small> : null}
          {actions.error ? (
            <button type="button" className="expedition-action-error" onClick={actions.clearError}>
              {actions.error}<span>关闭</span>
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="expedition-transcript charting-transcript" ref={transcript} aria-live="polite">
            {charting.messages.map((message) => (
              <article className={`expedition-message expedition-message--${message.role}`} key={message.id}>
                <span>{message.role === "guide" ? "MAP AGENT" : "你"}</span>
                <MarkdownText markdown={message.text} />
              </article>
            ))}
            {charting.streamingMessage ? (
              <article className="expedition-message expedition-message--guide is-streaming">
                <span>MAP AGENT</span><MarkdownText markdown={charting.streamingMessage.text} streaming />
              </article>
            ) : null}
            {(charting.state === "exploring" || charting.state === "reconciling" || charting.state === "returning") &&
            !charting.streamingMessage ? (
              <div className="expedition-thinking">
                <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
                {charting.state === "reconciling"
                  ? "正在找回原来的绘图会话"
                  : charting.state === "returning"
                    ? "地图 Agent 正在整理首张地图草案"
                    : "地图 Agent 正在确认当前地貌"}
              </div>
            ) : null}
          </div>

          {charting.error ? <p className="expedition-error">{charting.error}</p> : null}
          {actions.error ? (
            <button type="button" className="expedition-action-error" onClick={actions.clearError}>
              {actions.error}<span>关闭</span>
            </button>
          ) : null}

          {charting.approvalRequest ? (
            <ToolApprovalCard
              request={charting.approvalRequest}
              busy={busy}
              onDecision={(decision) => void actions.resolveChartingApproval(
                charting.id,
                charting.approvalRequest!.id,
                decision,
              ).catch(() => undefined)}
            />
          ) : null}

          <ChartingEndpointCards
            charting={charting}
            busy={busy}
            canConfirm={canReply}
            onConfirmDestination={(draftId) => void actions.confirmDestination(
              charting.id,
              draftId,
            ).catch(() => undefined)}
            onConfirmStartingPoint={(draftId, evidenceVersion) => void actions.confirmStartingPoint(
              charting.id,
              draftId,
              evidenceVersion,
            ).catch(() => undefined)}
          />

          {charting.proposal && (charting.state === "returned" || charting.state === "previewing") ? (
            <MapProposalCard
              charting={charting}
              busy={busy}
              onResume={() => void actions.resumeMapProposal(charting.id).catch(() => undefined)}
              onPreview={() => void actions.previewMap(charting.id, campaign.revision).catch(() => undefined)}
              onConfirm={() => charting.creationPlan
                ? void actions.confirmMap(charting.creationPlan).catch(() => undefined)
                : undefined}
            />
          ) : null}

          {canReply ? (
            <MessageComposer
              id={`charting-reply-${charting.id}`}
              label="你的回答"
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              placeholder="写下你的目标、边界、反例或担心混淆的地方…"
              context="继续同一个地图 Agent 会话"
              disabled={busy}
              busy={busy}
              secondaryAction={canFormProposal ? (
                <button
                  type="button"
                  className="is-secondary"
                  onClick={() => void actions.formMapProposal(charting.id).catch(() => undefined)}
                  disabled={busy}
                >
                  形成首张地图草案
                </button>
              ) : undefined}
            />
          ) : charting.state === "exploring" || charting.state === "awaiting_approval" || charting.state === "returning" ? (
            <div className="expedition-running">
              <span>{charting.state === "returning" ? "正在形成可审阅的首张地图草案" : "等待地图 Agent 完成本轮"}</span>
              {charting.activeTurnId && charting.state !== "returning" ? (
                <button
                  type="button"
                  onClick={() => void actions.interruptCharting(charting.id).catch(() => undefined)}
                  disabled={busy}
                >停止本轮</button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function ChartingEndpointCards({
  charting,
  busy,
  canConfirm,
  onConfirmDestination,
  onConfirmStartingPoint,
}: {
  charting: ChartingView;
  busy: boolean;
  canConfirm: boolean;
  onConfirmDestination(draftId: string): void;
  onConfirmStartingPoint(draftId: string, evidenceVersion: string): void;
}) {
  const destination = charting.confirmedDestination;
  const startingPoint = charting.confirmedStartingPoint;
  const destinationDraft = !destination ? charting.destinationDraft : undefined;
  const startingPointDraft = destination && !startingPoint ? charting.startingPointDraft : undefined;
  if (!destination && !destinationDraft && !startingPointDraft) {
    return null;
  }
  return (
    <section className="endpoint-cards" aria-label="目的地与起点">
      {destination ? (
        <article className="endpoint-card is-confirmed">
          <header><span>目的地</span><b>已确认</b></header>
          <MarkdownText markdown={destination.content} />
        </article>
      ) : destinationDraft ? (
        <article className="endpoint-card is-draft">
          <header><span>目的地草案</span><b>等待你的明确确认</b></header>
          <MarkdownText markdown={destinationDraft.content} />
          <div className="proposal-actions">
            <button type="button" className="writeback-confirm" onClick={() =>
              onConfirmDestination(destinationDraft.id)} disabled={busy || !canConfirm}>
              {busy ? "正在保存目的地…" : "确认目的地"}
            </button>
          </div>
        </article>
      ) : null}

      {startingPoint ? (
        <article className="endpoint-card is-confirmed">
          <header><span>起点</span><b>已确认并冻结</b></header>
          <MarkdownText markdown={startingPoint.summary} />
          <details className="proposal-details">
            <summary>查看形成依据与证据版本</summary>
            <ProposalDetail label="取证范围" items={startingPoint.evidenceScope} />
            <ProposalDetail label="项目内证据" items={startingPoint.evidencePaths} />
            <ProposalDetail label="对话证据" items={startingPoint.evidenceRefs} />
            <p><small>证据版本：{startingPoint.evidenceVersion}</small></p>
          </details>
        </article>
      ) : startingPointDraft ? (
        <article className="endpoint-card is-draft">
          <header><span>起点草案</span><b>等待你的明确确认</b></header>
          <MarkdownText markdown={startingPointDraft.summary} />
          <details className="proposal-details">
            <summary>查看形成依据与证据版本</summary>
            <ProposalDetail label="取证范围" items={startingPointDraft.evidenceScope} />
            <ProposalDetail label="项目内证据" items={startingPointDraft.evidencePaths} />
            <ProposalDetail label="对话证据" items={startingPointDraft.evidenceRefs} />
            <p><small>证据版本：{startingPointDraft.evidenceVersion}</small></p>
          </details>
          <div className="proposal-actions">
            <button type="button" className="writeback-confirm" onClick={() =>
              onConfirmStartingPoint(startingPointDraft.id, startingPointDraft.evidenceVersion)
            } disabled={busy || !canConfirm}>
              {busy ? "正在校验证据…" : "确认起点"}
            </button>
          </div>
        </article>
      ) : null}
    </section>
  );
}

function MapProposalCard({
  charting,
  busy,
  onResume,
  onPreview,
  onConfirm,
}: {
  charting: ChartingView;
  busy: boolean;
  onResume(): void;
  onPreview(): void;
  onConfirm(): void;
}) {
  const proposal = charting.proposal!;
  const plan = charting.creationPlan;
  if (plan) {
    return (
      <section className="writeback-preview map-creation-preview" aria-label="首张地图文件预览">
        <header>
          <div><p className="section-label">首张地图预览</p><h4>确认后才会创建这些地点</h4></div>
          <span>尚未写入</span>
        </header>
        <ol className="writeback-impact">
          {plan.locations.map((location) => (
            <li key={location.id}>
              <b>{location.id}</b><span>{location.title}</span>
              <small>{location.status === "frontier" ? "frontier · 当前可选" : `blocked by ${location.blockers.join("、")}`}</small>
            </li>
          ))}
        </ol>
        <p className="writeback-preview__guard">
          frontier 是所有当前可走地点的集合；进入推进模式后只聚焦其中一个，聚焦不代表已经探索或解决。
        </p>
        <details className="proposal-details">
          <summary>查看将新建的 {plan.files.length} 个 Markdown 文件</summary>
          {plan.files.map((file) => (
            <div className="writeback-file" key={file.path}>
              <strong>{file.path}</strong><pre>{file.diff}</pre>
            </div>
          ))}
        </details>
        <div className="proposal-actions proposal-actions--preview">
          <button type="button" className="is-secondary" onClick={onResume} disabled={busy}>继续讨论</button>
          <button type="button" className="writeback-confirm" onClick={onConfirm} disabled={busy}>
            {busy ? "正在安全建图…" : "确认创建首张地图"}<span aria-hidden="true">◆</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="proposal-card map-proposal-card" aria-label="首版地图草案">
      <header>
        <div><p className="section-label">首版地图草案</p><h4>{proposal.title}</h4></div>
        <span>{proposal.tickets.length} 个 ticket</span>
      </header>
      <div className="map-proposal-destination">
        <b>已确认目的地</b><p>{proposal.destination}</p>
      </div>
      <div className="map-proposal-destination">
        <b>已确认起点</b><p>{proposal.startingState}</p>
      </div>
      <ol className="map-proposal-tickets">
        {proposal.tickets.map((ticket, index) => (
          <li key={ticket.key}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            <span><strong>{ticket.title}</strong><small>{ticket.type} · {ticket.blockedBy.length ? `依赖 ${ticket.blockedBy.join("、")}` : "frontier 候选"}</small></span>
          </li>
        ))}
      </ol>
      <details className="proposal-details">
        <summary>查看 fog 与地图边界</summary>
        <ProposalDetail label="仍在迷雾中" items={proposal.fog} />
        <ProposalDetail label="本次不进入" items={proposal.outOfScope} />
      </details>
      <div className="proposal-actions">
        <button type="button" className="is-secondary" onClick={onResume} disabled={busy}>继续讨论</button>
        <button type="button" className="proposal-preview-button" onClick={onPreview} disabled={busy}>
          {busy ? "正在演算地图…" : "预览将创建的地图"}<span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}

function ChartingStateBadge({ codex, charting }: { codex: CodexServiceView; charting?: ChartingView }) {
  const state = charting?.state;
  const label = state ? chartingStateLabel(state) : codexStateLabel(codex.state);
  const tone = state === "awaiting_player"
    ? "player"
    : state === "failed" || state === "orphaned" || codex.state === "unavailable"
      ? "error"
      : state === "exploring" || state === "reconciling" || state === "returning" || codex.state !== "ready"
        ? "active"
        : "ready";
  return <span className={`codex-state codex-state--${tone}`}><i aria-hidden="true" />{label}</span>;
}

interface ThinkingStageProps {
  campaign: CampaignProjection;
  selection: Selection;
  connection: ConnectionState;
  connectionError?: string;
  expeditions: ExpeditionView[];
  charting?: ChartingView;
  codex: CodexServiceView;
  actions: ExpeditionActions;
  explorationBlocked?: string;
  onSelect(selection: Selection): void;
}

function ThinkingStage({
  campaign,
  selection,
  connection,
  connectionError,
  expeditions,
  charting,
  codex,
  actions,
  explorationBlocked,
  onSelect,
}: ThinkingStageProps) {
  return (
    <aside className="thinking-stage" aria-live="polite">
      <div className="thinking-stage__status">
        <ConnectionBadge state={connection} />
        <span className="thinking-stage__sequence">MAP {campaign.revision.slice(-6).toUpperCase()}</span>
      </div>
      <div className="thinking-stage__scroll" key={selectionKey(selection)}>
        {selection.kind === "start" ? (
          <StartPanel campaign={campaign} />
        ) : selection.kind === "destination" ? (
          <DestinationPanel campaign={campaign} />
        ) : selection.kind === "fog" ? (
          <FogPanel campaign={campaign} />
        ) : (
          <LocationPanel
            campaign={campaign}
            locationId={selection.id}
            expeditions={expeditions}
            charting={charting}
            codex={codex}
            actions={actions}
            explorationBlocked={explorationBlocked}
            onSelect={onSelect}
          />
        )}
      </div>
      <footer className="thinking-stage__footer">
        {connectionError && connection !== "live" ? (
          <span title={connectionError}>正在重新取得地图联系</span>
        ) : (
          <span>
            Wayfinder Markdown · {codex.state === "ready" ? "Agent 探索已连接" : "地图投影"}
          </span>
        )}
        <span className="stage-coordinates" aria-hidden="true">N 08° · E 14°</span>
      </footer>
    </aside>
  );
}

function LocationPanel({
  campaign,
  locationId,
  expeditions,
  charting,
  codex,
  actions,
  explorationBlocked,
  onSelect,
}: {
  campaign: CampaignProjection;
  locationId: string;
  expeditions: ExpeditionView[];
  charting?: ChartingView;
  codex: CodexServiceView;
  actions: ExpeditionActions;
  explorationBlocked?: string;
  onSelect(selection: Selection): void;
}) {
  const location = campaign.locations.find(({ id }) => id === locationId);
  if (!location) {
    return <p>这个地点已经离开当前地图。</p>;
  }

  const blockers = location.blockers
    .map((id) => campaign.locations.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Location => Boolean(candidate));
  const unresolvedBlockers = blockers.filter(({ sourceStatus }) => sourceStatus !== "resolved");
  const downstream = campaign.routes
    .filter(({ from }) => from === location.id)
    .map(({ to }) => campaign.locations.find((candidate) => candidate.id === to))
    .filter((candidate): candidate is Location => Boolean(candidate));
  const locationExpeditions = expeditions
    .filter((expedition) => expedition.locationId === location.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const expedition = [...locationExpeditions].reverse().find(
    ({ state }) => !isTerminalExpedition(state),
  ) ?? locationExpeditions.at(-1);
  const restorableChange = location.sourceStatus === "open"
    ? [...(charting?.rechartChanges ?? [])].reverse().find((change) =>
        !change.restoredLocationIds.includes(location.id) &&
        change.files.some((file) => file.locationId === location.id))
    : undefined;

  return (
    <article className={`location-panel location-panel--${location.status}`}>
      <header className="location-panel__header">
        <div>
          <p className="location-kicker">
            <span>{location.id}</span>
            {panelLabel(location.status)}
          </p>
          <h2>{location.title}</h2>
        </div>
        <StatusSigil status={location.status} />
      </header>

      {location.status === "frontier" ? (
        <p className="location-presence">
          <span aria-hidden="true" />
          当前选中此节点；它是 {campaign.summary.frontier} 个 frontier 中的一个。选中不代表已经探索或解决。
        </p>
      ) : null}

      {location.reviewState === "pending" ? (
        <section className="review-pending-block" role="status">
          <p className="section-label">待复核 · 节点与历史保持不变</p>
          <blockquote>{location.reviewQuestion}</blockquote>
          {location.reviewReason ? <p>{location.reviewReason}</p> : null}
        </section>
      ) : null}

      {location.rechartState === "pending_delete" ? (
        <section className="pending-deletion-block" role="status">
          <p className="section-label">本轮重绘建议待删除 · 下轮必须重新评估</p>
          <p>{location.pendingDeletionReason}</p>
        </section>
      ) : null}

      {restorableChange && charting ? (
        <section className="rechart-change-block" role="status">
          <p className="section-label">Map Agent 在本轮重新绘图中改变了这个议题</p>
          <p>你可以只撤销这一次变化；以后重新绘图仍会依据届时的答案重新评估它。</p>
          <button
            type="button"
            className="is-secondary"
            onClick={() => void actions.restoreRechartChange(
              charting.id,
              restorableChange.id,
              location.id,
            ).catch(() => undefined)}
            disabled={actions.busyTarget === `charting:${charting.id}` || Boolean(charting.pendingRechart)}
          >
            {actions.busyTarget === `charting:${charting.id}` ? "正在恢复…" : "恢复本次变化"}
          </button>
        </section>
      ) : null}

      {location.status === "frontier" && expedition ? (
        <ExpeditionPanel
          campaign={campaign}
          location={location}
          expedition={expedition}
          codex={codex}
          actions={actions}
          explorationBlocked={explorationBlocked}
        />
      ) : (
        <section className="question-block" aria-labelledby={`question-${location.id}`}>
          <p className="section-label" id={`question-${location.id}`}>
            {questionLabel(location.status)}
          </p>
          <blockquote>{location.question}</blockquote>
        </section>
      )}

      {location.status === "resolved" && location.answerMarkdown ? (
        <section className="answer-block">
          <p className="section-label">确认的决定</p>
          <MarkdownText markdown={location.answerMarkdown} />
          {location.answerHistory.length ? (
            <details className="answer-history">
              <summary>查看之前的 {location.answerHistory.length} 个版本</summary>
              {location.answerHistory.map((entry) => (
                <article key={`${entry.label}-${entry.answerMarkdown}`}>
                  <b>{entry.label}</b>
                  <MarkdownText markdown={entry.answerMarkdown} />
                </article>
              ))}
            </details>
          ) : null}
        </section>
      ) : null}

      {location.status === "resolved" ? (
        <ExpeditionPanel
          campaign={campaign}
          location={location}
          expedition={expedition}
          codex={codex}
          actions={actions}
          explorationBlocked={explorationBlocked}
        />
      ) : null}

      {location.status === "frontier" && !expedition ? (
        <ExpeditionPanel
          campaign={campaign}
          location={location}
          codex={codex}
          actions={actions}
          explorationBlocked={explorationBlocked}
        />
      ) : null}

      {location.status === "blocked" ? (
        <section className="dependency-block">
          <p className="section-label">尚未通过的关隘</p>
          <div className="dependency-list">
            {unresolvedBlockers.map((blocker) => (
              <button
                type="button"
                key={blocker.id}
                onClick={() => onSelect({ kind: "location", id: blocker.id })}
              >
                <span>{blocker.id}</span>
                <strong>{blocker.title}</strong>
                <i aria-hidden="true">←</i>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {downstream.length && !(location.status === "frontier" && expedition) ? (
        <section className="route-impact">
          <p className="section-label">从这里延伸的路线</p>
          <ul>
            {downstream.map((next) => {
              const remaining = next.blockers.filter(
                (blockerId) => blockerId !== location.id &&
                  campaign.locations.find(({ id }) => id === blockerId)?.sourceStatus !== "resolved",
              );
              return (
                <li key={next.id}>
                  <button
                    type="button"
                    onClick={() => onSelect({ kind: "location", id: next.id })}
                  >
                    <span className="route-impact__number">{next.id}</span>
                    <span>
                      <strong>{next.title}</strong>
                      <small>
                        {remaining.length
                          ? `仍需经过 ${remaining.join("、")}`
                          : "此处确认后可以抵达"}
                      </small>
                    </span>
                    <i aria-hidden="true">→</i>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

    </article>
  );
}

function ExpeditionPanel({
  campaign,
  location,
  expedition,
  codex,
  actions,
  explorationBlocked,
}: {
  campaign: CampaignProjection;
  location: Location;
  expedition?: ExpeditionView;
  codex: CodexServiceView;
  actions: ExpeditionActions;
  explorationBlocked?: string;
}) {
  const [draft, setDraft] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const busyTarget = expedition ? `expedition:${expedition.id}` : `location:${location.id}`;
  const busy = actions.busyTarget === busyTarget;
  const canReply = expedition?.state === "awaiting_player" || expedition?.state === "failed";
  const canFormProposal = canReply && expedition.messages.some(({ role }) => role === "player");
  const canRestart = expedition && isTerminalExpedition(expedition.state) && location.status === "frontier";
  const canRevise = expedition && isTerminalExpedition(expedition.state) && location.sourceStatus === "resolved";
  const canEnd = Boolean(
    expedition &&
    expedition.mode === "initial" &&
    !isTerminalExpedition(expedition.state) &&
    expedition.state !== "ending",
  );
  const proposalStale = Boolean(
    expedition?.proposal && expedition.proposal.sourceRevision !== campaign.revision,
  );

  useEffect(() => {
    const element = transcript.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [expedition?.messages.length, expedition?.streamingMessage?.text]);

  const start = () => {
    actions.clearError();
    void actions.startExpedition(location.id).catch(() => undefined);
  };

  const submit = () => {
    const message = draft.trim();
    if (!expedition || !message || busy) {
      return;
    }
    setDraft("");
    actions.clearError();
    void actions.sendMessage(expedition.id, message).catch(() => setDraft(message));
  };

  const formProposal = () => {
    if (!expedition || busy) {
      return;
    }
    actions.clearError();
    void actions.formProposal(expedition.id).catch(() => undefined);
  };

  const previewWriteback = () => {
    if (!expedition || busy || proposalStale) {
      return;
    }
    actions.clearError();
    void actions.previewWriteback(location.id, expedition.id, campaign.revision).catch(() => undefined);
  };

  const confirmWriteback = () => {
    if (!expedition?.writebackPlan || busy) {
      return;
    }
    actions.clearError();
    void actions.confirmWriteback(expedition.writebackPlan).catch(() => undefined);
  };

  const deferProposal = () => {
    if (!expedition || busy) {
      return;
    }
    actions.clearError();
    void actions.deferProposal(expedition.id).catch(() => undefined);
  };

  const resumeProposal = () => {
    if (!expedition || busy) {
      return;
    }
    actions.clearError();
    void actions.resumeProposal(expedition.id).catch(() => undefined);
  };

  const endExpedition = () => {
    if (
      !expedition ||
      busy ||
      !window.confirm("结束后不会形成答案或地图节点；当前会话与已有内容会保留为未完成历史。确定结束吗？")
    ) {
      return;
    }
    actions.clearError();
    void actions.endExpedition(expedition.id).catch(() => undefined);
  };

  return (
    <section className="expedition-panel" aria-label="Codex 探索任务">
      {expedition ? (
        <div className="expedition-context">
          <p className="section-label">当前问题</p>
          <p>{location.question}</p>
        </div>
      ) : null}

      <header className="expedition-panel__header">
        <div>
          <p className="expedition-panel__eyebrow">
            <span aria-hidden="true" /> CODEX EXPEDITION
          </p>
          <h3>{expedition ? "探索正在这里发生" : "从这里开始探索"}</h3>
        </div>
        <CodexStateBadge codex={codex} expedition={expedition} />
      </header>

      {expedition?.approvalRequest ? (
        <ToolApprovalCard
          request={expedition.approvalRequest}
          busy={busy}
          onDecision={(decision) => void actions.resolveExpeditionApproval(
            expedition.id,
            expedition.approvalRequest!.id,
            decision,
          ).catch(() => undefined)}
        />
      ) : null}

      {!expedition || canRestart || canRevise ? (
        <div className="expedition-launch">
          {expedition?.error ? <p className="expedition-error">{expedition.error}</p> : null}
          <p>
            Codex 会围绕这个地点一次问一个问题；你的回答和思考过程会保留在探索记录里。
          </p>
          <button
            type="button"
            className="expedition-launch__button"
            onClick={start}
            disabled={busy || Boolean(explorationBlocked)}
          >
            <span aria-hidden="true">✦</span>
            {busy
              ? "正在连接 Agent…"
              : canRevise
                ? "修订这个答案"
                : expedition
                  ? "重新开始探索"
                  : "开始探索"}
          </button>
          {codex.state !== "ready" ? (
            <small>{codex.error ?? "点击后会尝试连接本机 Codex。"}</small>
          ) : null}
          {explorationBlocked ? <small>{explorationBlocked}</small> : null}
          {actions.error ? (
            <button type="button" className="expedition-action-error" onClick={actions.clearError}>
              {actions.error}<span>关闭</span>
            </button>
          ) : null}

        </div>
      ) : (
        <>
          <div className="expedition-transcript" ref={transcript} aria-live="polite">
            {expedition.messages.map((message) => (
              <article
                className={`expedition-message expedition-message--${message.role}`}
                key={message.id}
              >
                <span>{message.role === "guide" ? "CODEX" : "你"}</span>
                <MarkdownText markdown={message.text} />
              </article>
            ))}
            {expedition.streamingMessage ? (
              <article className="expedition-message expedition-message--guide is-streaming">
                <span>CODEX</span>
                <MarkdownText markdown={expedition.streamingMessage.text} streaming />
              </article>
            ) : null}
            {(expedition.state === "exploring" || expedition.state === "reconciling" || expedition.state === "returning") &&
            !expedition.streamingMessage ? (
              <div className="expedition-thinking">
                <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
                {expedition.state === "reconciling"
                  ? "正在找回原来的探索路线"
                  : expedition.state === "returning"
                    ? "Codex 正在整理决策草案"
                    : "Codex 正在辨路"}
              </div>
            ) : null}
          </div>

          {expedition.error ? <p className="expedition-error">{expedition.error}</p> : null}
          {actions.error ? (
            <button type="button" className="expedition-action-error" onClick={actions.clearError}>
              {actions.error}<span>关闭</span>
            </button>
          ) : null}

          {expedition.proposal && (
            expedition.state === "returned" ||
            expedition.state === "drafted" ||
            expedition.state === "previewing"
          ) ? (
            <DecisionProposalCard
              expedition={expedition}
              stale={proposalStale}
              busy={busy}
              onPreview={previewWriteback}
              onConfirm={confirmWriteback}
              onDefer={deferProposal}
              onResume={resumeProposal}
            />
          ) : null}

          {expedition.state === "ending" ? (
            <div className="expedition-ending" role="status">
              这次探索已由你结束。Map Agent 正在把议题移出当前范围；不会生成答案、地图节点或确定路线。
            </div>
          ) : null}

          {canReply ? (
            <MessageComposer
              id={`expedition-reply-${expedition.id}`}
              label="你的回答"
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              placeholder="写下你的判断、疑问或反例…"
              context="继续同一个探索 Agent 会话"
              disabled={busy}
              busy={busy}
              secondaryAction={canFormProposal ? (
                <button
                  type="button"
                  className="is-secondary"
                  onClick={formProposal}
                  disabled={busy}
                >
                  形成草案
                </button>
              ) : undefined}
            />
          ) : expedition.state === "exploring" || expedition.state === "awaiting_approval" || expedition.state === "returning" ? (
            <div className="expedition-running">
              <span>
                {expedition.state === "awaiting_approval"
                  ? "等待你批准或拒绝工具请求"
                  : expedition.state === "returning"
                    ? "正在把探索整理成可审阅草案"
                    : "等待 Codex 完成本轮"}
              </span>
              {expedition.activeTurnId && expedition.state !== "returning" ? (
                <button
                  type="button"
                  onClick={() => void actions.interrupt(expedition.id).catch(() => undefined)}
                  disabled={busy}
                >
                  停止本轮
                </button>
              ) : null}
            </div>
          ) : null}

          {canEnd ? (
            <button
              type="button"
              className="expedition-end-button"
              onClick={endExpedition}
              disabled={busy}
            >
              结束这次探索并保留未完成历史
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function DecisionProposalCard({
  expedition,
  stale,
  busy,
  onPreview,
  onConfirm,
  onDefer,
  onResume,
}: {
  expedition: ExpeditionView;
  stale: boolean;
  busy: boolean;
  onPreview(): void;
  onConfirm(): void;
  onDefer(): void;
  onResume(): void;
}) {
  const proposal = expedition.proposal!;
  const plan = expedition.writebackPlan;
  if (plan) {
    return (
      <section className="writeback-preview" aria-label="地图变化预览">
        <header>
          <div>
            <p className="section-label">地图变化预览</p>
            <h4>
              {plan.changeKind === "reaffirmation"
                ? "确认原答案仍然成立"
                : plan.changeKind === "revision"
                  ? "确认修订并协调相关地图"
                  : "确认后，这些路线会改变"}
            </h4>
          </div>
          <span>尚未写入</span>
        </header>
        <ol className="writeback-impact">
          {plan.impact.map((impact) => (
            <li key={impact.locationId}>
              <b>{impact.locationId}</b>
              <span>{impact.title}</span>
              <small>{mapStatusLabel(impact.beforeStatus)} → {mapStatusLabel(impact.afterStatus)}</small>
            </li>
          ))}
        </ol>
        <p className="writeback-preview__guard">
          未列出的地点保持原状态；多重依赖的关隘不会提前解锁。
        </p>
        <details className="proposal-details">
          <summary>查看将修改的 {plan.files.length} 个 Markdown 文件</summary>
          {plan.files.map((file) => (
            <div className="writeback-file" key={file.path}>
              <strong>{file.path}</strong>
              <pre>{file.diff}</pre>
            </div>
          ))}
        </details>
        <div className="proposal-actions proposal-actions--preview">
          <button type="button" className="is-secondary" onClick={onResume} disabled={busy}>
            继续讨论
          </button>
          <button type="button" className="is-secondary" onClick={onDefer} disabled={busy}>
            暂存草案
          </button>
          <button
            type="button"
            className="writeback-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "正在安全写入…" : "确认写入 Wayfinder"}<span aria-hidden="true">◆</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="proposal-card" aria-label="决策草案">
      <header>
        <div>
          <p className="section-label">决策草案</p>
          <h4>{expedition.state === "drafted" ? "草案已保留，尚未确认" : "这还不是已确认的决定"}</h4>
        </div>
        <span>{expedition.state === "drafted" ? "已暂存" : confidenceLabel(proposal.confidence)}</span>
      </header>
      <MarkdownText markdown={proposal.answerMarkdown} />
      {proposal.rationale.length ? (
        <ul className="proposal-rationale">
          {proposal.rationale.slice(0, 2).map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
      <details className="proposal-details">
        <summary>审视依据、假设与回看条件</summary>
        <ProposalDetail label="未选路线" items={proposal.rejectedAlternatives} />
        <ProposalDetail label="当前假设" items={proposal.assumptions} />
        <ProposalDetail label="需要重看时" items={proposal.revisitConditions} />
        <ProposalDetail label="证据" items={proposal.evidenceRefs} />
      </details>
      {expedition.state === "drafted" ? (
        <p className="proposal-deferred">草案会保留在本次目标探索中；地图与 Markdown 都没有变化。</p>
      ) : null}
      {stale ? (
        <p className="proposal-stale">地图在草案形成后已变化。请继续探索，或根据新地图重新形成草案。</p>
      ) : null}
      <div className="proposal-actions">
        <button type="button" className="is-secondary" onClick={onResume} disabled={busy}>
          继续讨论
        </button>
        {expedition.state !== "drafted" ? (
          <button type="button" className="is-secondary" onClick={onDefer} disabled={busy}>
            暂存，稍后决定
          </button>
        ) : null}
        {!stale ? (
          <button type="button" className="proposal-preview-button" onClick={onPreview} disabled={busy}>
            {busy ? "正在演算地图…" : "预览地图变化"}<span aria-hidden="true">→</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ProposalDetail({ label, items }: { label: string; items: string[] }) {
  if (!items.length) {
    return null;
  }
  return (
    <section>
      <b>{label}</b>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

function ToolApprovalCard({
  request,
  busy,
  onDecision,
}: {
  request: AgentApprovalRequestView;
  busy: boolean;
  onDecision(decision: AgentApprovalDecision): void;
}) {
  return (
    <section className="tool-approval" aria-label="Agent 工具审批">
      <p className="section-label">需要你的运行时授权</p>
      <h4>{request.summary}</h4>
      {request.reason ? <p>{request.reason}</p> : null}
      {request.details.length ? (
        <ul>{request.details.map((detail) => <li key={detail}><code>{detail}</code></li>)}</ul>
      ) : null}
      <small>这只授权工具副作用，不等于确认答案或规范地图变化。</small>
      <div className="proposal-actions">
        <button type="button" className="is-secondary" onClick={() => onDecision("decline")} disabled={busy}>
          拒绝
        </button>
        <button type="button" onClick={() => onDecision("approve")} disabled={busy}>
          批准本次
        </button>
      </div>
    </section>
  );
}

function CodexStateBadge({
  codex,
  expedition,
}: {
  codex: CodexServiceView;
  expedition?: ExpeditionView;
}) {
  const state = expedition?.state;
  const label = state ? expeditionStateLabel(state) : codexStateLabel(codex.state);
  const tone = state === "awaiting_player"
    ? "player"
    : state === "failed" || state === "orphaned" || codex.state === "unavailable"
      ? "error"
      : state === "exploring" || state === "reconciling" || codex.state !== "ready"
        ? "active"
        : "ready";
  return <span className={`codex-state codex-state--${tone}`}><i aria-hidden="true" />{label}</span>;
}

function DestinationPanel({ campaign }: { campaign: CampaignProjection }) {
  return (
    <article className="destination-panel">
      <p className="location-kicker"><span>◎</span> NORTH STAR</p>
      <h2>这次目标探索要抵达哪里</h2>
      <div className="destination-panel__statement">
        <span aria-hidden="true">“</span>
        <p>{campaign.destination}</p>
      </div>
      <section>
        <p className="section-label">地图边界之外</p>
        <ul className="scope-list">
          {campaign.outOfScope.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </article>
  );
}

function StartPanel({ campaign }: { campaign: CampaignProjection }) {
  return (
    <article className="destination-panel start-panel">
      <p className="location-kicker"><span>◇</span> START</p>
      <h2>这次目标探索从哪里开始</h2>
      <div className="destination-panel__statement">
        <p>{campaign.startingState || "尚未记录起点。"}</p>
      </div>
      <section>
        <p className="section-label">允许作为事实的证据</p>
        <ul className="scope-list">
          {campaign.evidenceScope.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </article>
  );
}

function FogPanel({ campaign }: { campaign: CampaignProjection }) {
  return (
    <article className="fog-panel">
      <p className="location-kicker"><span>◌</span> UNCHARTED</p>
      <h2>还没有形成路线的区域</h2>
      <p className="fog-panel__intro">
        这些内容仍是模糊地貌，不把它们伪装成已经确定的问题或地点。
      </p>
      <ol className="fog-topic-list">
        {campaign.fog.map((area, index) => (
          <li key={area.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <p>{area.title}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

function StatusSigil({ status }: { status: Location["status"] }) {
  return (
    <span className={`status-sigil status-sigil--${status}`} aria-hidden="true">
      <i />
    </span>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <span className={`connection-badge connection-badge--${state}`}>
      <i aria-hidden="true" />
      {state === "live" ? "地图已同步" : state === "connecting" ? "正在定位" : "重新连接"}
    </span>
  );
}

function LoadingWorld({ error }: { error?: string }) {
  return (
    <main className="loading-world">
      <div className="loading-world__compass" aria-hidden="true"><i /></div>
      <p className="ui-eyebrow">WAYFINDER EXPLORER</p>
      <h1>{error ? "暂时看不清地图" : "正在载入目标探索"}</h1>
      <p>{error ?? "读取地点、足迹与尚未打开的路线…"}</p>
    </main>
  );
}

function defaultSelection(focus: string | null, campaign: CampaignProjection): Selection {
  const id = focus && campaign.locations.some((location) => location.id === focus)
    ? focus
    : campaign.locations.find(({ status }) => status === "frontier")?.id ??
      campaign.trail.at(-1)?.locationId ??
      campaign.locations[0]?.id;
  return id ? { kind: "location", id } : { kind: "destination" };
}

function panelLabel(status: Location["status"]): string {
  if (status === "frontier") {
    return "SELECTED FRONTIER";
  }
  if (status === "resolved") {
    return "TRAIL MEMORY";
  }
  return "LOCKED PASS";
}

function questionLabel(status: Location["status"]): string {
  if (status === "frontier") {
    return "待探索问题";
  }
  if (status === "resolved") {
    return "当时的问题";
  }
  return "待解决的问题";
}

function selectionKey(selection: Selection): string {
  return selection.kind === "location" ? `location-${selection.id}` : selection.kind;
}

function isTerminalExpedition(state: ExpeditionState): boolean {
  return state === "confirmed" || state === "abandoned" || state === "orphaned";
}

function expeditionStateLabel(state: ExpeditionState): string {
  if (state === "awaiting_player") {
    return "等你回答";
  }
  if (state === "exploring") {
    return "探索中";
  }
  if (state === "awaiting_approval") {
    return "边界确认";
  }
  if (state === "reconciling") {
    return "恢复路线";
  }
  if (state === "failed") {
    return "可继续";
  }
  if (state === "returning") {
    return "整理草案";
  }
  if (state === "orphaned") {
    return "任务失联";
  }
  if (state === "returned") {
    return "草案待审";
  }
  if (state === "drafted") {
    return "草案已暂存";
  }
  if (state === "previewing") {
    return "等待确认";
  }
  if (state === "confirmed") {
    return "已写入";
  }
  if (state === "abandoned") {
    return "已留档";
  }
  if (state === "ending") {
    return "正在结束";
  }
  return "已建立";
}

function chartingStateLabel(state: ChartingState): string {
  if (state === "awaiting_player") return "等你回答";
  if (state === "exploring") return "绘图中";
  if (state === "awaiting_approval") return "边界确认";
  if (state === "reconciling") return "恢复绘图";
  if (state === "failed") return "可继续";
  if (state === "returning") return "整理地图草案";
  if (state === "returned") return "草案待审";
  if (state === "previewing") return "等待建图确认";
  if (state === "confirmed") return "地图已创建";
  if (state === "orphaned") return "会话已留档";
  return "已建立";
}

function confidenceLabel(confidence: "low" | "medium" | "high"): string {
  return confidence === "high" ? "高把握" : confidence === "medium" ? "中等把握" : "低把握";
}

function mapStatusLabel(status: Location["status"]): string {
  return status === "resolved" ? "营地" : status === "frontier" ? "当前入口" : "受阻关隘";
}

function projectStatusLabel(project: CampaignProjectView): string {
  if (project.status === "empty") {
    return "等待绘制地图";
  }
  if (project.status === "missing") {
    return "需要重新关联";
  }
  if (project.status === "invalid") {
    return `${project.blockingDiagnostics ?? 0} 个源问题`;
  }
  return "地图已建立";
}

function projectPreviewPath(parentRoot: string, projectName: string): string {
  const root = parentRoot.trim().replace(/[\\/]+$/u, "");
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${projectName.trim()}`;
}

function codexStateLabel(state: CodexConnectionState): string {
  if (state === "ready") {
    return "Codex 已连接";
  }
  if (state === "connecting") {
    return "连接 Codex";
  }
  if (state === "reconnecting") {
    return "重新连接";
  }
  return "Codex 未连接";
}
