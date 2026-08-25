/**
 * Classifying HTTP failures so callers can act on them (spec 7.11, defect 8.7).
 *
 * The wire has always distinguished these; the client simply threw the same
 * bare `Error` for all of them, so every failure arrived at the UI as "something
 * went wrong" and every one got the same generic retry advice.
 *
 * The distinction that matters most is 403 against 404:
 *
 *   - 403 is about the person. Their access was revoked, or their session
 *     lapsed. Nothing they do to this workspace will help, and re-authenticating
 *     might.
 *   - 404 is about the resource. This item or type is unavailable, possibly
 *     because an administrator disabled it. Other roots in the same workspace
 *     are unaffected and should keep working.
 *
 * Conflating them means telling someone to re-authenticate when a resource type
 * was turned off, or blocking a whole workspace when one root went away.
 */

export type HttpFailureKind =
    | "unauthorized"
    | "forbidden"
    | "not-found"
    | "server-error"
    | "other";

/**
 * An HTTP failure that kept its status code.
 */
export class MagnusHttpError extends Error {
    public readonly status: number;
    public readonly kind: HttpFailureKind;
    public readonly url: string | undefined;

    public constructor(status: number, message: string, url?: string) {
        super(message);
        this.name = "MagnusHttpError";
        this.status = status;
        this.kind = classifyHttpStatus(status);
        this.url = url;
    }
}

export function classifyHttpStatus(status: number): HttpFailureKind {
    if (status === 401) {
        return "unauthorized";
    }
    if (status === 403) {
        return "forbidden";
    }
    if (status === 404) {
        return "not-found";
    }
    if (status >= 500) {
        return "server-error";
    }
    return "other";
}

/**
 * The sentence to show a user for a failure, and whether it is worth retrying.
 *
 * `retryable` drives whether a Retry action is offered. Offering one for a 403
 * invites someone to click it repeatedly against a decision an administrator
 * made deliberately.
 */
export function describeHttpFailure(
    status: number,
    serverUrl: string
): { message: string; retryable: boolean } {
    switch (classifyHttpStatus(status)) {
        case "unauthorized":
            return {
                message: `${serverUrl} did not recognise your session. Re-authenticate and try again.`,
                retryable: false
            };
        case "forbidden":
            return {
                message: `${serverUrl} denied access. Your Magnus permissions may have been changed.`,
                retryable: false
            };
        case "not-found":
            return {
                message:
                    "The server no longer offers this resource. It may have been deleted, "
                    + "or its type may have been disabled in the Magnus settings.",
                retryable: false
            };
        case "server-error":
            return {
                message: `${serverUrl} returned an error (${status}). This is a problem on the server, not with your workspace.`,
                retryable: true
            };
        default:
            return {
                message: `${serverUrl} returned an unexpected response (${status}).`,
                retryable: true
            };
    }
}
