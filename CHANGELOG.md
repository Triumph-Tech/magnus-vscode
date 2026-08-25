# Change Log

All notable changes to the **Magnus** VS Code extension are documented in this file. Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [1.2.0-beta.1] — Unreleased

> ⚠️ **Experimental beta, and a breaking change to pulled workspaces.**
> Requires `tech.triumph.Magnus` plugin **2.4.0**, which is not yet packaged.
> Most of this release does nothing useful against an older plugin.

### Breaking

- **Existing pulled workspaces must be pulled again.** The manifest moved to v2
  and a v1 manifest is refused with a message saying so. Nothing on disk is lost:
  files land at the same paths, only the bookkeeping shape changed. There is
  deliberately no migration.
- **A workspace is now a server, not a resource.** The workspace root sits one
  level up, at the server folder, and each pulled resource occupies a
  subdirectory beneath it. Pulling a second resource from the same server joins
  that workspace instead of creating another one beside it.

### Added

- **Restore Local Sync State**: a cloned repository can now become a working
  local-mode workspace. `magnus.json` is committed and `.magnus/` is not, so
  `git clone` produced a folder with content and intent but no sync state, no
  Source Control panel, and no command that could create one. Restore rebuilds
  `.magnus/` from the committed selection.

  **The server is the authority**: Restore brings local content to match it, so
  the workspace ends up byte-identical to the server and Source Control comes up
  clean. What changed relative to the repository is an ordinary `git diff`, and
  committing that is how the repo catches up. Restore warns before it overwrites,
  since uncommitted work is the one thing git cannot bring back. It does not
  rewrite `magnus.json`, so restoring your own clone leaves the repo otherwise
  untouched, and it can be re-run to discard local drift wholesale.
- **Disconnected servers are visible.** A clone can name a server this machine
  has never authenticated to, which until now surfaced only as an
  authentication failure on the first Fetch. The Source Control panel offers
  **Connect Server** instead, and connecting registers the server rather than
  leaving credentials attached to a server the tree will not display.
- **Edit Workspace Selection** (button on the Magnus Local panel): one checklist
  of every pullable resource on the server, with the current selection
  pre-checked. Adding and removing resources happen here. Unchecking asks whether
  to keep or delete the files, per resource, and never assumes.
- **`magnus.json`**, committed at the workspace root, recording which resources
  the workspace holds plus server and version details. Sync state stays in the
  gitignored `.magnus/`; pull now also seeds `.gitignore` so baselines are not
  committed by accident.
- **Background polling** for server-side changes while the panel is open,
  configurable via `magnusLocal.pollIntervalSeconds` (default 60, `0` disables).
- **Local mode for Lava Shortcodes, Lava applications and Apple TV apps.**
- **Deploy** and **Compile Theme** are now separate actions, each acting on one
  target you choose. Both can appear at once in a workspace holding both.

### Changed

- **Server changes are no longer applied to your working files automatically.**
  A change to a file you have not edited used to be written straight to disk; it
  now waits in Incoming Changes until you accept it. Only a genuine two-sided
  conflict is shown prominently.
- **Fetch is much faster on unchanged content.** It now skips downloading files
  the server reports as unmoved, so a fetch that finds nothing changed costs one
  request per resource instead of one per file.
- Push refuses when it cannot establish what the server looked like at your last
  sync, instead of proceeding silently.
- Files with no last-synced copy now appear in the panel as unverified rather
  than being hidden, and are repaired from the server when the workspace opens.
- Push is withdrawn, with a reason, for a resource type an administrator has
  disabled. Your files are untouched and stay editable.
- 403, 404 and network failures now produce different messages, and Retry is not
  offered where retrying cannot help.
- The **Servers** tree now renders the saved server list immediately instead of waiting for a per-server `GetServer` round-trip before showing anything. With many servers, especially if one is slow or unreachable, the tree could take several seconds to appear. The endpoint currently returns no fields the client uses, so dropping the call is a clean win; if Rock starts sending per-server tooltips or menu URIs in the future, we'll re-add the fetch as a lazy per-row enrichment. (Local mode does now call
  `GetServer`, once per workspace rather than per tree row, to read the plugin
  version and which resource types are enabled.)

### Fixed

- **A refused manifest no longer fails silently.** The Source Control panel read
  the manifest through a `catch` that turned every error into "no manifest",
  so a workspace pulled by an older Magnus was indistinguishable from a folder
  that was never pulled: no panel, no warning, nothing in the log to tell them
  apart. The version error is now surfaced.
- **Edit Workspace Selection** no longer sends you to Pull when the folder is a
  clone. It offers Restore instead, which is the command that can actually help.
- **Edit Workspace Selection** now seeds `.gitignore`. Only Pull did, so a
  workspace whose resources all arrived through Edit Selection would commit its
  baselines and staged incoming files on the first `git add .`.

