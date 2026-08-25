import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    BASELINE_DIR,
    readBaseline,
    removeBaseline,
    writeBaseline
} from "../baseline";

describe("baseline fs helpers", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-baseline-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it("readBaseline returns null for a path that was never written", async () => {
        expect(await readBaseline(tmp, "never-written.lava")).toBeNull();
    });

    it("writeBaseline + readBaseline round-trip exact bytes", async () => {
        const bytes = Buffer.from("hello world\n");
        await writeBaseline(tmp, "foo.lava", bytes);
        const read = await readBaseline(tmp, "foo.lava");
        expect(read).not.toBeNull();
        expect(Buffer.from(read!).toString("utf8")).toBe("hello world\n");
    });

    it("writeBaseline creates intermediate directories", async () => {
        const bytes = Buffer.from("nested");
        await writeBaseline(tmp, "a/b/c/deep.lava", bytes);
        const read = await readBaseline(tmp, "a/b/c/deep.lava");
        expect(Buffer.from(read!).toString("utf8")).toBe("nested");
    });

    it("writeBaseline overwrites an existing baseline", async () => {
        await writeBaseline(tmp, "foo.lava", Buffer.from("first"));
        await writeBaseline(tmp, "foo.lava", Buffer.from("second"));
        const read = await readBaseline(tmp, "foo.lava");
        expect(Buffer.from(read!).toString("utf8")).toBe("second");
    });

    it("removeBaseline deletes the file", async () => {
        await writeBaseline(tmp, "foo.lava", Buffer.from("bye"));
        await removeBaseline(tmp, "foo.lava");
        expect(await readBaseline(tmp, "foo.lava")).toBeNull();
    });

    it("removeBaseline is a no-op when the file does not exist", async () => {
        // Must not throw; the fetch/delete path relies on this.
        await expect(removeBaseline(tmp, "ghost.lava")).resolves.toBeUndefined();
    });

    it("writes under .magnus/baseline/ (documented location)", async () => {
        await writeBaseline(tmp, "foo.lava", Buffer.from("x"));
        const expected = path.join(tmp, BASELINE_DIR, "foo.lava");
        const stat = await fs.stat(expected);
        expect(stat.isFile()).toBe(true);
    });

    it("preserves raw bytes (no encoding transformation)", async () => {
        // Important because hashBytes is computed on raw bytes — a baseline
        // that round-trips through a text encoding would have a different hash
        // than the server bytes and every file would look "changed."
        const rawBytes = new Uint8Array([0x00, 0x01, 0xFF, 0xFE, 0x80, 0x20]);
        await writeBaseline(tmp, "bin.dat", rawBytes);
        const read = await readBaseline(tmp, "bin.dat");
        expect(read).not.toBeNull();
        expect(Array.from(read!)).toEqual(Array.from(rawBytes));
    });
});
