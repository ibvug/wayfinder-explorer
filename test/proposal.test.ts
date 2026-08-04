import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDecisionProposalContent,
  ProposalValidationError,
  validateSafeCommonMark,
} from "../src/expedition/proposal.ts";

const allowedEvidence = new Set([
  "campaign:destination",
  "location:08:question",
  "turn:turn-1",
]);

test("accepts a schema-valid decision proposal and resolves every evidence reference", () => {
  const proposal = parseDecisionProposalContent(JSON.stringify({
    answerMarkdown: "V1 必须通过一条 **写入到召回** 的端到端路径。",
    rationale: ["它形成最小但完整的产品闭环。"],
    evidenceRefs: ["location:08:question", "turn:turn-1"],
    rejectedAlternatives: ["只验收单个存储接口。"],
    assumptions: ["调用方能提供稳定的测试输入。"],
    revisitConditions: ["首个真实集成出现不同的主路径。"],
    confidence: "high",
  }), allowedEvidence);

  assert.equal(proposal.confidence, "high");
  assert.deepEqual(proposal.evidenceRefs, ["location:08:question", "turn:turn-1"]);
});

test("rejects hostile Markdown and unresolved evidence references", () => {
  assert.throws(
    () => validateSafeCommonMark("<script>alert(1)</script>"),
    ProposalValidationError,
  );
  assert.throws(
    () => validateSafeCommonMark("![secret](file:///tmp/secret)"),
    ProposalValidationError,
  );
  assert.throws(
    () => parseDecisionProposalContent(JSON.stringify({
      answerMarkdown: "[打开](javascript:alert(1))",
      rationale: [],
      evidenceRefs: ["turn:unknown"],
      rejectedAlternatives: [],
      assumptions: [],
      revisitConditions: [],
      confidence: "medium",
    }), allowedEvidence),
    ProposalValidationError,
  );
});
