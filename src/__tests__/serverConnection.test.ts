import { describe, expect, it, vi } from "vitest";
import { Secrets } from "../secrets";
import {
    addKnownServer,
    isServerKnown,
    normalizeServerUrl,
    resolveServerConnection
} from "../serverConnection";

/**
 * A cloned workspace names a server this machine may never have seen. These
 * helpers let the UI say "you are not connected to rock.example.com" up front
 * instead of letting it surface as an AuthenticationError on first Fetch.
 */

describe("normalizeServerUrl", () => {
    it("drops a trailing slash", () => {
        expect(normalizeServerUrl("https://rock.example.com/"))
            .toBe("https://rock.example.com");
    });

    it("drops a path", () => {
        expect(normalizeServerUrl("https://rock.example.com/page/12"))
            .toBe("https://rock.example.com");
    });

    it("lowercases scheme and host", () => {
        expect(normalizeServerUrl("HTTPS://Rock.Example.COM"))
            .toBe("https://rock.example.com");
    });

    it("preserves a non-default port", () => {
        expect(normalizeServerUrl("https://rock.example.com:8443/x"))
            .toBe("https://rock.example.com:8443");
    });

    it("tolerates a bare authority with no scheme", () => {
        expect(normalizeServerUrl("rock.example.com/")).toBe("rock.example.com");
    });

    it("trims surrounding whitespace", () => {
        expect(normalizeServerUrl("  https://rock.example.com  "))
            .toBe("https://rock.example.com");
    });
});

describe("isServerKnown", () => {
    it("matches across a trailing-slash difference", () => {
        expect(isServerKnown(["https://rock.example.com"], "https://rock.example.com/"))
            .toBe(true);
    });

    it("matches across a case difference in the host", () => {
        expect(isServerKnown(["https://rock.example.com"], "https://ROCK.example.com"))
            .toBe(true);
    });

    it("does not match a different host", () => {
        expect(isServerKnown(["https://rock.example.com"], "https://other.example.com"))
            .toBe(false);
    });

    it("treats a port difference as a different server", () => {
        expect(isServerKnown(["https://rock.example.com"], "https://rock.example.com:8443"))
            .toBe(false);
    });

    it("is false against an empty list", () => {
        expect(isServerKnown([], "https://rock.example.com")).toBe(false);
    });
});

describe("resolveServerConnection", () => {
    const secretsWith = (credentials: unknown): Secrets =>
        ({ getCredentials: vi.fn().mockResolvedValue(credentials) } as unknown as Secrets);

    it("reports connected when credentials are stored", async () => {
        const state = await resolveServerConnection(
            secretsWith({ username: "jay", password: "hunter2" }),
            "https://rock.example.com"
        );

        expect(state).toBe("connected");
    });

    it("reports disconnected when no credentials are stored", async () => {
        const state = await resolveServerConnection(
            secretsWith(undefined),
            "https://rock.example.com"
        );

        expect(state).toBe("disconnected");
    });

    /**
     * `commands.ts` adds a server to KnownServers without awaiting the login,
     * so list membership does not imply working credentials. Connection state
     * has to key off SecretStorage, and this pins that choice.
     */
    it("ignores the saved server list entirely", async () => {
        const secrets = secretsWith(null);
        const state = await resolveServerConnection(secrets, "https://rock.example.com");

        expect(state).toBe("disconnected");
        expect(secrets.getCredentials).toHaveBeenCalledWith("https://rock.example.com");
    });
});

describe("addKnownServer", () => {
    const fakeState = (initial: string[]) => {
        let stored = initial;
        return {
            get: <T,>(_key: string, fallback: T): T => (stored as unknown as T) ?? fallback,
            update: vi.fn(async (_key: string, value: unknown) => {
                stored = value as string[];
            }),
            read: () => stored
        };
    };

    it("adds a server that is not yet known", async () => {
        const state = fakeState([]);
        const changed = await addKnownServer(state, "https://rock.example.com/");

        expect(changed).toBe(true);
        expect(state.read()).toEqual(["https://rock.example.com"]);
    });

    it("stores the normalized form, not the raw input", async () => {
        const state = fakeState([]);
        await addKnownServer(state, "HTTPS://Rock.Example.com/some/path");

        expect(state.read()).toEqual(["https://rock.example.com"]);
    });

    it("is a no-op when the server is already known", async () => {
        const state = fakeState(["https://rock.example.com"]);
        const changed = await addKnownServer(state, "https://rock.example.com/");

        expect(changed).toBe(false);
        expect(state.update).not.toHaveBeenCalled();
    });

    it("preserves existing entries", async () => {
        const state = fakeState(["https://a.example.com"]);
        await addKnownServer(state, "https://b.example.com");

        expect(state.read()).toEqual(["https://a.example.com", "https://b.example.com"]);
    });
});
