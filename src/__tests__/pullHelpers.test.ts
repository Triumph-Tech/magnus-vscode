import { describe, expect, it } from "vitest";
import {
    aliasFromUrl,
    disambiguateName,
    extensionFromUri,
    isAISkillsCollectionNodeUri,
    isEmptyContent,
    isAppleTvAppNodeUri,
    isLavaApplicationNodeUri,
    isLocalModePullableUri,
    isShortcodesCollectionNodeUri,
    isMobileAppNodeUri,
    isPersistedDatasetsCollectionNodeUri,
    isThemeNodeUri,
    nameForDescriptor,
    sanitizeForFs,
    toFullUrl
} from "../pullHelpers";

describe("aliasFromUrl", () => {
    it("normalizes a plain https host", () => {
        expect(aliasFromUrl("https://rock.example.com")).toBe("rock-example-com");
    });

    it("preserves a non-default port", () => {
        expect(aliasFromUrl("https://rock.example.com:8443")).toBe("rock-example-com-8443");
    });

    it("lowercases the host", () => {
        expect(aliasFromUrl("https://Rock.Example.COM")).toBe("rock-example-com");
    });

    it("ignores trailing paths when building the alias", () => {
        expect(aliasFromUrl("https://rock.example.com/somepath")).toBe("rock-example-com");
    });

    it("handles http scheme", () => {
        expect(aliasFromUrl("http://rock.example.com")).toBe("rock-example-com");
    });

    it("does not treat a non-numeric 'port' as a port", () => {
        // Only a numeric suffix after the last ':' is split off as a port.
        // Non-numeric suffixes are nonsense inputs in practice; the behavior
        // here is "leave the authority alone" rather than trying to be clever.
        expect(aliasFromUrl("https://host:abc")).toBe("host:abc");
    });
});

describe("sanitizeForFs", () => {
    it("returns simple names unchanged", () => {
        expect(sanitizeForFs("My App")).toBe("My App");
    });

    it("replaces path separators with dashes", () => {
        expect(sanitizeForFs("a/b\\c")).toBe("a-b-c");
    });

    it("replaces all fs-unsafe characters", () => {
        expect(sanitizeForFs('a:b*c?d"e<f>g|h')).toBe("a-b-c-d-e-f-g-h");
    });

    it("replaces leading dots with a dash (avoids hidden files)", () => {
        expect(sanitizeForFs(".hidden")).toBe("-hidden");
        expect(sanitizeForFs("...weird")).toBe("-weird");
    });

    it("does not touch internal dots", () => {
        expect(sanitizeForFs("file.name.with.dots")).toBe("file.name.with.dots");
    });

    it("trims surrounding whitespace", () => {
        expect(sanitizeForFs("  spaced  ")).toBe("spaced");
    });
});

describe("disambiguateName", () => {
    it("returns the name unchanged when it's not used", () => {
        expect(disambiguateName("file.txt", new Set())).toBe("file.txt");
    });

    it("appends (2) on first collision", () => {
        expect(disambiguateName("file.txt", new Set(["file.txt"]))).toBe("file (2).txt");
    });

    it("increments until a slot opens", () => {
        const used = new Set(["file.txt", "file (2).txt", "file (3).txt"]);
        expect(disambiguateName("file.txt", used)).toBe("file (4).txt");
    });

    it("matches case-insensitively (macOS-friendly)", () => {
        // "File.txt" collides with existing "file.txt" on case-insensitive fs.
        expect(disambiguateName("File.txt", new Set(["file.txt"]))).toBe("File (2).txt");
    });

    it("handles extensionless names", () => {
        expect(disambiguateName("Home", new Set(["home"]))).toBe("Home (2)");
    });
});

describe("toFullUrl", () => {
    it("passes through an already-absolute URL", () => {
        expect(toFullUrl("https://server.com", "https://other.com/api/x"))
            .toBe("https://other.com/api/x");
    });

    it("joins a root-relative path", () => {
        expect(toFullUrl("https://server.com", "/api/x"))
            .toBe("https://server.com/api/x");
    });

    it("joins a bare relative path", () => {
        expect(toFullUrl("https://server.com", "api/x"))
            .toBe("https://server.com/api/x");
    });

    it("strips trailing slashes from the server URL", () => {
        expect(toFullUrl("https://server.com///", "api/x"))
            .toBe("https://server.com/api/x");
        expect(toFullUrl("https://server.com/", "/api/x"))
            .toBe("https://server.com/api/x");
    });
});

