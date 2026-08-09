import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  chartingPhaseHeading,
  ChartingProgressSteps,
  START_CHARTING_ACTION_LABEL,
} from "../web/src/ChartingProgress.ts";
import {
  ChartingProgressValidationError,
  parseChartingTurnContent,
} from "../src/charting/progress.ts";

test("keeps destination clarification inside the existing start-charting operation", () => {
  assert.equal(START_CHARTING_ACTION_LABEL, "开始绘图");
});

test("names the visible Map Agent work after the Explorer-owned stage", () => {
  assert.equal(chartingPhaseHeading("destination"), "地图 Agent 正在与你建立目的地");
  assert.equal(chartingPhaseHeading("starting_state"), "地图 Agent 正在与你建立起点");
  assert.equal(
    chartingPhaseHeading("ready_for_proposal"),
    "目的地与起点已建立，可以形成首张地图草案",
  );
});

test("renders exactly the endpoint stage persisted by Explorer", () => {
  const destination = renderToStaticMarkup(createElement(ChartingProgressSteps, {
    phase: "destination",
  }));
  assert.match(currentStep(destination), /建立目的地/);

  const startingState = renderToStaticMarkup(createElement(ChartingProgressSteps, {
    phase: "starting_state",
  }));
  assert.match(startingState, /class="is-done"[^>]*>.*建立目的地/s);
  assert.match(currentStep(startingState), /建立起点/);
  assert.doesNotMatch(startingState, /确认取证范围/);
  assert.equal((startingState.match(/<li/g) ?? []).length, 4);

  const ready = renderToStaticMarkup(createElement(ChartingProgressSteps, {
    phase: "ready_for_proposal",
  }));
  assert.match(currentStep(ready), /绘制首张地图/);
  assert.doesNotMatch(currentStep(ready), /逐题探索并重绘/);
});

test("does not guess a phase for a legacy conversation without persisted progress", () => {
  const markup = renderToStaticMarkup(createElement(ChartingProgressSteps, {
    phase: "unresolved",
  }));
  assert.match(markup, /正在从同一个地图 Agent 会话同步当前阶段/);
  assert.doesNotMatch(markup, /aria-current="step"/);
});

test("rejects unsafe endpoint drafts before they can be confirmed", () => {
  assert.throws(
    () => parseChartingTurnContent(JSON.stringify({
      message: "请确认。",
      destinationDraft: { content: "<script>alert(1)</script>" },
    })),
    ChartingProgressValidationError,
  );
  assert.throws(
    () => parseChartingTurnContent(JSON.stringify({
      message: "请确认。",
      startingPointDraft: {
        summary: "![本地文件](file:///tmp/private)",
        evidenceScope: ["当前项目目录"],
        evidencePaths: [],
        evidenceRefs: ["turn:one"],
      },
    })),
    ChartingProgressValidationError,
  );
});

function currentStep(markup: string): string {
  return /<li class="is-current" aria-current="step">([\s\S]*?)<\/li>/.exec(markup)?.[1] ?? "";
}
