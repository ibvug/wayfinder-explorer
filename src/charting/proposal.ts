import type { JsonValue } from "../../schemas/codex-app-server/serde_json/JsonValue.ts";
import { validateSafeCommonMark } from "../expedition/proposal.ts";
import type {
  ChartingRecord,
  MapProposalContent,
  MapTicketProposal,
} from "./model.ts";

const MAX_TITLE_LENGTH = 120;
const MAX_DESTINATION_LENGTH = 4_000;
const MAX_STARTING_STATE_LENGTH = 4_000;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_LIST_ITEMS = 24;
const MAX_LIST_ITEM_LENGTH = 1_000;
const MAX_TICKETS = 20;
const MIN_TICKETS = 0;
const TICKET_TYPES = ["grilling", "prototype", "research", "task"] as const;

export function mapProposalEvidenceRefs(charting: ChartingRecord): string[] {
  return [...new Set(charting.messages.flatMap(({ turnId }) =>
    turnId ? [`turn:${turnId}`] : []))].sort((left, right) => left.localeCompare(right, "en"));
}

export function mapProposalOutputSchema(evidenceRefs: string[]): JsonValue {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      destination: { type: "string" },
      startingState: { type: "string" },
      evidenceScope: stringArraySchema(),
      notes: stringArraySchema(),
      tickets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            type: { type: "string", enum: [...TICKET_TYPES] },
            question: { type: "string" },
            blockedBy: stringArraySchema(),
          },
          required: ["key", "title", "type", "question", "blockedBy"],
          additionalProperties: false,
        },
      },
      fog: stringArraySchema(),
      outOfScope: stringArraySchema(),
      evidenceRefs: {
        type: "array",
        items: { type: "string", enum: evidenceRefs },
      },
    },
    required: [
      "title",
      "destination",
      "startingState",
      "evidenceScope",
      "notes",
      "tickets",
      "fog",
      "outOfScope",
      "evidenceRefs",
    ],
    additionalProperties: false,
  };
}

export function buildMapProposalPrompt(projectName: string, evidenceRefs: string[]): string {
  return `现在请把这次绘图讨论收束为一份“待玩家审阅的首版地图草案”。

要求：
- 项目名是「${projectName}」。title 是地图标题，destination 是这段旅程最终要抵达的可观察结果。
- startingState 是玩家确认的固定现状基线；evidenceScope 是形成该基线时共同约定、实际使用过的取证边界。不要把后来可能发生的变化写入起点。
- Wayfinder 只是设计启发，不是绘图契约。不要采用预设的 breadth-first 层级，也不要为了画出完整路线而发明议题。
- tickets 记录起点与目的地之间当前已经能够稳定表达、且各自需要独立探索或新事实的自然议题，最多 ${MAX_TICKETS} 个；既可以是立即可探索议题，也可以是具有真实前置依赖的受阻议题。如果当前没有这样的议题，可以为空。每个 key 使用唯一的小写 ASCII kebab-case；blockedBy 只能引用同一草案里的 key。
- 保证依赖无环。不要为了制造多个 frontier 或依赖边而拆分同一个自然决策；一个连贯探索能解决的条件分支属于同一个 ticket。当前选中节点不属于地图草案。
- type 只使用 grilling、prototype、research、task。判断尚不清楚用 grilling；具体形态需要试做用 prototype；需要外部事实用 research；明确执行工作才用 task。
- fog 记录目前只能看见主题、还不能稳定表述成 ticket 的未知区域。outOfScope 记录明确不进入这段旅程的边界。
- tickets 在答案确认前都只是待探索议题，不是地图节点或确定路线。首张地图的正式节点只有起点和目的地；不要解决任何 ticket，不要填写 Answer，不要生成 Decisions so far，也不要连接起点与目的地。
- 忠实反映玩家在本线程表达的目标与边界，不替玩家补造偏好或事实。
- evidenceRefs 只能从下方标识中选择，并至少引用一个绘图 turn。
- 所有文本使用简体中文。不要使用 HTML、图片、元数据行或会破坏 Markdown 层级的标题。
- 只返回符合输出结构的 JSON，不要追加说明或问题。

可用 evidenceRefs：
${evidenceRefs.map((reference) => `- ${reference}`).join("\n")}`;
}

export function parseMapProposalContent(
  text: string,
  allowedEvidenceRefs: ReadonlySet<string>,
): MapProposalContent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new MapProposalValidationError("Codex 返回的地图草案不是有效 JSON。", { cause });
  }
  if (!isRecord(decoded)) {
    throw new MapProposalValidationError("Codex 返回的地图草案不是对象。");
  }
  const expectedKeys = new Set([
    "title",
    "destination",
    "startingState",
    "evidenceScope",
    "notes",
    "tickets",
    "fog",
    "outOfScope",
    "evidenceRefs",
  ]);
  if (Object.keys(decoded).some((key) => !expectedKeys.has(key))) {
    throw new MapProposalValidationError("Codex 返回的地图草案包含未允许的字段。");
  }

  const title = singleLine(decoded.title, "title", MAX_TITLE_LENGTH);
  const destination = safeSection(decoded.destination, "destination", MAX_DESTINATION_LENGTH);
  const startingState = safeSection(
    decoded.startingState,
    "startingState",
    MAX_STARTING_STATE_LENGTH,
  );
  const evidenceScope = stringList(decoded.evidenceScope, "evidenceScope");
  if (!evidenceScope.length) {
    throw new MapProposalValidationError("地图草案必须记录至少一项取证范围。");
  }
  const notes = stringList(decoded.notes, "notes");
  const fog = stringList(decoded.fog, "fog");
  const outOfScope = stringList(decoded.outOfScope, "outOfScope");
  const evidenceRefs = stringList(decoded.evidenceRefs, "evidenceRefs");
  if (!evidenceRefs.length) {
    throw new MapProposalValidationError("地图草案必须引用至少一个绘图 turn。");
  }
  for (const reference of evidenceRefs) {
    if (!allowedEvidenceRefs.has(reference)) {
      throw new MapProposalValidationError(`地图草案引用了无法解析的证据 ${reference}。`);
    }
  }

  if (!Array.isArray(decoded.tickets) || decoded.tickets.length < MIN_TICKETS || decoded.tickets.length > MAX_TICKETS) {
    throw new MapProposalValidationError(`地图草案必须包含 ${MIN_TICKETS} 到 ${MAX_TICKETS} 个待探索议题。`);
  }
  const tickets = decoded.tickets.map((value, index) => parseTicket(value, index));
  validateTicketGraph(tickets);
  return {
    title,
    destination,
    startingState,
    evidenceScope,
    notes,
    tickets,
    fog,
    outOfScope,
    evidenceRefs: [...new Set(evidenceRefs)],
  };
}

