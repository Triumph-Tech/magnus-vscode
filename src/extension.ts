import * as vscode from "vscode";
import { AboutWebviewProvider } from "./aboutWebViewProvider";
import { Commands } from "./commands";
import { Events } from "./events";

import { MagnusTreeDataProvider } from "./magnusTreeDataProvider";

export function activate(context: vscode.ExtensionContext): void {
    const events = new Events();

    context.subscriptions.push(events);
    context.subscriptions.push(new MagnusTreeDataProvider(context, events));
    context.subscriptions.push(new Commands(context, events));
    context.subscriptions.push(new AboutWebviewProvider(context));
}

export function deactivate(): void {
    /* future use */
}
