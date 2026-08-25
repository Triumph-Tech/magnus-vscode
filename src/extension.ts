import * as vscode from "vscode";
import { AboutWebviewProvider } from "./aboutWebViewProvider";
import { Api } from "./api";
import { BASELINE_SCHEME, BaselineContentProvider } from "./baselineContentProvider";
import { Secrets } from "./secrets";
import { Commands } from "./commands";
import { Events } from "./events";
import { registerHydrateCommand } from "./hydrateCommand";
import { MagnusSourceControlManager } from "./magnusSourceControl";
import { MagnusTreeDataProvider } from "./magnusTreeDataProvider";
import { PullRegistry } from "./pullRegistry";
import { registerPullCommand } from "./pullCommand";
import { registerPulledWorkspaceCommands } from "./pulledWorkspaceCommands";
import { registerReauthenticateCommand } from "./reauthenticateCommand";
import { registerRepairExtensionsCommand } from "./repairExtensions";
import { registerWalkthroughCommands } from "./walkthroughCommands";

export function activate(context: vscode.ExtensionContext): void {
    // --- Cloud-mode wiring (unchanged from upstream Magnus 1.0.2) -------
    const events = new Events();
    const secrets = new Secrets(context);
    const api = new Api(secrets);

    // --- Local-mode wiring (additive; cloud mode keeps working as-is) ---
    // PullRegistry tracks every app the user has pulled to a local workspace.
    // It's threaded into the tree data provider so the right-click menu can
    // toggle between "Pull to Local…" and "Open Local Workspace" based on
    // whether the app is already pulled.
    const pullRegistry = new PullRegistry(context);

    context.subscriptions.push(events);
    context.subscriptions.push(new MagnusTreeDataProvider(context, events, api, pullRegistry));
    context.subscriptions.push(new Commands(context, events, secrets, api));
    context.subscriptions.push(new AboutWebviewProvider(context));

    // Baselines back the SCM provider's quickdiff: every modified file shows
    // a diff against its last-synced server bytes. Registered as a virtual
    // text-document content provider so VS Code's diff editor can resolve
    // `magnus-baseline:...` URIs without round-tripping to the server.
    const baseline = new BaselineContentProvider();
    context.subscriptions.push(baseline);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, baseline)
    );

    // Source control surface — instantiates one SCM panel per pulled
    // workspace folder open in the current VS Code window, plus a
    // Restore/Connect placeholder for a cloned workspace that has a
    // committed `magnus.json` but no `.magnus/` yet. Cloud-only sessions
    // (neither file anywhere) still get nothing.
    const scm = new MagnusSourceControlManager(api, secrets, baseline);
    context.subscriptions.push(scm);

    for (const d of registerPullCommand(api, pullRegistry)) {
        context.subscriptions.push(d);
    }
    for (const d of registerPulledWorkspaceCommands(pullRegistry)) {
        context.subscriptions.push(d);
    }
    for (const d of registerRepairExtensionsCommand()) {
        context.subscriptions.push(d);
    }
    for (const d of registerReauthenticateCommand(context, api, secrets)) {
        context.subscriptions.push(d);
    }
    // Hydration writes a manifest into a folder that is already open, and no
    // workspace-folder event fires for that, so the manager is refreshed
    // explicitly once it finishes.
    for (const d of registerHydrateCommand(context, api, secrets, () => scm.refresh())) {
        context.subscriptions.push(d);
    }
    for (const d of registerWalkthroughCommands()) {
        context.subscriptions.push(d);
    }
}

export function deactivate(): void {
    /* future use */
}
