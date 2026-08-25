import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Manifest, MANIFEST_VERSION, hashBytes, readManifest, writeManifest } from "../manifest";
import { writeBaseline, readBaseline } from "../baseline";
import { readIncomingSidecar, writeIncomingSidecar } from "../incomingSidecar";
import {
    PushConfirmChoice,
    IPushFileApi,
    incomingAbsPath,
    performFilePush,
    writeIncoming
} from "../syncOperations";

/**
 * `performFilePush` orchestrates the side-effect sequence that follows a
 * push: server hash check, optional confirm modal, server PUT, then an
 * atomic update across manifest + baseline + incoming dir + sidecar. Each
 * test below pins one branch of that sequence against a real tmp workspace
 * to catch the "forgot to clean up X after Y" class of bug.
 */

const bytes = (s: string) => Buffer.from(s, "utf8");
const relPathFixture = "Pages/Home/Content.lava";
const serverUrlFixture = "https://rock.example.com";
const fileUriFixture = "/api/FileContent/block-handler/42/content";
const fullUrlFixture = `${serverUrlFixture}${fileUriFixture}`;

interface IApiCall {
    method: "GET" | "PUT";
    url: string;
    bytes?: Uint8Array;
}

function makeApi(initial: Record<string, Uint8Array> = {}): IPushFileApi & { calls: IApiCall[]; store: Record<string, Uint8Array> } {
    const store = { ...initial };
    const calls: IApiCall[] = [];
    return {
        store,
        calls,
        async getFileContent(url) {
            calls.push({ method: "GET", url });
            return store[url] ?? new Uint8Array();
        },
        async updateFileContent(url, b) {
            calls.push({ method: "PUT", url, bytes: b });
            store[url] = b;
        }
    };
}

