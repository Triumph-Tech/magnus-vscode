import * as vscode from "vscode";
import { AboutWebviewProvider } from "./aboutWebViewProvider";
import { Api } from "./api";
import { Secrets } from "./secrets";
import { Commands } from "./commands";
import { Events } from "./events";

import { MagnusTreeDataProvider } from "./magnusTreeDataProvider";

export function activate(context: vscode.ExtensionContext): void {
    const events = new Events();
    const secrets = new Secrets(context);
    const api = new Api(secrets);

    context.subscriptions.push(events);
    context.subscriptions.push(new MagnusTreeDataProvider(context, events, api));
    context.subscriptions.push(new Commands(context, events, secrets, api));
    context.subscriptions.push(new AboutWebviewProvider(context));
}

export function deactivate(): void {
    /* future use */
}
