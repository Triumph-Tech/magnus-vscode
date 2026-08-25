import { describe, expect, it } from "vitest";
import { buildSqlEndpointUrl, connectPath } from "../sqlEndpoints";

describe("buildSqlEndpointUrl", () => {
    it("joins a server URL and a path", () => {
        expect(buildSqlEndpointUrl("https://rock.example.org", connectPath))
            .toBe("https://rock.example.org/api/TriumphTech/Magnus/Sql/Connect");
    });

    it("removes trailing slashes from the server URL", () => {
        expect(buildSqlEndpointUrl("https://rock.example.org///", connectPath))
            .toBe("https://rock.example.org/api/TriumphTech/Magnus/Sql/Connect");
    });

    it("assumes https when the server URL has no scheme", () => {
        expect(buildSqlEndpointUrl("rock.example.org", connectPath))
            .toBe("https://rock.example.org/api/TriumphTech/Magnus/Sql/Connect");
    });

    it("preserves an insecure scheme", () => {
        expect(buildSqlEndpointUrl("http://localhost:6229", connectPath))
            .toBe("http://localhost:6229/api/TriumphTech/Magnus/Sql/Connect");
    });

    it("ignores surrounding white space", () => {
        expect(buildSqlEndpointUrl("  https://rock.example.org  ", connectPath))
            .toBe("https://rock.example.org/api/TriumphTech/Magnus/Sql/Connect");
    });
});
