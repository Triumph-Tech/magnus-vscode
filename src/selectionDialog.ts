import * as vscode from "vscode";
import { Api } from "./api";
import { MagnusSelectionEntry } from "./magnusJson";
import { normalizePathPrefix } from "./manifest";
import { isLocalModePullableUri, sanitizeForFs } from "./pullHelpers";

/**
 * The "what should this workspace hold?" dialog.
 *
 * One flat checklist of every pullable resource on a server, grouped by type.
 * Not a two-step "pick a type, then pick a resource" wizard: the thing a person
 * wants to do is check another box, and a wizard makes adding one theme to an
 * existing workspace a four-step errand.
 *
 * The list is built by walking exactly two levels of the tree, which is also why
 * it is honest about types Magnus does not support: a type that lists no
 * children simply contributes nothing, rather than the client keeping its own
 * list of what local mode handles and drifting from the server's.
 */

/** One row in the checklist. */
interface IResourceItem extends vscode.QuickPickItem {
    entry?: MagnusSelectionEntry;
}

/**
 * Build the path prefix a resource will occupy inside the workspace.
 *
 * Mirrors what `pullToWorkspace` has always produced, so a resource picked
 * through the dialog lands where the same resource picked from the tree would:
 * `<Platform>/<Resource>/`, both filesystem-sanitised.
 */
export function prefixForResource(platform: string | undefined, displayName: string): string {
    const leaf = sanitizeForFs(displayName);
    return normalizePathPrefix(platform ? `${sanitizeForFs(platform)}/${leaf}` : leaf);
}

/**
 * Enumerate everything on a server that can be pulled, grouped by type.
 *
 * Two levels: the virtual filesystems, then their immediate children. A
 * filesystem that fails to enumerate is skipped with its error surfaced rather
 * than silently omitted, because an empty group and an unreachable one look
 * identical in a checklist and mean very different things.
 */
async function enumeratePullableResources(
    api: Api,
    serverUrl: string,
    progress: vscode.Progress<{ message?: string }>
): Promise<{ items: IResourceItem[]; failures: string[] }> {
    const topLevel = await api.getChildItems(serverUrl, undefined);

    const items: IResourceItem[] = [];
    const failures: string[] = [];

    for (const group of topLevel) {
        if (!group.isFolder || !group.uri) {
            continue;
        }

        progress.report({ message: group.displayName });

        let children;
        try {
            children = await api.getChildItems(serverUrl, group.uri);
        }
        catch (err) {
            failures.push(`${group.displayName}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }

        // Same gate the tree's right-click uses. Without it the dialog would
        // happily offer websites and the server filesystem, which local mode
        // has no story for, and the two entry points would disagree about what
        // is pullable.
        const pullable = children.filter(c => c.isFolder && isLocalModePullableUri(c.uri));

        // A collection type is its own pull target rather than a container of
        // them, so if the group node itself qualifies it is offered directly.
        if (pullable.length === 0 && isLocalModePullableUri(group.uri)) {
            items.push({ label: group.displayName, kind: vscode.QuickPickItemKind.Separator });
            items.push({
                label: group.displayName,
                description: "all items",
                entry: {
                    uri: group.uri ?? "",
                    displayName: group.displayName,
                    platform: group.displayName,
                    pathPrefix: prefixForResource(undefined, group.displayName)
                }
            });
            continue;
        }

        if (pullable.length === 0) {
            continue;
        }

        items.push({ label: group.displayName, kind: vscode.QuickPickItemKind.Separator });

        for (const child of pullable) {
            items.push({
                label: child.displayName,
                description: group.displayName,
                entry: {
                    uri: child.uri ?? "",
                    displayName: child.displayName,
                    platform: group.displayName,
                    pathPrefix: prefixForResource(group.displayName, child.displayName)
                }
            });
        }
    }

    return { items, failures };
}

/**
 * Show the checklist and return the chosen selection, or null if cancelled.
 *
 * `current` is pre-checked, so the dialog opens showing what the workspace holds
 * and the interaction is "check one more" rather than "rebuild the list".
 * `preSeed` is a prefix to additionally check on open, which is how a right-click
 * in the tree arrives here: it lands the user in the same dialog with their
 * intent already expressed, instead of on a separate one-off path.
 */
export async function promptForSelection(
    api: Api,
    serverUrl: string,
    current: MagnusSelectionEntry[],
    preSeed?: string
): Promise<MagnusSelectionEntry[] | null> {
    const enumerated = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Magnus: listing resources on ${serverUrl}…`,
            cancellable: false
        },
        (progress) => enumeratePullableResources(api, serverUrl, progress)
    );

    const { items, failures } = enumerated;

    if (failures.length > 0) {
        void vscode.window.showWarningMessage(
            `Magnus: ${failures.length} resource type${failures.length === 1 ? "" : "s"} could not be listed `
            + "and are missing from this dialog:\n" + failures.join("\n")
        );
    }

    const selectable = items.filter(i => i.entry);

    if (selectable.length === 0) {
        void vscode.window.showErrorMessage(
            `Magnus: nothing on ${serverUrl} is available to pull. `
            + "The resource types you have access to may be disabled on the server."
        );
        return null;
    }

    const currentPrefixes = new Set(current.map(e => e.pathPrefix));
    if (preSeed) {
        currentPrefixes.add(preSeed);
    }

    const picked = await new Promise<readonly IResourceItem[] | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick<IResourceItem>();
        quickPick.title = `Magnus Local — what should this workspace hold?`;
        quickPick.placeholder = "Check the resources to keep locally. Unchecking one asks before removing files.";
        quickPick.canSelectMany = true;
        quickPick.matchOnDescription = true;
        quickPick.ignoreFocusOut = true;
        quickPick.items = items;
        quickPick.selectedItems = selectable.filter(i => currentPrefixes.has(i.entry!.pathPrefix));

        quickPick.onDidAccept(() => {
            resolve(quickPick.selectedItems);
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });
        quickPick.show();
    });

    if (picked === undefined) {
        return null;
    }

    // Entries the server did not list this time are preserved rather than read
    // as unchecked. A resource type that failed to enumerate above is absent
    // from the list entirely, and treating absence as a deletion request would
    // offer to delete a workspace's files because of a transient server error.
    const listedPrefixes = new Set(selectable.map(i => i.entry!.pathPrefix));
    const unlisted = current.filter(e => !listedPrefixes.has(e.pathPrefix));

    return [...picked.map(i => i.entry!), ...unlisted];
}
