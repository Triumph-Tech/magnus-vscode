import * as vscode from "vscode";
import { addEntry, createHistoryEntry, defaultHistorySize, HistoryEntry, HistoryEntryInput, parseStoredHistory } from "./queryHistory";

/** The `globalState` key the history is stored under. */
export const queryHistoryStateKey = "magnus.sql.queryHistory";

/** The setting that caps the history, where 0 turns it off. */
export const historySizeSettingKey = "magnus.sql.historySize";

/**
 * Holds the query history and writes it through to `globalState`.
 *
 * The list is read once at construction and kept in memory from then on, so the
 * quick pick never waits on storage and recording a run never has to re-read
 * and re-validate everything. Every rule about what an entry looks like, what
 * gets kept and what a corrupt store degrades to lives in {@link queryHistory};
 * this is only the shell around it.
 *
 * Persistence is best effort on purpose. A run that succeeded must not be
 * reported as failed because its history entry could not be saved, so a write
 * that throws is logged and dropped.
 */
export class QueryHistoryStore {
    // #region Private Properties

    /** The context that identifies our extension instance. */
    private context: vscode.ExtensionContext;

    /** The history, newest first. */
    private history: HistoryEntry[];

    /** The number the identifier of the next entry recorded in this window is built from. */
    private nextId: number = 1;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the history store and loads what is on disk.
     *
     * @param context The context that identifies our extension instance.
     */
    public constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.history = parseStoredHistory(context.globalState.get(queryHistoryStateKey));
    }

    // #endregion

    // #region Private Functions

    /**
     * Gets the number of entries the history is capped at.
     *
     * @returns The cap, where 0 means history is switched off.
     */
    private getMaxSize(): number {
        const configured = vscode.workspace.getConfiguration().get<number>(historySizeSettingKey, defaultHistorySize);

        if (typeof configured !== "number" || !isFinite(configured) || configured < 0) {
            return defaultHistorySize;
        }

        return Math.floor(configured);
    }

    /**
     * Writes the in memory history to `globalState`, swallowing a failure.
     */
    private async persist(): Promise<void> {
        try {
            await this.context.globalState.update(queryHistoryStateKey, this.history);
        }
        catch (error) {
            // Losing a history entry is not worth telling anyone about, and it is
            // certainly not worth failing the run that produced it.
            console.warn("Magnus: the query history could not be saved.", error);
        }
    }

    // #endregion

    // #region Public Functions

    /**
     * Gets the history.
     *
     * @returns The entries, newest first. The returned array is a copy.
     */
    public getEntries(): HistoryEntry[] {
        return [...this.history];
    }

    /**
     * Gets one entry by its identifier.
     *
     * @param id The identifier of the entry.
     *
     * @returns The entry, or undefined when it is no longer in the history.
     */
    public getEntry(id: string): HistoryEntry | undefined {
        return this.history.find(entry => entry.id === id);
    }

    /**
     * Records a run.
     *
     * @param input The details of the run, without its identifier.
     */
    public async record(input: Omit<HistoryEntryInput, "id">): Promise<void> {
        const maxSize = this.getMaxSize();

        if (maxSize <= 0) {
            if (this.history.length > 0) {
                this.history = [];

                await this.persist();
            }

            return;
        }

        const id = `${Date.now().toString(36)}-${this.nextId++}`;

        this.history = addEntry(this.history, createHistoryEntry({ ...input, id }), maxSize);

        await this.persist();
    }

    /**
     * Discards the whole history.
     */
    public async clear(): Promise<void> {
        this.history = [];

        await this.persist();
    }

    // #endregion
}
