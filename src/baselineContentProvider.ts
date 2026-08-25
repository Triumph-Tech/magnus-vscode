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
 * URIs are of the form `magnus-local-baseline://<encoded-root>/<relPath>`,
 * where `<encoded-root>` is the workspace root path with slashes encoded.
 */
export const BASELINE_SCHEME = "magnus-local-baseline";

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

/** Build a baseline URI for the given workspace root and relative file path. */
export function encodeBaselineUri(workspaceRoot: string, relPath: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: BASELINE_SCHEME,
        authority: encodeURIComponent(workspaceRoot),
        path: `/${relPath.split("/").map(encodeURIComponent).join("/")}`
    });
}

function decodeBaselineUri(uri: vscode.Uri): { workspaceRoot: string; relPath: string } {
    return {
        workspaceRoot: decodeURIComponent(uri.authority),
        relPath: uri.path.replace(/^\//, "").split("/").map(decodeURIComponent).join("/")
    };
}
