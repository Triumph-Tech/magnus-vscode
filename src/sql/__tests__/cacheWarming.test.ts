import { describe, expect, it } from "vitest";
import { emptyWarmState, forgetWarmedServer, markWarmFinished, markWarmStarted, shouldWarmTables } from "../cacheWarming";
import { defaultCacheTtlMs } from "../nodeCache";

const serverUrl = "https://rock.example.org/";

describe("shouldWarmTables", () => {
    it("warms a server that has never been seen", () => {
        expect(shouldWarmTables(emptyWarmState, "https://rock.example.org/")).toBe(true);
    });

    it("does not warm a server that is being walked", () => {
        const state = markWarmStarted(emptyWarmState, "https://rock.example.org/");

        expect(shouldWarmTables(state, "https://rock.example.org/")).toBe(false);
    });

    it("does not warm a server that is already warm", () => {
        const state = markWarmFinished(markWarmStarted(emptyWarmState, "https://rock.example.org/"), "https://rock.example.org/", true);

        expect(shouldWarmTables(state, "https://rock.example.org/")).toBe(false);
    });

    it("allows one more try after a failure", () => {
        const state = markWarmFinished(markWarmStarted(emptyWarmState, "https://rock.example.org/"), "https://rock.example.org/", false);

        expect(shouldWarmTables(state, "https://rock.example.org/")).toBe(true);
    });

    it("treats the same server written differently as one server", () => {
        const state = markWarmStarted(emptyWarmState, "https://Rock.Example.org/");

        expect(shouldWarmTables(state, "https://rock.example.org")).toBe(false);
    });

    it("keeps servers apart", () => {
        const state = markWarmStarted(emptyWarmState, "https://rock.example.org/");

        expect(shouldWarmTables(state, "https://other.example.org/")).toBe(true);
    });

    it("never warms an empty server URL", () => {
        expect(shouldWarmTables(emptyWarmState, "")).toBe(false);
        expect(shouldWarmTables(emptyWarmState, "   ")).toBe(false);
    });
});

describe("markWarmStarted", () => {
    it("does not modify the state it was given", () => {
        const state = markWarmStarted(emptyWarmState, "https://rock.example.org/");

        expect(Object.keys(emptyWarmState)).toHaveLength(0);
        expect(Object.keys(state)).toHaveLength(1);
    });
});

describe("markWarmFinished", () => {
    it("records a success as warmed and a failure as failed", () => {
        const succeeded = markWarmFinished(emptyWarmState, serverUrl, true, 1000);
        const failed = markWarmFinished(emptyWarmState, serverUrl, false, 1000);

        expect(Object.values(succeeded)).toEqual([{ status: "warmed", at: 1000 }]);
        expect(Object.values(failed)).toEqual([{ status: "failed", at: 1000 }]);
    });
});

describe("shouldWarmTables and the cache time to live", () => {
    it("does not warm a server warmed inside the time to live", () => {
        const state = markWarmFinished(emptyWarmState, serverUrl, true, 1000);

        expect(shouldWarmTables(state, serverUrl, 1000 + defaultCacheTtlMs - 1)).toBe(false);
    });

    it("warms again once the warm is as old as the time to live", () => {
        const state = markWarmFinished(emptyWarmState, serverUrl, true, 1000);

        expect(shouldWarmTables(state, serverUrl, 1000 + defaultCacheTtlMs)).toBe(true);
    });

    it("never re-warms when the cache never expires", () => {
        const state = markWarmFinished(emptyWarmState, serverUrl, true, 1000);

        expect(shouldWarmTables(state, serverUrl, 1000 + defaultCacheTtlMs * 10, 0)).toBe(false);
    });

    it("leaves a walk that is still running alone however old it is", () => {
        const state = markWarmStarted(emptyWarmState, serverUrl, 1000);

        expect(shouldWarmTables(state, serverUrl, 1000 + defaultCacheTtlMs * 10)).toBe(false);
    });
});

describe("forgetWarmedServer", () => {
    it("makes a warmed server warmable again", () => {
        const state = forgetWarmedServer(markWarmFinished(emptyWarmState, serverUrl, true, 1000), serverUrl);

        expect(shouldWarmTables(state, serverUrl, 1001)).toBe(true);
    });

    it("makes a failed server warmable again", () => {
        const state = forgetWarmedServer(markWarmFinished(emptyWarmState, serverUrl, false, 1000), serverUrl);

        expect(Object.keys(state)).toHaveLength(0);
    });

    it("does not disturb a walk that is running", () => {
        const running = markWarmStarted(emptyWarmState, serverUrl, 1000);

        expect(forgetWarmedServer(running, serverUrl)).toBe(running);
    });

    it("leaves other servers alone", () => {
        let state = markWarmFinished(emptyWarmState, serverUrl, true, 1000);

        state = markWarmFinished(state, "https://other.example.org/", true, 1000);
        state = forgetWarmedServer(state, serverUrl);

        expect(shouldWarmTables(state, "https://other.example.org/", 1001)).toBe(false);
    });

    it("does not modify the state it was given", () => {
        const warmed = markWarmFinished(emptyWarmState, serverUrl, true, 1000);

        forgetWarmedServer(warmed, serverUrl);

        expect(Object.keys(warmed)).toHaveLength(1);
    });

    it("changes nothing for a server it has never seen", () => {
        expect(forgetWarmedServer(emptyWarmState, serverUrl)).toBe(emptyWarmState);
    });
});
