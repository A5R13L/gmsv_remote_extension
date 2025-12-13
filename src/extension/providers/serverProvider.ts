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

export function removeServer(servers: Server[], id: number) {
	const config = vscode.workspace.getConfiguration();
	const newServers = servers.filter((_, idx) => idx !== id);
	config.update("gmodRemote.servers", newServers, vscode.ConfigurationTarget.Global);
}

export function getActiveServer() {
	const config = vscode.workspace.getConfiguration();
	const activeServer = config.get<Server | undefined>("gmodRemote.activeServer");
	return activeServer;
}