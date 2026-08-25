import { describe, expect, it } from "vitest";
import { friendlyNetworkMessage } from "../networkErrors";

describe("friendlyNetworkMessage", () => {
    const serverUrl = "https://rock.example.com";

    it("translates ENOTFOUND into a 'check VPN' message", () => {
        const msg = friendlyNetworkMessage("getaddrinfo ENOTFOUND rock.example.com", serverUrl);
        expect(msg).toBe("Can't resolve rock.example.com. Check your connection or VPN.");
    });

    it("translates ECONNREFUSED into a 'server up?' message", () => {
        const msg = friendlyNetworkMessage("connect ECONNREFUSED 127.0.0.1:80", serverUrl);
        expect(msg).toContain("refused the connection");
        expect(msg).toContain("rock.example.com");
    });

    it("translates ECONNRESET into a retry message", () => {
        const msg = friendlyNetworkMessage("read ECONNRESET", serverUrl);
        expect(msg).toContain("was reset");
    });

    it("translates ETIMEDOUT into a retry message", () => {
        const msg = friendlyNetworkMessage("connect ETIMEDOUT 10.0.0.1:443", serverUrl);
        expect(msg).toContain("did not respond in time");
    });

    it("translates axios timeout into a seconds-based message", () => {
        const msg = friendlyNetworkMessage("timeout of 60000ms exceeded", serverUrl);
        expect(msg).toContain("60s");
        expect(msg).toContain("rock.example.com");
    });

    it("translates TLS errors", () => {
        const msg = friendlyNetworkMessage("unable to verify the first certificate", serverUrl);
        expect(msg).toContain("TLS certificate problem");
    });

    it("falls back to the raw message when unrecognized", () => {
        const msg = friendlyNetworkMessage("some weirdly novel error", serverUrl);
        expect(msg).toBe("some weirdly novel error");
    });

    it("strips scheme and path from the server URL when interpolating the host", () => {
        const msg = friendlyNetworkMessage(
            "getaddrinfo ENOTFOUND rock.example.com",
            "https://rock.example.com:8443/some/path"
        );
        expect(msg).toBe("Can't resolve rock.example.com:8443. Check your connection or VPN.");
    });

    it("handles a bare hostname (no scheme)", () => {
        const msg = friendlyNetworkMessage("getaddrinfo ENOTFOUND x", "myhost");
        expect(msg).toContain("myhost");
    });
});
