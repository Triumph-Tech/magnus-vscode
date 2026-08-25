import * as vscode from "vscode";

/** The globalState key under which the pulled-workspace list is persisted. */
const STATE_KEY = "PulledWorkspaces";

/**
 * A single pulled workspace entry, surfaced in the "Pulled Workspaces"
 * section of the Magnus tree view.
 */
export type PulledWorkspace = {
    /** Server base URL this workspace was pulled from. */
    serverUrl: string;

    /** Absolute local filesystem path to the workspace root. */
    localPath: string;

    /** Human-facing label, e.g. "prod-church-org / Kids App". */
    label: string;

    /** The server URI that was pulled as the root of this workspace. */
    rootUri: string;

    /** ISO-8601 timestamp of when the pull completed. */
    pulledAt: string;
};

/**
 * Persists the user's list of pulled workspaces across VS Code sessions
 * and across windows (via globalState). Pulled workspaces are not tied to
 * any currently-open folder — they track every pull the user has done.
 */
export class PullRegistry {
    private context: vscode.ExtensionContext;
    private didChange: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();

    public readonly onDidChange: vscode.Event<void> = this.didChange.event;

    public constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /** Snapshot of all pulled workspaces, sorted by label. */
    public list(): PulledWorkspace[] {
        const items = this.context.globalState.get<PulledWorkspace[]>(STATE_KEY, []);
        return [...items].sort((a, b) => a.label.localeCompare(b.label));
    }

    /**
     * Add a pulled workspace. If an entry with the same localPath already
     * exists it is replaced (e.g. after a re-pull).
     */
    public async add(ws: PulledWorkspace): Promise<void> {
        const items = this.context.globalState.get<PulledWorkspace[]>(STATE_KEY, []);
        const filtered = items.filter(i => i.localPath !== ws.localPath);
        filtered.push(ws);
        await this.context.globalState.update(STATE_KEY, filtered);
        this.didChange.fire();
    }

    /**
     * Remove a pulled workspace from the list. Does not touch files on disk.
     */
    public async remove(localPath: string): Promise<void> {
        const items = this.context.globalState.get<PulledWorkspace[]>(STATE_KEY, []);
        const filtered = items.filter(i => i.localPath !== localPath);
        await this.context.globalState.update(STATE_KEY, filtered);
        this.didChange.fire();
    }

    public findByLocalPath(localPath: string): PulledWorkspace | undefined {
        return this.list().find(i => i.localPath === localPath);
    }
}