## [1.1.0-beta.3] — 2026-05

> ⚠️ **Experimental beta.** Extends local mode to a third entity type, **Persisted Datasets**. Cloud-mode persisted datasets (introduced via Rock plugin 2.3.x) continue to work without an extension upgrade; this release adds the Pull/Fetch/Push workflow for the dataset's `BuildScript.lava`.

### Changed

- **Add Server** prompts now stay open when focus moves to another window, so you can switch to a password manager mid-flow without losing the server URL or username you already entered.

### Added — Getting Started walkthrough

A new **Get Started with Magnus** walkthrough is available from VS Code's Welcome tab, the **Help and Documentation** panel, or the command palette (**Magnus: Open Getting Started**). Six steps cover the full flow: Add Server, Explore the tree, Edit in Cloud mode, Edit in Local mode, Review changes in Source Control, and Push back to the server.

### Changed — Help and Documentation panel

The **Help and Documentation** panel in the Magnus view now offers three links instead of two: **Getting started** (opens the walkthrough), **Documentation** (`triumph.tech/magnus`), and **Report issue** (the GitHub repo). The previous two links both pointed to the same incorrect URL (`https://www.triumph.tech`).

### Added — Local mode for Persisted Datasets

Local mode now supports a third content type alongside mobile apps, AI Skills, and Website Themes. Pull the entire **Persisted Datasets** collection into a single workspace, organized into per-dataset subfolders.

**Tree view (right-click on the Persisted Datasets node):**
- **Pull to Local Workspace…** — opens an OS folder picker; every persisted dataset the user can edit is materialized under `<server-alias>/Persisted Datasets/<dataset-name>/BuildScript.lava`. Datasets with `BuildScriptType` other than `Lava` are filtered out, mirroring cloud mode.
- The Persisted Datasets tree node displays **`↓ pulled`** when a workspace exists, the same as AI Skills.

**Source Control panel** behaves identically to AI Skills workspaces: edits to `BuildScript.lava` show up in the Changes group, push round-trips back to the dataset row, fetch picks up server-side edits and renames. The Deploy button is hidden (datasets have no compile step in this release).

**Workspace bookkeeping** under `.magnus/` mirrors AI Skills: `manifest.json`, `baseline/`, `incoming/`, `incoming.json`. The manifest's `root.platform` field is `"Persisted Datasets"` and `root.buildUri` is `null`.

**Server-side rename and delete** flow through the existing reconciliation logic. Dataset URIs are keyed by Id, so renaming a dataset in the Rock UI surfaces as a folder rename under the same per-dataset directory; deleting a dataset falls out of the next Fetch. If the local copy still has uncommitted edits, the deletion is surfaced in Incoming Changes for you to accept or reject rather than being applied; only a local copy that is byte-identical to the last-synced baseline (or already gone) is removed automatically.

### Server-side requirement

Requires a `tech.triumph.Magnus` plugin build containing the Persisted Datasets virtual filesystem.

> **Correction (2026-08-18).** This section previously named plugin **v2.3.5**, which does not exist: that version string appears nowhere in the plugin, whose assembly version is `2.3.0.0`. The Persisted Datasets handler does exist in plugin source at `2.3.0.0`, but `2.3.0` was never packaged for the Rock Shop either. The newest packaged plugin release is **v2.2**, so this beta requires a plugin built from source. See the note under beta.2.

## [1.1.0-beta.2] — 2026-05

> ⚠️ **Experimental beta.** Builds on beta.1 by extending local mode to two new content types: **AI Skills** and **Website Themes**. Cloud-mode AI Skills and Themes (introduced via Rock plugin 2.3.0) continue to work without an extension upgrade; this release adds the Pull/Fetch/Push workflow for both.

### Added — Local mode for AI Skills

Local mode now supports a second content type alongside mobile apps. Pull the entire **AI Skills** collection into a single workspace, organized into per-skill subfolders.

**Tree view (right-click on the AI Skills node):**
- **Pull to Local Workspace…** — opens an OS folder picker; every AI Skill the user can edit is materialized under `<server-alias>/AI Skills/<skill-name>/<tool-name>.<ext>`. Tools with `ToolType = ExecuteLava` get `.lava`; `AIPrompt` get `.md`. ExecuteCode tools and tools the user lacks Edit access to are filtered out (mirroring cloud mode).
- The AI Skills tree node now displays **`↓ pulled`** when a workspace exists, the same as mobile apps.

**Source Control panel** behaves identically to mobile-app workspaces, with one difference:
- The **Deploy** button is hidden (AI Skills have no compile step).

**Workspace bookkeeping** under `.magnus/` mirrors the mobile-app shape: `manifest.json`, `baseline/`, `incoming/`, `incoming.json`. The manifest's `root.platform` field is set to `"AI Skills"` and `root.buildUri` is `null`.

