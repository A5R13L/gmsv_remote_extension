import * as vscode from "vscode";
import { Server } from "../types";

export function getServers() {
	const config = vscode.workspace.getConfiguration();
	const servers = config.get<Server[] | undefined>("gmodRemote.servers") || [];

	return servers;
}

export function storeNewServer(servers: Server[], server: Server) {
	const config = vscode.workspace.getConfiguration();
	const newServers = [...servers, server];
	config.update("gmodRemote.servers", newServers, vscode.ConfigurationTarget.Global);
}