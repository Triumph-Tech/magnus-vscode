# CLAUDE.md: Magnus VS Code extension

Remote editor for [Rock RMS](https://www.rockrms.com). This repo is the VS Code
client. It talks to the Magnus Rock plugin installed on the user's Rock server.

## Commands

```bash
npm install
npm test            # vitest, 408 tests across 26 files
npm run build       # webpack, development mode
npm run lint        # eslint
```

`npm run test:integration` builds, lints, then launches a real VS Code instance.
It needs to download VS Code, so prefer `npm test` for fast iteration.

## Two modes

Everything in this extension is one of two modes, and knowing which one a change
belongs to is the first question to ask.

**Cloud mode** is the original design. Opening a file is a live round-trip: no
local copy, no merge, no offline. `magnusTreeDataProvider.ts` is both the
`TreeDataProvider` and the `FileSystemProvider` (registered for two URI schemes,
secure and insecure), with `api.ts` holding the HTTP layer and `events.ts` the
wiring.

**Local mode** (added in 1.1.0, opt-in) pulls a subtree onto real disk and gives
it a Source Control panel with pull/fetch/push. This is where most of the recent
code and nearly all of the tests are. Entry points: `pullCommand.ts`,
`magnusSourceControl.ts`, `syncDecisions.ts`, `syncOperations.ts`.

Cloud mode still works for every content type. Local mode supports a subset:
mobile apps, AI Skills, Website Themes, Persisted Datasets, Lava Shortcodes, Lava
applications, Apple TV apps. Deliberately not websites (its own scoped project,
spec 7.12) or `serverfs`.

## The server contract is descriptor-driven

This is the single most important thing to understand before touching `api.ts`.

The client hardcodes exactly one URL:

```
api/TriumphTech/Magnus/GetTreeItems/root
```

Everything else is discovered. Each tree item comes back as an `IItemDescriptor`
(see `src/types/global.d.ts`) carrying the URIs for its own available actions:
`buildUri`, `deleteUri`, `newFileUri`, `newFolderUri`, `uploadFileUri`,
`remoteEditUri`, and so on. The client does not construct these and must not
assume their shape. A null URI means the action is unavailable for that item, and
the UI hides it.

Consequences worth internalizing:

- Adding a content type on the server usually needs no client change for cloud
  mode. The server emits descriptors and the tree renders them.
- Never build an endpoint path by string concatenation. Follow the descriptor.
- `GetFlatTree` is a bulk optimization that returns a whole subtree with
  `parentUri` links, so Pull and Fetch avoid a per-level walk. See `flatTree.ts`.

## Local mode workspace layout

A pulled workspace mirrors server content at real paths, with bookkeeping in a
`.magnus/` directory at the root:

| Path | Purpose |
|---|---|
| `.magnus/manifest.json` | `roots[]` (one per pulled resource, each with a `pathPrefix`) plus `items`, keyed by POSIX path relative to the workspace root. Folder keys end in `/`. Files carry a sha256 `hash` and `lastSyncedAt`. |
| `.magnus/baseline/` | the exact bytes last synced. Powers three-way diffing and the SCM gutter. |
| `.magnus/incoming/` | server-side changes staged by Fetch, not yet applied. |
| `.magnus/incoming.json` | index of what is staged. |
| `magnus.json` | **Committed**, and deliberately outside `.magnus/`. The selection: which resources this workspace holds, plus server, versions and `pulledAt`. Never hashes or the item list. |

Because `.magnus/` is gitignored and `magnus.json` is not, `git clone` yields a
third state: content and intent present, sync state absent. **Restore Local Sync
State** (`hydrateCommand.ts`) is the only thing that closes that gap. Pull cannot:
it refuses a non-empty target and nests a `<serverAlias>/` folder inside whatever
you point it at.

**The server is the authority.** Restore overwrites local content, so the
workspace ends byte-identical to the server and its SCM panel comes up empty.
What changed relative to the repository is then a `git diff`, and committing it
is how the repo catches up. Restore warns before overwriting, because
uncommitted work is the one thing git cannot recover.

An earlier design tried to preserve local content and represent the difference
inside Magnus, making server bytes the baseline while adopting the working file.
That inverted the direction of every server-side advance: files the user had
never touched appeared as their own outgoing edits, and Push would have
overwritten newer server content with a stale clone. Git already models "what
changed here" better than a second mechanism layered on top. Do not reintroduce
this without resolving that.

Restore is re-runnable on an already-restored workspace, which is how you
discard local drift wholesale; Fetch remains the per-file route. It never writes
`magnus.json` (that would churn `pulledAt` and dirty every teammate's tree), and
it never produces the "manifest present, baseline absent" state, because it
writes baselines as it goes.

`resolveDescriptor.ts` exists because `magnus.json` records a selection, not
descriptors, and `GetFlatTree` deliberately excludes the subtree root from its
own response. `buildUri` and the descriptor the recursive-walk fallback needs
are therefore recovered by walking down from the one hardcoded tree URL.

The manifest schema is versioned (`MANIFEST_VERSION` in `manifest.ts`). Bump it
and handle migration if you change the shape; real workspaces exist on disk and
must keep opening.

Local-mode change detection is content hashing against the baseline, never mtime.
(`lightFileStat.ts` does use mtime, but that is cloud mode's `FileStat`, which is
a different concern.)

## Two safety invariants

Both are load-bearing. Do not weaken either without a deliberate decision.

**Local mode never deletes server content.** A file missing locally is ambiguous
(accidental delete? cleared property?), so push refuses it and points the user at
Discard instead. See `syncOperations.ts`.

**Server-side deletion never silently discards local work.**
`classifyServerDeletion` returns `auto-delete` only when the local file is absent
or byte-identical to the baseline. Anything else, including a one-newline
difference or a legacy workspace with no baseline on disk, returns
`flag-conflict` and requires explicit user confirmation before unlinking.

`CHANGELOG.md` used to describe this as "dirty-content salvage to
`.magnus/salvage/`". There is no salvage directory and never was; the real
mechanism is the confirmation prompt above. Corrected 2026-08-18, but the phrase
may survive in older release notes elsewhere.

## Conventions

- Follow the patterns already in the file you are editing.
- Local mode logic is deliberately split into pure functions (`syncDecisions.ts`,
  `pullHelpers.ts`, `contentFilter.ts`) separate from side-effecting ones
  (`syncOperations.ts`). Keep decisions pure and testable; that is why the test
  suite can cover sync behavior without a server.
- Any new sync or classification rule needs a vitest case. That is the
  established bar in this repo.
- `contentFilter.ts` is a volume filter, not a semantics filter. Rock exposes every
  block setting and page scaffold as its own endpoint (~1000+ files for a 50-page
  mobile app), so local mode keeps only page metadata and block content bodies.
  It matches on server URI shapes, which means **a server-side URI rename silently
  changes what gets pulled**, with no error on either side. Treat those regexes as
  a contract with the server, and prefer the tree filter over the content filter
  when possible since it avoids recursing at all.
- Per-content-type rules (which AI Skill tool types are editable, which file
  extension each gets, which datasets qualify) are enforced **server-side** and the
  client just renders what it receives. Do not reimplement them here.
- `npm run lint` should report **zero errors**. If you see any, they are yours.
  (The config used to reject the `UPPER_SNAKE_CASE` module constants the
  local-mode code uses throughout, so 17 unactionable errors were permanently
  present and everyone learned to ignore the count. The config was corrected
  rather than the code renamed.) Warnings are a separate, larger cleanup.

## Server-side requirement

Local mode features depend on matching virtual filesystem support in the Rock
plugin, which is versioned separately and released through the Rock Shop.
`CHANGELOG.md` records the minimum plugin version per release. There is
currently no runtime version handshake, so a version mismatch surfaces as a
failed request rather than a clear message.
