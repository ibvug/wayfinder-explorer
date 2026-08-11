import { createElement, Fragment } from "react";

import type { ChartingPhase } from "../../src/charting/model.ts";

export const START_CHARTING_ACTION_LABEL = "开始绘图";

export function chartingPhaseHeading(phase: ChartingPhase): string {
  if (phase === "destination") {
    return "地图 Agent 正在与你建立目的地";
  }
  if (phase === "starting_state") {
    return "地图 Agent 正在与你建立起点";
  }
  if (phase === "ready_for_proposal") {
    return "目的地与起点已建立，可以形成首张地图草案";
  }
  return "正在同步地图 Agent 会话";
}

const STEPS = [
  { title: "建立目的地", detail: "明确可观察结果与稳定边界" },
  { title: "建立起点", detail: "沟通背景，必要时定向取证并确认固定基线" },
  { title: "绘制首张地图", detail: "议题仍是议题，不提前生成节点或路线" },
  { title: "逐题探索并重绘", detail: "答案明确确认后才成为节点" },
] as const;

const PHASE_STEP: Record<Exclude<ChartingPhase, "unresolved">, number> = {
  destination: 0,
  starting_state: 1,
  ready_for_proposal: 2,
};

export function ChartingProgressSteps({ phase }: { phase: ChartingPhase }) {
  const current = phase === "unresolved" ? undefined : PHASE_STEP[phase];
  return createElement(
    Fragment,
    null,
    current === undefined
      ? createElement(
          "p",
          { className: "charting-phases__sync", role: "status" },
          "正在从同一个地图 Agent 会话同步当前阶段；同步完成前不会开放首图草案。",
        )
      : null,
    createElement(
      "ol",
      { className: "charting-phases", "data-charting-phase": phase },
      STEPS.map((step, index) => {
        const className = current === undefined
          ? undefined
          : index < current
            ? "is-done"
            : index === current
              ? "is-current"
              : undefined;
        return createElement(
          "li",
          {
            className,
            "aria-current": index === current ? "step" : undefined,
            key: step.title,
          },
          createElement("b", null, String(index + 1).padStart(2, "0")),
          createElement(
            "span",
            null,
            createElement("strong", null, step.title),
            createElement("small", null, step.detail),
          ),
        );
      }),
    ),
  );
}
