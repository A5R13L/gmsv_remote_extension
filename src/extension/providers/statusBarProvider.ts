import * as vscode from "vscode";
import { RelayClient } from "../modules/relay";

export function useStatusBar(context: vscode.ExtensionContext, relay: RelayClient) {
	const statusBar = new StatusBar(relay);

	statusBar.show();
	context.subscriptions.push(statusBar.get());
}

export class StatusBar {
	private status: vscode.StatusBarItem;

	constructor(private relay: RelayClient) {
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.status.command = "gmod-remote.connect";
		this.update("$(debug-disconnect) GMod Remote: Connect to Server", "Click to connect", new vscode.ThemeColor("statusBarItem.errorBackground"));

		this.relay.on("connecting", () => {
			this.update("$(remote) GMod Remote: Connecting...", "Connecting to server...", undefined);
		});

		this.relay.on("connected", () => {
			this.update(`$(remote) GMod Remote: ${this.relay.name() || "Server"}`, `Connected to server`, undefined);
		});

		this.relay.on("disconnected", () => {
			this.update("$(debug-disconnect) GMod Remote: Disconnected", "Click to connect", new vscode.ThemeColor("statusBarItem.errorBackground"));
		});
	}

	show() {
		this.status.show();
	}

	update(text: string, tooltip: string, backgroundColor: vscode.ThemeColor | undefined) {
		this.status.text = text;
		this.status.tooltip = tooltip;
		this.status.backgroundColor = backgroundColor;
	}

	get() {
		return this.status;
	}
}