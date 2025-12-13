import { RelayClient } from "./modules/relay";
import { RemoteFileSystemProvider } from "./providers/fileSystemProvider";
import { SearchProvider } from "./providers/searchProvider";

export type Server = {
	name: string;
	address: string;
	relay: string;
	password: string;
	encryptionKey: string;
}

export type SearchOptions = {
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
	includeFiles: string;
	excludeFiles: string;
}

export type SearchChunk = {
	file: string;
	line: number;
	lineText: string;
	matchStart: number;
	matchEnd: number;
}

export type FileResult = {
	file: string;
	chunks: Array<{
		line: number;
		lineText: string;
		matchStart: number;
		matchEnd: number;
	}>;
}

export type ActiveConnection = {
	server: Server;
}

declare global {
	var gmodRemoteFileSystemProvider: RemoteFileSystemProvider;
	var gmodRemoteRelay: RelayClient;
	var gmodSearchProvider: SearchProvider;
}