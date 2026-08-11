import type { JsonValue } from "../../schemas/codex-app-server/serde_json/JsonValue.ts";
import { validateSafeCommonMark } from "../expedition/proposal.ts";

import type {
  ChartingPhase,
  LegacyReportedChartingPhase,
} from "./model.ts";

const LEGACY_REPORTED_PHASES = [
  "destination",
  "starting_state",
  "ready_for_proposal",
] as const satisfies readonly LegacyReportedChartingPhase[];
const LEGACY_EVIDENCE_SCOPE_PHASE = "evidence_scope";

const MAX_GUIDE_MESSAGE_LENGTH = 12_000;

export interface ChartingTurnContent {
  message: string;
  destinationDraft?: { content: string };
  startingPointDraft?: {
    summary: string;
    evidenceScope: string[];
    evidencePaths: string[];
    evidenceRefs: string[];
  };
  /** Compatibility only: old Agent turns reported phase instead of endpoint drafts. */
  legacyPhase?: LegacyReportedChartingPhase;
}

export function chartingTurnOutputSchema(phase: ChartingPhase): JsonValue {
  const properties: Record<string, JsonValue> = {
    message: { type: "string" },
  };
  if (phase === "destination" || phase === "unresolved") {
    properties.destinationDraft = {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    };
  } else if (phase === "starting_state") {
    properties.startingPointDraft = {
      type: "object",
      properties: {
        summary: { type: "string" },
        evidenceScope: { type: "array", items: { type: "string" } },
        evidencePaths: { type: "array", items: { type: "string" } },
        evidenceRefs: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "evidenceScope", "evidencePaths", "evidenceRefs"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties,
    required: ["message"],
    additionalProperties: false,
  };
}

export function parseChartingTurnContent(text: string): ChartingTurnContent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new ChartingProgressValidationError("Map Agent progress is not valid JSON.", { cause });
  }
  if (!isRecord(decoded) || Object.keys(decoded).some((key) =>
    key !== "message" && key !== "phase" && key !== "destinationDraft" && key !== "startingPointDraft")) {
    throw new ChartingProgressValidationError("Map Agent progress has an invalid shape.");
  }
  if (typeof decoded.message !== "string" || !decoded.message.trim()) {
    throw new ChartingProgressValidationError("Map Agent progress is missing its visible message.");
  }
  const message = decoded.message.trim();
  if (message.length > MAX_GUIDE_MESSAGE_LENGTH) {
    throw new ChartingProgressValidationError("Map Agent progress message is too long.");
  }
  const legacyPhase = decoded.phase === undefined ? undefined : normalizeReportedChartingPhase(decoded.phase);
  if (decoded.phase !== undefined && !legacyPhase) {
    throw new ChartingProgressValidationError("Map Agent progress has an invalid phase.");
  }
  const destinationDraft = parseDestinationDraft(decoded.destinationDraft);
  const startingPointDraft = parseStartingPointDraft(decoded.startingPointDraft);
  if (destinationDraft && startingPointDraft) {
    throw new ChartingProgressValidationError("Map Agent progress cannot propose both endpoints at once.");
  }
  return { message, destinationDraft, startingPointDraft, legacyPhase };
}

export function tryParseChartingTurnContent(text: string): ChartingTurnContent | undefined {
  try {
    return parseChartingTurnContent(text);
  } catch {
    return undefined;
  }
}

export class ChartingProgressValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChartingProgressValidationError";
  }
}

function parseDestinationDraft(value: unknown): { content: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "content")) {
    throw new ChartingProgressValidationError("Destination draft has an invalid shape.");
  }
  const content = safeMarkdown(value.content, "Destination draft", 12_000);
  return { content };
}

function parseStartingPointDraft(value: unknown): ChartingTurnContent["startingPointDraft"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).some((key) =>
    key !== "summary" && key !== "evidenceScope" && key !== "evidencePaths" && key !== "evidenceRefs")) {
    throw new ChartingProgressValidationError("Starting-point draft has an invalid shape.");
  }
  const evidenceScope = stringArray(value.evidenceScope, "Evidence scope", 32, 2_000);
  if (!evidenceScope.length) {
    throw new ChartingProgressValidationError("Starting-point draft must name its evidence scope.");
  }
  return {
    summary: safeMarkdown(value.summary, "Starting-point summary", 16_000),
    evidenceScope,
    evidencePaths: stringArray(value.evidencePaths, "Evidence paths", 128, 4_000),
    evidenceRefs: stringArray(value.evidenceRefs, "Evidence references", 256, 1_000),
  };
}

function safeMarkdown(value: unknown, label: string, maxLength: number): string {
  const markdown = requiredText(value, label, maxLength);
  try {
    validateSafeCommonMark(markdown);
  } catch (cause) {
    throw new ChartingProgressValidationError(`${label} contains unsafe Markdown.`, { cause });
  }
  return markdown;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChartingProgressValidationError(`${label} is empty.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new ChartingProgressValidationError(`${label} is too long.`);
  }
  return text;
}

function stringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ChartingProgressValidationError(`${label} has an invalid size.`);
  }
  return value.map((item) => requiredText(item, label, maxLength));
}

function normalizeReportedChartingPhase(value: unknown): LegacyReportedChartingPhase | undefined {
  if (value === LEGACY_EVIDENCE_SCOPE_PHASE) {
    return "starting_state";
  }
  return typeof value === "string" && (LEGACY_REPORTED_PHASES as readonly string[]).includes(value)
    ? value as LegacyReportedChartingPhase
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