export function isMapProposalMessage(text: string): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.evidenceRefs)) {
    return false;
  }
  const refs = decoded.evidenceRefs.filter((value): value is string => typeof value === "string");
  if (refs.length !== decoded.evidenceRefs.length) {
    return false;
  }
  try {
    parseMapProposalContent(text, new Set(refs));
    return true;
  } catch {
    return false;
  }
}

export class MapProposalValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message.trim(), options);
    this.name = "MapProposalValidationError";
  }
}

function parseTicket(value: unknown, index: number): MapTicketProposal {
  if (!isRecord(value)) {
    throw new MapProposalValidationError(`ticket ${index + 1} 不是对象。`);
  }
  const expectedKeys = new Set(["key", "title", "type", "question", "blockedBy"]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new MapProposalValidationError(`ticket ${index + 1} 包含未允许的字段。`);
  }
  const key = singleLine(value.key, `tickets[${index}].key`, 64);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
    throw new MapProposalValidationError(`ticket ${key} 的 key 必须是小写 ASCII kebab-case。`);
  }
  const title = singleLine(value.title, `tickets[${index}].title`, MAX_TITLE_LENGTH);
  const question = safeSection(value.question, `tickets[${index}].question`, MAX_QUESTION_LENGTH);
  if (!TICKET_TYPES.includes(value.type as (typeof TICKET_TYPES)[number])) {
    throw new MapProposalValidationError(`ticket ${key} 的 type 不受支持。`);
  }
  const blockedBy = stringList(value.blockedBy, `tickets[${index}].blockedBy`);
  return { key, title, type: value.type as MapTicketProposal["type"], question, blockedBy };
}

function validateTicketGraph(tickets: MapTicketProposal[]): void {
  const keys = new Set<string>();
  for (const ticket of tickets) {
    if (keys.has(ticket.key)) {
      throw new MapProposalValidationError(`地图草案包含重复 ticket key ${ticket.key}。`);
    }
    keys.add(ticket.key);
  }
  for (const ticket of tickets) {
    if (new Set(ticket.blockedBy).size !== ticket.blockedBy.length) {
      throw new MapProposalValidationError(`ticket ${ticket.key} 包含重复依赖。`);
    }
    for (const blocker of ticket.blockedBy) {
      if (!keys.has(blocker)) {
        throw new MapProposalValidationError(`ticket ${ticket.key} 引用了不存在的依赖 ${blocker}。`);
      }
      if (blocker === ticket.key) {
        throw new MapProposalValidationError(`ticket ${ticket.key} 不能依赖自身。`);
      }
    }
  }
  const ticketsByKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) {
      throw new MapProposalValidationError(`ticket 依赖图包含经过 ${key} 的环。`);
    }
    if (visited.has(key)) {
      return;
    }
    visiting.add(key);
    for (const blocker of ticketsByKey.get(key)?.blockedBy ?? []) {
      visit(blocker);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const ticket of tickets) {
    visit(ticket.key);
  }
}

function safeSection(value: unknown, name: string, maximum: number): string {
  const text = requiredString(value, name, maximum);
  validateSafeCommonMark(text);
  if (/^ {0,3}#{1,6}(?:\s|$)/m.test(text) || /^(?:Type|Status|Blocked by):/im.test(text)) {
    throw new MapProposalValidationError(`地图草案 ${name} 不能包含标题或 ticket 元数据行。`);
  }
  return text;
}

function singleLine(value: unknown, name: string, maximum: number): string {
  const text = requiredString(value, name, maximum);
  if (/\r|\n/.test(text) || /^\s*[-*+]\s/.test(text)) {
    throw new MapProposalValidationError(`地图草案 ${name} 必须是单行文本。`);
  }
  validateSafeCommonMark(text);
  return text;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new MapProposalValidationError(`地图草案 ${name} 必须是最多 ${MAX_LIST_ITEMS} 项的数组。`);
  }
  return value.map((item) => singleLine(item, name, MAX_LIST_ITEM_LENGTH));
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MapProposalValidationError(`地图草案 ${name} 必须是非空文本。`);
  }
  if (value.length > maximum) {
    throw new MapProposalValidationError(`地图草案 ${name} 超过 ${maximum} 个字符。`);
  }
  return value.trim();
}

function stringArraySchema(): JsonValue {
  return { type: "array", items: { type: "string" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
