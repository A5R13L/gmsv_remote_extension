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
			switch (res.error_code) {
				case "not_a_directory":
					throw vscode.FileSystemError.FileNotADirectory(uri.path);
				default:
					throw vscode.FileSystemError.FileNotFound(uri.path);
			}
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


		const res = await this.relay.rpc("FS.Read", {
			path: serverPath
		});

		if (!res.success) {
			switch (res.error_code) {
				case "not_a_file":
					throw FileSystemError.FileIsADirectory(uri.path);
				default:
					throw FileSystemError.FileNotFound(uri.path);
			}
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

	async copy(sourceUri: vscode.Uri, destinationUri: vscode.Uri) {
		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Copy", {
			from: this.toServerPath(sourceUri),
			to: this.toServerPath(destinationUri)
		});

		if (!res.success) {
			switch (res.error_code) {
				case "file_not_found":
					throw FileSystemError.FileNotFound(sourceUri.path);
				case "file_already_exists":
					throw FileSystemError.FileExists(destinationUri.path);
				default:
					throw FileSystemError.FileNotFound(sourceUri.path);
			}
		}

		this.refresh(destinationUri);
	}

	async createDirectory(uri: vscode.Uri) {
		if (!this.connected) {
			throw vscode.FileSystemError.Unavailable("Not connected");
		}

		const res = await this.relay.rpc("FS.Mkdir", {
			path: this.toServerPath(uri)
		});

		if (!res.success) {
			switch (res.error_code) {
				case "directory_already_exists":
					throw vscode.FileSystemError.FileExists(uri.path);
				default:
					throw vscode.FileSystemError.FileNotFound(uri.path);
			}
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
			switch (res.error_code) {
				case "file_already_exists":
					throw FileSystemError.FileExists(newUri.path);
				default:
					throw FileSystemError.FileNotFound(newUri.path);
			}
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

	async connect(server: Server, isRestore = false) {
		await this.context.workspaceState.update("gmodRemote.activeConnection", {
			server,
			connectionTime: Date.now()
		});

		if (!isRestore) {
			await this.context.globalState.update("gmodRemote.pendingConnection", {
				server,
				connectionTime: Date.now()
			});
		}

		this.relay.connect(server.relay, server.address, server.password, server.encryptionKey).then(() => {
			this.setupWorkspace(server);
			if (!isRestore) {
				this.context.globalState.update("gmodRemote.pendingConnection", undefined);
			}
		});
	}

	async restoreConnection() {
		let savedConnection = this.context.workspaceState.get<ActiveConnection | undefined>("gmodRemote.activeConnection");

		if (!savedConnection || !savedConnection.server) {
			const pendingConnection = this.context.globalState.get<ActiveConnection | undefined>("gmodRemote.pendingConnection");
			if (pendingConnection && pendingConnection.server) {
				await this.context.workspaceState.update("gmodRemote.activeConnection", pendingConnection);
				await this.context.globalState.update("gmodRemote.pendingConnection", undefined);
				savedConnection = pendingConnection;
			} else {
				return;
			}
		}

		this.connect(savedConnection.server, true);
	}

	disconnect() {
		this.relay.disconnect();
		this.connected = false;
		this.context.workspaceState.update("gmodRemote.activeConnection", undefined);
	}
}
