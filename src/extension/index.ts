import * as vscode from "vscode";
import { useRelay } from "./providers/relayProvider";
import { useRemoteFS } from "./providers/fileSystemProvider";
import { useStatusBar } from "./providers/statusBarProvider";
import { useCommands } from "./providers/commandProvider";
import { useSearchProvider } from "./providers/searchProvider";
import { useSearchView } from "./providers/searchViewWebviewProvider";
import { Server } from "./types";

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

	// Handle URI commands for opening new windows with connections
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			handleUri: async (uri: vscode.Uri) => {
				if (uri.path === "/connect") {
					const serverParam = uri.query.split("&").find(p => p.startsWith("server="));
					if (serverParam) {
						try {
							const serverJson = decodeURIComponent(serverParam.split("=")[1]);
							const server = JSON.parse(serverJson);
							// Connect in this new window
							await remoteFS.connect(server);
						} catch (error) {
							vscode.window.showErrorMessage(`Failed to parse server connection: ${error}`);
						}
					}
				}
			}
		})
	);

	// Register command to connect from URI (for cases where URI handler doesn't work)
	context.subscriptions.push(
		vscode.commands.registerCommand("gmod-remote.connectFromUri", async (server: Server) => {
			if (server) {
				await remoteFS.connect(server);
			}
		})
	);

	remoteFS.restoreConnection();
}

export function deactivate() { }
