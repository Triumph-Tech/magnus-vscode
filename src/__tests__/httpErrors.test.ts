import { describe, expect, it } from "vitest";
import { MagnusHttpError, classifyHttpStatus, describeHttpFailure } from "../httpErrors";

/**
 * Defect 8.7: every HTTP failure used to arrive as the same bare Error, so a
 * revoked permission, a disabled resource type and a flaky network all produced
 * the same "something went wrong, want to retry?".
 *
 * The 403/404 split is the one that changes what a person should do: 403 is
 * about them, 404 is about the resource.
 */

describe("classifyHttpStatus", () => {
    it("separates the two failures that mean different things", () => {
        expect(classifyHttpStatus(403)).toBe("forbidden");
        expect(classifyHttpStatus(404)).toBe("not-found");
    });

    it("treats 401 as its own case, not as forbidden", () => {
        // A lapsed session is fixable by re-authenticating; revoked permissions
        // are not, and telling someone to log in again when an administrator
        // removed their access sends them in circles.
        expect(classifyHttpStatus(401)).toBe("unauthorized");
    });

    it("groups 5xx as server-error", () => {
        expect(classifyHttpStatus(500)).toBe("server-error");
        expect(classifyHttpStatus(502)).toBe("server-error");
        expect(classifyHttpStatus(503)).toBe("server-error");
    });

    it("falls back to 'other' for anything unrecognised", () => {
        expect(classifyHttpStatus(418)).toBe("other");
        expect(classifyHttpStatus(429)).toBe("other");
    });
});

describe("describeHttpFailure", () => {
    const url = "https://rock.example.com";

    it("does not offer a retry for 403 or 404", () => {
        // Retrying a 403 means clicking repeatedly at a decision an
        // administrator made deliberately; retrying a 404 means clicking at
        // content that is gone.
        expect(describeHttpFailure(403, url).retryable).toBe(false);
        expect(describeHttpFailure(404, url).retryable).toBe(false);
        expect(describeHttpFailure(401, url).retryable).toBe(false);
    });

    it("offers a retry for server errors, which are usually transient", () => {
        expect(describeHttpFailure(500, url).retryable).toBe(true);
        expect(describeHttpFailure(503, url).retryable).toBe(true);
    });

    it("names the disabled-type possibility on a 404", () => {
        // The most likely cause a user can act on, and invisible otherwise.
        expect(describeHttpFailure(404, url).message).toMatch(/disabled/i);
    });

    it("points at permissions on a 403, not at the network", () => {
        expect(describeHttpFailure(403, url).message).toMatch(/permission/i);
    });

    it("says a 5xx is not the user's workspace", () => {
        expect(describeHttpFailure(502, url).message).toMatch(/not with your workspace/i);
    });
});

describe("MagnusHttpError", () => {
    it("keeps the status and classifies it", () => {
        const err = new MagnusHttpError(404, "gone", "https://rock.example.com/api/x");
        expect(err.status).toBe(404);
        expect(err.kind).toBe("not-found");
        expect(err.url).toBe("https://rock.example.com/api/x");
    });

    it("is still an Error, so existing catch sites keep working", () => {
        // The throw sites were changed in place; anything catching `Error` and
        // reading `.message` must not have been broken by that.
        const err = new MagnusHttpError(403, "denied");
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe("denied");
    });
});
