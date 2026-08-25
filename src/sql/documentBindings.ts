import { normalizeServerUrl } from "./nodeCache";
import { StatementClassification } from "./statementSplitter";

/**
 * The decision core for binding a SQL document to a server, and for the
 * confirmation prompt that guards a production tagged server.
 *
 * A pulled workspace already names its server in `magnus.json`, so any `.sql`
 * file inside one runs with no setup at all. Everything else is bound
 * explicitly, once, and remembered for the lifetime of the document.
 *
 * The `magnus.json` reader here is deliberately its own minimal thing. Local
 * mode owns that file on another branch and its direction is still settling; all
 * this feature needs from it is the server URL, so it reads that and nothing
 * else rather than importing a local mode module.
 */

/**
 * The environment a saved server is tagged with, or undefined when it is
 * untagged. An untagged server is treated as production; see
 * {@link effectiveEnvironment}.
 */
export type ServerEnvironment = "production" | "staging" | "development" | undefined;

/**
 * An environment with the untagged case already resolved, which is what every
 * behavior is decided from.
 */
export type ResolvedServerEnvironment = "production" | "staging" | "development";

/**
 * Resolves the environment a server is treated as.
 *
 * **Every saved server is a real Rock server, so the default posture is
 * production.** An untagged server therefore behaves exactly as a production
 * tagged one does: red status bar, confirmation before anything that changes
 * data. Tagging a server staging or development is the explicit opt out, which
 * means tags only ever relax the guard and never tighten it.
 *
 * This is the one place that rule lives. Nothing else may compare an
 * environment against `undefined` to decide behavior.
 *
 * @param environment The tag on the server, if it has one.
 *
 * @returns The environment the server is treated as.
 */
export function effectiveEnvironment(environment: ServerEnvironment): ResolvedServerEnvironment {
    return environment ?? "production";
}

/**
 * The bindings of the documents that are currently open, keyed by document URI.
 * Held in memory only; a binding does not survive a window reload.
 */
export type BindingState = Readonly<Record<string, string>>;

/**
 * What the run command should do about a document's binding.
 */
export type BindingResolution =
    /** The document already has an explicit binding. */
    | { kind: "bound"; serverUrl: string }
    /** The document is inside a pulled workspace and binds to its server without asking. */
    | { kind: "autoBind"; serverUrl: string }
    /** Nothing names a server for this document, so the person has to pick one. */
    | { kind: "needsPicker" };

/**
 * The one thing this feature reads out of a workspace's `magnus.json`.
 */
export type MagnusJsonBinding = {
    /** The URL of the server the workspace was pulled from. */
    serverUrl: string;
};

/** An empty binding state, used when a window opens. */
export const emptyBindingState: BindingState = {};

/**
 * Decides which server a document runs against.
 *
 * An explicit binding always wins over the workspace: someone who rebound a
 * document through the status bar meant it, even inside a pulled workspace.
 *
 * @param documentUri The URI of the document, as a string.
 * @param state The bindings of the documents that are currently open.
 * @param workspaceMagnusJson The workspace's `magnus.json` binding, or null when there is none.
 *
 * @returns What the run command should do about the binding.
 */
export function resolveBinding(documentUri: string, state: BindingState, workspaceMagnusJson: MagnusJsonBinding | null): BindingResolution {
    const bound = state[documentUri];

    if (bound !== undefined && bound !== "") {
        return {
            kind: "bound",
            serverUrl: bound
        };
    }

    if (workspaceMagnusJson && workspaceMagnusJson.serverUrl !== "") {
        return {
            kind: "autoBind",
            serverUrl: workspaceMagnusJson.serverUrl
        };
    }

    return {
        kind: "needsPicker"
    };
}

/**
 * Records the server a document is bound to.
 *
 * @param state The bindings of the documents that are currently open.
 * @param documentUri The URI of the document, as a string.
 * @param serverUrl The URL of the server to bind it to.
 *
 * @returns The new binding state.
 */
export function bindDocument(state: BindingState, documentUri: string, serverUrl: string): BindingState {
    return {
        ...state,
        [documentUri]: serverUrl
    };
}

