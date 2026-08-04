import type { JsonValue } from "../../schemas/codex-app-server/serde_json/JsonValue.ts";
import type { CampaignProjection, Location } from "../model.ts";
import type {
  DecisionProposalContent,
  ExpeditionRecord,
} from "./model.ts";

const MAX_ANSWER_LENGTH = 20_000;
const MAX_LIST_ITEMS = 24;
const MAX_LIST_ITEM_LENGTH = 2_000;

export function proposalEvidenceRefs(
  campaign: CampaignProjection,
  expedition: ExpeditionRecord,
): string[] {
  const references = new Set<string>([
    "campaign:destination",
    "campaign:out-of-scope",
  ]);
  for (const location of campaign.locations) {
    references.add(`location:${location.id}:question`);
    if (location.answerMarkdown) {
      references.add(`location:${location.id}:answer`);
    }
  }
  for (const message of expedition.messages) {
    if (message.turnId) {
      references.add(`turn:${message.turnId}`);
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right, "en"));
}

export function decisionProposalOutputSchema(evidenceRefs: string[]): JsonValue {
  return {
    type: "object",
    properties: {
      answerMarkdown: { type: "string" },
      rationale: stringArraySchema(),
      evidenceRefs: {
        type: "array",
        items: evidenceRefs.length
          ? { type: "string", enum: evidenceRefs }
          : { type: "string", enum: [] },
      },
      rejectedAlternatives: stringArraySchema(),
      assumptions: stringArraySchema(),
      revisitConditions: stringArraySchema(),
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: [
      "answerMarkdown",
      "rationale",
      "evidenceRefs",
      "rejectedAlternatives",
      "assumptions",
      "revisitConditions",
      "confidence",
    ],
    additionalProperties: false,
  };
}

export function buildProposalPrompt(
  campaign: CampaignProjection,
  location: Location,
  evidenceRefs: string[],
): string {
  return `现在请把这次探索收束为一份“待玩家审阅的决策草案”。

要求：
- 只解决地点 ${location.id}「${location.title}」的问题。
- answerMarkdown 写成确认后可直接进入该 issue 的 Answer 正文；它不是已确认决定，不要声称已写入。
- 忠实反映玩家在本线程表达的判断，不替玩家补造偏好或事实。
- rationale 解释为何这个答案服务于目的地；rejectedAlternatives 记录讨论后未选的路线。
- assumptions 与 revisitConditions 必须具体；没有内容时返回空数组。
- evidenceRefs 只能从下面给定的标识中选择；至少引用当前问题和一个相关探索 turn（如果列表中存在 turn 标识）。
- answerMarkdown 只使用安全 CommonMark：可用段落、标题、列表、强调和行内代码；不要使用 HTML、图片或不安全链接。
- 只返回符合输出结构的 JSON 数据，不要追加问题或说明。

当前目的地：${campaign.destination}
当前问题：${location.question}

可用 evidenceRefs：
${evidenceRefs.map((reference) => `- ${reference}`).join("\n")}`;
}

export function parseDecisionProposalContent(
  text: string,
  allowedEvidenceRefs: ReadonlySet<string>,
): DecisionProposalContent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new ProposalValidationError("Codex 返回的草案不是有效 JSON。", { cause });
  }
  if (!isRecord(decoded)) {
    throw new ProposalValidationError("Codex 返回的草案不是对象。 ");
  }
  const expectedKeys = new Set([
    "answerMarkdown",
    "rationale",
    "evidenceRefs",
    "rejectedAlternatives",
    "assumptions",
    "revisitConditions",
    "confidence",
  ]);
  if (Object.keys(decoded).some((key) => !expectedKeys.has(key))) {
    throw new ProposalValidationError("Codex 返回的草案包含未允许的字段。 ");
  }

  const answerMarkdown = requiredString(decoded.answerMarkdown, "answerMarkdown", MAX_ANSWER_LENGTH);
  validateSafeCommonMark(answerMarkdown);
  const rationale = stringList(decoded.rationale, "rationale");
  const evidenceRefs = stringList(decoded.evidenceRefs, "evidenceRefs");
  if (!evidenceRefs.length) {
    throw new ProposalValidationError("草案必须引用至少一项可解析证据。");
  }
  const rejectedAlternatives = stringList(decoded.rejectedAlternatives, "rejectedAlternatives");
  const assumptions = stringList(decoded.assumptions, "assumptions");
  const revisitConditions = stringList(decoded.revisitConditions, "revisitConditions");
  if (
    decoded.confidence !== "low" &&
    decoded.confidence !== "medium" &&
    decoded.confidence !== "high"
  ) {
    throw new ProposalValidationError("草案 confidence 必须是 low、medium 或 high。 ");
  }
  for (const reference of evidenceRefs) {
    if (!allowedEvidenceRefs.has(reference)) {
      throw new ProposalValidationError(`草案引用了无法解析的证据 ${reference}。`);
    }
  }

  return {
    answerMarkdown,
    rationale,
    evidenceRefs: [...new Set(evidenceRefs)],
    rejectedAlternatives,
    assumptions,
    revisitConditions,
    confidence: decoded.confidence,
  };
}

export function validateSafeCommonMark(markdown: string): void {
  if (/<!--[\s\S]*?-->|<\s*\/?\s*[A-Za-z][^>]*>/.test(markdown)) {
    throw new ProposalValidationError("草案答案不能包含原始 HTML。 ");
  }
  if (/!\s*\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/.test(markdown)) {
    throw new ProposalValidationError("草案答案不能包含图片。 ");
  }
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(markdown)) {
    throw new ProposalValidationError("草案答案包含不允许的控制字符。 ");
  }
  for (const match of markdown.matchAll(/\[[^\]]+\]\(\s*([^\s)]+)[^)]*\)/g)) {
    const destination = match[1].replace(/^<|>$/g, "");
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(destination)?.[1].toLowerCase();
    if (scheme && scheme !== "https" && scheme !== "http") {
      throw new ProposalValidationError(`草案答案包含不安全链接协议 ${scheme}:。`);
    }
  }
}

export class ProposalValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message.trim(), options);
    this.name = "ProposalValidationError";
  }
}

function stringArraySchema(): JsonValue {
  return {
    type: "array",
    items: { type: "string" },
  };
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProposalValidationError(`草案 ${name} 必须是非空文本。`);
  }
  if (value.length > maximum) {
    throw new ProposalValidationError(`草案 ${name} 超过 ${maximum} 个字符。`);
  }
  return value.trim();
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new ProposalValidationError(`草案 ${name} 必须是最多 ${MAX_LIST_ITEMS} 项的数组。`);
  }
  return value.map((item) => requiredString(item, name, MAX_LIST_ITEM_LENGTH));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
