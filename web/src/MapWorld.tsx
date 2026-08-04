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
      selection.kind === "location"
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
  }, [selection, points, destination.canvasX, destination.canvasY, fog.canvasX, fog.canvasY]);

  const trailPairs = campaign.trail.slice(1).flatMap((stop, index) => {
    const from = points[campaign.trail[index].locationId];
    const to = points[stop.locationId];
    return from && to ? [{ from, to, key: `trail-${stop.locationId}` }] : [];
  });
  const trailIds = new Set(campaign.trail.map(({ locationId }) => locationId));
  const lastTrail = campaign.trail.at(-1);
  const frontierBridges = lastTrail
    ? campaign.locations.flatMap((location) => {
        const from = points[lastTrail.locationId];
        const to = points[location.id];
        return location.status === "frontier" && !location.blockers.length && !trailIds.has(location.id) && from && to
          ? [{ from, to, key: `bridge-${location.id}` }]
          : [];
      })
    : [];
  const outgoing = new Set(campaign.routes.map(({ from }) => from));
  const destinationRoutes = campaign.locations.flatMap((location) => {
    const from = points[location.id];
    return !outgoing.has(location.id) && from
      ? [{ from, to: destination, key: `destination-${location.id}` }]
      : [];
  });

  return (
    <section className="map-shell" aria-label="决策旅程地图">
      <div className="map-shell__caption" aria-hidden="true">
        <span>已走过</span>
        <i className="legend-mark legend-mark--trail" />
        <span>Frontier（可探索）</span>
        <i className="legend-mark legend-mark--frontier" />
        <span>当前选中</span>
        <i className="legend-mark legend-mark--selected" />
        <span>关隘</span>
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

            {trailPairs.map(({ from, to, key }) => (
              <path key={key} className="route route--trail" d={routePath(from, to)} />
            ))}
            {frontierBridges.map(({ from, to, key }) => (
              <path key={key} className="route route--current" d={routePath(from, to)} />
            ))}
            {campaign.routes.map((route) => {
              const from = points[route.from];
              const to = points[route.to];
              if (!from || !to) {
                return null;
              }
              const fromFrontier = campaign.locations.find(({ id }) => id === route.from)?.status === "frontier";
              const selected =
                selection.kind === "location" &&
                (selection.id === route.from || selection.id === route.to);
              return (
                <path
                  key={`${route.from}-${route.to}`}
                  className={[
                    "route",
                    `route--${route.state}`,
                    fromFrontier ? "route--from-frontier" : "",
                    selected ? "route--selected" : "",
                  ].filter(Boolean).join(" ")}
                  d={routePath(from, to)}
                />
              );
            })}
            {destinationRoutes.map(({ from, to, key }) => (
              <path key={key} className="route route--destination" d={routePath(from, to)} />
            ))}
          </svg>

          {campaign.locations.map((location) => {
            const point = points[location.id];
            if (!point) {
              return null;
            }
            const isSelected = selection.kind === "location" && selection.id === location.id;
            return (
              <button
                key={location.id}
                type="button"
                className={`map-node map-node--${location.status}${isSelected ? " is-selected" : ""}`}
                style={{ left: point.canvasX, top: point.canvasY }}
                onClick={() => onSelect({ kind: "location", id: location.id })}
                aria-label={`${location.id} ${location.title}，${statusLabel(location.status)}${isSelected ? "，当前选中" : ""}`}
                aria-pressed={isSelected}
                data-location-id={location.id}
              >
                <span className="map-node__marker">
                  <span className="map-node__id">{location.id}</span>
                </span>
                {isSelected || location.status === "frontier" ? (
                  <span className={`map-node__state${isSelected ? " is-selected" : ""}`}>
                    {isSelected ? "当前选中" : "FRONTIER"}
                  </span>
                ) : null}
                <span className="map-node__tooltip" role="tooltip">
                  {location.title}
                </span>
              </button>
            );
          })}

          <button
            type="button"
            className={`destination-landmark${selection.kind === "destination" ? " is-selected" : ""}`}
            style={{ left: destination.canvasX, top: destination.canvasY }}
            onClick={() => onSelect({ kind: "destination" })}
            aria-label="查看旅程目的地"
            aria-pressed={selection.kind === "destination"}
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
