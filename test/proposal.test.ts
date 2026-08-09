import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDecisionProposalContent,
  ProposalValidationError,
  validateSafeCommonMark,
} from "../src/expedition/proposal.ts";
import {
  buildMapProposalPrompt,
  parseMapProposalContent,
} from "../src/charting/proposal.ts";

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

test("a first map accepts one complete natural decision without manufacturing another frontier", () => {
  const proposal = parseMapProposalContent(JSON.stringify({
    title: "单一自然决策",
    notes: [],
    tickets: [{
      key: "choose-runtime-if-needed",
      title: "判断并选择持久任务运行时",
      type: "grilling",
      question: "是否需要持久任务运行时；如果需要，哪一种方案满足恢复要求？",
      blockedBy: [],
    }],
    fog: [],
    outOfScope: ["现实开发执行"],
    evidenceRefs: ["turn:charting-1"],
  }), new Set(["turn:charting-1"]));

  assert.equal(proposal.tickets.length, 1);
  assert.equal(proposal.tickets[0].key, "choose-runtime-if-needed");
});

test("first-map instructions follow Explorer issue semantics instead of breadth-first layers", () => {
  const prompt = buildMapProposalPrompt(
    "Explorer flow",
    ["turn:charting-1"],
    "明确是否采用持久任务运行时。",
    "当前只有一个同步脚本。",
    ["当前项目目录"],
  );

  assert.match(prompt, /Wayfinder 只是设计启发，不是绘图契约/);
  assert.match(prompt, /只有起点和目的地两个节点/);
  assert.match(prompt, /待探索议题，不是地图节点或确定路线/);
  assert.match(prompt, /输出结构故意没有端点字段/);
  assert.match(prompt, /预览并明确确认后才写入地图/);
  assert.doesNotMatch(prompt, /采用 Wayfinder 的 breadth-first charting/);
});