describe("isEmptyContent", () => {
    it("treats zero bytes as empty", () => {
        expect(isEmptyContent(new Uint8Array(0))).toBe(true);
    });

    it("treats whitespace-only content as empty", () => {
        expect(isEmptyContent(Buffer.from("   \n\t  \r\n "))).toBe(true);
    });

    it("treats non-whitespace content as non-empty", () => {
        expect(isEmptyContent(Buffer.from("hello"))).toBe(false);
    });

    it("treats one meaningful char among whitespace as non-empty", () => {
        expect(isEmptyContent(Buffer.from("  a  "))).toBe(false);
    });
});

describe("extensionFromUri", () => {
    it("returns the extension from the last path segment", () => {
        expect(extensionFromUri("/api/Magnus/FileContent/foo/content.lava")).toBe("lava");
    });

    it("lowercases the extension", () => {
        expect(extensionFromUri("/api/Magnus/FileContent/foo/Content.LAVA")).toBe("lava");
    });

    it("handles css", () => {
        expect(extensionFromUri("/api/Magnus/FileContent/foo/page-styles.css")).toBe("css");
    });

    it("handles txt", () => {
        expect(extensionFromUri("/api/Magnus/FileContent/foo/metadata.txt")).toBe("txt");
    });

    it("ignores query strings", () => {
        expect(extensionFromUri("/foo/content.lava?v=2")).toBe("lava");
    });

    it("ignores fragments", () => {
        expect(extensionFromUri("/foo/content.lava#anchor")).toBe("lava");
    });

    it("returns null when the last segment has no extension", () => {
        expect(extensionFromUri("/api/Magnus/GetTreeItems/mobileapps/page-settings/123")).toBe(null);
    });

    it("returns null on the empty string", () => {
        expect(extensionFromUri("")).toBe(null);
    });

    it("returns null for a path without slashes", () => {
        // Defensive — real Magnus URIs are always /-prefixed, but we shouldn't
        // throw on a malformed input from a future server change.
        expect(extensionFromUri("metadata.txt")).toBe(null);
    });
});

describe("nameForDescriptor", () => {
    it("appends the extension when displayName has none", () => {
        expect(nameForDescriptor("Content", false, "/api/Magnus/FileContent/x/content.lava"))
            .toBe("Content.lava");
    });

    it("trusts displayName when it already has an extension", () => {
        // Some Rock endpoints already include the extension in displayName
        // (e.g. file-attachment listings). Don't double-append.
        expect(nameForDescriptor("settings.json", false, "/api/x/settings.json"))
            .toBe("settings.json");
    });

    it("returns folder names verbatim — no extension append", () => {
        // Folders don't carry leaf extensions in their URIs; even if the
        // folder name happened to contain a dot, we never want to treat it
        // like a file extension.
        expect(nameForDescriptor("Page Settings", true, "/api/Magnus/GetTreeItems/x/page-settings/1"))
            .toBe("Page Settings");
    });

    it("sanitizes filesystem-unsafe chars before appending", () => {
        // displayName containing `:` would otherwise create a forbidden path
        // on Windows; sanitize first, append second.
        expect(nameForDescriptor("Foo: Bar", false, "/x/baz.lava"))
            .toBe("Foo- Bar.lava");
    });

    it("falls back to the displayName when the URI has no extension", () => {
        expect(nameForDescriptor("Metadata", false, "/api/Magnus/x/no-extension-here"))
            .toBe("Metadata");
    });

    it("falls back to the displayName when uri is null", () => {
        expect(nameForDescriptor("Metadata", false, null)).toBe("Metadata");
    });

    it("falls back to the displayName when uri is undefined", () => {
        expect(nameForDescriptor("Metadata", false, undefined)).toBe("Metadata");
    });

    it("returns 'item' for an empty displayName (matches existing fallback)", () => {
        // Mirrors the `|| "item"` fallback that pull/walk used before this
        // helper existed; we shouldn't regress that safety net.
        expect(nameForDescriptor("", false, "/x/foo.lava")).toBe("item.lava");
    });
});

