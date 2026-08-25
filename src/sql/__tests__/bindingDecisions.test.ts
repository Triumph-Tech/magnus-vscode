import { describe, expect, it } from "vitest";
import { addAlwaysAllowServer, buildDestructiveConfirmationMessage, buildServerPickItems, buildStatusBarPresentation, destructiveConfirmationDetail, environmentBackgroundColorId, environmentPickItems, findSavedServer, getServerEnvironment, productionBackgroundColorId, resolveScratchServer, serverHostLabel, ServerEnvironmentMap, setServerEnvironment, stagingBackgroundColorId } from "../bindingDecisions";

const serverUrl = "https://rock.example.org";
const otherServerUrl = "https://other.example.org";

describe("server environments", () => {
    it("has no tag for a server that was never tagged", () => {
        expect(getServerEnvironment({}, serverUrl)).toBeUndefined();
    });

    it("records and reads a tag that relaxes the guard", () => {
        const environments = setServerEnvironment({}, serverUrl, "staging");

        expect(getServerEnvironment(environments, serverUrl)).toBe("staging");
    });

    it("stores production as no tag at all, since it is the default", () => {
        const environments = setServerEnvironment({}, serverUrl, "production");

        expect(getServerEnvironment(environments, serverUrl)).toBeUndefined();
        expect(environments).toEqual({});
    });

    it("clears a relaxing tag when production is chosen", () => {
        const relaxed = setServerEnvironment({}, serverUrl, "development");
        const back = setServerEnvironment(relaxed, serverUrl, "production");

        expect(getServerEnvironment(back, serverUrl)).toBeUndefined();
    });

    it("reads a legacy production entry as no tag", () => {
        const legacy = { [serverUrl]: "production" } as unknown as ServerEnvironmentMap;

        expect(getServerEnvironment(legacy, serverUrl)).toBeUndefined();
    });

    it("keys tags by the normalized URL so spellings share one tag", () => {
        const environments = setServerEnvironment({}, "HTTPS://Rock.Example.org/", "staging");

        expect(getServerEnvironment(environments, serverUrl)).toBe("staging");
    });

    it("removes a tag when it is set to nothing", () => {
        const tagged = setServerEnvironment({}, serverUrl, "staging");
        const untagged = setServerEnvironment(tagged, serverUrl, undefined);

        expect(getServerEnvironment(untagged, serverUrl)).toBeUndefined();
    });

    it("leaves the other servers alone and does not mutate what it was given", () => {
        const first: ServerEnvironmentMap = setServerEnvironment({}, serverUrl, "staging");
        const second = setServerEnvironment(first, otherServerUrl, "development");

        expect(getServerEnvironment(second, serverUrl)).toBe("staging");
        expect(getServerEnvironment(first, otherServerUrl)).toBeUndefined();
    });
});

describe("environmentPickItems", () => {
    it("offers production first and says it is the default", () => {
        expect(environmentPickItems[0].label).toBe("Production");
        expect(environmentPickItems[0].environment).toBeUndefined();
        expect(environmentPickItems[0].description).toContain("untagged");
    });

    it("offers only the two tags that relax the guard as stored values", () => {
        expect(environmentPickItems.map(item => item.environment)).toEqual([undefined, "staging", "development"]);
    });
});

describe("addAlwaysAllowServer", () => {
    it("adds a server that is not on the list", () => {
        expect(addAlwaysAllowServer([], serverUrl)).toEqual([serverUrl]);
    });

    it("does not add a server twice, whatever its spelling", () => {
        const once = addAlwaysAllowServer([], serverUrl);

        expect(addAlwaysAllowServer(once, "HTTPS://Rock.Example.org/")).toBe(once);
    });

    it("keeps the servers already on the list", () => {
        expect(addAlwaysAllowServer([otherServerUrl], serverUrl)).toEqual([otherServerUrl, serverUrl]);
    });
});

describe("serverHostLabel", () => {
    it("takes the host out of a URL", () => {
        expect(serverHostLabel("https://rock.example.org/some/path")).toBe("rock.example.org");
    });

    it("keeps a port", () => {
        expect(serverHostLabel("http://localhost:6229")).toBe("localhost:6229");
    });

    it("drops credentials", () => {
        expect(serverHostLabel("https://user:pass@rock.example.org")).toBe("rock.example.org");
    });

    it("hands back anything it cannot parse", () => {
        expect(serverHostLabel("rock.example.org")).toBe("rock.example.org");
    });
});

