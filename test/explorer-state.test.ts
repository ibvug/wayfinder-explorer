import assert from "node:assert/strict";
import test from "node:test";

import type { ChartingView } from "../src/charting/model.ts";
import type { CampaignProjection } from "../src/model.ts";
import { projectOperationalArrival } from "../src/service/explorer-state.ts";

test("an exhausted zero-issue map arrives only after a successful rechart", () => {
  const campaign = emptyExhaustedCampaign();
  const charting = chartingView();

  const firstMap = projectOperationalArrival(campaign, false, charting);
  assert.equal(firstMap.mapNodes.at(-1)?.state, "open");
  assert.deepEqual(firstMap.determinedRoutes, [], "first-map endpoints are not connected automatically");

  const afterRechart = projectOperationalArrival(campaign, false, {
    ...charting,
    rechartChanges: [{
      id: "rechart-change-final",
      confirmedLocationId: "01",
      sourceRevisionBefore: "sha256:before",
      sourceRevisionAfter: campaign.revision,
      createdAt: "2026-08-07T00:00:00.000Z",
      files: [],
      restoredLocationIds: [],
    }],
  });
  assert.equal(afterRechart.mapNodes.at(-1)?.state, "arrived");
  assert.deepEqual(afterRechart.determinedRoutes, [{ from: "start", to: "destination" }]);

  const pending = projectOperationalArrival(campaign, false, {
    ...charting,
    pendingRechart: {
      confirmedLocationId: "01",
      triggerKind: "exploration_ended",
      activeLocationIds: [],
      sourceRevision: campaign.revision,
      requestedAt: "2026-08-07T00:00:00.000Z",
    },
    rechartChanges: [{
      id: "rechart-change-final",
      confirmedLocationId: "01",
      sourceRevisionBefore: "sha256:before",
      sourceRevisionAfter: campaign.revision,
      createdAt: "2026-08-07T00:00:00.000Z",
      files: [],
      restoredLocationIds: [],
    }],
  });
  assert.equal(pending.mapNodes.at(-1)?.state, "open");
  assert.deepEqual(pending.determinedRoutes, []);
});

function emptyExhaustedCampaign(): CampaignProjection {
  return {
    id: "campaign-acde00000006",
    root: "/tmp/wayfinder-empty-exhausted",
    revision: "sha256:final",
    title: "Zero issue completion",
    destination: "No decisions remain.",
    startingState: "One optional question was considered.",
    evidenceScope: ["Current project"],
    outOfScope: ["The ended optional branch"],
    locations: [],
    routes: [],
    mapNodes: [
      { id: "start", kind: "start", state: "current", title: "Start" },
      { id: "destination", kind: "destination", state: "open", title: "No decisions remain." },
    ],
    determinedRoutes: [],
    trail: [],
    fog: [],
    diagnostics: [],
    summary: {
      total: 0,
      resolved: 0,
      frontier: 0,
      blocked: 0,
      fog: 0,
      blockingDiagnostics: 0,
      warnings: 0,
    },
  };
}

function chartingView(): ChartingView {
  return {
    id: "charting-zero",
    campaignId: "campaign-acde00000006",
    threadId: "thread-zero",
    state: "confirmed",
    messages: [],
    mapCreatedAt: "2026-08-07T00:00:00.000Z",
    rechartQueue: [],
    rechartChanges: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
