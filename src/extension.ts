import * as vscode from 'vscode';
import { CodePilotViewProvider } from './CodePilotViewProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('CodePilot Agent is now active');

	const provider = new CodePilotViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CodePilotViewProvider.viewType, provider)
	);

	let disposable = vscode.commands.registerCommand('codepilot-agent.start', () => {
		vscode.window.showInformationMessage('CodePilot Agent Started!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