describe("isMobileAppNodeUri", () => {
    it("matches the mobile-app root path", () => {
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12")).toBe(true);
    });

    it("matches with a trailing slash", () => {
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12/")).toBe(true);
    });

    it("matches with a query string", () => {
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12?v=1")).toBe(true);
    });

    it("matches case-insensitively", () => {
        // Defensive — Rock URIs are usually lowercase but path matching
        // shouldn't be sensitive to a stray uppercase segment.
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/MobileApps/App/12")).toBe(true);
    });

    it("rejects descendants under an app", () => {
        // Pages, blocks, settings folders inside an app shouldn't show
        // the Pull entry — we only support pulling whole apps.
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12/page-settings/1679")).toBe(false);
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/page-settings/1679")).toBe(false);
    });

    it("rejects the mobile-apps group folder itself", () => {
        // The "Mobile Apps" group node has URI `/mobileapps` but no app id
        // — pulling the whole group isn't supported.
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps")).toBe(false);
    });

    it("rejects other Rock content types", () => {
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/contentchannels/12")).toBe(false);
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/pages/12")).toBe(false);
    });

    it("rejects null, undefined, and empty", () => {
        expect(isMobileAppNodeUri(null)).toBe(false);
        expect(isMobileAppNodeUri(undefined)).toBe(false);
        expect(isMobileAppNodeUri("")).toBe(false);
    });

    it("rejects URIs missing the numeric app id", () => {
        // `/mobileapps/app` (no id) isn't a real node we'd see, but
        // defensively shouldn't pass either.
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/")).toBe(false);
        expect(isMobileAppNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app")).toBe(false);
    });
});

describe("isAISkillsCollectionNodeUri", () => {
    it("matches the AI Skills collection root", () => {
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/")).toBe(true);
    });

    it("matches without a trailing slash", () => {
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills")).toBe(true);
    });

    it("matches with a query string", () => {
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills?v=1")).toBe(true);
    });

    it("matches case-insensitively", () => {
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/AISkills/")).toBe(true);
    });

    it("rejects per-skill descendants", () => {
        // Individual skills aren't pullable on their own — only the
        // whole collection is.
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/skill/42")).toBe(false);
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/skill/42/")).toBe(false);
    });

    it("rejects per-tool URIs", () => {
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/FileContent/aiskills/tool-prompt/123/Prompt.lava")).toBe(false);
    });

    it("rejects other Rock content types", () => {
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/")).toBe(false);
        expect(isAISkillsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/lavaapplication/")).toBe(false);
    });

    it("rejects null, undefined, and empty", () => {
        expect(isAISkillsCollectionNodeUri(null)).toBe(false);
        expect(isAISkillsCollectionNodeUri(undefined)).toBe(false);
        expect(isAISkillsCollectionNodeUri("")).toBe(false);
    });
});

describe("isPersistedDatasetsCollectionNodeUri", () => {
    it("matches the Persisted Datasets collection root", () => {
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets/")).toBe(true);
    });

    it("matches without a trailing slash", () => {
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets")).toBe(true);
    });

    it("matches with a query string", () => {
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets?v=1")).toBe(true);
    });

    it("matches case-insensitively", () => {
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/PersistedDatasets/")).toBe(true);
    });

    it("rejects per-dataset descendants", () => {
        // Individual datasets aren't pullable on their own — only the
        // whole collection is.
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets/dataset/42")).toBe(false);
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets/dataset/42/")).toBe(false);
    });

    it("rejects per-file URIs", () => {
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/FileContent/persisteddatasets/dataset/42/BuildScript.lava")).toBe(false);
    });

    it("rejects other Rock content types", () => {
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/")).toBe(false);
        expect(isPersistedDatasetsCollectionNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/")).toBe(false);
    });

    it("rejects null, undefined, and empty", () => {
        expect(isPersistedDatasetsCollectionNodeUri(null)).toBe(false);
        expect(isPersistedDatasetsCollectionNodeUri(undefined)).toBe(false);
        expect(isPersistedDatasetsCollectionNodeUri("")).toBe(false);
    });
});

describe("isThemeNodeUri", () => {
    it("matches a theme root", () => {
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Stark")).toBe(true);
    });

    it("matches with a trailing slash", () => {
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Stark/")).toBe(true);
    });

    it("matches with a query string", () => {
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Stark?v=1")).toBe(true);
    });

    it("matches case-insensitively", () => {
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/Themes/Theme/Stark")).toBe(true);
    });

    it("matches URL-encoded theme names", () => {
        // Theme names can include spaces; the URI keeps them as %20.
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/My%20Stark")).toBe(true);
    });

    it("rejects descendants inside a theme", () => {
        // Subfolders and files inside a theme aren't pullable on their
        // own — only the theme directory itself is.
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Stark/Layouts")).toBe(false);
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/FileContent/themes/theme/Stark/Layouts/Site.Master.aspx")).toBe(false);
    });

    it("rejects the VFS root", () => {
        // The Themes VFS root lists themes but isn't itself a pull target.
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes")).toBe(false);
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/themes/")).toBe(false);
    });

    it("rejects other Rock content types", () => {
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12")).toBe(false);
        expect(isThemeNodeUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/")).toBe(false);
    });

    it("rejects null, undefined, and empty", () => {
        expect(isThemeNodeUri(null)).toBe(false);
        expect(isThemeNodeUri(undefined)).toBe(false);
        expect(isThemeNodeUri("")).toBe(false);
    });
});

describe("isLocalModePullableUri", () => {
    it("accepts mobile-app roots", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12")).toBe(true);
    });

    it("accepts the AI Skills collection root", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/")).toBe(true);
    });

    it("accepts theme roots", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Stark")).toBe(true);
    });

    it("accepts the Persisted Datasets collection root", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets/")).toBe(true);
    });

    it("rejects unsupported content types", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/contentchannels/12")).toBe(false);
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/lavaapplication/")).toBe(false);
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/pages/12")).toBe(false);
    });

    it("rejects descendants under supported roots", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/12/page-settings/1679")).toBe(false);
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/aiskills/skill/42")).toBe(false);
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Stark/Layouts")).toBe(false);
    });

    it("rejects the Themes VFS root (only theme directories are pullable)", () => {
        expect(isLocalModePullableUri("/api/TriumphTech/Magnus/GetTreeItems/themes")).toBe(false);
    });

    it("rejects null, undefined, and empty", () => {
        expect(isLocalModePullableUri(null)).toBe(false);
        expect(isLocalModePullableUri(undefined)).toBe(false);
        expect(isLocalModePullableUri("")).toBe(false);
    });
});

