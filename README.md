# Wayfinder Explorer

Wayfinder Explorer turns strict `map.md` plus `issues/*.md` files into a local,
game-like decision world. M3 renders the dark expedition map, keeps the current
question in a single text stage, lets the player explore a Frontier through a
persistent Codex conversation, and turns that journey into an explicitly
reviewed decision without making Codex the source of truth.

Requirements: Node.js 24 or newer and a locally authenticated `codex` CLI.

```bash
cd wayfinder-explorer
npm install
npm test
npm run build
npm start -- test/fixtures/personal-brain-v1

# Source inspection without opening the map
npm run inspect -- test/fixtures/personal-brain-v1
npm run inspect -- test/fixtures/personal-brain-v1 --json
```

The service prints the local origin to open in a browser. The inspect command
exits with status 1 when blocking source diagnostics exist in either output
mode. JSON output includes exact field and section source ranges so Explorer can
patch only managed Markdown regions.

`openCampaignOverlay()` stores generated coordinates under the operating
system's application-data directory (or an injected test directory). Existing
Location coordinates survive source revisions; only newly discovered Locations
receive deterministic positions. Overlay damage is regenerated without touching
the canonical Wayfinder Markdown.

The browser service binds only to `127.0.0.1`. A random per-process token is
embedded in its same-origin bootstrap and required by every API request. The
browser receives a ready-to-render projection and never reads or writes campaign
files directly.

## Project library

The project title opens a persistent Campaign library. Existing Wayfinder
directories can be selected with the native macOS or Windows folder chooser, added by
absolute path, switched, or relinked after they move. Creating an empty project
requires both a name and a user-selected parent directory; Explorer creates the
project folder there and does not hide canonical `map.md` or `issues/*.md`
content inside application data.

Replaceable layout, the project registry, Journey and Charting events, recovery
metadata, and runtime bindings live under the operating system's
application-data directory. Stable Campaign ids keep those records attached when
a project directory is relinked; canonical map content remains in the selected
project directory.

## First-map charting

An empty project enters Charting instead of showing a broken or invented map.
Explorer keeps one persistent Map Agent session while the player first discusses
the destination and then the fixed starting state. The Map Agent can form an
endpoint draft, but only the player's dedicated `确认目的地` or `确认起点` action
establishes it; an ordinary chat reply never confirms an endpoint or advances the
stage. Explorer persists both confirmations before allowing a first-map proposal.
Discussion of the exploration background, evidence boundaries, and any bounded
inspection all happen while establishing the starting point rather than as a
third user-facing stage.

The starting-point draft is one self-contained current-state summary with its
evidence shown separately. Explorer binds it to an exact evidence version and
revalidates that version on confirmation. Changed evidence invalidates the old
draft and asks the same Map Agent session to recheck it; a confirmed starting
point remains a frozen historical baseline.

The first structured map proposal cannot author or rewrite either endpoint;
Explorer attaches the exact confirmed destination, starting point, and evidence
scope. The proposal records the natural issues that can already be
expressed from the gap between those endpoints, their genuine dependencies, fog,
and out-of-scope boundaries. It does not impose a breadth-first layer or invent a
complete route. Each issue must represent one complete natural decision; Explorer
does not split a decision to manufacture multiple frontier choices or dependency
edges.

The first map has only two nodes: the start and destination. Unresolved
issues remain issues, even when selected or claimed. A confirmed answer creates
the corresponding decision node, then the same Map Agent coordinates the new
answer across the whole map and re-establishes the current frontier.

The player first reviews the structured proposal and then requests an exact
preview of the `map.md` and `issues/*.md` files. Preview does not create
canonical files. Explicit confirmation performs a revision check and installs
all new files without silently replacing an existing map. Charting messages and
state transitions are append-only in `charting.jsonl`; the confirmed Markdown
becomes the canonical map.

In the rendered map, `frontier` means every currently traversable Location.
Only one Location can be the current UI selection, and selecting it does not
resolve or remove any other frontier. That replaceable focus is stored in
`overlay.json` and restored after refresh or restart.

## Codex Expeditions

Selecting a frontier issue of type `grilling`, `research`, `prototype`, or `task`
exposes `开始探索`. Explorer starts one stable `codex app-server` thread in a
read-only sandbox and streams visible Codex messages into the right-hand stage.
The Exploration Agent adapts its method to the issue type, and any requested tool
side effects remain subject to explicit runtime approval. Player replies continue
that same thread. Only one non-terminal Expedition can exist for a Location;
repeated starts return the existing Expedition.

