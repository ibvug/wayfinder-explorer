import { useRef } from "react";

import type { CampaignProjection } from "../../src/model.ts";
import type { Selection } from "./app-types.ts";
import { useModalDialog } from "./use-modal-dialog.ts";

interface JourneyLogProps {
  campaign: CampaignProjection;
  onClose(): void;
  onSelect(selection: Selection): void;
}

export function JourneyLog({ campaign, onClose, onSelect }: JourneyLogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useModalDialog<HTMLElement>({ onClose, initialFocus: closeButton });

  const frontier = campaign.locations.filter(({ status }) => status === "frontier");

  return (
    <div className="log-backdrop" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="journey-log"
        role="dialog"
        aria-modal="true"
        aria-labelledby="journey-log-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="journey-log__header">
          <div>
            <p className="ui-eyebrow">TRAIL ARCHIVE</p>
            <h2 id="journey-log-title">探索总览</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭探索总览"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="journey-log__body">
          <section className="log-section" aria-labelledby="walked-title">
            <div className="log-section__heading">
              <h3 id="walked-title">走过的路</h3>
              <span>{campaign.trail.length} 个决定</span>
            </div>
            <ol className="trail-list">
              {campaign.trail.map((stop) => (
                <li key={stop.locationId}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect({ kind: "location", id: stop.locationId });
                      onClose();
                    }}
                  >
                    <span className="trail-list__number">{stop.locationId}</span>
                    <span className="trail-list__copy">
                      <strong>{stop.title}</strong>
                      {stop.summary ? <small>{stop.summary}</small> : null}
                    </span>
                    <span className="trail-list__arrow" aria-hidden="true">↗</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className="log-section" aria-labelledby="frontier-title">
            <div className="log-section__heading">
              <h3 id="frontier-title">当前前沿</h3>
              <span>{frontier.length} 个入口</span>
            </div>
            <div className="frontier-list">
              {frontier.map((location) => (
                <button
                  type="button"
                  key={location.id}
                  onClick={() => {
                    onSelect({ kind: "location", id: location.id });
                    onClose();
                  }}
                >
                  <span>{location.id}</span>
                  <strong>{location.title}</strong>
                </button>
              ))}
            </div>
          </section>

          <button
            type="button"
            className="fog-log-entry"
            onClick={() => {
              onSelect({ kind: "fog" });
              onClose();
            }}
          >
            <span className="fog-log-entry__symbol" aria-hidden="true">◌</span>
            <span>
              <small>未测绘区域</small>
              <strong>{campaign.fog.length} 个仍未形成地点的议题</strong>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>
    </div>
  );
}
