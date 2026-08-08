# Spec：已确认答案修订与 Explorer 侧影响协调

Status: ready-for-agent

## Problem Statement

探索者在一次目标探索中会不断获得新认识，但 Explorer 当前把确认答案视为不可替换的终点：已经带有 Answer 的议题不能再次写回，已经确认的探索也不能继续形成替代答案。探索者如果发现早先判断不再支持抵达目的地，只能手工修改 Wayfinder Markdown、建立新的目标探索，或者让地图继续展示已经失效的确定路线。

手工修正不仅会丢失旧答案的历史，还会把一致性维护责任推给探索者。上游答案变化可能影响已确认答案、尚未开始的议题、正在探索状态、答案草案、路线和当前前沿；探索者无法可靠地逐项找出并同步所有显式依赖与语义关联。当前投影也只有 open/resolved 两种来源状态，无法表达“节点仍然存在，但它的答案因真实冲突而待复核”，因此一旦允许修订，地图很容易在节点身份、确定路线和抵达判定之间自相矛盾。

本 spec 先实现 Explorer 一侧的完整修订、协调提案验证、预览、确认、持久化和恢复流程，并只通过最高层 HTTP/API seam 验收。验收测试使用确定性的 fake 提供地图变化提案，不启动真实 Agent 或 Codex。真实 Agent 运行时适配器及其独立契约测试留给后续 spec。

## Solution

探索者可以在同一次目标探索中重新打开已经确认的地图节点，沿用现有“继续讨论 → 形成草案 → 预览地图变化 → 确认写回”操作形成替代答案。Explorer 明确区分答案草案、确认答案和修订答案：只有探索者确认后，替代答案才成为当前已解决事实；旧答案作为历史保留，不被原地覆盖或删除。

修订不会创建重复节点或另一张地图。原地图节点保持身份和布局位置，当前答案、答案历史及其路线有效性分别投影。Explorer 把已确认答案及其上下文交给一个地图变化提案边界，接收针对整次目标探索的结构化协调提案。该提案可以包含可推导的议题、关系、路线、探索上下文和答案草案变化，也可以指出无法从既有意图可靠解决的真实判断冲突。Explorer 自己负责校验提案、以精确源 revision 进行内存投影、展示预览并在用户确认后安全写回；提案提供者不能直接修改规范地图内容。

机械且可推导的变化由 Explorer 在一次协调中应用，不要求探索者逐项批准。只有真实判断冲突才产生待复核答案。待复核答案仍是同一个地图节点，保留答案和历史，但暂时不作为当前确定事实，其相关连接不属于确定路线，并阻止抵达目的地。探索者仍通过原有讨论和确认操作复核：可以确认原答案仍成立，也可以确认替代答案。

答案确认与随后派生的影响协调具有明确的恢复边界。探索者的确认一旦被耐久记录，就不会因为协调或重新绘图失败而回滚；系统进入待重新绘图状态，自动或立即重试，并暂停从旧前沿开始新探索及后续答案确认。已经开始的无关探索可以继续。多个接近同时发生的确认按照确认顺序依次协调，后一个总是基于包含前一个结果的最新地图。

## User Stories

