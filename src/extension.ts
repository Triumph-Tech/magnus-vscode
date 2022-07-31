import * as vscode from 'vscode';

import { RockExplorer } from "./rockExplorer";

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('rockrms-interface.addServer', () => {
		vscode.window.showInformationMessage('Hello World from RockRMS Interface!');
	}));

	new RockExplorer(context);
}

export function deactivate() {

}
