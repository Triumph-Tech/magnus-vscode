import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Manifest, MANIFEST_VERSION, hashBytes, readManifest, writeManifest } from "../manifest";
import { writeBaseline, readBaseline } from "../baseline";
import { IncomingEntry, readIncomingSidecar, writeIncomingSidecar } from "../incomingSidecar";
import {
    PullConfirmKind,
    incomingAbsPath,
    performPullFromServer,
    writeIncoming
} from "../syncOperations";

/**
 * `performPullFromServer` is the user's "accept the server's version of
 * this file" action. It dispatches across three branches (server-deleted,
 * server-new, conflict) with confirmation prompts and several side-effect
 * targets. The likely bug class is "forgot to clean up X after Y" — these
 * tests pin every branch's confirm + side-effect combination.
 */

const bytes = (s: string) => Buffer.from(s, "utf8");
const relPathFixture = "Pages/Home/Content.lava";
const fileUriFixture = "/api/FileContent/block-handler/42/content";

function makeManifest(items: Manifest["items"] = {}): Manifest {
    return {
        version: MANIFEST_VERSION,
        server: { url: "https://rock.example.com", alias: "rock-example-com" },
        roots: [{ uri: "/api/tree/1", displayName: "My App", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
        items
    };
}

describe("performPullFromServer", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-pull-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    /** A confirm callback that always accepts. */
    const accept = vi.fn(async (_kind: PullConfirmKind) => true);
    /** A confirm callback that always declines. */
    const decline = vi.fn(async (_kind: PullConfirmKind) => false);

    describe("isDeleted branch (server removed the file)", () => {
        async function setupDeletedScenario() {
            const trackedHash = hashBytes(bytes("baseline content"));
            const manifest = makeManifest({
                [relPathFixture]: { uri: fileUriFixture, isFolder: false, hash: trackedHash, lastSyncedAt: "2026-04-21T00:00:00.000Z" }
            });
            await writeManifest(tmp, manifest);
            await writeBaseline(tmp, relPathFixture, bytes("baseline content"));
            await fs.mkdir(path.dirname(path.join(tmp, relPathFixture)), { recursive: true });
            await fs.writeFile(path.join(tmp, relPathFixture), bytes("local edits"));
            const sidecarEntry: IncomingEntry = {
                uri: fileUriFixture,
                displayName: "Content.lava",
                fetchedAt: "2026-04-22T00:00:00.000Z",
                isNew: false,
                isDeleted: true
            };
            await writeIncomingSidecar(tmp, { version: 1, items: { [relPathFixture]: sidecarEntry } });
            return { manifest };
        }

        it("on accept: removes local file, baseline, manifest entry, sidecar entry", async () => {
            const { manifest } = await setupDeletedScenario();
            const confirm = vi.fn(async (_k: PullConfirmKind) => true);

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm });

            expect(outcome).toBe("deletion-applied");
            expect(confirm).toHaveBeenCalledWith("accept-deletion");
            await expect(fs.access(path.join(tmp, relPathFixture))).rejects.toThrow();
            expect(await readBaseline(tmp, relPathFixture)).toBeNull();
            expect(manifest.items[relPathFixture]).toBeUndefined();
            const sidecar = await readIncomingSidecar(tmp);
            expect(sidecar.items[relPathFixture]).toBeUndefined();
        });

        it("on decline: nothing changes anywhere", async () => {
            const { manifest } = await setupDeletedScenario();

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm: decline });

            expect(outcome).toBe("deletion-cancelled");
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("local edits"));
            expect(await readBaseline(tmp, relPathFixture)).toEqual(bytes("baseline content"));
            expect(manifest.items[relPathFixture]).toBeDefined();
            const sidecar = await readIncomingSidecar(tmp);
            expect(sidecar.items[relPathFixture]).toBeDefined();
        });
    });

    describe("isNew branch (server has a file not in the manifest)", () => {
        async function setupNewScenario(opts: { localExists: boolean }) {
            const manifest = makeManifest();
            await writeManifest(tmp, manifest);
            await writeIncoming(tmp, relPathFixture, bytes("server-new content"));
            const sidecarEntry: IncomingEntry = {
                uri: fileUriFixture,
                displayName: "Content.lava",
                fetchedAt: "2026-04-22T00:00:00.000Z",
                isNew: true
            };
            await writeIncomingSidecar(tmp, { version: 1, items: { [relPathFixture]: sidecarEntry } });
            if (opts.localExists) {
                await fs.mkdir(path.dirname(path.join(tmp, relPathFixture)), { recursive: true });
                await fs.writeFile(path.join(tmp, relPathFixture), bytes("pre-existing local"));
            }
            return { manifest };
        }

        it("creates the file, baseline, and manifest entry without prompting when local does not exist", async () => {
            const { manifest } = await setupNewScenario({ localExists: false });
            const confirm = vi.fn(async (_k: PullConfirmKind) => true);

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm });

            expect(outcome).toBe("new-applied");
            expect(confirm).not.toHaveBeenCalled();
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("server-new content"));
            expect(await readBaseline(tmp, relPathFixture)).toEqual(bytes("server-new content"));
            expect(manifest.items[relPathFixture]).toMatchObject({
                uri: fileUriFixture,
                isFolder: false,
                hash: hashBytes(bytes("server-new content"))
            });
            // Incoming bytes and sidecar entry both cleared.
            await expect(fs.access(incomingAbsPath(tmp, relPathFixture))).rejects.toThrow();
            const sidecar = await readIncomingSidecar(tmp);
            expect(sidecar.items[relPathFixture]).toBeUndefined();
        });

        it("prompts when local exists and overwrites on accept", async () => {
            const { manifest } = await setupNewScenario({ localExists: true });
            const confirm = vi.fn(async (_k: PullConfirmKind) => true);

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm });

            expect(outcome).toBe("new-applied");
            expect(confirm).toHaveBeenCalledWith("overwrite-existing-new");
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("server-new content"));
        });

        it("prompts when local exists and leaves everything alone on decline", async () => {
            const { manifest } = await setupNewScenario({ localExists: true });

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm: decline });

            expect(outcome).toBe("new-cancelled");
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("pre-existing local"));
            expect(await readBaseline(tmp, relPathFixture)).toBeNull();
            expect(manifest.items[relPathFixture]).toBeUndefined();
            // Incoming bytes still present so the user can retry.
            expect(await fs.readFile(incomingAbsPath(tmp, relPathFixture))).toEqual(bytes("server-new content"));
        });
    });

    describe("conflict branch (tracked entry, server diverged)", () => {
        async function setupConflictScenario(opts: { localBytes: Uint8Array; baselineBytes: Uint8Array }) {
            const trackedHash = hashBytes(opts.baselineBytes);
            const manifest = makeManifest({
                [relPathFixture]: { uri: fileUriFixture, isFolder: false, hash: trackedHash, lastSyncedAt: "2026-04-21T00:00:00.000Z" }
            });
            await writeManifest(tmp, manifest);
            await writeBaseline(tmp, relPathFixture, opts.baselineBytes);
            await fs.mkdir(path.dirname(path.join(tmp, relPathFixture)), { recursive: true });
            await fs.writeFile(path.join(tmp, relPathFixture), opts.localBytes);
            await writeIncoming(tmp, relPathFixture, bytes("server diverged content"));
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
            return { manifest };
        }

        it("does not prompt when local is clean (matches baseline)", async () => {
            const baseline = bytes("baseline content");
            const { manifest } = await setupConflictScenario({ localBytes: baseline, baselineBytes: baseline });
            const confirm = vi.fn(async (_k: PullConfirmKind) => true);

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm });

            expect(outcome).toBe("conflict-applied");
            expect(confirm).not.toHaveBeenCalled();
            // Local + baseline both replaced with server bytes.
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("server diverged content"));
            expect(await readBaseline(tmp, relPathFixture)).toEqual(bytes("server diverged content"));
            expect(manifest.items[relPathFixture].hash).toBe(hashBytes(bytes("server diverged content")));
        });

        it("prompts when local is dirty and overwrites on accept", async () => {
            const { manifest } = await setupConflictScenario({
                localBytes: bytes("local edits"),
                baselineBytes: bytes("baseline content")
            });
            const confirm = vi.fn(async (_k: PullConfirmKind) => true);

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm });

            expect(outcome).toBe("conflict-applied");
            expect(confirm).toHaveBeenCalledWith("overwrite-conflict-dirty");
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("server diverged content"));
        });

        it("prompts when local is dirty and leaves everything alone on decline", async () => {
            const { manifest } = await setupConflictScenario({
                localBytes: bytes("local edits"),
                baselineBytes: bytes("baseline content")
            });
            const originalHash = manifest.items[relPathFixture].hash;

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm: decline });

            expect(outcome).toBe("conflict-cancelled");
            // Local edits preserved, baseline untouched, manifest hash unchanged.
            expect(await fs.readFile(path.join(tmp, relPathFixture))).toEqual(bytes("local edits"));
            expect(await readBaseline(tmp, relPathFixture)).toEqual(bytes("baseline content"));
            expect(manifest.items[relPathFixture].hash).toBe(originalHash);
            // Incoming bytes still present so the user can retry.
            expect(await fs.readFile(incomingAbsPath(tmp, relPathFixture))).toEqual(bytes("server diverged content"));
        });

        it("clears incoming bytes and sidecar entry after successful application", async () => {
            const baseline = bytes("baseline");
            const { manifest } = await setupConflictScenario({ localBytes: baseline, baselineBytes: baseline });

            await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm: accept });

            await expect(fs.access(incomingAbsPath(tmp, relPathFixture))).rejects.toThrow();
            const sidecar = await readIncomingSidecar(tmp);
            expect(sidecar.items[relPathFixture]).toBeUndefined();
        });
    });

    describe("missing-incoming-bytes safety", () => {
        it("returns 'no-server-bytes' without mutating anything when staged file is missing", async () => {
            // Sidecar says 'isNew' but the incoming bytes file doesn't exist.
            // Could happen from manual cleanup, partial fetch, etc.
            const manifest = makeManifest();
            await writeManifest(tmp, manifest);
            await writeIncomingSidecar(tmp, {
                version: 1,
                items: {
                    [relPathFixture]: {
                        uri: fileUriFixture,
                        displayName: "Content.lava",
                        fetchedAt: "2026-04-22T00:00:00.000Z",
                        isNew: true
                    }
                }
            });
            // Note: did NOT call writeIncoming.

            const outcome = await performPullFromServer({ root: tmp, manifest, relPath: relPathFixture, confirm: accept });

            expect(outcome).toBe("no-server-bytes");
            expect(manifest.items[relPathFixture]).toBeUndefined();
            // Sidecar entry preserved so the user can re-fetch and retry.
            const sidecar = await readIncomingSidecar(tmp);
            expect(sidecar.items[relPathFixture]).toBeDefined();
        });
    });
});