The claimant can explicitly end an unfinished Expedition. Explorer preserves the
conversation as unfinished history, releases the claim, and asks the Map Agent to
rechart the still-open issue out of the active exploration scope. It does not
create an answer or map node. This is distinct from interrupting one Codex turn
or merely selecting another Location.

Explorer stores replaceable layout and Expedition-to-thread bindings in
`overlay.json`, and appends visible messages and state transitions to
`journey.jsonl` under the operating system's application-data directory. On
restart it reads and resumes the recorded Codex thread, so the same question and
reply box return without editing `map.md` or `issues/*.md`.

The generated stable protocol bindings live in `schemas/codex-app-server` and
can be refreshed against the installed compatibility baseline with:

```bash
codex app-server generate-ts --out schemas/codex-app-server
```

## Decision return and safe writeback

After at least one player answer, `形成草案` starts a structured finalization
turn in the same Exploration Agent task. Explorer validates the proposal schema,
evidence references, and safe CommonMark before displaying it. The model-authored
JSON never becomes the canonical decision by itself.

`暂存，稍后决定` records the complete proposal as a draft in the Journey while
leaving both the map and Wayfinder Markdown untouched. Returning to that
Location restores the draft. `继续讨论` resumes the same Codex task, so the
player can add new judgment and form a revised proposal without losing the
earlier journey history. After an Explorer restart, the persisted task is
explicitly resumed before a new Codex turn is started.

`预览地图变化` re-reads the exact source revision, patches the managed fields in
memory, and reprojects the graph. Confirmation uses file hashes as a
compare-and-swap boundary, durable same-directory temporary files, and a
recovery journal. An external edit after preview is preserved and causes a
conflict instead of being overwritten. Only a confirmed writeback changes
canonical map content. For an open issue, it changes the issue to `resolved`,
appends its `Answer`, records it under `Decisions so far`, and moves the
Expedition to `confirmed`.

A confirmed decision node can be reopened with `修订这个答案`. The revision
continues the same Expedition and Codex thread, keeps the node identity and layout,
and preserves the replaced answer under answer history. If coordination finds a
real conflict in another confirmed answer, that answer remains on the same node as
`待复核`; the player can use the same flow either to reaffirm it or confirm a
replacement answer.

After confirmation or ending an exploration, the current implementation queues a
Map Agent rechart and blocks new starts from the stale frontier. A failed rechart
shows `重试重绘`. Applied rechart changes remain visible, and `恢复本次变化` can
undo one current issue change without permanently protecting that issue from a
future rechart.

## Development status

The sections above describe the behavior available in the current runnable
product. The following accepted design work is not yet delivered and should not
be inferred from the current UI or HTTP API:

- A controlled operation for changing an established destination. Every change
  must first prove that the current target exploration can still reach the new
  destination; otherwise Explorer preserves the current exploration and starts a
  new one. See
  [ADR-0041](docs/adr/0041-destination-change-requires-reachability-check.md).
- One immutable pre-confirmation plan that presents the candidate answer together
  with its complete anticipated map impact. The current preview covers the answer
  writeback and directly projected changes; full Map Agent impact coordination is
  still formed after confirmation. See the
  [human-driven exploration spec](.scratch/human-driven-exploration/spec.md).
- One end-to-end durable confirmation queue covering acceptance, answer write,
  impact coordination, rechart application, ordering, and crash recovery. The
  current product has an atomic writeback journal plus a post-confirmation rechart
  queue and retry path, but not the unified lifecycle described by the
  [human-driven exploration spec](.scratch/human-driven-exploration/spec.md),
  [ADR-0016](docs/adr/0016-concurrent-confirmations-rechart-in-order.md),
  [ADR-0017](docs/adr/0017-rechart-failure-does-not-undo-confirmation.md), and
  [ADR-0020](docs/adr/0020-pending-rechart-recovers-automatically.md).
- Runtime-neutral domain storage and public projections for logical Agent
  sessions. The current records and browser snapshot still carry Codex
  `threadId` bindings. See
  [ADR-0036](docs/adr/0036-agent-roles-use-replaceable-task-runtimes.md).