/**
 * Work item 20: shortcodes, Lava applications and Apple TV apps join local mode.
 *
 * Each matcher has to accept exactly the pull target and reject its descendants,
 * because a descendant that slips through becomes a workspace rooted halfway
 * down a tree, with a manifest that can never reconcile against the real root.
 */

describe("isShortcodesCollectionNodeUri", () => {
    it("accepts the collection root", () => {
        expect(isShortcodesCollectionNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/shortcodes"
        )).toBe(true);
        expect(isShortcodesCollectionNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/shortcodes/"
        )).toBe(true);
    });

    it("rejects an individual shortcode", () => {
        // Shortcodes are pulled as a collection; each one is two files, so a
        // per-shortcode workspace would be all overhead.
        expect(isShortcodesCollectionNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/shortcodes/shortcode/12"
        )).toBe(false);
    });

    it("rejects null and empty", () => {
        expect(isShortcodesCollectionNodeUri(null)).toBe(false);
        expect(isShortcodesCollectionNodeUri("")).toBe(false);
    });
});

describe("isLavaApplicationNodeUri", () => {
    it("accepts an application root", () => {
        // Note the doubled segment: the filesystem identifier and the path kind
        // are both "lavaapplication".
        expect(isLavaApplicationNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/lavaapplication/lavaapplication/7"
        )).toBe(true);
    });

    it("rejects the filesystem root", () => {
        expect(isLavaApplicationNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/lavaapplication"
        )).toBe(false);
    });

    it("rejects descendants of an application", () => {
        expect(isLavaApplicationNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/lavaapplication/application-blocks/7"
        )).toBe(false);
        expect(isLavaApplicationNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/lavaapplication/lavaapplication/7/settings"
        )).toBe(false);
    });
});

describe("isAppleTvAppNodeUri", () => {
    it("accepts an app root", () => {
        expect(isAppleTvAppNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/appletvapps/app/3"
        )).toBe(true);
    });

    it("rejects descendants", () => {
        expect(isAppleTvAppNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/appletvapps/app/3/page/9"
        )).toBe(false);
    });

    it("does not confuse itself with a mobile app", () => {
        expect(isAppleTvAppNodeUri(
            "/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/3"
        )).toBe(false);
    });
});

describe("isLocalModePullableUri, after item 20", () => {
    it("accepts all seven supported shapes", () => {
        const supported = [
            "/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/1",
            "/api/TriumphTech/Magnus/GetTreeItems/aiskills",
            "/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Rock",
            "/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets",
            "/api/TriumphTech/Magnus/GetTreeItems/shortcodes",
            "/api/TriumphTech/Magnus/GetTreeItems/lavaapplication/lavaapplication/2",
            "/api/TriumphTech/Magnus/GetTreeItems/appletvapps/app/4"
        ];
        for (const uri of supported) {
            expect(isLocalModePullableUri(uri), uri).toBe(true);
        }
    });

    it("still rejects websites and the server filesystem", () => {
        // 7.12 keeps websites as its own scoped project because it combines a
        // deep tree with open-ended block coverage; serverfs has no local-mode
        // story at all. Both must stay out of the pull gate and therefore out of
        // the selection dialog.
        expect(isLocalModePullableUri(
            "/api/TriumphTech/Magnus/GetTreeItems/websites/site/1"
        )).toBe(false);
        expect(isLocalModePullableUri(
            "/api/TriumphTech/Magnus/GetTreeItems/serverfs"
        )).toBe(false);
    });
});
