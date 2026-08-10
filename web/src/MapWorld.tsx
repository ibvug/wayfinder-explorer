import { useEffect, useMemo, useRef } from "react";

import type { CampaignProjection, ExplorerOverlay, LayoutPoint } from "../../src/model.ts";
import type { Selection } from "./app-types.ts";

interface MapWorldProps {
  campaign: CampaignProjection;
  overlay: ExplorerOverlay;
  selection: Selection;
  onSelect(selection: Selection): void;
}

interface CanvasPoint extends LayoutPoint {
  canvasX: number;
  canvasY: number;
}

export function MapWorld({ campaign, overlay, selection, onSelect }: MapWorldProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const bounds = overlay.layout.bounds;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const points = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(overlay.layout.locations).map(([id, point]) => [
          id,
          toCanvasPoint(point, bounds.minX, bounds.minY),
        ]),
      ),
    [overlay.layout.locations, bounds.minX, bounds.minY],
  );
  const start = toCanvasPoint(
    overlay.layout.start,
    bounds.minX,
    bounds.minY,
  );
  const destination = toCanvasPoint(
    overlay.layout.destination,
    bounds.minX,
    bounds.minY,
  );
  const fog = toCanvasPoint(overlay.layout.fogEntrance, bounds.minX, bounds.minY);

  useEffect(() => {
    const container = viewport.current;
    if (!container) {
      return;
    }
    const target =
      selection.kind === "start"
        ? start
      : selection.kind === "location"
        ? points[selection.id]
        : selection.kind === "destination"
          ? destination
          : fog;
    if (!target) {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = window.requestAnimationFrame(() => {
      container.scrollTo({
        left: Math.max(0, target.canvasX - container.clientWidth * 0.44),
        top: Math.max(0, target.canvasY - container.clientHeight * 0.5),
        behavior: reducedMotion ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selection, points, start.canvasX, start.canvasY, destination.canvasX, destination.canvasY, fog.canvasX, fog.canvasY]);

  const decisionNodes = campaign.mapNodes.filter(({ kind }) => kind === "decision");
  const destinationNode = campaign.mapNodes.find(({ kind }) => kind === "destination");
  const issues = campaign.locations.filter(({ sourceStatus }) => sourceStatus !== "resolved");
  const determinedRoutes = campaign.determinedRoutes.flatMap((route) => {
    const from = route.from === "start"
      ? start
      : route.from === "destination"
        ? destination
        : points[route.from];
    const to = route.to === "start"
      ? start
      : route.to === "destination"
        ? destination
        : points[route.to];
    return from && to ? [{ fromId: route.from, toId: route.to, from, to }] : [];
  });

  return (
    <section className="map-shell" aria-label="目标探索地图">
      <div className="map-shell__caption" aria-hidden="true">
        <span>已确认节点</span>
        <i className="legend-mark legend-mark--trail" />
        <span>待探索 issue</span>
        <i className="legend-mark legend-mark--frontier" />
        <span>当前选中</span>
        <i className="legend-mark legend-mark--selected" />
        <span>未开放 issue</span>
        <i className="legend-mark legend-mark--gate" />
      </div>
      <div className="map-viewport" ref={viewport} data-testid="map-viewport">
        <div className="map-world" style={{ width, height }}>
          <div className="map-world__grain" aria-hidden="true" />
          <svg
            className="route-layer"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
          >
            <defs>
              <filter id="frontier-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {determinedRoutes.map((route) => {
              const selected =
                (selection.kind === "start" && route.fromId === "start") ||
                (selection.kind === "destination" && route.toId === "destination") ||
                (selection.kind === "location" &&
                  (selection.id === route.fromId || selection.id === route.toId));
              return (
                <path
                  key={`${route.fromId}-${route.toId}`}
                  className={[
                    "route",
                    "route--determined",
                    selected ? "route--selected" : "",
                  ].filter(Boolean).join(" ")}
                  d={routePath(route.from, route.to)}
                />
              );
            })}
          </svg>

          <button
            type="button"
            className={`start-landmark${selection.kind === "start" ? " is-selected" : ""}`}
            style={{ left: start.canvasX, top: start.canvasY }}
            onClick={() => onSelect({ kind: "start" })}
            aria-label="查看起点"
            aria-pressed={selection.kind === "start"}
            data-map-node-id="start"
          >
            <span className="start-landmark__marker" aria-hidden="true">◇</span>
            <span className="start-landmark__label">起点</span>
            <span className="start-landmark__tooltip" role="tooltip">{campaign.startingState}</span>
          </button>

          {decisionNodes.map((node) => {
            const point = node.locationId ? points[node.locationId] : undefined;
            if (!point) {
              return null;
            }
            const isSelected = selection.kind === "location" && selection.id === node.locationId;
            return (
              <button
                key={node.id}
                type="button"
                className={`map-node map-node--resolved map-node--${node.state}${isSelected ? " is-selected" : ""}`}
                style={{ left: point.canvasX, top: point.canvasY }}
                onClick={() => onSelect({ kind: "location", id: node.locationId! })}
                aria-label={`${node.id} ${node.title}，已确认地图节点${isSelected ? "，当前选中" : ""}`}
                aria-pressed={isSelected}
                data-map-node-id={node.id}
              >
                <span className="map-node__marker">
                  <span className="map-node__id">{node.id}</span>
                </span>
                {isSelected || node.state === "review_pending" ? (
                  <span className={`map-node__state${isSelected ? " is-selected" : ""}`}>
                    {isSelected ? "当前选中" : "待复核"}
                  </span>
                ) : null}
                <span className="map-node__tooltip" role="tooltip">
                  {node.title}
                </span>
              </button>
            );
          })}

          {issues.map((location) => {
            const point = points[location.id];
            if (!point) {
              return null;
            }
            const isSelected = selection.kind === "location" && selection.id === location.id;
            return (
              <button
                key={location.id}
                type="button"
                className={`map-node issue-marker map-node--${location.status}${location.rechartState === "pending_delete" ? " issue-marker--pending-delete" : ""}${isSelected ? " is-selected" : ""}`}
                style={{ left: point.canvasX, top: point.canvasY }}
                onClick={() => onSelect({ kind: "location", id: location.id })}
                aria-label={`${location.id} ${location.title}，${statusLabel(location.status)}；这是未确认 issue，不是地图节点${isSelected ? "，当前选中" : ""}`}
                aria-pressed={isSelected}
                data-issue-id={location.id}
              >
                <span className="map-node__marker">
                  <span className="map-node__id">{location.id}</span>
                </span>
                {isSelected || location.status === "frontier" ? (
                  <span className={`map-node__state${isSelected ? " is-selected" : ""}`}>
                    {isSelected ? "当前选择" : location.rechartState === "pending_delete" ? "待删除" : "ISSUE"}
                  </span>
                ) : null}
                <span className="map-node__tooltip" role="tooltip">{location.title}</span>
              </button>
            );
          })}

          <button
            type="button"
            className={`destination-landmark destination-landmark--${destinationNode?.state ?? "open"}${selection.kind === "destination" ? " is-selected" : ""}`}
            style={{ left: destination.canvasX, top: destination.canvasY }}
            onClick={() => onSelect({ kind: "destination" })}
            aria-label="查看目的地"
            aria-pressed={selection.kind === "destination"}
            data-map-node-id="destination"
          >
            <span className="destination-landmark__rings" aria-hidden="true" />
            <span className="destination-landmark__label">目的地</span>
          </button>

          <button
            type="button"
            className={`fog-entrance${selection.kind === "fog" ? " is-selected" : ""}`}
            style={{ left: fog.canvasX, top: fog.canvasY }}
            onClick={() => onSelect({ kind: "fog" })}
            aria-label={`打开未测绘区域，共 ${campaign.fog.length} 个议题`}
            aria-pressed={selection.kind === "fog"}
          >
            <span className="fog-entrance__eyebrow">尚未测绘</span>
            <span className="fog-entrance__title">迷雾区域</span>
            <span className="fog-entrance__count">{campaign.fog.length} 个议题</span>
          </button>
        </div>
      </div>
      <div className="map-shell__edge map-shell__edge--left" aria-hidden="true" />
      <div className="map-shell__edge map-shell__edge--right" aria-hidden="true" />
    </section>
  );
}

function toCanvasPoint(point: LayoutPoint, minX: number, minY: number): CanvasPoint {
  return {
    ...point,
    canvasX: point.x - minX,
    canvasY: point.y - minY,
  };
}

function routePath(from: CanvasPoint, to: CanvasPoint): string {
  const distance = Math.max(80, Math.abs(to.canvasX - from.canvasX));
  const control = Math.min(180, distance * 0.46);
  const direction = to.canvasX >= from.canvasX ? 1 : -1;
  return [
    `M ${from.canvasX} ${from.canvasY}`,
    `C ${from.canvasX + control * direction} ${from.canvasY}`,
    `${to.canvasX - control * direction} ${to.canvasY}`,
    `${to.canvasX} ${to.canvasY}`,
  ].join(" ");
}

function statusLabel(status: "resolved" | "frontier" | "blocked"): string {
  if (status === "resolved") {
    return "已经走过";
  }
  if (status === "frontier") {
    return "frontier，可探索";
  }
  return "尚未开放";
}
