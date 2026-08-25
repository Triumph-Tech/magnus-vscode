# Spec: SQL Tools for the Magnus VS Code extension

Status: Implemented (phases 1–4 complete on the sql-tools branch)
Author: Claude (implementation to be done by Claude)
Date: 2026-08-25

## 1. Summary

Bring the capabilities of the retired Azure Data Studio extension
([Triumph-Tech/magnus-ads](https://github.com/Triumph-Tech/magnus-ads)) into
the Magnus VS Code extension, and go beyond them: browse a Rock server's
database objects, write and run SQL with modern editor affordances, view
results in a grid with rich inspection and copy/export, keep a query
history, and get Rock-aware authoring help. Azure Data Studio support ended
2026-02-28, stranding every user of the old extension.

The ADS extension could not be ported because it was built on ADS's
proprietary `azdata` API (connection dialog, object explorer, query editor
binding, results grid), which does not exist in VS Code. This spec replaces
those UI surfaces with standard VS Code APIs. The data plane is unchanged:
all SQL execution happens server-side in the Magnus Rock plugin through REST
endpoints that are already deployed. **No server-side changes are required
or planned; every feature below works against the existing plugin.**

## 2. Goals

- Everything magnus-ads actually shipped: connect, browse
  databases/tables/columns, run a query, view result sets and messages,
  cancel a running query, Select Top 1000, export results.
- Feel like an upgrade, not a port: effortless server binding, statement-
  level execution, query history, Rock-aware IntelliSense, cell inspectors,
  and rich copy formats — none of which ADS provided.
- Integrate with the existing Magnus extension: same saved servers, same
  `api/Auth/Login` authentication, same `Secrets` storage. No second login.
- Follow repo conventions: pure decision logic split from side-effecting
  code, vitest coverage for every decision rule, zero lint errors.

## 3. Non-goals and deferred ideas

Out of scope permanently:

- Direct SQL Server connections (TDS). Everything goes through the Magnus
  plugin.
- Integration with or dependency on the `ms-mssql.mssql` extension (no
  pluggable connection providers; it cannot host Rock-proxied connections).
- Features the ADS extension stubbed but never shipped: edit-data grids,
  create database/login, execution plans.
- Any plugin change, including a server-side row limit.

Considered and deliberately deferred (revisit after v1): multi-server
fan-out with cross-server result diff, SQL notebooks (VS Code Notebook
API), client-side chart tab, result-set diffing, and exposing query
execution as a Language Model Tool for Copilot/Claude chat.

## 4. Background: the server contract (existing, unchanged)

The Magnus Rock plugin (`tech.triumph.Magnus`, Rockit repo) already exposes,
in `Rest/MagnusController.cs`:

| Endpoint | Method | Purpose |
|---|---|---|
| `api/TriumphTech/Magnus/Sql/Connect` | POST | Session negotiation; returns `databaseName`, `rockVersion`, `sqlVersion`, `sqlEdition`, `oSVersion` |
| `api/TriumphTech/Magnus/Sql/ExecuteQuery` | POST | Starts a query; returns an `ExecuteQueryProgress` with an `identifier` |
| `api/TriumphTech/Magnus/Sql/Status/{identifier}` | GET | Polled until `isComplete`; accumulates `messages`, returns `resultSets` |
| `api/TriumphTech/Magnus/Sql/Cancel/{identifier}` | DELETE | Cancels a running query |
| `api/TriumphTech/Magnus/Sql/ObjectExplorerNodes` | POST | Children of a node: DatabasesFolder → Database → TablesFolder → Table → ColumnsFolder → Column |
| `api/TriumphTech/Magnus/Sql/ColumnNames` | POST | Column names for a table (powers Select Top 1000, completion, hover) |

Wire types (`ExecuteQueryProgress`, `QueryResultSet`, `QueryColumn`,
`QueryMessage`, `ObjectExplorerNodeBag`, etc.) are already defined in
magnus-ads `src/types.ts` and will be copied into this repo's `src/types/`
largely verbatim. `QueryColumnType` drives display formatting (String,
Number, Boolean, DateTime, ByteArray).

Authentication is the cookie/token from `api/Auth/Login`, which `src/api.ts`
already manages, including reauthentication. SQL endpoints ride the same
session.

## 5. User experience

### 5.1 Connecting and binding

- **Object Explorer**: a new "SQL" node under each connected server in the
  existing Magnus tree view. Expanding it lazily loads
  `ObjectExplorerNodes`. Node icons use VS Code codicons (`database`,
  `table`, `symbol-field`).
- **Auto-bind in pulled workspaces.** A local-mode workspace's `magnus.json`
  already names the server. Any `.sql` file inside such a workspace binds to
  that server automatically — open, write, run, zero setup. Side effect
  worth advertising: committing `queries/*.sql` beside `magnus.json` gives
  the team a git-versioned query library that is runnable and
  pre-connected on every clone.
- **Named query editors.** New Query and Scratch Query open
  `untitled:Query-N.sql` rather than an anonymous buffer, N counting up per
  window and skipping names already open. An anonymous untitled document takes
  its tab caption from its own first line, so the tab renames and resizes
  itself on every keystroke; a named one does not, and the `.sql` extension is
  what earns the editor its language mode. The results panel is titled after
  the editor (`Results: Query-1.sql`), not after the server, which the panel's
  own header names. Naming lives in `queryDocumentNames.ts`.
- **Explicit binding everywhere else.** An untitled editor created via New
  Query is bound at creation; a loose `.sql` file gets a quick pick of saved
  servers on first run, remembered for the document's lifetime. The status
  bar shows the binding (`$(database) rock.example.org · RockDb`); clicking
  it rebinds.
- **Scratch query** (`magnus.sql.scratchQuery`, default `Cmd+K Cmd+G` /
  `Ctrl+K Ctrl+G`, global): opens an untitled SQL editor bound to the
  last-used server (quick pick if none yet), workspace or not. The
  "I just need to check something" path is two keystrokes. The chord is
  deliberately one that VS Code itself never registers on any platform: the
  earlier `Ctrl+K Ctrl+Q` shadowed Go to Last Edit Location globally, which a
  global binding has no right to do.
- **Environment tags. Untagged means production.** Every saved server is a
  real Rock server, so the default posture is production: an untagged server
  behaves exactly as a production one does, with the error-background tint on
  the status bar item and a confirmation before any statement classified as
  destructive (see 6.3). Tagging a server `staging` or `development` is the
  explicit opt out. **Tags only ever relax the guard, never tighten it**, so
  forgetting to tag is safe and the unsafe state has to be asked for.
  - The rule lives in exactly one function, `effectiveEnvironment(env)` in
    `documentBindings.ts`, which resolves `undefined` to `production`.
    Nothing else compares an environment against `undefined` to decide
    behavior.
  - Only the two relaxing tags are stored. Production is the absence of an
    entry, not the string `production`, so untagged and production are one
    state with one spelling; the Set Server Environment picker offers
    Production (default), Staging and Development, and choosing Production
    clears the entry. A legacy `production` entry reads back as untagged and
    therefore behaves identically.
  - The confirmation dialog says the server is *treated as* production rather
    than tagged as it, and points at Set Server Environment. It offers
    "always allow on this server", which is persisted per server.

### 5.2 Writing and running

- **Run Query** (`magnus.sql.runQuery`): editor title play button and
  `Cmd+Shift+E` / `Ctrl+Shift+E` while the cursor is in a SQL editor. If text
  is selected, only the selection runs (ADS parity). The binding is scoped to
  `editorLangId == sql && editorTextFocus` rather than to the language alone,
  so `Ctrl+Shift+E` still focuses the Explorer whenever focus is anywhere but
  a SQL editor.
- **Run statement under cursor** (`magnus.sql.runStatement`, `Cmd+Enter` /
  `Ctrl+Enter`): no selection needed; the statement containing the cursor is
  detected and run. Statement boundaries come from a pure T-SQL splitter
  (batch separators, semicolons, string/comment/bracket awareness — not a
  full parser, see 6.3).
- **Per-statement CodeLens**: a "Run" lens above each detected statement or
  `GO` batch. Togglable via `magnus.sql.codeLens` setting.
- **Select Top 1000** on Table nodes: fetches `ColumnNames`, generates
  `SELECT TOP (1000) [col], ... FROM [table]`, opens it bound, runs it.
- **Rock-aware IntelliSense**:
  - Table-name completion from the cached object explorer data; column
    completion after a table name or alias via `Sql/ColumnNames`.
  - A static catalog of Rock's core schema conventions shipped with the
    extension (`rockCatalog`): canonical join paths, and a diagnostic
    warning for the classic mistake of joining `PersonId` directly where a
    `PersonAliasId` column is involved.
  - **Join-clause completion** where a join is written, not in the column
    list: right after a `JOIN` keyword (`JOIN`, `INNER`, `LEFT`/`RIGHT`/`FULL
    [OUTER]`; not `CROSS JOIN`, which takes no `ON`), each foreign key column
    of the tables already in the statement offers the whole clause —
    target table, a fresh alias, and the `ON` condition — with the `JOIN`
    keyword already typed left alone. A curated two-hop path such as
    `PersonAliasId → PersonAlias → Person` offers both the first hop alone
    and the full chain, whose added hop is always spelled `INNER JOIN`. Plain
    table names are still offered there, one tier below. Column lists come
    from the object explorer cache, with the catalog's curated foreign keys
    standing in for a table nothing is cached for; a completion may fetch at
    most one column list, never one per table in scope.
  - A snippet library of blessed Rock queries (person search, attendance,
    giving, group membership), contributed as standard VS Code snippets for
    the `sql` language, prefixed `rock-`.
  - No full T-SQL language service; this already exceeds ADS, whose
    `parseSyntax` was a no-op.
- **Hover a table name** in a bound editor → column list peek via
  `Sql/ColumnNames` (cached).
- While running: status bar spinner, **Cancel Query** command, progress
  messages stream into the results panel as `Status` polling returns them.

### 5.3 Query history

Every executed statement is recorded (per server: statement text, server,
database, started-at, duration, row counts, success/error summary) in
`globalState`, capped at a configurable count (default 500,
`magnus.sql.historySize`; 0 disables).

- **Query History** (`magnus.sql.showHistory`): a QuickPick, most recent
  first, fuzzy-searchable across statement text and server name. Selecting
  an entry offers Re-run, Open in editor (bound to the original server), or
  Copy.
- History stores statement text only — never results — and can be cleared
  (`magnus.sql.clearHistory`).

### 5.4 Results panel

A webview panel, one per query editor, reused across runs (ADS behavior).

- Tab strip: `Results 1..N` + `Messages`. Messages carries PRINT output,
  row counts, and errors with line numbers; clicking an error moves the
  editor cursor to that line.
- Virtualized grid (only visible rows in the DOM) so 100k-row results stay
  responsive. Cells formatted by `QueryColumnType` (dates ISO-formatted,
  NULL as dimmed `NULL`, byte arrays as `0x…` previews).
- **Cell inspector**: activating a cell (double-click or Enter) opens an
  inspector pane inside the panel. Content is auto-detected: JSON and XML
  are pretty-printed with folding (Rock stores JSON throughout
  AttributeValues and AdditionalSettings), long text wraps, binary shows
  hex. Esc closes.
- **Row inspector**: a transposed single-record view (column name / value
  pairs, one per line) for wide rows like `Person`. Toggled from the grid's
  row gutter.
- Selection and clipboard: click/drag range selection; **Copy as…** menu
  with: plain (tab-separated), with headers, Markdown table, CSV, JSON
  (array of objects), and `INSERT` statements (using the source table name
  when the query was a single-table select, else prompting).
- Export buttons: CSV, JSON, Excel (`.xlsx`), via save dialog. Serializers
  port from magnus-ads `src/serializers/` and are unit tested.
- Footer: row count, server-reported duration, and a truncation notice when
  the render cap applies (see 6.4).

The webview follows VS Code theming (`--vscode-*` variables), uses
`retainContextWhenHidden: false` with state serialization, and a strict CSP
(no remote resources).

### 5.5 Explorer navigation

- **Go to table** (`magnus.sql.goToTable`, `Cmd+T`-style QuickPick scoped to
  the extension): fuzzy search over all tables of the bound server (from the
  cached object explorer list, fetched on demand the first time). Selecting
  offers Reveal in tree, Select Top 1000, or Insert name at cursor.

## 6. Architecture

Follows the repo's pure/side-effecting split:

| New file | Kind | Responsibility |
|---|---|---|
| `src/sql/sqlApi.ts` | side-effecting | HTTP layer for the six `Sql/*` endpoints; thin methods over the existing `Api`/`Secrets` (reuses auth, `httpErrors.ts` mapping, reauthentication) |
| `src/sql/queryRunner.ts` | side-effecting | Lifecycle of one execution: submit, poll `Status` with backoff, stream messages, cancel. Ported from magnus-ads with `azdata` types replaced |
| `src/sql/queryDecisions.ts` | pure | Polling cadence, completion/error classification, message merging, render-cap truncation decisions |
| `src/sql/statementSplitter.ts` | pure | T-SQL statement/batch boundary detection (strings, comments, brackets, `GO`); powers run-under-cursor, CodeLens, and destructive-statement classification |
| `src/sql/resultFormatting.ts` | pure | Cell display values per `QueryColumnType`, NULL handling, copy-as assemblies (tab, Markdown, CSV, JSON, INSERT), inspector content detection (JSON/XML/binary) |
| `src/sql/documentBindings.ts` | pure + thin state | Document URI → server binding; auto-bind resolution from `magnus.json` (via existing `magnusJson.ts`); picker decisions; environment-tag lookup |
| `src/sql/queryHistory.ts` | pure + thin state | History entry shaping, cap/eviction, fuzzy-filter decisions; persistence via `globalState` |
| `src/sql/rockCatalog.ts` | pure + static data | Rock core-schema catalog: join-path suggestions, `PersonId`/`PersonAliasId` diagnostic |
| `src/sql/completionProvider.ts` | side-effecting | CompletionItem/Hover/CodeLens/Diagnostic providers wiring editor events to the pure modules |
| `src/sql/sqlObjectExplorer.ts` | side-effecting | SQL children in the existing tree; per-server node cache (also feeds completion and Go to table) |
| `src/sql/resultsPanel.ts` | side-effecting | Webview lifecycle, extension↔grid message protocol |
| `src/sql/webview/` | webview assets | Grid UI: tabs, virtualized table, toolbar, cell/row inspectors. Vanilla TS, no framework |
| `src/sql/serializers/` | pure | CSV/JSON/Excel export, ported from magnus-ads |
| `src/sql/sqlCommands.ts` | side-effecting | Command registrations, wired in `extension.ts` |
| `snippets/rock-sql.json` | static | Rock query snippet library |

`package.json` gains: the commands above, menus gated on
`viewItem`/`resourceLangId == sql` context keys, keybindings, snippet
contribution, and settings (`magnus.sql.maxRenderRows`,
`magnus.sql.historySize`, `magnus.sql.codeLens`,
`magnus.sql.sanitizeSpreadsheetCells`, per-server environment tag stored with
the profile).

### 6.1 Data flow for one query

1. The run command resolves the statement text (whole doc, selection, or
   splitter-detected statement) and the document's binding (auto-bind →
   explicit binding → picker).
2. If the server is production-tagged and the splitter classifies the
   statement as destructive, confirm (see 5.1).
3. `queryRunner` POSTs `ExecuteQuery`, gets `identifier`, polls
   `Status/{identifier}` (250 ms → 1 s backoff per `queryDecisions`),
   forwarding new messages to the panel.
4. On `isComplete`, result sets go to `resultsPanel` in chunks via
   `postMessage` (keeps the extension host responsive), and a history entry
   is recorded.
5. Cancel aborts the poll loop and fires `Cancel/{identifier}`.

### 6.2 Caching

Object explorer nodes and `ColumnNames` responses are cached per server with
a short TTL and invalidated by the tree's existing refresh command. The
cache feeds completion, hover, and Go to table without extra round-trips.

### 6.3 Statement splitting and destructive classification

`statementSplitter.ts` is a tokenizer, not a parser: it tracks string
literals, quoted identifiers, block/line comments, and `GO` separators to
find statement boundaries, and classifies a statement as destructive when
its first significant keyword is `UPDATE`, `DELETE`, `INSERT`, `MERGE`,
`TRUNCATE`, `DROP`, `ALTER`, `CREATE`, or `EXEC`. Misclassification fails
safe in both directions: an unrecognized shape is treated as destructive on
prod, and classification never blocks execution on non-prod servers. Every
rule is a vitest case.

### 6.4 Large results

The REST contract returns complete result sets in memory and, with plugin
changes off the table, the full payload always crosses the wire. The client
guards the UI, not the network: rows beyond `magnus.sql.maxRenderRows`
(default 10,000) are held but rendered on demand as the grid scrolls, exports
always include all rows, and the footer plus Messages tab state the full row
count explicitly (no silent truncation). There is deliberately no way to turn
the cap off: a setting of 0 or less falls back to the default and anything
above 100,000 is clamped to it, because rendering an unbounded result set in
one burst is a freeze nobody can escape. The initial render is also streamed
across turns of the event loop, a chunk per turn, so the first rows paint
while the later ones are still being formatted. If extension-
host memory becomes a real problem in practice, that is the signal to
revisit a server-side `maxRows` parameter as a future plugin release — noted
here only so the decision trail exists.

## 7. Error handling

- Auth failures reuse the existing reauthentication flow
  (`reauthenticateCommand.ts`); a 401 mid-query prompts reauth and offers
  retry.
- A 404 on any `Sql/*` endpoint reports "This server's Magnus plugin does
  not support SQL tools (requires plugin version 2.0 or later)" rather than
  a raw failure — the known no-handshake gap, handled at the call site.
  (The `Sql/*` endpoints first shipped in the packaged v2.0 plugin,
  August 2023, per the Rockit repo history.)
- SQL errors arrive as `QueryMessage` entries with `code`/`lineNumber`;
  rendered in Messages with editor line navigation.
- Network drop mid-poll: retry with backoff for 30 s, then surface the
  error and stop polling (the server-side query keeps its own lifecycle).

## 8. Security

- Credentials stay in `SecretStorage` via the existing `Secrets` class.
- Results live in extension-host memory and the webview only; nothing
  touches disk except explicit exports. Query history stores statement text
  only, never results, and is clearable.
- Webview: strict CSP, no remote content, `enableScripts` only, incoming
  messages shape-validated.
- Who may execute SQL is enforced server-side by the Magnus plugin's
  security grants, exactly as with ADS. The prod-confirmation prompt is a
  courtesy guard, not a security boundary, and is documented as such.

## 9. Testing

Per repo convention, every decision rule gets a vitest case. Pure modules
are fully unit tested:

- `statementSplitter`: boundaries across strings/comments/brackets/`GO`,
  cursor-to-statement mapping, destructive classification incl. fail-safe
  default.
- `queryDecisions`: polling/backoff schedule, completion and error
  classification, render-cap decisions and their messaging.
- `resultFormatting`: cell formatting per column type incl. NULL and
  byte-array edges; every Copy-as format (Markdown escaping, INSERT
  quoting); inspector content detection.
- `documentBindings`: auto-bind from `magnus.json`, binding lifecycle,
  environment-tag lookup, picker decisions.
- `queryHistory`: entry shaping, eviction at cap, fuzzy filtering.
- `rockCatalog`: join-path suggestions, `PersonId` diagnostic triggers and
  non-triggers.
- `serializers`: CSV quoting, JSON shapes, Excel round-trip.

`sqlApi` is tested against a mocked fetch like the existing `api.ts` tests.
The webview grid gets DOM-level tests for virtualization windowing, copy
assembly, and inspector open/close. Integration smoke (tree expansion, run
query round-trip against a mock server) joins the existing integration
suite.

## 10. Implementation plan

Phases are independently shippable; each ends green (`npm test`,
`npm run lint` zero errors) with a CHANGELOG entry.

1. **Plumbing + Object Explorer + Go to table.** Wire types, `sqlApi`, SQL
   node under servers, node caching, 404 → friendly unsupported-plugin
   message, Go to table QuickPick (#14).
   *Visible result: browse and fuzzy-find database objects.*
2. **Query execution.** `statementSplitter`, document bindings with
   auto-bind (#1), New Query, scratch query (#2), Run Query / run statement
   under cursor / CodeLens (#5), environment tags with prod confirmation
   (#3), cancel, status bar, results panel shell with Messages tab.
   *Visible result: run queries fast from anywhere, safely on prod.*
3. **Results grid.** Virtualized grid, tabs, cell and row inspectors (#9),
   Copy as… (#10), CSV/JSON/Excel export, render cap, Select Top 1000.
   *This is the bulk of the schedule.*
4. **Authoring aids.** Query history (#6), completion + hover peek
   (#7, #15), Rock catalog diagnostics and snippet library (#7).

## 11. Branch strategy and separation rules

This work lives on the `sql-tools` branch, based on `origin/main` (v1.0.2,
cloud-mode only) — deliberately not on the in-flight local-mode branch,
whose direction is still settling. Three rules keep the eventual merge
clean:

1. All new code lives in `src/sql/` (plus `snippets/`). No edits to shared
   files such as `api.ts`; `sqlApi.ts` consumes only the `Api` class's
   stable public auth surface, which is identical on both branches.
2. Wiring is additive-only: appended registrations in `extension.ts`, new
   contribution blocks in `package.json`, one hook adding the SQL node to
   the tree provider.
3. Auto-bind reads `magnus.json` with its own minimal reader in
   `documentBindings` and must not import local-mode modules. `magnus.json`
   is a committed file with a documented shape; the feature works no matter
   which direction local mode takes.

Notes that follow from the base: file references elsewhere in this spec to
local-mode modules (`httpErrors.ts`, `reauthenticateCommand.ts`,
`serverTree.ts`, `magnusJson.ts`) are conceptual on this base — the
equivalents here are `api.ts`'s error handling and
`magnusTreeDataProvider.ts`. This branch also introduces vitest for the
pure `src/sql/` modules (main's harness is mocha/vscode-test only); the
local-mode branch adds vitest too, so the `package.json` overlap resolves
trivially.

## 12. Risks and open questions

- **Grid quality is the product.** If the hand-rolled virtual grid proves
  fiddly, fallback is an established MIT grid library bundled locally;
  decision point at the start of phase 3.
- **Statement splitting is heuristic.** The tokenizer will meet exotic
  T-SQL. Mitigations: selection-run and whole-doc-run always available as
  ground truth; splitter failures degrade to those, never block.
- **Memory on huge results** is bounded only by the render cap client-side
  (see 6.4); documented limitation.
- **Open question — where the SQL node lives**: this spec puts it inside the
  existing server tree (one auth, one tree). Alternative is a separate
  view; flagging for review.
- **Open question — command naming**: `magnus.sql.*` namespace proposed.
