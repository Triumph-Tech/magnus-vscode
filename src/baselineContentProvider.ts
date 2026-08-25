import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BASELINE_DIR, readBaseline, removeBaseline, writeBaseline } from "./baseline";

// Re-export the fs helpers so downstream modules keep their existing imports.
// The provider below is the VS Code-facing surface; the helpers live in
// ./baseline so tests can import them without pulling in the vscode module.
export { BASELINE_DIR, readBaseline, removeBaseline, writeBaseline };

/**
 * URI scheme for the "last synced with server" view of a pulled file. Used by
 * the quick-diff provider so VS Code's inline diff editor has something to
 * compare the working file against.
 *
 * URIs are of the form `magnus-local-baseline:/<relPath>?<json>`, where the
 * query carries the workspace root and which consumer the URI is for. The
 * root must not live in the authority: VS Code lower-cases the authority when
 * a URI round-trips through toString, so an authority-encoded root reaches
 * the provider case-flattened, which only works on case-insensitive volumes.
 */
export const BASELINE_SCHEME = "magnus-local-baseline";

/**
 * Which consumer a baseline URI is built for. The quick-diff gutter of an open
 * editor and the left side of an explicit diff must not share one URI: VS Code
 * resolves both through the same reference collection, and releasing one holder
 * while acquiring the other in the same tick makes the extension-provider path
 * call createModel on a model that is still registered, which throws
 * "ModelService: Cannot add model because it already exists!" and leaves the
 * model leaked so the diff stays broken until the window reloads. Distinct URIs
 * per consumer keep the two on separate models entirely.
 */
export type BaselineUse = "quickdiff" | "diff";

/**
 * Read-only text content provider that serves the last-synced bytes for a
 * pulled file. VS Code registers this once; the quick-diff provider produces
 * URIs in this scheme pointing at the right baseline file.
 */
export class BaselineContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private didChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.didChange.event;

    public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const { workspaceRoot, relPath } = decodeBaselineUri(uri);
        const baselinePath = path.join(workspaceRoot, BASELINE_DIR, relPath);
        try {
            return await fs.readFile(baselinePath, "utf8");
        }
        catch {
            return "";
        }
    }

    /** Notify VS Code that a baseline has changed so open diff editors refresh. */
    public notifyChanged(uri: vscode.Uri): void {
        this.didChange.fire(uri);
    }

    public dispose(): void {
        this.didChange.dispose();
    }
}

/**
 * Build a baseline URI for the given workspace root and relative file path.
 *
 * @param workspaceRoot The absolute path of the pulled workspace.
 * @param relPath The path of the file relative to the workspace root.
 * @param use The consumer the URI is for; see {@link BaselineUse}.
 */
export function encodeBaselineUri(workspaceRoot: string, relPath: string, use: BaselineUse = "quickdiff"): vscode.Uri {
    return vscode.Uri.from({
        scheme: BASELINE_SCHEME,
        path: `/${relPath.split("/").map(encodeURIComponent).join("/")}`,
        query: JSON.stringify({ root: workspaceRoot, use })
    });
}

function decodeBaselineUri(uri: vscode.Uri): { workspaceRoot: string; relPath: string } {
    const { root } = JSON.parse(uri.query) as { root: string };

    return {
        workspaceRoot: root,
        relPath: uri.path.replace(/^\//, "").split("/").map(decodeURIComponent).join("/")
    };
}
