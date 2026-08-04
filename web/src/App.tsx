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
import type {
  CampaignProjectIndex,
  CampaignProjectView,
} from "../../src/project/model.ts";
import { JourneyLog } from "./JourneyLog.tsx";
import { MarkdownText } from "./MarkdownText.ts";
import { MapWorld } from "./MapWorld.tsx";
import type { ConnectionState, ExpeditionActions, Selection } from "./app-types.ts";
import { useCampaign } from "./use-campaign.ts";

export function App() {
  const { snapshot, connection, error, actions } = useCampaign();
  const [selection, setSelection] = useState<Selection>();
  const [logOpen, setLogOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const lastCampaignId = useRef<string | undefined>(undefined);
  const lastLocationCount = useRef<number | undefined>(undefined);
  const closeLog = useCallback(() => setLogOpen(false), []);
  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next.kind === "location") {
      void actions.setPlayerFocus(next.id).catch(() => undefined);
    }
  }, [actions]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    const campaignChanged = lastCampaignId.current !== snapshot.campaign.id;
    const mapWasJustCreated = lastLocationCount.current === 0 && snapshot.campaign.locations.length > 0;
    lastCampaignId.current = snapshot.campaign.id;
    lastLocationCount.current = snapshot.campaign.locations.length;
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

  if (!snapshot || !selection) {
    return <LoadingWorld error={error} />;
  }

  const { campaign, overlay, expeditions, codex } = snapshot;
  const activeProject = snapshot.projects.projects.find(
    ({ id }) => id === snapshot.projects.activeProjectId,
  );
  const emptyProject = activeProject?.status === "empty";
  const progress = campaign.summary.total
    ? Math.round((campaign.summary.resolved / campaign.summary.total) * 100)
    : 0;

  return (
    <main className="explorer-app">
      <header className="topbar">
        <button
          type="button"
          className="brand-block project-trigger"
          onClick={() => setProjectsOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={projectsOpen}
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
          </span>
          <div>
            <p className="ui-eyebrow">WAYFINDER EXPLORER · 项目</p>
            <h1>{activeProject?.name ?? campaign.title}<i aria-hidden="true">⌄</i></h1>
          </div>
        </button>

        <button
          type="button"
          className="destination-summary"
          onClick={() => setSelection({ kind: "destination" })}
          aria-label="查看完整目的地"
        >
          <span>目的地</span>
          <strong>{emptyProject ? "空项目 · 等待定义目的地" : campaign.destination}</strong>
        </button>

        <div className="topbar__actions">
          <div className="progress-readout" aria-label={`旅程进度 ${campaign.summary.resolved} / ${campaign.summary.total}`}>
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
            旅程日志
          </button>
        </div>
      </header>

      {campaign.summary.blockingDiagnostics > 0 && !emptyProject ? (
        <div className="diagnostic-banner" role="status">
          源地图有 {campaign.summary.blockingDiagnostics} 个阻塞诊断；地图仍可查看，但语义操作已冻结。
        </div>
      ) : null}

      {emptyProject && activeProject ? (
        <EmptyProjectStage
          project={activeProject}
          campaign={campaign}
          charting={snapshot.charting}
          codex={codex}
          actions={actions}
        />
      ) : (
        <div className="workspace">
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
            codex={codex}
            actions={actions}
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
          onClose={() => setProjectsOpen(false)}
        />
      ) : null}
    </main>
  );
}