**Server-side rename and delete** flow naturally through the existing reconciliation logic. Tool URIs are keyed by Id, so renaming a tool in the Rock UI surfaces as a renamed file under the same skill folder; deleting a tool falls out of the next Fetch, with the same confirmation behaviour: uncommitted local edits are surfaced in Incoming Changes rather than discarded, and only a clean local copy is removed automatically.

### Added — Local mode for Website Themes

Local mode now also supports Rock website themes. A new **Themes** entry in the Magnus tree exposes each theme directory (`~/Themes/<ThemeName>/`) on the server. Themes are independent of any specific site — one theme can back multiple sites — so the pull unit is the theme, not the site.

**Tree view (right-click on a theme node):**
- **Pull to Local Workspace…** — opens an OS folder picker; every file under the theme directory is materialized at the mirrored relative path. All file types are surfaced; there is no extension allow-list. Edit access is governed by the Magnus security role.
- The theme node displays **`↓ pulled`** when a workspace exists.

**Source Control panel** behaves identically to mobile-app workspaces, including:
- **Compile Theme** (rocket icon) — triggers the server-side Less/SCSS compile so style changes show up in the running site.

**Workspace bookkeeping** under `.magnus/` is unchanged. The manifest's `root.platform` field is set to `"Themes"` and `root.buildUri` carries the compile endpoint.

**Enablement.** The Themes VFS is gated by the standard `EnabledVirtualFilesystems` list on the Magnus settings page — the same checkbox model every other VFS uses. The Server Filesystem VFS continues to expose `~/Themes/` independently in cloud mode and is unaffected by this list.

### Changed — Local-mode plumbing generalized

- Pull eligibility, tree decorations, and Deploy-button visibility no longer hardcode mobile-app URI patterns. The new `isLocalModePullableUri` helper composes per-content-type checks; adding the next content type (Persisted Datasets, etc.) is purely additive.
- The Deploy button now hides whenever `manifest.root.buildUri` is null/empty, regardless of content type.

### Removed — AGENTS.md generation

The extension no longer writes an `AGENTS.md` file at the root of pulled workspaces. Developers manage their own AI tool configuration files (`AGENTS.md`, `CLAUDE.md`, `.cursor/`, etc.) directly. The `magnusLocal.writeAgentsFile` setting is gone; pulls that previously left an `AGENTS.md` in place will leave the existing file untouched, but new pulls will not generate one.

### Server-side requirement

Requires a `tech.triumph.Magnus` plugin build containing the AI Skills and Themes virtual filesystems. The mobile-app workflow from beta.1 still works against the packaged v2.2; the new content types do not.

> **Correction (2026-08-18).** Plugin `2.3.0` is the assembly version in plugin source, not a published release. The newest packaged plugin release is **v2.2**, so both this beta and beta.3 require a plugin built from source rather than installed from the Rock Shop. Because there is no version handshake between client and plugin, a mismatch surfaces as a failed request rather than a clear message; returning the plugin version from `GetServer` is planned for plugin 2.4.0.

### Preserved verbatim from beta.1

All mobile-app local-mode behavior, all cloud-mode behavior, and all the API/auth changes from beta.1 are unchanged. Existing pulled mobile-app workspaces continue to work without migration.

---

## [1.1.0-beta.1] — 2026-04

> ⚠️ **Experimental beta.** This version introduces a new "local mode" alongside Magnus's existing cloud-mode editing. Cloud mode is preserved verbatim from 1.0.2, but local mode is new and currently scoped to **mobile apps only**. Expect rough edges; report issues at https://github.com/Triumph-Tech/magnus-vscode/issues. The `1.0.2` stable release remains the recommended version for production use until this stabilizes.

### Added — Magnus Local mode

A parallel workflow that materializes a mobile app's content as real files on disk, with full source-control integration. Designed to make Rock content editable by AI tools (Claude Code, Cursor, Copilot, etc.) that operate on a real filesystem and don't understand custom URI schemes.

**Tree view (right-click on a mobile app):**
- **Pull to Local Workspace…** — opens an OS folder picker; the content is materialized inside the chosen folder under `<server-alias>/<group>/<app-name>/`. Each app pulled gets its own subfolder, so multiple apps can share a parent. The subdirectory layout mirrors how the apps are organized on the server.
- **Open Local Workspace** — opens the pulled folder in a new VS Code window.
- **Reveal Local Workspace in Finder** — opens the folder in the OS file manager.
- **Unlink Local Workspace** — removes the registry entry without touching files on disk.
- Pulled apps display **`↓ pulled`** after their label in the tree.

