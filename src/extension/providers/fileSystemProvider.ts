import * as vscode from "vscode";
import { RelayClient } from "../modules/relay";
import { FileSystemError } from "vscode";
import { ActiveConnection, Server } from "../types";

export function useRemoteFS(relay: RelayClient, context: vscode.ExtensionContext) {
	if (!globalThis.gmodRemoteFileSystemProvider) {
		globalThis.gmodRemoteFileSystemProvider = new RemoteFileSystemProvider(relay, context);
	}

	return globalThis.gmodRemoteFileSystemProvider;
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
	private connected = false;
	private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	onDidChangeFile = this.emitter.event;

	constructor(private relay: RelayClient, private context: vscode.ExtensionContext) {
		this.relay.on("connected", () => {
			this.connected = true;

			this.refresh(vscode.Uri.parse("gmod:/"));
		});

		this.relay.on("disconnected", () => {
			this.connected = false;

			this.refresh(vscode.Uri.parse("gmod:/"));
		});
	}

	refresh(uri: vscode.Uri) {
		const changeList: vscode.FileChangeEvent[] = [];

		if (uri.path === "/") {
			changeList.push({
				type: vscode.FileChangeType.Deleted,
				uri
			});

			changeList.push({
				type: vscode.FileChangeType.Created,
				uri
			});
		}
		else {
			changeList.push({
				type: vscode.FileChangeType.Changed,
				uri
			});
		}

		setTimeout(() => {
			this.emitter.fire(changeList);
		}, 5);
	}

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}

	private toServerPath(uri: vscode.Uri) {
		return uri.path;
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		if (uri.path === "/") {
			return {
				type: vscode.FileType.Directory,
				ctime: Date.now(),
				mtime: Date.now(),
				size: 0
			};
		}

		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Stat", {
			path: this.toServerPath(uri)
		});

		if (!res.success) {

			throw FileSystemError.FileNotFound(uri.path);
		}

		return {
			type: res.type === "directory"
				? vscode.FileType.Directory
				: vscode.FileType.File,
			ctime: res.created,
			mtime: res.modified,
			size: res.size
		};
	}

	async readDirectory(uri: vscode.Uri) {
		if (!this.connected) {

			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.ListFiles", {
			path: this.toServerPath(uri)
		});

		if (!res.success) {

			throw FileSystemError.FileNotFound(uri.path);
		}

		return res.entries.map((e: any) => [
			e.name,
			e.type === "directory"
				? vscode.FileType.Directory
				: vscode.FileType.File
		]);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const serverPath = this.toServerPath(uri);

		const stat = await this.relay.rpc("FS.Stat", {
			path: serverPath
		});

		if (!stat.success) {
			throw FileSystemError.FileNotFound(uri.path);
		}

		const res = await this.relay.rpc("FS.Read", {
			path: serverPath,
			offset: 0,
			length: stat.size
		});

		if (!res.success) {
			throw FileSystemError.FileNotFound(uri.path);
		}

		let fileChunks: Uint8Array[] = [];

		return new Promise((resolve) => {
			this.relay.stream(this.relay.getLastRequestId(), (chunk) => {
				fileChunks.push(chunk);
			}, () => {
				resolve(Buffer.concat(fileChunks));
			});
		});
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array) {
		if (!this.connected) {	
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Write", {
			path: this.toServerPath(uri),
			offset: 0,
			data: Buffer.from(content).toString("base64")
		});

		if (!res.success) {
			throw FileSystemError.FileNotFound(uri.path);
		}

		await this.relay.rpc("FS.Truncate", {
			path: this.toServerPath(uri),
			size: content.length
		});

		this.refresh(uri);
	}

	async createDirectory(uri: vscode.Uri) {
		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Mkdir", {
			path: this.toServerPath(uri)
		});

		if (!res.success) {
			throw FileSystemError.FileNotFound(uri.path);
		}

		this.refresh(uri);
	}

	async delete(uri: vscode.Uri) {
		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Delete", {
			path: this.toServerPath(uri)
		});

		if (!res.success) {
			throw FileSystemError.FileNotFound(uri.path);
		}

		this.refresh(uri);
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri) {
		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Rename", {
			from: this.toServerPath(oldUri),
			to: this.toServerPath(newUri)
		});

		if (!res.success) {
			throw FileSystemError.FileNotFound(newUri.path);
		}

		this.refresh(newUri);
	}

	setupWorkspace(server: Server) {
		const uri = vscode.Uri.parse("gmod:/");
		const name = this.relay.name() || server.name;

		vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length || 0, 0, {
			name,
			uri
		});
	}

	async connect(server: Server) {
		await this.context.globalState.update("gmodRemote.activeConnection", {
			server,
			connectionTime: Date.now()
		});

		this.relay.connect(server.relay, server.address, server.password, server.encryptionKey).then(() => {
			this.setupWorkspace(server);
		});
	}

	async restoreConnection() {
		const savedConnection = this.context.globalState.get<ActiveConnection | undefined>("gmodRemote.activeConnection");

		if (!savedConnection || !savedConnection.server) {
			return;
		}

		this.connect(savedConnection.server);
	}

	disconnect() {
		this.relay.disconnect();
		this.connected = false;
		this.context.globalState.update("gmodRemote.activeConnection", undefined);
	}
}