function ProjectDrawer({
  index,
  actions,
  onClose,
}: {
  index: CampaignProjectIndex;
  actions: ExpeditionActions;
  onClose(): void;
}) {
  const [mode, setMode] = useState<"create" | "add" | "relink">();
  const [targetProject, setTargetProject] = useState<CampaignProjectView>();
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const busy = Boolean(
    actions.busyTarget?.startsWith("project:") ||
    actions.busyTarget?.startsWith("directory:"),
  );
  const choosingDirectory = actions.busyTarget?.startsWith("directory:");

  const resetForm = () => {
    setMode(undefined);
    setTargetProject(undefined);
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
          : Promise.reject(new Error("没有要重新关联的项目。"));
    void operation.then(onClose).catch(() => undefined);
  };

  return (
    <div className="project-drawer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) {
        onClose();
      }
    }}>
      <section className="project-drawer" role="dialog" aria-modal="true" aria-label="选择项目">
        <header>
          <div>
            <p className="ui-eyebrow">CAMPAIGN LIBRARY</p>
            <h2>选择一段旅程</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭项目选择">×</button>
        </header>

        <div className="project-list">
          {index.projects.map((project) => (
            <button
              type="button"
              className={project.id === index.activeProjectId ? "is-active" : ""}
              key={project.id}
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
          ))}
        </div>

        {actions.error ? <p className="project-drawer__error">{actions.error}</p> : null}

        {mode ? (
          <form className="project-create-form" onSubmit={submit}>
            {mode === "create" ? (
              <div className="project-create-form__field">
                <label htmlFor="project-name">空项目名称</label>
                <input
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
                    ? "已有项目文件夹"
                    : `「${targetProject?.name}」的新文件夹`}
              </label>
              <div className="project-path-picker">
                <input
                  id="project-root"
                  value={root}
                  onChange={(event) => setRoot(event.target.value)}
                  placeholder="/Users/name/Documents"
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
                  将创建：{root.trim().replace(/\/$/, "")}/{name.trim()}
                </small>
              ) : (
                <small className="project-create-form__hint">
                  {mode === "create"
                    ? "项目 Markdown 将保存在你选择的位置；应用数据仍单独保存。"
                    : "选择包含 map.md 与 issues/ 的 Wayfinder 项目文件夹，也可以手动输入路径。"}
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
                    ? "建立空项目"
                    : mode === "add"
                      ? "添加并打开"
                      : "重新关联"}
              </button>
            </div>
          </form>
        ) : (
          <footer>
            <button type="button" onClick={() => { setMode("create"); setName(""); setRoot(""); }}>
              <span aria-hidden="true">＋</span> 建立空项目
            </button>
            <button type="button" onClick={beginAdd} disabled={busy}>
              选择已有项目
            </button>
          </footer>
        )}
      </section>
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
        <p className="ui-eyebrow">CHARTING MODE · 绘制地图</p>
        <h2>先确认目的地，再绘制第一层地貌</h2>
        <p>
          这里还没有 `map.md`。Codex 会先与你确认要抵达的结果，再做 breadth-first 扫描，形成候选 ticket、迷雾与边界；不会提前替你解决任何决定。
        </p>
        <div className="empty-project-stage__path">
          <span>项目目录</span>
          <code>{project.root}</code>
        </div>
        <ol className="charting-phases">
          <li className={!charting?.proposal ? "is-current" : "is-done"}>
            <b>01</b><span><strong>确认目的地</strong><small>明确可观察结果与边界</small></span>
          </li>
          <li className={charting?.proposal ? "is-current" : ""}>
            <b>02</b><span><strong>绘制首版地图</strong><small>候选 ticket、依赖、fog、out of scope</small></span>
          </li>
          <li>
            <b>03</b><span><strong>推进地图</strong><small>确认后从多个 frontier 中选择</small></span>
          </li>
        </ol>
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
  const canFormProposal = canReply && charting.messages.some(({ role }) => role === "player");

  useEffect(() => {
    const element = transcript.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [charting?.messages.length, charting?.streamingMessage?.text]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!charting || !message || busy) {
      return;
    }
    setDraft("");
    actions.clearError();
    void actions.sendChartingMessage(charting.id, message).catch(() => setDraft(message));
  };

  return (
    <article className="charting-panel" aria-label="Wayfinder 绘图会话">
      <header className="expedition-panel__header">
        <div>
          <p className="expedition-panel__eyebrow"><span aria-hidden="true" /> CODEX CHARTING</p>
          <h3>{charting ? "首张地图正在这里形成" : "从一个想法开始绘图"}</h3>
        </div>
        <ChartingStateBadge codex={codex} charting={charting} />
      </header>

      {!charting ? (
        <div className="expedition-launch">
          <p>开始后是一个可持续、可恢复的 Codex 会话。只有你审阅并确认草案后，Explorer 才会创建 Markdown。</p>
          <button
            type="button"
            className="expedition-launch__button"
            onClick={() => void actions.startCharting().catch(() => undefined)}
            disabled={busy}
          >
            <span aria-hidden="true">✦</span>{busy ? "正在连接 Codex…" : "开始确认目的地"}
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
                <span>{message.role === "guide" ? "CODEX" : "你"}</span>
                <MarkdownText markdown={message.text} />
              </article>
            ))}
            {charting.streamingMessage ? (
              <article className="expedition-message expedition-message--guide is-streaming">
                <span>CODEX</span><MarkdownText markdown={charting.streamingMessage.text} streaming />
              </article>
            ) : null}
            {(charting.state === "exploring" || charting.state === "reconciling" || charting.state === "returning") &&
            !charting.streamingMessage ? (
              <div className="expedition-thinking">
                <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
                {charting.state === "reconciling"
                  ? "正在找回原来的绘图会话"
                  : charting.state === "returning"
                    ? "Codex 正在整理首版地图草案"
                    : "Codex 正在辨认地貌"}
              </div>
            ) : null}
          </div>

          {charting.error ? <p className="expedition-error">{charting.error}</p> : null}
          {actions.error ? (
            <button type="button" className="expedition-action-error" onClick={actions.clearError}>
              {actions.error}<span>关闭</span>
            </button>
          ) : null}

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
            <form className="expedition-composer" onSubmit={submit}>
              <label htmlFor={`charting-reply-${charting.id}`}>你的回答</label>
              <textarea
                id={`charting-reply-${charting.id}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="写下你的目标、边界、反例或担心混淆的地方…"
                rows={3}
                maxLength={8_000}
                disabled={busy}
              />
              <div>
                <small>继续同一个 Codex 绘图任务</small>
                <span className="expedition-composer__actions">
                  {canFormProposal ? (
                    <button
                      type="button"
                      className="is-secondary"
                      onClick={() => void actions.formMapProposal(charting.id).catch(() => undefined)}
                      disabled={busy}
                    >
                      形成地图草案
                    </button>
                  ) : null}
                  <button type="submit" disabled={!draft.trim() || busy}>
                    {busy ? "正在送达…" : "继续绘图"}<span aria-hidden="true">↗</span>
                  </button>
                </span>
              </div>
            </form>
          ) : charting.state === "exploring" || charting.state === "awaiting_approval" || charting.state === "returning" ? (
            <div className="expedition-running">
              <span>{charting.state === "returning" ? "正在形成可审阅地图草案" : "等待 Codex 完成本轮"}</span>
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
        <b>目的地</b><p>{proposal.destination}</p>
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
  codex: CodexServiceView;
  actions: ExpeditionActions;
  onSelect(selection: Selection): void;
}

function ThinkingStage({
  campaign,
  selection,
  connection,
  connectionError,
  expeditions,
  codex,
  actions,
  onSelect,
}: ThinkingStageProps) {
  return (
    <aside className="thinking-stage" aria-live="polite">
      <div className="thinking-stage__status">
        <ConnectionBadge state={connection} />
        <span className="thinking-stage__sequence">MAP {campaign.revision.slice(-6).toUpperCase()}</span>
      </div>
      <div className="thinking-stage__scroll" key={selectionKey(selection)}>
        {selection.kind === "destination" ? (
          <DestinationPanel campaign={campaign} />
        ) : selection.kind === "fog" ? (
          <FogPanel campaign={campaign} />
        ) : (
          <LocationPanel
            campaign={campaign}
            locationId={selection.id}
            expeditions={expeditions}
            codex={codex}
            actions={actions}
            onSelect={onSelect}
          />
        )}
      </div>
      <footer className="thinking-stage__footer">
        {connectionError && connection !== "live" ? (
          <span title={connectionError}>正在重新取得地图联系</span>
        ) : (
          <span>
            Wayfinder Markdown · {codex.state === "ready" ? "Codex 只读探索已连接" : "只读投影"}
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
  codex,
  actions,
  onSelect,
}: {
  campaign: CampaignProjection;
  locationId: string;
  expeditions: ExpeditionView[];
  codex: CodexServiceView;
  actions: ExpeditionActions;
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

      {location.status === "frontier" && expedition ? (
        <ExpeditionPanel
          campaign={campaign}
          location={location}
          expedition={expedition}
          codex={codex}
          actions={actions}
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
        </section>
      ) : null}

      {location.status === "frontier" && !expedition ? (
        <ExpeditionPanel
          campaign={campaign}
          location={location}
          codex={codex}
          actions={actions}
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
}: {
  campaign: CampaignProjection;
  location: Location;
  expedition?: ExpeditionView;
  codex: CodexServiceView;
  actions: ExpeditionActions;
}) {
  const [draft, setDraft] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  const busyTarget = expedition ? `expedition:${expedition.id}` : `location:${location.id}`;
  const busy = actions.busyTarget === busyTarget;
  const canReply = expedition?.state === "awaiting_player" || expedition?.state === "failed";
  const canFormProposal = canReply && expedition.messages.some(({ role }) => role === "player");
  const canRestart = expedition && isTerminalExpedition(expedition.state) && location.status === "frontier";
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
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

      {!expedition || canRestart ? (
        <div className="expedition-launch">
          {expedition?.error ? <p className="expedition-error">{expedition.error}</p> : null}
          <p>
            Codex 会围绕这个地点一次问一个问题；你的回答和走过的思路会留在旅程记录里。
          </p>
          <button type="button" className="expedition-launch__button" onClick={start} disabled={busy}>
            <span aria-hidden="true">✦</span>
            {busy ? "正在连接 Codex…" : expedition ? "重新开始探索" : "开始探索"}
          </button>
          {codex.state !== "ready" ? (
            <small>{codex.error ?? "点击后会尝试连接本机 Codex。"}</small>
          ) : null}
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

          {canReply ? (
            <form className="expedition-composer" onSubmit={submit}>
              <label htmlFor={`expedition-reply-${expedition.id}`}>你的回答</label>
              <textarea
                id={`expedition-reply-${expedition.id}`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="写下你的判断、疑问或反例…"
                rows={3}
                maxLength={8_000}
                disabled={busy}
              />
              <div>
                <small>继续同一个 Codex 任务</small>
                <span className="expedition-composer__actions">
                  {canFormProposal ? (
                    <button
                      type="button"
                      className="is-secondary"
                      onClick={formProposal}
                      disabled={busy}
                    >
                      形成草案
                    </button>
                  ) : null}
                  <button type="submit" disabled={!draft.trim() || busy}>
                    {busy ? "正在送达…" : "继续探索"}<span aria-hidden="true">↗</span>
                  </button>
                </span>
              </div>
            </form>
          ) : expedition.state === "exploring" || expedition.state === "awaiting_approval" || expedition.state === "returning" ? (
            <div className="expedition-running">
              <span>
                {expedition.state === "awaiting_approval"
                  ? "只读边界正在处理请求"
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
            <h4>确认后，这些路线会改变</h4>
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
        <p className="proposal-deferred">草案会保留在这次旅程中；地图与 Markdown 都没有变化。</p>
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
      <h2>这段旅程要抵达哪里</h2>
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
      <h1>{error ? "暂时看不清地图" : "正在展开旅程地图"}</h1>
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
    return "空项目";
  }
  if (project.status === "missing") {
    return "需要重新关联";
  }
  if (project.status === "invalid") {
    return `${project.blockingDiagnostics ?? 0} 个源问题`;
  }
  return "旅程地图";
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
