import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASELINE_DIR, readBaseline, writeBaseline } from "../baseline";
import { renameTracked } from "../syncOperations";

/**
 * `renameTracked` is the on-disk side of fetch's rename-detection feature.
 * It moves the working file (via a caller-supplied callback so production
 * can route through `vscode.workspace.fs.rename` for editor retargeting)
 * and the baseline copy together. These tests exercise the helper against
 * a real tmp directory using node `fs.promises.rename` as the working-file
 * impl. Concerns covered:
 *   - working file plus baseline both move
 *   - parent directories are created on the destination side
 *   - case-only rename succeeds via the temp-name two-step
 *   - missing baseline is non-fatal
 *   - no-op when from === to
 *   - target-exists / source-missing surface as thrown errors
 */
describe("renameTracked", () => {
    let tmp: string;
    const renameWorkingFile = (from: string, to: string) => fs.rename(from, to);

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-rename-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it("moves the working file and the baseline together", async () => {
        const fromRel = "foo.lava";
        const toRel = "bar.lava";
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));
        await writeBaseline(tmp, fromRel, Buffer.from("baseline"));

        await renameTracked({ root: tmp, oldRelPath: fromRel, newRelPath: toRel, renameWorkingFile });

        await expect(fs.access(path.join(tmp, fromRel))).rejects.toThrow();
        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("body");
        expect(await readBaseline(tmp, fromRel)).toBeNull();
        expect(Buffer.from((await readBaseline(tmp, toRel))!).toString("utf8")).toBe("baseline");
    });

    it("creates intermediate directories on the destination side", async () => {
        const fromRel = "foo.lava";
        const toRel = "nested/deep/bar.lava";
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));
        await writeBaseline(tmp, fromRel, Buffer.from("baseline"));

        await renameTracked({ root: tmp, oldRelPath: fromRel, newRelPath: toRel, renameWorkingFile });

        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("body");
        expect(Buffer.from((await readBaseline(tmp, toRel))!).toString("utf8")).toBe("baseline");
    });

    it("survives a case-only rename via the temp-name two-step", async () => {
        // On case-insensitive filesystems (macOS APFS default) a direct
        // rename from "Foo.lava" to "foo.lava" is a no-op. The helper goes
        // through a temp name so the case actually flips.
        const fromRel = "Foo.lava";
        const toRel = "foo.lava";
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));
        await writeBaseline(tmp, fromRel, Buffer.from("baseline"));

        await renameTracked({ root: tmp, oldRelPath: fromRel, newRelPath: toRel, renameWorkingFile });

        // The file must exist with the exact target case. Read directory
        // entries so we don't lean on case-insensitive lookups to confirm.
        const entries = await fs.readdir(tmp);
        expect(entries).toContain(toRel);
        const baselineEntries = await fs.readdir(path.join(tmp, BASELINE_DIR));
        expect(baselineEntries).toContain(toRel);
    });

    it("is a no-op when oldRelPath equals newRelPath", async () => {
        const rel = "foo.lava";
        await fs.writeFile(path.join(tmp, rel), Buffer.from("body"));
        await writeBaseline(tmp, rel, Buffer.from("baseline"));

        await renameTracked({ root: tmp, oldRelPath: rel, newRelPath: rel, renameWorkingFile });

        expect((await fs.readFile(path.join(tmp, rel))).toString("utf8")).toBe("body");
        expect(Buffer.from((await readBaseline(tmp, rel))!).toString("utf8")).toBe("baseline");
    });

    it("treats a missing baseline as non-fatal", async () => {
        const fromRel = "foo.lava";
        const toRel = "bar.lava";
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));
        // No baseline written.

        await renameTracked({ root: tmp, oldRelPath: fromRel, newRelPath: toRel, renameWorkingFile });

        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("body");
        expect(await readBaseline(tmp, toRel)).toBeNull();
    });

    it("throws when the destination working file already exists", async () => {
        // Prevents silent overwrites if two renames race or if there is a
        // sibling collision the caller didn't disambiguate.
        const fromRel = "foo.lava";
        const toRel = "bar.lava";
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));
        await fs.writeFile(path.join(tmp, toRel), Buffer.from("preexisting"));

        // node fs.rename overwrites by default, so simulate the
        // overwrite:false behavior of vscode.workspace.fs.rename.
        const strictRename = async (from: string, to: string) => {
            try {
                await fs.access(to);
                throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
            }
            catch (err) {
                if ((err as NodeJS.ErrnoException).code === "EEXIST") { throw err; }
            }
            await fs.rename(from, to);
        };

        await expect(renameTracked({
            root: tmp,
            oldRelPath: fromRel,
            newRelPath: toRel,
            renameWorkingFile: strictRename
        })).rejects.toThrow();

        expect((await fs.readFile(path.join(tmp, fromRel))).toString("utf8")).toBe("body");
        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("preexisting");
    });

    it("propagates ENOENT when the source working file is missing", async () => {
        await expect(renameTracked({
            root: tmp,
            oldRelPath: "missing.lava",
            newRelPath: "bar.lava",
            renameWorkingFile
        })).rejects.toThrow();
    });

    it("preserves baseline bytes through brackets-and-spaces paths via explicit write", async () => {
        // Pinned because Phase 1 testing surfaced a 362-file conflict
        // storm that traced back to baseline `fs.rename` silently failing
        // on paths with brackets and spaces. Production now passes
        // `baselineBytes` so the helper writes the new baseline directly.
        const fromRel = "[Sandbox] Account Update/Blocks/[Main] Profile Details - Profile Details/Content.lava";
        const toRel = "Sandbox/Blocks/[Main] Profile Details - Profile Details/Content.lava";
        const bodyBytes = Buffer.from("body");
        const baselineSnapshot = Buffer.from("baseline");

        await fs.mkdir(path.join(tmp, path.dirname(fromRel)), { recursive: true });
        await fs.writeFile(path.join(tmp, fromRel), bodyBytes);
        await writeBaseline(tmp, fromRel, baselineSnapshot);

        await renameTracked({
            root: tmp,
            oldRelPath: fromRel,
            newRelPath: toRel,
            renameWorkingFile,
            baselineBytes: baselineSnapshot
        });

        // Working file moved.
        await expect(fs.access(path.join(tmp, fromRel))).rejects.toThrow();
        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("body");
        // Baseline written at the new path with the bytes we passed in.
        expect(Buffer.from((await readBaseline(tmp, toRel))!).toString("utf8")).toBe("baseline");
        // Old baseline removed.
        expect(await readBaseline(tmp, fromRel)).toBeNull();
    });

    it("prunes empty parent directories left behind by the move", async () => {
        // Pinned to catch the cosmetic regression where renaming the last
        // file under a `Page/Blocks/[Main] X/` subtree left empty
        // `Page/Blocks/[Main] X/` and even `Page/` directories visible in
        // the explorer.
        const fromRel = "Old Page/Blocks/[Main] X - Y/Content.lava";
        const toRel = "New Page/Blocks/[Main] X - Y/Content.lava";
        const bytes = Buffer.from("body");
        const baseline = Buffer.from("baseline");

        await fs.mkdir(path.join(tmp, path.dirname(fromRel)), { recursive: true });
        await fs.writeFile(path.join(tmp, fromRel), bytes);
        await writeBaseline(tmp, fromRel, baseline);

        await renameTracked({
            root: tmp,
            oldRelPath: fromRel,
            newRelPath: toRel,
            renameWorkingFile,
            baselineBytes: baseline
        });

        // Old path tree should be gone.
        await expect(fs.access(path.join(tmp, "Old Page"))).rejects.toThrow();
        await expect(fs.access(path.join(tmp, BASELINE_DIR, "Old Page"))).rejects.toThrow();
        // New path tree exists with content.
        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("body");
        expect(Buffer.from((await readBaseline(tmp, toRel))!).toString("utf8")).toBe("baseline");
    });

    it("stops pruning at the workspace root and does not touch siblings", async () => {
        // If a sibling file or folder remains under the old parent, prune
        // must stop there. We must never delete the workspace root either.
        const fromRel = "Page/Blocks/[Main] X/Content.lava";
        const toRel = "Page Renamed/Blocks/[Main] X/Content.lava";
        const siblingRel = "Page/Blocks/[Hero] Other/Content.lava";

        await fs.mkdir(path.join(tmp, path.dirname(fromRel)), { recursive: true });
        await fs.mkdir(path.join(tmp, path.dirname(siblingRel)), { recursive: true });
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));
        await fs.writeFile(path.join(tmp, siblingRel), Buffer.from("sibling"));
        await writeBaseline(tmp, fromRel, Buffer.from("baseline"));

        await renameTracked({
            root: tmp,
            oldRelPath: fromRel,
            newRelPath: toRel,
            renameWorkingFile,
            baselineBytes: Buffer.from("baseline")
        });

        // Page/ and Page/Blocks/ remain because of the sibling. The
        // immediate empty `[Main] X/` parent of the moved file IS pruned.
        await expect(fs.access(path.join(tmp, "Page/Blocks/[Hero] Other/Content.lava"))).resolves.toBeUndefined();
        await expect(fs.access(path.join(tmp, "Page/Blocks/[Main] X"))).rejects.toThrow();
        // Workspace root still exists.
        await expect(fs.access(tmp)).resolves.toBeUndefined();
    });

    it("baselineBytes:null skips the baseline write but still moves the working file", async () => {
        // When the workspace had no baseline at the old path, the
        // pre-pass passes `null`. The helper must not invent a baseline
        // (Phase 1 only renames clean files; null baseline means we
        // skipped this case anyway, but the contract should be tight).
        const fromRel = "foo.lava";
        const toRel = "bar.lava";
        await fs.writeFile(path.join(tmp, fromRel), Buffer.from("body"));

        await renameTracked({
            root: tmp,
            oldRelPath: fromRel,
            newRelPath: toRel,
            renameWorkingFile,
            baselineBytes: null
        });

        expect((await fs.readFile(path.join(tmp, toRel))).toString("utf8")).toBe("body");
        expect(await readBaseline(tmp, toRel)).toBeNull();
    });
});
