import { effectiveEnvironment, ServerEnvironment } from "./documentBindings";
import { normalizeServerUrl } from "./nodeCache";

/**
 * The presentation and storage decisions around a document's binding: what the
 * status bar item says, how it is tinted, how the environment tags and the
 * always-allow list are stored, and how the server quick pick reads.
 *
 * The storage here is a plain record so that the rules can be tested without
 * `globalState`; {@link BindingManager} is the shell that reads and writes it.
 */

/** The `globalState` key that holds the environment tag of each server. */
export const serverEnvironmentsStateKey = "magnus.sql.serverEnvironments";

/** The `globalState` key that holds the servers that stopped asking for confirmation. */
export const alwaysAllowDestructiveStateKey = "magnus.sql.alwaysAllowDestructive";

/** The `globalState` key that holds the server a scratch query binds to. */
export const lastUsedServerStateKey = "magnus.sql.lastUsedServer";

/** The theme color that tints the status bar item on a production server. */
export const productionBackgroundColorId = "statusBarItem.errorBackground";

/** The theme color that tints the status bar item on a staging server. */
export const stagingBackgroundColorId = "statusBarItem.warningBackground";

/**
 * The environment tag of each server, keyed by normalized server URL.
 *
 * Only the two tags that relax the guard are ever stored. Production is the
 * default posture, so it is represented by the absence of an entry rather than
 * by the string `production`: one state, one spelling, and a workspace tagged
 * before this rule existed reads the same as one tagged after it. Read the map
 * through {@link getServerEnvironment} and resolve it with
 * `effectiveEnvironment`, never by testing for a `production` entry.
 */
export type ServerEnvironmentMap = Readonly<Record<string, "staging" | "development">>;

/**
 * One entry of the environment quick pick.
 */
export type EnvironmentPickItem = {
    /** The name of the environment, as it is displayed. */
    label: string;

    /** What choosing it does. */
    description: string;

    /** The tag to store, which is undefined for production. */
    environment: ServerEnvironment;
};

/**
 * The choices the Set Server Environment picker offers.
 *
 * Production leads and is the default rather than an opt in, and its description
 * says so, because that is what an untagged server already gets.
 */
export const environmentPickItems: readonly EnvironmentPickItem[] = [
    {
        label: "Production",
        description: "Default, including for untagged servers. Red status bar, warns before anything that changes data",
        environment: undefined
    },
    {
        label: "Staging",
        description: "Opt out of the warnings. Orange status bar",
        environment: "staging"
    },
    {
        label: "Development",
        description: "Opt out of the warnings. No tint",
        environment: "development"
    }
];

/**
 * What the status bar item shows for the active editor.
 */
export type StatusBarPresentation = {
    /** The text of the item, including its codicon. */
    text: string;

    /** The hover text of the item. */
    tooltip: string;

    /** The theme color to tint the item's background with, or undefined for the default. */
    backgroundColorId: string | undefined;
};

/**
 * One entry of the server quick pick.
 */
export type ServerPickItem = {
    /** The URL of the server, which is what is displayed. */
    label: string;

    /** The environment tag of the server, when it has one. */
    description: string;

    /** The URL of the server this entry selects. */
    serverUrl: string;
};

/**
 * Gets the environment a server is tagged with.
 *
 * A server that is untagged, or that was tagged production before production
 * became the default, both read as undefined, which `effectiveEnvironment`
 * resolves to production.
 *
 * @param environments The environment tag of each server.
 * @param serverUrl The URL of the server.
 *
 * @returns The tag, or undefined when the server has none.
 */
export function getServerEnvironment(environments: ServerEnvironmentMap, serverUrl: string): ServerEnvironment {
    const stored = environments[normalizeServerUrl(serverUrl)];

    return stored === "staging" || stored === "development" ? stored : undefined;
}

/**
 * Records the environment a server is tagged with.
 *
 * Production, like undefined, clears the entry: production is the default
 * posture, so it needs no tag, and storing one would leave two spellings of the
 * same state.
 *
 * @param environments The environment tag of each server.
 * @param serverUrl The URL of the server.
 * @param environment The tag to apply, or undefined or production to clear it.
 *
 * @returns The new map of tags.
 */
export function setServerEnvironment(environments: ServerEnvironmentMap, serverUrl: string, environment: ServerEnvironment): ServerEnvironmentMap {
    const key = normalizeServerUrl(serverUrl);
    const next = { ...environments };

    if (environment === "staging" || environment === "development") {
        next[key] = environment;
    }
    else {
        delete next[key];
    }

    return next;
}

/**
 * Adds a server to the list of servers that no longer prompt before a
 * destructive statement runs.
 *
 * This is only ever called from the confirmation dialog's own button. There is
 * no command that turns the guard off wholesale, on purpose.
 *
 * @param alwaysAllowServers The URLs of the servers already on the list.
 * @param serverUrl The URL of the server to add.
 *
 * @returns The new list, unchanged when the server was already on it.
 */
export function addAlwaysAllowServer(alwaysAllowServers: string[], serverUrl: string): string[] {
    const normalized = normalizeServerUrl(serverUrl);

    if (alwaysAllowServers.some(existing => normalizeServerUrl(existing) === normalized)) {
        return alwaysAllowServers;
    }

    return [...alwaysAllowServers, normalized];
}

/**
 * Gets the host name of a server, which is what the status bar has room for.
 *
 * @param serverUrl The URL of the server.
 *
 * @returns The host name, or the URL itself when it cannot be parsed.
 */