1. As an 探索者, I want to reopen a previously confirmed map node, so that I can reconsider an answer when later learning changes my judgment.
2. As an 探索者, I want to continue the original discussion for a confirmed answer, so that I do not have to reconstruct the reasoning in a new conversation.
3. As an 探索者, I want the current confirmed answer to remain visible while I discuss a possible revision, so that exploration does not silently change established facts.
4. As an 探索者, I want a revised proposal to remain only an 答案草案 until I explicitly confirm it, so that experimentation cannot alter the map.
5. As an 探索者, I want to preview all map changes caused by a replacement answer, so that I understand the effect before confirming it.
6. As an 探索者, I want confirmation to make the replacement answer the current answer, so that the map reflects my latest judgment.
7. As an 探索者, I want the old answer retained as history, so that the path by which my understanding changed remains inspectable.
8. As an 探索者, I want a revised answer to keep the same map node identity, so that revision does not create a duplicate decision.
9. As an 探索者, I want a revised node to keep its saved map position, so that the visual map does not jump when only the answer changes.
10. As an 探索者, I want the node to display which answer is current, so that historical answers are not mistaken for active facts.
11. As an 探索者, I want the map to remove connections no longer supported by current answers from the 确定路线, so that an invalid route is not presented as settled.
12. As an 探索者, I want explicitly dependent content to be reconsidered after an upstream revision, so that the graph remains internally consistent.
13. As an 探索者, I want semantically related content to be considered even without a declared dependency edge, so that meaningful downstream effects are not missed.
14. As an 探索者, I want mechanically derivable issue and route changes applied together, so that I do not have to maintain several representations manually.
15. As an 探索者, I want unchanged issues and routes to remain untouched, so that coordination does not produce gratuitous churn.
16. As an 探索者, I want only genuine conflicts in my earlier judgments returned to me, so that I spend attention on decisions rather than bookkeeping.
17. As an 探索者, I want each genuine conflict expressed as one focused review question, so that I can understand exactly what judgment must be revisited.
18. As an 探索者, I want a 待复核答案 to remain on the same map node with its history intact, so that uncertainty does not erase prior exploration.
19. As an 探索者, I want a 待复核答案 to stop supporting a 确定路线, so that the map is honest about unsettled premises.
20. As an 探索者, I want a 待复核答案 to block 抵达目的地, so that the Explorer cannot declare the decision path closed while a real conflict remains.
21. As an 探索者, I want to confirm that a reviewed answer still stands, so that a false alarm can be resolved without creating a replacement node.
22. As an 探索者, I want to revise a reviewed answer through the same proposal and confirmation flow, so that review does not introduce a parallel workflow.
23. As an 探索者, I want an unrelated 正在探索状态 to continue unchanged, so that one answer revision does not disrupt independent work.
24. As an 探索者, I want a related 正在探索状态 to retain its identity, conversation, and claim while receiving updated premises, so that existing exploration is coordinated instead of discarded.
25. As an 探索者, I want prior draft content retained in history when its premise changes, so that useful thinking is not lost.
26. As an 探索者, I want only a currently coordinated draft to be confirmable, so that stale premises cannot enter the map as facts.
27. As an 探索者, I want the Explorer to show the coordinated draft or the unresolved conflict, so that I do not have to manually compare internal representations.
28. As an 探索者, I want the confirmation itself to survive a subsequent coordination failure, so that my explicit judgment is never silently undone.
29. As an 探索者, I want a newly confirmed node or replacement answer shown immediately while the map is 待重新绘图, so that confirmed facts remain visible.
30. As an 探索者, I want the last successful frontier to be marked as stale while coordination is pending, so that incomplete recomputation is not presented as current.
31. As an 探索者, I want existing explorations to remain available while the map is 待重新绘图, so that a derived failure does not stop unrelated thinking.
32. As an 探索者, I want new exploration starts blocked while the frontier is stale, so that no new claim is based on known-outdated issues.
33. As an 探索者, I want later confirmations queued while coordination is pending, so that global changes cannot be applied out of order.
34. As an 探索者, I want automatic retry and an immediate retry action after coordination failure, so that recovery does not require reconfirming my answer.
35. As an 探索者, I want multiple near-simultaneous confirmations processed in confirmation order, so that each coordination sees all previously confirmed facts.
36. As an 探索者, I want an external Markdown edit after preview to cause a conflict instead of being overwritten, so that my manual work is preserved.
37. As an 探索者, I want a restart during preview, confirmation, or coordination to recover to an honest state, so that crashes cannot leave half-applied map semantics.
38. As an 探索者, I want old campaigns with one Answer per resolved issue to open without manual migration, so that this feature does not strand existing maps.
39. As an 探索者, I want existing map selection, discussion, draft, preview, and confirmation operations to retain their meanings, so that answer revision feels like an extension of the current product.
40. As an 探索者, I want restored issues and pending deletions to continue following their existing one-rechart semantics, so that revision does not create permanent protection or deletion commands.
41. As an 探索者, I want the final successful rechart to close or archive unneeded unstarted issues before arrival, so that a revised map still uses the established completion rule.
42. As an 探索者, I want arrival to remain impossible while open issues, active explorations, fog, pending review, or pending rechart remain, so that 抵达目的地 continues to mean a closed decision path.
43. As a project maintainer, I want malformed or over-broad coordination proposals rejected before canonical writes, so that a fake or future real coordinator cannot bypass Explorer invariants.
44. As a project maintainer, I want coordination events and answer history to replay deterministically, so that restarts produce the same visible state without calling a coordinator again unnecessarily.
45. As a project maintainer, I want the first acceptance suite to run without a real Agent or Codex process, so that the Explorer-side behavior is fast, deterministic, and independently testable.

## Implementation Decisions

