import assert from "node:assert/strict";
import test from "node:test";

import {
  isRechartProposalMessage,
  parseRechartProposalContent,
  rechartProposalOutputSchema,
} from "../src/charting/rechart-proposal.ts";

test("uses a strict-output-compatible grouped schema for heterogeneous issue changes", () => {
  const schema = rechartProposalOutputSchema(
    ["campaign:revision", "location:01:answer"],
    ["01", "02", "03"],
  );

  assert.equal(containsSchemaCombinator(schema), false);
  assert.deepEqual(
    Object.keys((schema as Record<string, any>).properties.issueChanges.properties),
    ["creates", "updates", "pendingDeletes", "ends"],
  );
  const issueChanges = (schema as Record<string, any>).properties.issueChanges.properties;
  assert.deepEqual(issueChanges.creates.items.properties.blockedBy.items.enum, ["01", "02", "03"]);
  assert.deepEqual(issueChanges.updates.items.properties.issueId.enum, ["01", "02", "03"]);
});

test("parses grouped structured-output issue changes into the domain union", () => {
  const text = JSON.stringify({
    issueChanges: {
      creates: [{
        key: "new-decision",
        title: "新增决定",
        type: "grilling",
        question: "现在需要决定什么？",
        blockedBy: [],
        reason: "答案显露了一个新的自然决定。",
      }],
      updates: [{
        issueId: "02",
        title: "更新后的决定",
        type: "prototype",
        question: "新的问题是什么？",
        blockedBy: ["01"],
        reason: "已确认答案改变了问题。",
      }],
      pendingDeletes: [{ issueId: "03", reason: "已不再需要。" }],
      ends: [],
    },
    fog: [],
    outOfScope: ["联网"],
    reviewConflicts: [],
    explorationUpdates: [],
    summary: "地图已协调。",
    evidenceRefs: ["location:01:answer"],
  });

  const parsed = parseRechartProposalContent(
    text,
    new Set(["campaign:revision", "location:01:answer"]),
  );

  assert.deepEqual(parsed.issueChanges.map(({ kind }) => kind), [
    "create",
    "update",
    "pending_delete",
  ]);
  assert.equal(isRechartProposalMessage(text), true);
});

function containsSchemaCombinator(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSchemaCombinator);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("oneOf" in record || "anyOf" in record || "allOf" in record) {
    return true;
  }
  return Object.values(record).some(containsSchemaCombinator);
}
