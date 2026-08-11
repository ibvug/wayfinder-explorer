import assert from "node:assert/strict";
import test from "node:test";

import type { CampaignProjectView } from "../src/project/model.ts";
import {
  consumeProjectWheel,
  openableProjects,
  projectAfterStep,
  projectDialStep,
  wrapProjectIndex,
} from "../web/src/project-selector.ts";

function project(id: string, status: CampaignProjectView["status"] = "ready"): CampaignProjectView {
  return {
    id,
    name: id,
    root: `C:\\projects\\${id}`,
    managed: true,
    createdAt: "2026-08-11T00:00:00.000Z",
    lastOpenedAt: "2026-08-11T00:00:00.000Z",
    status,
  };
}

test("project selector excludes missing projects and wraps in both directions", () => {
  const projects = openableProjects([
    project("alpha"),
    project("missing", "missing"),
    project("beta"),
    project("gamma", "empty"),
  ]);

  assert.deepEqual(projects.map(({ id }) => id), ["alpha", "beta", "gamma"]);
  assert.equal(projectAfterStep(projects, "alpha", -1)?.id, "gamma");
  assert.equal(projectAfterStep(projects, "gamma", 1)?.id, "alpha");
  assert.equal(projectAfterStep(projects, "alpha", 2)?.id, "gamma");
  assert.equal(wrapProjectIndex(-1, projects.length), 2);
});

test("project selector converts each trackpad burst into one precise reel step", () => {
  assert.deepEqual(consumeProjectWheel(0, 40), { accumulator: 40, steps: 0 });
  assert.deepEqual(consumeProjectWheel(40, 20), { accumulator: 8, steps: 1 });
  assert.deepEqual(consumeProjectWheel(0, -60), { accumulator: -8, steps: -1 });
  assert.deepEqual(consumeProjectWheel(0, 500), { accumulator: 32, steps: 1 });
  assert.deepEqual(consumeProjectWheel(0, -500), { accumulator: -32, steps: -1 });
  assert.equal(projectDialStep(3), 1);
  assert.equal(projectDialStep(-3), -1);
  assert.equal(projectDialStep(0), 0);
});