function makeManifest(opts: { entryHash?: string | null }): Manifest {
    return {
        version: MANIFEST_VERSION,
        server: { url: serverUrlFixture, alias: "rock-example-com" },
        roots: [{ uri: "/api/tree/1", displayName: "My App", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
        items: {
            [relPathFixture]: {
                uri: fileUriFixture,
                isFolder: false,
                hash: opts.entryHash ?? undefined,
                lastSyncedAt: "2026-04-21T00:00:00.000Z"
            }
        }
    };
}

describe("performFilePush", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-push-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    /** Lay down a manifest, baseline, and local file. Returns the manifest object. */
    async function fixture(opts: {
        baselineBytes: Uint8Array;
        localBytes: Uint8Array;
        serverBytes: Uint8Array;
        entryHash?: string | null;
        /** Skip writing `.magnus/baseline/`, for the no-baseline-at-all cases. */
        skipBaseline?: boolean;
    }): Promise<{ manifest: Manifest; api: ReturnType<typeof makeApi> }> {
        // Distinguish "caller didn't say" (use baseline hash) from "caller
        // explicitly passed null" (legacy workspace, no recorded hash).
        const entryHash = opts.entryHash === undefined ? hashBytes(opts.baselineBytes) : opts.entryHash;
        const manifest = makeManifest({ entryHash });
        await writeManifest(tmp, manifest);
        if (!opts.skipBaseline) {
            await writeBaseline(tmp, relPathFixture, opts.baselineBytes);
        }
        await fs.mkdir(path.dirname(path.join(tmp, relPathFixture)), { recursive: true });
        await fs.writeFile(path.join(tmp, relPathFixture), opts.localBytes);
        const api = makeApi({ [fullUrlFixture]: opts.serverBytes });
        return { manifest, api };
    }

    const noopShowServer = vi.fn(async () => undefined);

    describe("happy path: server hash matches manifest hash", () => {
        it("PUTs local bytes and skips the confirm prompt", async () => {
            const synced = bytes("synced content");
            const { manifest, api } = await fixture({
                baselineBytes: synced,
                localBytes: bytes("local edits"),
                serverBytes: synced
            });
            const onConflictPrompt = vi.fn(async (): Promise<PushConfirmChoice> => "cancel");

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt,
                onShowServerVersion: noopShowServer
            });

            expect(onConflictPrompt).not.toHaveBeenCalled();
            expect(api.calls).toEqual([
                { method: "GET", url: fullUrlFixture },
                { method: "PUT", url: fullUrlFixture, bytes: bytes("local edits") }
            ]);
            expect(result.kind).toBe("applied");
            if (result.kind === "applied") {
                expect(result.newLocalHash).toBe(hashBytes(bytes("local edits")));
            }
        });

        it("updates manifest hash, lastSyncedAt, and on-disk baseline atomically", async () => {
            const synced = bytes("synced content");
            const newLocal = bytes("local edits");
            const { manifest, api } = await fixture({
                baselineBytes: synced,
                localBytes: newLocal,
                serverBytes: synced
            });
            const before = manifest.items[relPathFixture].lastSyncedAt;

            await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt: vi.fn(async () => "cancel"),
                onShowServerVersion: noopShowServer
            });

            // Manifest in memory mutated.
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(newLocal));
            expect(manifest.items[relPathFixture].lastSyncedAt).not.toBe(before);

            // Manifest on disk persisted.
            const persisted = await readManifest(tmp);
            expect(persisted?.items[relPathFixture].hash).toBe(hashBytes(newLocal));

            // Baseline replaced with the pushed bytes.
            const baseline = await readBaseline(tmp, relPathFixture);
            expect(baseline).toEqual(newLocal);
        });

        it("clears any pre-existing incoming bytes and sidecar entry for this file", async () => {
            const synced = bytes("synced content");
            const { manifest, api } = await fixture({
                baselineBytes: synced,
                localBytes: bytes("local edits"),
                serverBytes: synced
            });
            // Pre-seed an incoming entry as if a fetch had flagged this file.
            await writeIncoming(tmp, relPathFixture, bytes("stale incoming bytes"));
            await writeIncomingSidecar(tmp, {
                version: 1,
                items: {
                    [relPathFixture]: {
                        uri: fileUriFixture,
                        displayName: "Content.lava",
                        fetchedAt: "2026-04-22T00:00:00.000Z",
                        isNew: false
                    }
                }
            });

            await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt: vi.fn(async () => "cancel"),
                onShowServerVersion: noopShowServer
            });

            // Incoming bytes file removed.
            await expect(fs.access(incomingAbsPath(tmp, relPathFixture))).rejects.toThrow();
            // Sidecar entry removed.
            const sidecar = await readIncomingSidecar(tmp);
            expect(sidecar.items[relPathFixture]).toBeUndefined();
        });
    });

    describe("conflict path: server hash differs from manifest hash", () => {
        it("calls onConflictPrompt when the server has moved", async () => {
            const baseline = bytes("baseline at last sync");
            const { manifest, api } = await fixture({
                baselineBytes: baseline,
                localBytes: bytes("local edits"),
                serverBytes: bytes("someone else pushed first")
            });
            const onConflictPrompt = vi.fn(async (): Promise<PushConfirmChoice> => "force-overwrite");

            await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt,
                onShowServerVersion: noopShowServer
            });

            expect(onConflictPrompt).toHaveBeenCalledOnce();
        });

        it("force-overwrite: PUTs local bytes and updates manifest", async () => {
            const baseline = bytes("baseline at last sync");
            const { manifest, api } = await fixture({
                baselineBytes: baseline,
                localBytes: bytes("local edits"),
                serverBytes: bytes("server moved")
            });

            await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt: vi.fn(async () => "force-overwrite"),
                onShowServerVersion: noopShowServer
            });

            const putCalls = api.calls.filter(c => c.method === "PUT");
            expect(putCalls).toHaveLength(1);
            expect(putCalls[0].bytes).toEqual(bytes("local edits"));
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(bytes("local edits")));
        });

        it("view-server: invokes onShowServerVersion with server bytes and returns 'viewing-server' (not an error)", async () => {
            const baseline = bytes("baseline");
            const serverBytes = bytes("server moved");
            const { manifest, api } = await fixture({
                baselineBytes: baseline,
                localBytes: bytes("local edits"),
                serverBytes
            });
            const onShowServerVersion = vi.fn(async () => undefined);

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt: vi.fn(async () => "view-server"),
                onShowServerVersion
            });

            // User-driven outcome, not an error: caller (push class wrapper)
            // can distinguish this from a real failure and stay quiet.
            expect(result.kind).toBe("viewing-server");
            expect(onShowServerVersion).toHaveBeenCalledWith(serverBytes);
            // No PUT happened.
            expect(api.calls.some(c => c.method === "PUT")).toBe(false);
            // Manifest hash unchanged.
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(baseline));
        });

        it("cancel: returns 'cancelled' (not an error) with no side effects", async () => {
            const baseline = bytes("baseline");
            const originalLastSynced = "2026-04-21T00:00:00.000Z";
            const { manifest, api } = await fixture({
                baselineBytes: baseline,
                localBytes: bytes("local edits"),
                serverBytes: bytes("server moved")
            });

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt: vi.fn(async () => "cancel"),
                onShowServerVersion: noopShowServer
            });

            // User clicked Cancel — this is a normal return, not a failure.
            // The class wrapper relies on this so it can avoid surfacing
            // a misleading "push failed" error toast.
            expect(result.kind).toBe("cancelled");
            // No PUT, no manifest mutation, no baseline rewrite.
            expect(api.calls.some(c => c.method === "PUT")).toBe(false);
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(baseline));
            expect(manifest.items[relPathFixture].lastSyncedAt).toBe(originalLastSynced);
            expect(await readBaseline(tmp, relPathFixture)).toEqual(baseline);
        });
    });

    describe("validation guards", () => {
        it("throws 'Not a tracked file' when the relPath is not in the manifest", async () => {
            const { manifest, api } = await fixture({
                baselineBytes: bytes("x"),
                localBytes: bytes("x"),
                serverBytes: bytes("x")
            });

            await expect(performFilePush({
                root: tmp,
                manifest,
                relPath: "Pages/Unknown/file.lava",
                api,
                onConflictPrompt: vi.fn(async () => "cancel"),
                onShowServerVersion: noopShowServer
            })).rejects.toThrow(/Not a tracked file/);

            // Guarded before any network call.
            expect(api.calls).toEqual([]);
        });

        it("throws 'Not a tracked file' when the entry is a folder", async () => {
            const { manifest, api } = await fixture({
                baselineBytes: bytes("x"),
                localBytes: bytes("x"),
                serverBytes: bytes("x")
            });
            manifest.items["Pages/Home/"] = {
                uri: "/api/tree/home",
                isFolder: true,
                displayName: "Home"
            };

            await expect(performFilePush({
                root: tmp,
                manifest,
                relPath: "Pages/Home/",
                api,
                onConflictPrompt: vi.fn(async () => "cancel"),
                onShowServerVersion: noopShowServer
            })).rejects.toThrow(/Not a tracked file/);

            expect(api.calls).toEqual([]);
        });

        it("throws the explicit local-deletion guard when the file is missing on disk", async () => {
            const { manifest, api } = await fixture({
                baselineBytes: bytes("x"),
                localBytes: bytes("x"),
                serverBytes: bytes("x")
            });
            // Delete the local file after fixture setup.
            await fs.unlink(path.join(tmp, relPathFixture));

            await expect(performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt: vi.fn(async () => "cancel"),
                onShowServerVersion: noopShowServer
            })).rejects.toThrow(/Magnus Local doesn't delete server items/);

            // Guarded before any network call.
            expect(api.calls).toEqual([]);
        });
    });

    describe("no recorded manifest hash: push falls back to the baseline (spec 8.1)", () => {
        it("prompts when the baseline shows the server moved", async () => {
            // The bug this replaced. A perfectly good baseline sat on disk, the
            // server had genuinely moved, and push waved it through without
            // asking because it only ever read `entry.hash`.
            const { manifest, api } = await fixture({
                baselineBytes: bytes("baseline"),
                localBytes: bytes("local edits"),
                serverBytes: bytes("server has different bytes"),
                entryHash: null
            });
            const onConflictPrompt = vi.fn(async (): Promise<PushConfirmChoice> => "cancel");

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt,
                onShowServerVersion: noopShowServer
            });

            expect(onConflictPrompt).toHaveBeenCalledTimes(1);
            expect(result.kind).toBe("cancelled");
            // Cancelled means nothing was sent and nothing was recorded.
            expect(api.calls.some(c => c.method === "PUT")).toBe(false);
            expect(manifest.items[relPathFixture].hash).toBeUndefined();
        });

        it("does not prompt when the baseline shows the server is unchanged", async () => {
            // The other half: falling back to the baseline must not turn every
            // hash-less entry into a prompt. The server still holds exactly the
            // bytes we last synced, so this is safe and must stay quiet.
            const synced = bytes("synced content");
            const { manifest, api } = await fixture({
                baselineBytes: synced,
                localBytes: bytes("local edits"),
                serverBytes: synced,
                entryHash: null
            });
            const onConflictPrompt = vi.fn(async (): Promise<PushConfirmChoice> => "cancel");

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt,
                onShowServerVersion: noopShowServer
            });

            expect(onConflictPrompt).not.toHaveBeenCalled();
            expect(result.kind).toBe("applied");
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(bytes("local edits")));
            // The push also repairs the state that caused the gap.
            expect(await readBaseline(tmp, relPathFixture)).toEqual(bytes("local edits"));
        });

        it("fails closed when there is neither a baseline nor a manifest hash", async () => {
            // Nothing on disk says what the server looked like at last sync, so
            // pushing could silently overwrite someone else's work. Ask.
            const { manifest, api } = await fixture({
                baselineBytes: bytes("unused"),
                localBytes: bytes("local edits"),
                serverBytes: bytes("server content"),
                entryHash: null,
                skipBaseline: true
            });
            const onConflictPrompt = vi.fn(async (): Promise<PushConfirmChoice> => "cancel");

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt,
                onShowServerVersion: noopShowServer
            });

            expect(onConflictPrompt).toHaveBeenCalledTimes(1);
            expect(result.kind).toBe("cancelled");
            expect(api.calls.some(c => c.method === "PUT")).toBe(false);
        });

        it("still allows a confirmed force-overwrite with no baseline", async () => {
            // Failing closed must remain an ask, not a block. The user can see
            // the server version and decide to overwrite it.
            const { manifest, api } = await fixture({
                baselineBytes: bytes("unused"),
                localBytes: bytes("local edits"),
                serverBytes: bytes("server content"),
                entryHash: null,
                skipBaseline: true
            });
            const onConflictPrompt = vi.fn(async (): Promise<PushConfirmChoice> => "force-overwrite");

            const result = await performFilePush({
                root: tmp,
                manifest,
                relPath: relPathFixture,
                api,
                onConflictPrompt,
                onShowServerVersion: noopShowServer
            });

            expect(result.kind).toBe("applied");
            expect(api.store[fullUrlFixture]).toEqual(bytes("local edits"));
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(bytes("local edits")));
        });
    });
});