export function serverHostLabel(serverUrl: string): string {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(serverUrl.trim());

    if (!match) {
        return serverUrl.trim();
    }

    const authority = match[1];
    const at = authority.lastIndexOf("@");

    return at >= 0 ? authority.substring(at + 1) : authority;
}

/**
 * Decides what the status bar item shows.
 *
 * A production server is tinted with the error background and a staging server
 * with the warning background, which is the same visual language the rest of
 * Visual Studio Code uses for "look before you type". An untagged server is
 * treated as production, so it gets the red as well.
 *
 * @param serverUrl The URL of the server the active document is bound to, or undefined when it is unbound.
 * @param environment The tag on that server, if it has one.
 * @param isRunning True while a query from this document is in flight.
 *
 * @returns What the item should show, or null when it should be hidden.
 */
export function buildStatusBarPresentation(serverUrl: string | undefined, environment: ServerEnvironment, isRunning: boolean): StatusBarPresentation | null {
    if (serverUrl === undefined) {
        return {
            text: "$(database) Not bound",
            tooltip: "This SQL editor is not bound to a Magnus server. Click to bind one.",
            backgroundColorId: undefined
        };
    }

    const host = serverHostLabel(serverUrl);
    const backgroundColorId = environmentBackgroundColorId(environment);

    if (isRunning) {
        return {
            text: `$(sync~spin) ${host}`,
            tooltip: `Running a query on ${serverUrl}. Click to cancel it.`,
            backgroundColorId
        };
    }

    const resolved = effectiveEnvironment(environment);
    const tag = environment === undefined ? " (production by default)" : ` (${resolved})`;

    return {
        text: `$(database) ${host}`,
        tooltip: `SQL queries in this editor run on ${serverUrl}${tag}. Click to bind a different server.`,
        backgroundColorId
    };
}

/**
 * Gets the theme color that tints the status bar item for an environment.
 *
 * @param environment The tag on the bound server, if it has one. Untagged resolves to production.
 *
 * @returns The theme color identifier, or undefined for the default background.
 */
export function environmentBackgroundColorId(environment: ServerEnvironment): string | undefined {
    const resolved = effectiveEnvironment(environment);

    if (resolved === "production") {
        return productionBackgroundColorId;
    }

    if (resolved === "staging") {
        return stagingBackgroundColorId;
    }

    return undefined;
}

/**
 * Builds the entries of the server quick pick.
 *
 * An untagged server is described as production too, since that is how it
 * behaves, with the word "default" to say where the classification came from.
 *
 * @param servers The URLs of the saved servers.
 * @param environments The environment tag of each server.
 *
 * @returns One entry per server, in the order they were saved.
 */
export function buildServerPickItems(servers: string[], environments: ServerEnvironmentMap): ServerPickItem[] {
    return servers.map(serverUrl => {
        const environment = getServerEnvironment(environments, serverUrl);

        return {
            label: serverUrl,
            description: environment ?? "production (default)",
            serverUrl
        };
    });
}

/**
 * Decides which server a scratch query binds to.
 *
 * The last server used is remembered so that the second scratch query needs no
 * decision at all. A remembered server that is no longer saved is ignored, and
 * a single saved server is used without asking.
 *
 * @param lastUsedServer The URL of the server remembered from last time, if any.
 * @param servers The URLs of the saved servers.
 *
 * @returns The server to bind to, or undefined when the person has to pick.
 */
export function resolveScratchServer(lastUsedServer: string | undefined, servers: string[]): string | undefined {
    if (lastUsedServer !== undefined && lastUsedServer !== "") {
        const normalized = normalizeServerUrl(lastUsedServer);
        const match = servers.find(server => normalizeServerUrl(server) === normalized);

        if (match !== undefined) {
            return match;
        }
    }

    return servers.length === 1 ? servers[0] : undefined;
}

/**
 * Finds the saved server a URL names, if any.
 *
 * The comparison is on the normalized URL, so a spelling that differs only in
 * case or in a trailing slash still matches, and the saved spelling is what is
 * returned so that everything downstream keys off the URL the person added.
 *
 * This is what stands between a workspace's `magnus.json` and an arbitrary host:
 * the file is committed, so a cloned repository can name any server it likes,
 * and honoring it without this check would mean a clone deciding where someone's
 * SQL runs.
 *
 * @param servers The URLs of the saved servers.
 * @param serverUrl The URL to look for.
 *
 * @returns The saved server as it is spelled in the list, or undefined when the URL is not one of them.
 */
export function findSavedServer(servers: string[], serverUrl: string): string | undefined {
    if (serverUrl.trim() === "") {
        return undefined;
    }

    const normalized = normalizeServerUrl(serverUrl);

    return servers.find(server => normalizeServerUrl(server) === normalized);
}

/**
 * Builds the modal warning shown before a destructive statement runs on a server
 * treated as production.
 *
 * The wording says "treated as", not "tagged as": most servers reach this dialog
 * by being untagged rather than by anyone having tagged them, and a prompt that
 * claims a tag nobody set reads as a bug.
 *
 * @param serverUrl The URL of the bound server.
 *
 * @returns The text of the warning.
 */
export function buildDestructiveConfirmationMessage(serverUrl: string): string {
    return `This statement changes data on ${serverHostLabel(serverUrl)}, which is treated as production. Run it anyway?`;
}

/**
 * The second line of the destructive confirmation dialog, which says where the
 * production classification came from and how to change it.
 */
export const destructiveConfirmationDetail = "Every Magnus server is treated as production unless it is tagged staging or development. Statements that change data cannot be undone from here. Use Set Server Environment to change the tag.";
