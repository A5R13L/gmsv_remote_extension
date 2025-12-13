import * as vscode from "vscode";
import { RelayClient } from "../modules/relay";
import { getServers, removeServer, storeNewServer } from "./serverProvider";
import { Server } from "../types";
import { useRemoteFS } from "./fileSystemProvider";

export function useCommands(context: vscode.ExtensionContext, relay: RelayClient) {
	const remoteFS = useRemoteFS(relay, context);
	
	context.subscriptions.push(vscode.commands.registerCommand("gmod-remote.connect", async () => {
		const currentServers = getServers();

		const serverList: { id: number; label: string; description: string; server: Server | null; type: "server" | "add-server" | "remove-server" }[] = currentServers.map((server, idx) => ({
			id: idx,
			label: server.name,
			description: `${server.address} via ${server.relay}`,
			server: server,
			type: "server"
		}));

		serverList.push({
			id: -1,
			label: "+ Add New Server...",
			description: "",
			server: null,
			type: "add-server"
		});

		if (currentServers.length > 0) {
			serverList.push({
				id: -1,
				label: "- Delete Server",
				description: "",
				server: null,
				type: "remove-server"
			});
		}

		const selectedServer = await vscode.window.showQuickPick(serverList, {
			placeHolder: "Select a server to connect to"
		});

		if (!selectedServer) {
			return;
		};

		let server = selectedServer.server;

		if (selectedServer.type === "remove-server") {
			const serverToRemove = await vscode.window.showQuickPick(serverList.filter((server) => server.type === "server"), {
				placeHolder: "Select a server to remove"
			});

			if (!serverToRemove) {
				return;
			}

			removeServer(currentServers, serverToRemove.id);
			vscode.window.showInformationMessage("Server removed successfully");
			return;
		} else if (selectedServer.type === "add-server") {
			const [name, address, relay, password, encryptionKey] = await getNewServerInfo();

			if (!name || !address || !relay) {
				vscode.window.showErrorMessage("Please fill in all the fields");
				return;
			};

			server = {
				name,
				address,
				relay,
				password: password || "",
				encryptionKey: encryptionKey || ""
			};

			storeNewServer(currentServers, server);
		}

		if (!server) {
			return;
		};

		// Open a new window with the remote connection via URI
		const serverJson = encodeURIComponent(JSON.stringify(server));
		const uri = vscode.Uri.parse(`vscode://gmod-remote/connect?server=${serverJson}`);
		await vscode.env.openExternal(uri);
	}));

	context.subscriptions.push(vscode.commands.registerCommand("gmod-remote.disconnect", async () => {
		remoteFS.disconnect();
	}));
}

async function getNewServerInfo() {
	const name = await vscode.window.showInputBox({
		prompt: "Enter the name of the server"
	});

	const address = await vscode.window.showInputBox({
		prompt: "Enter the address of the server"
	});

	const relay = await vscode.window.showInputBox({
		prompt: "Enter the relay of the server",
		value: "wss://gmsv_remote.asrieldev.workers.dev"
	});

	const password = await vscode.window.showInputBox({
		prompt: "Enter the password of the server"
	});

	const encryptionKey = await vscode.window.showInputBox({
		prompt: "Enter the encryption key of the server (Leave blank for none)",
	});

	return [name, address, relay, password, encryptionKey];
}