- This first spec owns the Explorer-side domain, application, persistence, API, and UI behavior for revision and coordinated map changes. It defines a map-change proposal interface and tests it with a deterministic fake. A real Agent runtime adapter is not part of this spec.
- The Campaign projection will distinguish a node's stable identity, current-answer state, answer history, review state, and route validity. A previously confirmed node remains projected even when its answer is pending review.
- A new issue that has never had a confirmed answer still does not become a map node. Pending review is available only to an existing confirmed node and must not blur the boundary between 议题 and 地图节点.
- The canonical issue representation will be extended in a backward-compatible way to preserve one current answer plus prior confirmed answer revisions. Existing resolved issues with a single Answer are interpreted as having one current revision.
- Historical answers are append-only facts. Confirming a replacement changes which revision is current; it never mutates or deletes the prior answer's content.
- The map ledger continues to reference one stable issue/node identity. It will not gain one entry per answer revision and will not generate a second map for review.
- The overlay continues to key layout by stable location id. Revision and review-state changes may change visual region/status but do not allocate new coordinates.
- Continuing discussion from a confirmed Expedition is the entry to revision. The existing operation is widened to permit a confirmed record to return to discussion while preserving its transcript, confirmed proposal, and answer-revision history.
- Forming, deferring, resuming, and previewing a replacement proposal retain their existing meanings. A replacement proposal does not become current merely because it was generated, deferred, or previewed.
- The structured map-change proposal is based on an exact Campaign source revision and the candidate answer revision. It describes intended changes to issues, dependencies, routes, fog, active exploration context, drafts, pending deletions, histories, and any genuine review conflicts.
- Each proposed change carries evidence and a reason category sufficient for Explorer to distinguish a derivable coordination change from a conflict that requires exploration judgment.
- The proposal provider cannot write Campaign files. Explorer validates the schema, rejects unsafe CommonMark or path traversal, restricts edits to managed Campaign content, and simulates the complete proposal against an in-memory projection before exposing a preview.
- Proposal validation enforces domain invariants: stable ids cannot be reassigned; unconfirmed issues cannot masquerade as nodes; active claims cannot be silently ended; current answers and histories cannot disappear; dependency cycles and dangling references remain blocking errors; arrival cannot be asserted while open or pending work remains.
- AI/coordinator output is not trusted as the source of truth. Explorer remains the sole authority that turns a validated proposal into a preview and the sole module that writes canonical map content after explicit confirmation.
- A genuine conflict produces a review record associated with the existing node. The node retains its answer and history but its current-answer status no longer contributes to a determined route until the review is resolved.
- The fixed behaviors from superseded ADR-0030, ADR-0032, ADR-0033, and ADR-0034 are not reintroduced. Explorer does not automatically mark every graph descendant for manual review, enforce a universal dependency-order review queue, require explicit session calibration, or require every stale draft to be manually rebuilt when the proposal can derive the correct result.
- Unrelated active explorations remain unchanged. Related active explorations retain their Expedition id, claim, transcript, and history; coordination updates their effective premise and the currently confirmable proposal without ending or replacing the exploration.
- Confirmation is serialized per Campaign. Every accepted answer or revision receives a monotonically ordered confirmation record, and its coordination completes or enters recovery before the next queued confirmation is applied.
- Confirmation and rechart are separate durable phases. The answer confirmation is recorded first. Derived coordination changes then apply through a recoverable write journal. Failure after confirmation leaves the answer confirmed, records pending rechart, and never rolls the answer back.
- While pending rechart, the projection combines the newly confirmed fact with the last successful coordinated map, marks the frontier stale, prevents new claims and later confirmations, and permits already active explorations to continue.
- Retry is idempotent. Recovery uses the persisted confirmation and coordination proposal when still valid; it does not ask the user to reconfirm and does not duplicate answer-history entries or map changes.
- Preview and confirmation keep the existing compare-and-swap boundary. The expected source revision, proposal hash, affected-file hashes, and resulting projection are checked before durable replacement. Any external edit invalidates the plan and remains untouched.
- The writeback layer will support both first confirmation and revision, plus coordinated changes spanning all affected managed Campaign documents. Its recovery journal records enough phase information to distinguish a durable answer confirmation from pending derived changes.
- Event storage will gain explicit events for answer revision confirmation, coordination requested/proposed/applied/failed, review requested/resolved, and retry. Replaying these events must reconstruct the same current answer, histories, pending state, and visible projections.
- Existing event logs and overlays remain readable. Any conversion to the richer revision model occurs on read or through append-only upgrade events rather than destructive rewriting.
- Explorer snapshots will expose current answer revision, answer history summaries, review state, pending-rechart state, and preview impact without exposing coordinator-internal or runtime-specific identifiers.
- The HTTP operation surface remains stable. Existing routes/actions for continuing discussion, forming and deferring proposals, previewing map changes, confirming writeback, retrying pending rechart, selecting nodes, and starting exploration retain their roles; payloads and snapshots may add backward-compatible fields needed to represent revision.
- The UI keeps the existing map and right-hand interaction model. It adds only the states and history necessary to make current, historical, pending-review, and pending-rechart semantics visible; this spec does not redesign navigation or create a second review workflow.
- Pending deletion, restore, arrival, and confirmation ordering continue to follow the established Campaign rules after revision. Coordination may update their inputs but does not weaken their invariants.
- Wayfinder behavior is design input, not a compatibility contract. The implementation follows Explorer's glossary and active ADRs when they differ from an upstream Wayfinder representation.

