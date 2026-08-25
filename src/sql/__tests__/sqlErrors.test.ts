import { describe, expect, it } from "vitest";
import { classifySqlError, isUnsupportedPluginStatus, notFoundMessage, SqlToolsUnsupportedError, unsupportedPluginMessage } from "../sqlErrors";

describe("isUnsupportedPluginStatus", () => {
    it("treats a 404 as an unsupported plugin", () => {
        expect(isUnsupportedPluginStatus(404)).toBe(true);
    });

    it("does not treat other failures as an unsupported plugin", () => {
        expect(isUnsupportedPluginStatus(200)).toBe(false);
        expect(isUnsupportedPluginStatus(401)).toBe(false);
        expect(isUnsupportedPluginStatus(403)).toBe(false);
        expect(isUnsupportedPluginStatus(500)).toBe(false);
    });
});

describe("classifySqlError", () => {
    it("turns the shared Api not found error into an unsupported plugin error", () => {
        const result = classifySqlError(new Error(notFoundMessage), "https://rock.example.org");

        expect(result).toBeInstanceOf(SqlToolsUnsupportedError);
        expect(result.message).toBe(unsupportedPluginMessage);
        expect((result as SqlToolsUnsupportedError).serverUrl).toBe("https://rock.example.org");
    });

    it("mentions the required plugin version", () => {
        expect(classifySqlError(new Error(notFoundMessage)).message).toContain("2.0");
    });

    it("passes other errors through unchanged", () => {
        const error = new Error("Server has denied you access to this resource.");

        expect(classifySqlError(error)).toBe(error);
    });

    it("passes an unsupported plugin error through unchanged", () => {
        const error = new SqlToolsUnsupportedError("https://rock.example.org");

        expect(classifySqlError(error)).toBe(error);
    });

    it("wraps a thrown string", () => {
        expect(classifySqlError("boom").message).toBe("boom");
    });

    it("wraps a thrown value that carries no message", () => {
        expect(classifySqlError(undefined).message).toBe("Unable to complete the SQL request.");
        expect(classifySqlError("").message).toBe("Unable to complete the SQL request.");
    });
});
