import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBaseline } from "../baseline";
import { materializeFile } from "../materializeFile";

/**
 * The server is the authority. Hydration replaces what is on disk with the
 * server's version, so a restored workspace is byte-identical to the server and
 * its Source Control panel comes up empty. What changed relative to the
 * repository is a `git diff`, which is the tool that already models that well.
 *
 * The outcome values exist to report what happened, never to change what gets
 * written.
 */

const SERVER = Buffer.from("server bytes\n");
const LOCAL = Buffer.from("locally committed bytes\n");

describe("materializeFile", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-materialize-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    const readWorking = (rel: string) => fs.readFile(path.join(tmp, rel));

    const seed = async (rel: string, bytes: Buffer) => {
        await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
        await fs.writeFile(path.join(tmp, rel), bytes);
    };

    describe("hydrate mode", () => {
        it("replaces a differing local file with the server's version", async () => {
            await seed("app/content.lava", LOCAL);

            const outcome = await materializeFile(tmp, "app/content.lava", SERVER, "hydrate");

            expect(outcome).toBe("replaced");
            expect(await readWorking("app/content.lava")).toEqual(SERVER);
        });

        /**
         * Working tree and baseline must agree after hydration, or the SCM comes
         * up claiming the user modified files they never touched. This is the
         * regression that motivated the rewrite.
         */
        it("leaves working tree and baseline identical, so the SCM is clean", async () => {
            await seed("app/content.lava", LOCAL);

            await materializeFile(tmp, "app/content.lava", SERVER, "hydrate");

            expect(await readWorking("app/content.lava"))
                .toEqual(await readBaseline(tmp, "app/content.lava"));
        });

        it("reports a file that already matched as unchanged", async () => {
            await seed("app/same.lava", SERVER);

            const outcome = await materializeFile(tmp, "app/same.lava", SERVER, "hydrate");

            expect(outcome).toBe("unchanged");
            expect(await readBaseline(tmp, "app/same.lava")).toEqual(SERVER);
        });

        it("reports a file absent locally as written", async () => {
            const outcome = await materializeFile(tmp, "app/new.lava", SERVER, "hydrate");

            expect(outcome).toBe("written");
            expect(await readWorking("app/new.lava")).toEqual(SERVER);
            expect(await readBaseline(tmp, "app/new.lava")).toEqual(SERVER);
        });

        it("creates missing intermediate directories", async () => {
            await materializeFile(tmp, "a/b/c/deep.lava", SERVER, "hydrate");

            expect(await readWorking("a/b/c/deep.lava")).toEqual(SERVER);
        });

        it("replaces an empty local file", async () => {
            await seed("app/empty.lava", Buffer.from(""));

            const outcome = await materializeFile(tmp, "app/empty.lava", SERVER, "hydrate");

            expect(outcome).toBe("replaced");
            expect(await readWorking("app/empty.lava")).toEqual(SERVER);
        });

        it("fails loudly when a directory stands where a file belongs", async () => {
            await fs.mkdir(path.join(tmp, "app/collide"), { recursive: true });

            await expect(
                materializeFile(tmp, "app/collide", SERVER, "hydrate")
            ).rejects.toThrow();
        });
    });

    describe("pull mode", () => {
        it("writes the server's bytes and its baseline", async () => {
            const outcome = await materializeFile(tmp, "app/content.lava", SERVER, "pull");

            expect(outcome).toBe("written");
            expect(await readWorking("app/content.lava")).toEqual(SERVER);
            expect(await readBaseline(tmp, "app/content.lava")).toEqual(SERVER);
        });

        /**
         * Pull materializes into a directory it has already verified is empty,
         * so it does not stat the target and always reports `written`.
         */
        it("does not inspect the existing file", async () => {
            await seed("app/content.lava", LOCAL);

            const outcome = await materializeFile(tmp, "app/content.lava", SERVER, "pull");

            expect(outcome).toBe("written");
            expect(await readWorking("app/content.lava")).toEqual(SERVER);
        });
    });

    it("keeps the baseline out of the working tree", async () => {
        await materializeFile(tmp, "app/content.lava", SERVER, "pull");

        const workingEntries = await fs.readdir(path.join(tmp, "app"));
        expect(workingEntries).toEqual(["content.lava"]);
    });
});