## Testing Decisions

- The primary and only acceptance seam for this spec is the production-like Explorer HTTP application boundary. Tests call the same operations as the browser and observe API snapshots, canonical Campaign Markdown, application-data history, and restart behavior.
- The acceptance fixture uses real Campaign parsing, Explorer state, event stores, proposal validation, preview planning, writeback, recovery, and projection. Only the map-change proposal provider is replaced by a deterministic fake; no real Agent, Codex process, network call, model judgment, or tool execution is required.
- Good acceptance tests assert external behavior rather than classes, private methods, or the number of internal calls. They prove what the explorer sees, what canonical content exists, what survives restart, and what operations are allowed in each state.
- The existing server-level tests are the prior art for driving token-bound JSON operations through the application boundary. Existing writeback and Campaign-projection tests remain prior art for exact source revisions, in-memory impact projection, conflict rejection, durable journals, and stable overlay coordinates.
- One full happy-path test will start from a Campaign containing confirmed upstream and downstream answers, continue the upstream discussion, form and preview a replacement answer, confirm it, consume a fake coordination proposal, and prove current answer/history, stable node identity/coordinates, route changes, updated frontier, and unaffected content.
- One genuine-conflict test will prove that a dependent answer remains on the same node, becomes pending review, leaves determined routes, blocks arrival, and can be reaffirmed or revised through the existing discussion/proposal/preview/confirmation operations.
- One active-exploration test will prove that unrelated exploration is unchanged while related exploration keeps its id, claim, transcript, and history and receives a coordinated current premise/draft.
- One ordering test will submit near-simultaneous confirmations and prove that the second coordination sees the first confirmed result and cannot overtake a pending rechart.
- One recovery test will fail after durable answer confirmation but before derived coordination completes, restart Explorer, prove that the answer remains confirmed, and complete an idempotent retry without duplicate history.
- One optimistic-concurrency test will edit canonical Markdown after preview and prove that confirmation preserves the external version, invalidates the plan, and performs no partial overwrite.
- One backward-compatibility test will open an existing single-Answer Campaign and prove it projects as one current answer revision with unchanged node identity and layout.
- Focused lower-level tests are retained only where the HTTP seam cannot cheaply enumerate corruption cases: canonical parser compatibility, proposal-schema rejection, event replay validation, write-journal phase recovery, and projection invariants.
- No separate Agent runtime adapter contract test is part of this spec. Tool events, permission requests, Codex Thread binding, and runtime replacement will be specified and tested later.

## Out of Scope

- Implementing or independently testing a real Codex/Agent runtime adapter.
- Starting, resuming, or migrating real Codex Thread bindings for the map-change proposal provider.
- Normal Agent tool access, tool-event presentation, or approval handling for side effects.
- Proving that a model makes a high-quality semantic-impact judgment; this spec proves how Explorer validates and applies a supplied structured proposal.
- Redesigning existing map navigation, node visuals, transcript interaction, proposal controls, or confirmation controls beyond the additional states and history required for revision.
- Adding a second manual maintenance workflow for graph descendants, session calibration, or stale drafts.
- Restoring the superseded fixed-review behaviors from ADR-0030 and ADR-0032 through ADR-0034.
- Changing the purpose of a target exploration after a substantial destination change; that still requires a new exploration.
- Executing the real-world work described by decisions; 抵达目的地 still means that the decision path is closed.
- Publishing this spec or its tickets to a remote issue tracker.

## Further Notes

- Active decision sources for this spec are ADR-0028, ADR-0029, ADR-0031, ADR-0035, and the existing confirmation/rechart/recovery ADRs. ADR-0001 is superseded by ADR-0031. ADR-0015, ADR-0030, ADR-0032, ADR-0033, and ADR-0034 are superseded by ADR-0035.
- ADR-0036 through ADR-0038, and the runtime-specific portion of ADR-0037, remain decisions to implement in the follow-up Agent-runtime spec. This spec preserves the application boundary they will later satisfy instead of binding Explorer behavior to Codex protocol details.
- ADR-0039 applies here as an interaction constraint: introducing the revision and coordination states must preserve the meanings of existing user operations.
- The current repository test baseline is not green before this feature: several tests depend on a Personal Brain fixture outside the repository, and the installed dependency tree is missing `react-markdown`. These are pre-existing environment/baseline issues and must be repaired or isolated before the complete suite can serve as a release gate.