/**
 * Forgets the binding of a document, which happens when it is closed.
 *
 * @param state The bindings of the documents that are currently open.
 * @param documentUri The URI of the document, as a string.
 *
 * @returns The new binding state.
 */
export function unbindDocument(state: BindingState, documentUri: string): BindingState {
    if (state[documentUri] === undefined) {
        return state;
    }

    const next = { ...state };

    delete next[documentUri];

    return next;
}

/**
 * Gets the server a document is explicitly bound to.
 *
 * @param state The bindings of the documents that are currently open.
 * @param documentUri The URI of the document, as a string.
 *
 * @returns The URL of the server, or undefined if the document has no explicit binding.
 */
export function getBinding(state: BindingState, documentUri: string): string | undefined {
    return state[documentUri];
}

/**
 * Reads the server URL out of a workspace's `magnus.json`.
 *
 * The file is committed and its shape is documented: `server` is an object with
 * a `url` and an `alias`, which is what a pulled workspace writes. Two older
 * spellings are still accepted, a bare `server` string and a `serverUrl` string,
 * so a workspace pulled by an earlier version keeps working. Anything else,
 * including malformed JSON and a `server` object without a usable `url`, yields
 * null and the document falls back to the picker. This never throws: a broken
 * file must not break the run command.
 *
 * @param jsonText The text of the `magnus.json` file.
 *
 * @returns The binding the file names, or null if it does not name one.
 */
export function parseMagnusJson(jsonText: string): MagnusJsonBinding | null {
    let parsed: unknown;

    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        return null;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
    }

    const bag = parsed as Record<string, unknown>;
    const serverUrl = firstNonEmptyString(objectUrl(bag["server"]), bag["server"], bag["serverUrl"]);

    if (serverUrl === undefined) {
        return null;
    }

    return {
        serverUrl
    };
}

/**
 * Reads the `url` out of the object form of the `server` field.
 *
 * Anything that is not an object, or an object whose `url` is not a string,
 * yields undefined so that the older string spellings still get their turn.
 *
 * @param value The value of the `server` field, whatever shape it turned out to be.
 *
 * @returns The URL the object names, or undefined if it does not name one.
 */
function objectUrl(value: unknown): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }

    return (value as Record<string, unknown>)["url"];
}

/**
 * Picks the first of the candidates that is a string with something in it.
 *
 * @param candidates The values to consider, in order of preference.
 *
 * @returns The trimmed value, or undefined if none of them qualify.
 */
function firstNonEmptyString(...candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate.trim();
        }
    }

    return undefined;
}

/**
 * Decides whether running a statement needs the person to confirm first.
 *
 * The prompt is a courtesy guard, not a security boundary: who may execute SQL
 * is enforced server side. It fires on any server treated as production, which
 * by {@link effectiveEnvironment} includes every untagged one, and an
 * unrecognized statement shape counts as destructive so that a tokenizer miss
 * fails safe.
 *
 * @param environment The tag on the bound server, if it has one.
 * @param classification How the statement splitter classified the statement.
 * @param alwaysAllowServers The URLs of the servers the person chose to stop being asked about.
 * @param serverUrl The URL of the bound server.
 *
 * @returns True if the person must confirm before the statement runs.
 */
export function needsDestructiveConfirmation(environment: ServerEnvironment, classification: StatementClassification, alwaysAllowServers: string[], serverUrl: string): boolean {
    if (effectiveEnvironment(environment) !== "production") {
        return false;
    }

    if (classification === "read") {
        return false;
    }

    return !isAlwaysAllowed(alwaysAllowServers, serverUrl);
}

/**
 * Determines if a server is on the always allow list.
 *
 * @param alwaysAllowServers The URLs of the servers the person chose to stop being asked about.
 * @param serverUrl The URL of the server to check.
 *
 * @returns True if the server is on the list.
 */
export function isAlwaysAllowed(alwaysAllowServers: string[], serverUrl: string): boolean {
    const normalized = normalizeServerUrl(serverUrl);

    return alwaysAllowServers.some(allowed => normalizeServerUrl(allowed) === normalized);
}
