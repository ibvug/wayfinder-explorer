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
npm start -- ../.scratch/personal-brain-v1

# Source inspection without opening the map
npm run inspect -- ../.scratch/personal-brain-v1
npm run inspect -- ../.scratch/personal-brain-v1 --json
```

The human-readable command exits with status 1 when blocking source diagnostics
exist. JSON output includes exact field and section source ranges so the later
writeback module can patch only managed Markdown regions.

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

Only replaceable layout, the project registry, journey events, and Codex thread
bindings live under the operating system's application-data directory. Stable
Campaign ids keep those records attached when a project directory is relinked.

## First-map charting

An empty project enters Charting instead of showing a broken or invented map.
Explorer keeps one persistent Map Agent session while the player first confirms
the destination, then agrees the evidence scope and confirms a fixed starting
state. The first structured map proposal records the natural issues that can
already be expressed from the gap between those endpoints, their genuine
dependencies, fog, and out-of-scope boundaries. It does not impose a
breadth-first layer or invent a complete route. Each issue must represent one
complete natural decision; Explorer does not split a decision to manufacture
multiple frontier choices or dependency edges.

The first map has only the start and destination as formal nodes. Unresolved
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

Selecting one `grilling` node from the frontier set exposes `开始探索`. Explorer starts one stable
`codex app-server` thread in a read-only sandbox and streams visible Codex
messages into the right-hand stage. Player replies continue that same thread.
Only one non-terminal Expedition can exist for a Location; repeated starts
return the existing Expedition.

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
turn in the same Codex task. Explorer validates the proposal schema, evidence
references, and safe CommonMark before displaying it. The model-authored JSON
never becomes the canonical decision by itself.

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
conflict instead of being overwritten. Only a confirmed writeback changes the
issue to `resolved`, appends its `Answer`, records it under `Decisions so far`,
and moves the Expedition to `confirmed`.
