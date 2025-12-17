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

export type RelayClientRPCMessage = {
	type: "client_rpc";
	requestId: number;
	action: string;
	payload: string;
}

export type RelayPingMessage = {
	type: "ping";
}

export type RelayPongMessage = {
	type: "pong";
}

export type RelayClientHelloFailureMessage = {
	type: "client_hello_failure";
}

export type RelayClientHelloMessage = {
	type: "client_hello";
	serverAddress: string;
	serverPassword: string;
	clientName?: string;
}

export type RelayServerUpdateMessage = {
	type: "server_update";
	serverName: string;
}

export type RelayServerRPCResponseMessage = {
	type: "server_rpc_response";
	clientId: string;
	requestId: number;
	response: string;
}

export type RelayServerRPCStreamStartMessage = {
	type: "server_rpc_stream_start";
	requestId: number;
}

export type RelayServerRPCStreamChunkMessage = {
	type: "server_rpc_stream_chunk";
	requestId: number;
}

export type RelayServerRPCStreamStopMessage = {
	type: "server_rpc_stream_stop";
	requestId: number;
}

export type RelayRPCResponse = {
	success: boolean;
	error_code?: string;
	requestId: number;
}

export type ListFilesEntry = {
	name: string;
	type: "directory" | "file";
	lastModified: number;
	size?: number;
}

export type RelayRPCResponseListFiles = RelayRPCResponse & Partial<{
	entries: ListFilesEntry[];
}>;

export type RelayRPCResponseRead = RelayRPCResponse;
export type RelayRPCResponseWrite = RelayRPCResponse;
export type RelayRPCResponseDelete = RelayRPCResponse;
export type RelayRPCResponseMkdir = RelayRPCResponse;
export type RelayRPCResponseRename = RelayRPCResponse;
export type RelayRPCResponseCopy = RelayRPCResponse;
export type RelayRPCResponseMove = RelayRPCResponse;

export type RelayRPCResponseExists = RelayRPCResponse & Partial<{
	exists: boolean;
}>;

export type RelayRPCResponseStat = RelayRPCResponse & Partial<{
	type: "directory" | "file";
	size?: number;
	created: number;
	modified: number;
}>;

export type RelayRPCResponseTruncate = RelayRPCResponse & Partial<{
	size: number;
}>;

export type RelayRPCResponseSearch = RelayRPCResponse & Partial<{
	results: {
		file: string;
		line: number;
		lineText: string;
		matchStart: number;
		matchEnd: number;
	}[];
}>;

export type RelayRPCRequestStat = {
	path: string;
}

export type RelayRPCRequestReadDirectory = {
	path: string;
}

export type RelayRPCRequestReadFile = {
	path: string;
}

export type RelayRPCRequestWriteFile = {
	path: string;
	offset: number;
	data: string;
}

export type RelayRPCRequestCopy = {
	from: string;
	to: string;
}

export type RelayRPCCreateDirectory = {
	path: string;
}

export type RelayRPCRequestDelete = {
	path: string;
}

export type RelayRPCRequestRename = {
	from: string;
	to: string;
}

export type RelayRPCRequestTruncate = {
	path: string;
	size: number;
}

export type RelayRPCRequestSearch = {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
	includeFiles: string;
	excludeFiles: string;
}

export type RelayRPCRequest = RelayRPCRequestStat | RelayRPCRequestReadDirectory | RelayRPCRequestReadFile | RelayRPCRequestWriteFile | RelayRPCRequestCopy | RelayRPCCreateDirectory | RelayRPCRequestDelete | RelayRPCRequestRename | RelayRPCRequestTruncate | RelayRPCRequestSearch;

export type RelayRPCResponses = RelayRPCResponseListFiles | RelayRPCResponseRead | RelayRPCResponseWrite | RelayRPCResponseDelete | RelayRPCResponseMkdir | RelayRPCResponseRename | RelayRPCResponseCopy | RelayRPCResponseMove | RelayRPCResponseExists | RelayRPCResponseStat | RelayRPCResponseTruncate | RelayRPCResponseSearch;

export type RelayMessage = RelayPingMessage | RelayPongMessage | RelayClientRPCMessage | RelayClientHelloMessage | RelayClientHelloFailureMessage | RelayServerUpdateMessage | RelayServerRPCResponseMessage | RelayServerRPCStreamStartMessage | RelayServerRPCStreamChunkMessage | RelayServerRPCStreamStopMessage;

declare global {
	var gmodRemoteFileSystemProvider: RemoteFileSystemProvider;
	var gmodRemoteRelay: RelayClient;
	var gmodSearchProvider: SearchProvider;
}