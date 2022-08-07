import * as vscode from "vscode";
import { Commands } from "./commands";
import { Events } from "./events";

import { RockTreeDataProvider } from "./rockTreeDataProvider";

export function activate(context: vscode.ExtensionContext): void {
    const events = new Events();

    context.subscriptions.push(events);
    context.subscriptions.push(new RockTreeDataProvider(context, events));
    context.subscriptions.push(new Commands(context, events));
}

export function deactivate(): void {
    /* future use */
}