describe("buildStatusBarPresentation", () => {
    it("shows the unbound state for a SQL editor with no server", () => {
        const presentation = buildStatusBarPresentation(undefined, undefined, false);

        expect(presentation?.text).toBe("$(database) Not bound");
        expect(presentation?.backgroundColorId).toBeUndefined();
    });

    it("shows the host of the bound server", () => {
        const presentation = buildStatusBarPresentation(serverUrl, undefined, false);

        expect(presentation?.text).toBe("$(database) rock.example.org");
        expect(presentation?.tooltip).toContain(serverUrl);
    });

    it("tints an untagged server with the error background, because it is treated as production", () => {
        expect(buildStatusBarPresentation(serverUrl, undefined, false)?.backgroundColorId).toBe(productionBackgroundColorId);
    });

    it("says in the tooltip that an untagged server is production by default", () => {
        expect(buildStatusBarPresentation(serverUrl, undefined, false)?.tooltip).toContain("(production by default)");
    });

    it("shows a spinner tinted red on an untagged server while a query runs", () => {
        const presentation = buildStatusBarPresentation(serverUrl, undefined, true);

        expect(presentation?.text).toBe("$(sync~spin) rock.example.org");
        expect(presentation?.backgroundColorId).toBe(productionBackgroundColorId);
    });

    it("tints a production server with the error background", () => {
        expect(buildStatusBarPresentation(serverUrl, "production", false)?.backgroundColorId).toBe(productionBackgroundColorId);
    });

    it("tints a staging server with the warning background", () => {
        expect(buildStatusBarPresentation(serverUrl, "staging", false)?.backgroundColorId).toBe(stagingBackgroundColorId);
    });

    it("does not tint a development server", () => {
        expect(buildStatusBarPresentation(serverUrl, "development", false)?.backgroundColorId).toBeUndefined();
    });

    it("names the tag in the tooltip", () => {
        expect(buildStatusBarPresentation(serverUrl, "production", false)?.tooltip).toContain("(production)");
    });

    it("shows a spinner that cancels while a query runs", () => {
        const presentation = buildStatusBarPresentation(serverUrl, "production", true);

        expect(presentation?.text).toBe("$(sync~spin) rock.example.org");
        expect(presentation?.tooltip).toContain("cancel");
        expect(presentation?.backgroundColorId).toBe(productionBackgroundColorId);
    });
});

describe("environmentBackgroundColorId", () => {
    it("maps each environment to its theme color", () => {
        expect(environmentBackgroundColorId("production")).toBe(productionBackgroundColorId);
        expect(environmentBackgroundColorId("staging")).toBe(stagingBackgroundColorId);
        expect(environmentBackgroundColorId("development")).toBeUndefined();
    });

    it("gives an untagged server the production color", () => {
        expect(environmentBackgroundColorId(undefined)).toBe(productionBackgroundColorId);
    });
});

describe("buildServerPickItems", () => {
    it("shows the tag of each server as its description, and production for an untagged one", () => {
        const environments = setServerEnvironment({}, serverUrl, "staging");

        expect(buildServerPickItems([serverUrl, otherServerUrl], environments)).toEqual([
            { label: serverUrl, description: "staging", serverUrl },
            { label: otherServerUrl, description: "production (default)", serverUrl: otherServerUrl }
        ]);
    });

    it("has nothing to offer when no servers are saved", () => {
        expect(buildServerPickItems([], {})).toEqual([]);
    });
});

describe("resolveScratchServer", () => {
    it("uses the server remembered from last time", () => {
        expect(resolveScratchServer(serverUrl, [otherServerUrl, serverUrl])).toBe(serverUrl);
    });

    it("matches the remembered server regardless of its spelling", () => {
        expect(resolveScratchServer("HTTPS://Rock.Example.org/", [serverUrl])).toBe(serverUrl);
    });

    it("ignores a remembered server that is no longer saved", () => {
        expect(resolveScratchServer("https://gone.example.org", [serverUrl, otherServerUrl])).toBeUndefined();
    });

    it("uses the only saved server without asking", () => {
        expect(resolveScratchServer(undefined, [serverUrl])).toBe(serverUrl);
    });

    it("asks when several servers are saved and none is remembered", () => {
        expect(resolveScratchServer(undefined, [serverUrl, otherServerUrl])).toBeUndefined();
    });

    it("asks when nothing is saved at all", () => {
        expect(resolveScratchServer(undefined, [])).toBeUndefined();
    });
});

describe("buildDestructiveConfirmationMessage", () => {
    it("names the server and says it is treated as production", () => {
        const message = buildDestructiveConfirmationMessage(serverUrl);

        expect(message).toContain("rock.example.org");
        expect(message).toContain("treated as production");
    });

    it("does not claim the server was tagged, because it usually was not", () => {
        expect(buildDestructiveConfirmationMessage(serverUrl)).not.toContain("tagged");
    });
});

describe("destructiveConfirmationDetail", () => {
    it("says where the classification came from and how to change it", () => {
        expect(destructiveConfirmationDetail).toContain("unless it is tagged staging or development");
        expect(destructiveConfirmationDetail).toContain("Set Server Environment");
    });
});

describe("findSavedServer", () => {
    it("finds a saved server", () => {
        expect(findSavedServer([otherServerUrl, serverUrl], serverUrl)).toBe(serverUrl);
    });

    it("matches a spelling that differs only in case or a trailing slash", () => {
        expect(findSavedServer([serverUrl], "https://Rock.Example.Org/")).toBe(serverUrl);
    });

    it("returns the saved spelling rather than the one it was asked with", () => {
        expect(findSavedServer(["https://Rock.Example.Org"], serverUrl)).toBe("https://Rock.Example.Org");
    });

    it("does not find a server nobody saved", () => {
        expect(findSavedServer([serverUrl], "https://attacker.example.net")).toBeUndefined();
    });

    it("does not find a different host that shares a suffix", () => {
        expect(findSavedServer([serverUrl], "https://evil-rock.example.org")).toBeUndefined();
    });

    it("finds nothing when nothing is saved", () => {
        expect(findSavedServer([], serverUrl)).toBeUndefined();
    });

    it("finds nothing for an empty URL", () => {
        expect(findSavedServer([serverUrl], "   ")).toBeUndefined();
    });
});
