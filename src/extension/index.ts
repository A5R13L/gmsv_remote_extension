import * as vscode from "vscode";
import { useRelay } from "./providers/relayProvider";
import { useRemoteFS } from "./providers/fileSystemProvider";
import { useStatusBar } from "./providers/statusBarProvider";
import { useCommands } from "./providers/commandProvider";
import { useSearchProvider } from "./providers/searchProvider";
import { useSearchView } from "./providers/searchViewWebviewProvider";

export function activate(context: vscode.ExtensionContext) {
	const relay = useRelay();
	const remoteFS = useRemoteFS(relay, context);
	const fileSystemProvider = vscode.workspace.registerFileSystemProvider("gmod", remoteFS, { isCaseSensitive: true });

	context.subscriptions.push(fileSystemProvider);
	useStatusBar(context, relay);
	useCommands(context, relay);
	useSearchProvider(relay);

	const searchViewProvider = useSearchView(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("gmod-remote.search", searchViewProvider),
		searchViewProvider
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("gmod-remote.search.focus", () => {
			searchViewProvider.focusSearchInput();
		})
	);

	remoteFS.restoreConnection();
}

export function deactivate() { }
