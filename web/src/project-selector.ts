import type { CampaignProjectView } from "../../src/project/model.ts";

export const PROJECT_WHEEL_STEP_PX = 52;

export function openableProjects(projects: readonly CampaignProjectView[]): CampaignProjectView[] {
  return projects.filter(({ status }) => status !== "missing");
}

export function wrapProjectIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return ((index % length) + length) % length;
}

export function projectAfterStep(
  projects: readonly CampaignProjectView[],
  currentId: string | undefined,
  delta: number,
): CampaignProjectView | undefined {
  if (projects.length === 0) {
    return undefined;
  }
  const currentIndex = Math.max(0, projects.findIndex(({ id }) => id === currentId));
  return projects[wrapProjectIndex(currentIndex + delta, projects.length)];
}

export function consumeProjectWheel(
  accumulator: number,
  delta: number,
): { accumulator: number; steps: number } {
  const total = accumulator + delta;
  const rawSteps = Math.trunc(total / PROJECT_WHEEL_STEP_PX);
  const steps = Math.max(-2, Math.min(2, rawSteps));
  return {
    accumulator: total - steps * PROJECT_WHEEL_STEP_PX,
    steps,
  };
}