**Source Control panel** (appears automatically when a pulled workspace is open):
- **Changes** group: locally modified files compared against last-synced bytes; click to diff.
- **Incoming Changes** group: server-side changes that conflict with your local edits or are net-new on the server; click to compare baseline vs server.
- **Push All Changes** (cloud-upload icon) — uploads local edits with a server-side conflict check; refuses if the server moved since last sync, with options to view the server version or force-overwrite.
- **Fetch from Server** (cloud-download icon) — explicit, user-initiated only. No automatic background fetches; the status bar shows `last fetched X ago` so you can decide when to sync.
- **Deploy Mobile App** (rocket icon) — equivalent to right-click → Deploy in cloud mode. Triggers Rock's mobile-app server-side compile so layout/CSS changes show up in the running mobile client.
- Per-resource inline actions: **Push** / **Discard** in Changes; **Pull Server Version** in Incoming Changes.

**Workspace bookkeeping** (under `.magnus/` in each pulled workspace):
- `manifest.json` — server URL, tree URI, per-file URIs and content hashes
- `baseline/` — last-synced server bytes, used for SCM diffs
- `incoming/` — server changes fetched but not yet merged

**File extensions** are preserved on disk (`Content.lava`, `CSS Styles.css`, `Metadata.txt`, etc.) so VS Code language detection and your installed Lava/CSS extensions activate automatically. The `Repair File Extensions` command migrates workspaces pulled with a pre-1.1.0 build that lacked this.

**`AGENTS.md`** is generated at the root of each pulled workspace with format-neutral instructions for AI coding tools (Claude Code, Cursor, Aider, etc.). Disable via the `magnusLocal.writeAgentsFile` setting if you don't want it.

**Settings (new):**

| Setting | Default | Purpose |
|---|---|---|
| `magnusLocal.pullRoot` | `""` (empty) | Optional starting directory for the Pull dialog. Leave blank to use the OS picker's last-used directory. |
| `magnusLocal.allowMultiAppWorkspace` | `false` | Allow pulling multiple apps into a single VS Code workspace. Off by default — AI tools would otherwise read across apps. |
| `magnusLocal.writeAgentsFile` | `true` | Whether to generate `AGENTS.md` at the workspace root on pull. |

### Changed — API surface (additive; benefits cloud mode too)

- Per-request HTTP timeout raised from 10s → 60s. Rock can be slow under load; one cold-start request shouldn't take down a fetch.
- New `AuthenticationError` class distinguishes "session expired" from generic network errors so the extension can offer re-authentication instead of a generic "try again."
- Single-shot 401 retry via fresh login. Stale cookies recover transparently without bothering the user.
- New **Re-authenticate Server…** right-click action on server nodes — handy when stored credentials expire.

### Preserved verbatim from 1.0.2

All cloud-mode behavior is untouched:
- The `ttmagnus://` / `ttmagnuss://` virtual filesystem for inline editing
- Right-click commands: Add/Remove Server, Refresh, Deploy (renamed from "Build" to match Rock UI), New File, New Folder, Upload, Upload Folder, Delete, Copy ID/Guid/Value, View on Web, Edit on Web
- Activity bar icon, Servers view, welcome screen, `.rckcs` C# language association

If you don't pull anything to local, the extension behaves exactly like 1.0.2.

### Scope and limitations

- **Local mode supports mobile apps only** in this release. Other Rock content types (web pages, content channels, persisted datasets) won't show the Pull menu.
- **Push-time conflict resolution is "all or nothing."** No 3-way merge editor, no per-line cherry-pick. You either pull the server version or force-overwrite with yours. A future release may add merge tooling if conflicts turn out to be common in practice.
- **No automatic fetch.** Staleness is the default state; fetch is always an explicit click. If you want to know whether the server has moved, ask.
- **Server-side requirement:** the Triumph-Rockit `tech.triumph.Magnus` plugin v2.2 or later must be installed and configured on your Rock server. Local mode uses the same `FileContent` REST endpoints cloud mode does.

### Install

This is a sideload-only build — it isn't on the VS Code marketplace yet.

1. Download `magnus-1.1.0-beta.1.vsix` from the release assets below.
2. In VS Code: Extensions panel → `…` menu (top right) → **Install from VSIX…** → pick the file.
3. Reload the window when prompted.

The extension ID is `TriumphTech.magnus`, the same as the marketplace version. Installing this `.vsix` replaces the marketplace install in your VS Code; uninstall and reinstall from marketplace to roll back.

### Internal

- 117 vitest unit tests covering pure-module helpers (manifest, baselines, content filter, network errors, repair plan, naming).

## [1.0.2]

- Bumped version to 1.0.2.
- Added support for custom language extension to C#.

## [1.0.1]

- Bumped version to 1.0.1.
- Added link to issue tracker.

## [1.0.0]

- Initial release.
