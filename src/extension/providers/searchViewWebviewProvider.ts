import * as vscode from "vscode";
import { SearchChunk, SearchOptions, FileResult } from "../types";
import { useSearchProvider } from "./searchProvider";
import { useRelay } from "./relayProvider";
import { RelayClient } from "../modules/relay";

export class SearchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = "gmod-remote.search";
	private _view?: vscode.WebviewView;
	private searchProvider: ReturnType<typeof useSearchProvider>;
	private relay: RelayClient;
	private searchOptions: SearchOptions = {
		caseSensitive: false,
		wholeWord: false,
		useRegex: false,
		includeFiles: "",
		excludeFiles: ""
	};
	private currentQuery: string = "";
	private results: Map<string, SearchChunk[]> = new Map();
	private fileOrder: string[] = [];
	private isSearching: boolean = false;
	private resultCount: number = 0;
	private updateTimeout?: NodeJS.Timeout;
	private searchEndTimeout?: NodeJS.Timeout;
	private disposed: boolean = false;
	private lastSearchRequestId?: number;

	constructor(
		private readonly _context: vscode.ExtensionContext
	) {
		this.relay = useRelay();
		this.searchProvider = useSearchProvider(this.relay);
		this.setupSearchProvider();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._context.extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async data => {
			switch (data.type) {
				case "search":
					this.currentQuery = data.query || "";
					if (this.currentQuery) {
						await this.triggerSearch();
					} else {
						if (this.lastSearchRequestId !== undefined) {
							this.relay.stopStream(this.lastSearchRequestId);
							this.lastSearchRequestId = undefined;
						}
						if (this.updateTimeout) {
							clearTimeout(this.updateTimeout);
							this.updateTimeout = undefined;
						}
						if (this.searchEndTimeout) {
							clearTimeout(this.searchEndTimeout);
							this.searchEndTimeout = undefined;
						}
						this.isSearching = false;
						this.results.clear();
						this.fileOrder = [];
						this.resultCount = 0;
						this.updateResults();
						this.updateStatus();
					}
					break;
				case "toggleCaseSensitive":
					this.searchOptions.caseSensitive = !this.searchOptions.caseSensitive;
					this.updateOptions();
					await this.triggerSearchIfNeeded();
					break;
				case "toggleWholeWord":
					this.searchOptions.wholeWord = !this.searchOptions.wholeWord;
					this.updateOptions();
					await this.triggerSearchIfNeeded();
					break;
				case "toggleRegex":
					this.searchOptions.useRegex = !this.searchOptions.useRegex;
					this.updateOptions();
					await this.triggerSearchIfNeeded();
					break;
				case "updateIncludeFiles":
					this.searchOptions.includeFiles = data.value || "";
					this.updateOptions();
					await this.triggerSearchIfNeeded();
					break;
				case "updateExcludeFiles":
					this.searchOptions.excludeFiles = data.value || "";
					this.updateOptions();
					await this.triggerSearchIfNeeded();
					break;
				case "openFile":
					try {
						const chunk: SearchChunk = data.chunk;
						const uri = vscode.Uri.parse(`gmod:${chunk.file}`);
						const document = await vscode.workspace.openTextDocument(uri);
						const existingEditor = vscode.window.visibleTextEditors.find(
							editor => editor.document.uri.toString() === uri.toString()
						);

						const editor = existingEditor || await vscode.window.showTextDocument(document, {
							preserveFocus: false
						});

						const lineNumber = chunk.line;

						const maxLine = Math.max(0, document.lineCount - 1);
						const actualLine = Math.min(Math.max(0, lineNumber), maxLine);

						const line = document.lineAt(actualLine);
						const matchStart = Math.min(chunk.matchStart, line.text.length);
						const matchEnd = Math.min(chunk.matchEnd, line.text.length);

						const range = new vscode.Range(
							new vscode.Position(actualLine, matchStart),
							new vscode.Position(actualLine, matchEnd)
						);
						editor.selection = new vscode.Selection(range.start, range.end);
						editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
					} catch (error) {
						vscode.window.showErrorMessage(`Failed to open file: ${error}`);
					}
					break;
				case "openFileHeader":
					try {
						const filePath: string = data.file;
						const uri = vscode.Uri.parse(`gmod:${filePath}`);
						const existingEditor = vscode.window.visibleTextEditors.find(
							editor => editor.document.uri.toString() === uri.toString()
						);
						if (!existingEditor) {
							const document = await vscode.workspace.openTextDocument(uri);

							await vscode.window.showTextDocument(document, {
								preserveFocus: false
							});
						} else {
							await vscode.window.showTextDocument(existingEditor.document, {
								preserveFocus: false
							});
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						vscode.window.showErrorMessage(`Failed to open file: ${errorMessage}`);
					}
					break;
				case "removeResult":
					this.removeResult(data.file, data.line, data.matchStart, data.matchEnd);
					break;
				case "replace":
					try {
						await this.replaceMatch(data.chunk, data.replaceText);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						vscode.window.showErrorMessage(`Replace failed: ${errorMessage}`);
					}
					break;
				case "replaceAll":
					try {
						await this.replaceAll(data.replaceText);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						vscode.window.showErrorMessage(`Replace all failed: ${errorMessage}`);
					}
					break;
				case "replaceFile":
					try {
						await this.replaceFile(data.file, data.replaceText);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						vscode.window.showErrorMessage(`Replace file failed: ${errorMessage}`);
					}
					break;
			}
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				setTimeout(() => {
					webviewView.webview.postMessage({ type: "focus" });
				}, 100);
			}
		});
	}

	public focusSearchInput() {
		if (this._view && !this.disposed) {
			if (!this._view.visible) {
				this._view.show?.(true);
			}
			setTimeout(() => {
				if (!this.disposed && this._view) {
					this._view.webview.postMessage({ type: "focus" });
				}
			}, 100);
		}
	}

	private async triggerSearch() {
		if (this.disposed || !this.currentQuery) {
			return;
		}

		if (this.lastSearchRequestId !== undefined) {
			this.relay.stopStream(this.lastSearchRequestId);
		}

		try {
			this.lastSearchRequestId = await this.searchProvider.search(this.currentQuery, this.searchOptions);
		} catch (error) {
			if (!this.disposed) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Search failed: ${errorMessage}`);
			}
		}
	}

	private async triggerSearchIfNeeded() {
		if (this.currentQuery) {
			await this.triggerSearch();
		}
	}

	private setupSearchProvider() {
		this.searchProvider.start(() => {
			if (this.disposed) {
				return;
			}

			if (this.searchEndTimeout) {
				clearTimeout(this.searchEndTimeout);
				this.searchEndTimeout = undefined;
			}

			this.results.clear();
			this.fileOrder = [];
			this.resultCount = 0;
			this.isSearching = true;
			this.updateResults();
			this.updateStatus();
		});

		this.searchProvider.resultStream((chunks: SearchChunk[]) => {
			if (this.disposed || !this.currentQuery) {
				return;
			}

			if (this.searchEndTimeout) {
				clearTimeout(this.searchEndTimeout);
			}
			this.searchEndTimeout = setTimeout(() => {
				if (!this.disposed && this.isSearching && this.currentQuery) {
					this.isSearching = false;
					this.updateResults();
					this.updateStatus();
				}
			}, 2000);

			for (const chunk of chunks) {
				if (!this.results.has(chunk.file)) {
					this.results.set(chunk.file, []);
					this.fileOrder.push(chunk.file);
				}
				this.results.get(chunk.file)!.push(chunk);
				this.resultCount++;
			}

			if (this.updateTimeout) {
				clearTimeout(this.updateTimeout);
			}

			this.updateTimeout = setTimeout(() => {
				if (!this.disposed && this.currentQuery) {
					this.updateResults();
					this.updateStatus();
				}
			}, 100);
		});

		this.searchProvider.end(() => {
			if (this.disposed) {
				return;
			}

			if (this.updateTimeout) {
				clearTimeout(this.updateTimeout);
				this.updateTimeout = undefined;
			}
			if (this.searchEndTimeout) {
				clearTimeout(this.searchEndTimeout);
				this.searchEndTimeout = undefined;
			}

			this.isSearching = false;
			this.updateResults();
			this.updateStatus();
		});
	}

	private updateOptions() {
		if (this._view && !this.disposed) {
			this._view.webview.postMessage({
				type: "updateOptions",
				options: this.searchOptions
			});
		}
	}

	private updateResults() {
		if (this._view && !this.disposed) {
			const results: FileResult[] = [];
			for (const file of this.fileOrder) {
				const chunks = this.results.get(file) || [];
				results.push({
					file,
					chunks: chunks.map(chunk => ({
						line: chunk.line,
						lineText: chunk.lineText,
						matchStart: chunk.matchStart,
						matchEnd: chunk.matchEnd
					}))
				});
			}

			this._view.webview.postMessage({
				type: "updateResults",
				results,
				isSearching: this.isSearching,
				resultCount: this.resultCount,
				fileCount: this.results.size
			});
			this._view.webview.postMessage({
				type: "updateStatus",
				isSearching: this.isSearching,
				resultCount: this.resultCount,
				fileCount: this.results.size
			});
		}
	}

	private updateStatus() {
		if (this._view && !this.disposed) {
			this._view.webview.postMessage({
				type: "updateStatus",
				isSearching: this.isSearching,
				resultCount: this.resultCount,
				fileCount: this.results.size
			});
		}
	}

	private removeResult(file: string, line: number, matchStart: number, matchEnd: number, updateUI: boolean = true) {
		const chunks = this.results.get(file);

		if (!chunks) {
			return;
		}

		const index = chunks.findIndex(chunk =>
			chunk.line === line &&
			chunk.matchStart === matchStart &&
			chunk.matchEnd === matchEnd
		);

		if (index !== -1) {
			chunks.splice(index, 1);
			this.resultCount--;

			if (chunks.length === 0) {
				this.results.delete(file);
				const fileIndex = this.fileOrder.indexOf(file);
				if (fileIndex !== -1) {
					this.fileOrder.splice(fileIndex, 1);
				}
			}

			if (updateUI) {
				this.updateResults();
				this.updateStatus();
			}
		}
	}

	private async replaceMatch(chunk: SearchChunk, replaceText: string) {
		const uri = vscode.Uri.parse(`gmod:${chunk.file}`);
		const document = await vscode.workspace.openTextDocument(uri);
		const existingEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === uri.toString()
		);
		const editor = existingEditor || await vscode.window.showTextDocument(document);

		const lineNumber = chunk.line;
		const maxLine = Math.max(0, document.lineCount - 1);
		const actualLine = Math.min(Math.max(0, lineNumber), maxLine);

		const line = document.lineAt(actualLine);
		const matchStart = Math.min(chunk.matchStart, line.text.length);
		const matchEnd = Math.min(chunk.matchEnd, line.text.length);

		const range = new vscode.Range(
			new vscode.Position(actualLine, matchStart),
			new vscode.Position(actualLine, matchEnd)
		);

		const success = await editor.edit(editBuilder => {
			editBuilder.replace(range, replaceText);
		});

		if (success) {
			await document.save();

			this.removeResult(chunk.file, chunk.line, chunk.matchStart, chunk.matchEnd);
		}
	}

	private async replaceAll(replaceText: string) {
		const chunksToReplace: SearchChunk[] = [];
		for (const file of this.fileOrder) {
			const chunks = this.results.get(file) || [];
			chunksToReplace.push(...chunks);
		}

		if (chunksToReplace.length === 0) {
			return;
		}

		const fileGroups = new Map<string, SearchChunk[]>();
		for (const chunk of chunksToReplace) {
			if (!fileGroups.has(chunk.file)) {
				fileGroups.set(chunk.file, []);
			}
			fileGroups.get(chunk.file)!.push(chunk);
		}

		let totalReplaced = 0;
		const chunksToRemove: SearchChunk[] = [];

		for (const [file, chunks] of fileGroups.entries()) {
			const uri = vscode.Uri.parse(`gmod:${file}`);
			const document = await vscode.workspace.openTextDocument(uri);
			const existingEditor = vscode.window.visibleTextEditors.find(
				editor => editor.document.uri.toString() === uri.toString()
			);
			const editor = existingEditor || await vscode.window.showTextDocument(document);

			chunks.sort((a, b) => {
				if (a.line !== b.line) {
					return b.line - a.line;
				}
			
				return b.matchStart - a.matchStart;
			});

			let fileReplacedCount = 0;
			const success = await editor.edit(editBuilder => {
				for (const chunk of chunks) {
					const lineNumber = chunk.line;
					const maxLine = Math.max(0, document.lineCount - 1);
					const actualLine = Math.min(Math.max(0, lineNumber), maxLine);

					try {
						const line = document.lineAt(actualLine);
						const matchStart = Math.min(chunk.matchStart, line.text.length);
						const matchEnd = Math.min(chunk.matchEnd, line.text.length);

						const range = new vscode.Range(
							new vscode.Position(actualLine, matchStart),
							new vscode.Position(actualLine, matchEnd)
						);

						editBuilder.replace(range, replaceText);
						fileReplacedCount++;
					} catch (error) {
					}
				}
			});

			if (success && fileReplacedCount > 0) {
				await document.save();

				chunksToRemove.push(...chunks);
				totalReplaced += fileReplacedCount;
			}
		}

		if (chunksToRemove.length > 0) {
			for (const chunk of chunksToRemove) {
				this.removeResult(chunk.file, chunk.line, chunk.matchStart, chunk.matchEnd, false);
			}
			this.updateResults();
			this.updateStatus();
		}

		if (totalReplaced > 0) {
			vscode.window.showInformationMessage(`Replaced ${totalReplaced} occurrence(s)`);
		}
	}

	private async replaceFile(file: string, replaceText: string) {
		const chunks = this.results.get(file);
		if (!chunks || chunks.length === 0) {
			return;
		}

		const uri = vscode.Uri.parse(`gmod:${file}`);
		const document = await vscode.workspace.openTextDocument(uri);
		const existingEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === uri.toString()
		);
		const editor = existingEditor || await vscode.window.showTextDocument(document);

		const sortedChunks = [...chunks].sort((a, b) => {
			if (a.line !== b.line) {
				return b.line - a.line;
			}

			return b.matchStart - a.matchStart;
		});

		let replacedCount = 0;
		const success = await editor.edit(editBuilder => {
			for (const chunk of sortedChunks) {
				const lineNumber = chunk.line;
				const maxLine = Math.max(0, document.lineCount - 1);
				const actualLine = Math.min(Math.max(0, lineNumber), maxLine);

				try {
					const line = document.lineAt(actualLine);
					const matchStart = Math.min(chunk.matchStart, line.text.length);
					const matchEnd = Math.min(chunk.matchEnd, line.text.length);

					const range = new vscode.Range(
						new vscode.Position(actualLine, matchStart),
						new vscode.Position(actualLine, matchEnd)
					);

					editBuilder.replace(range, replaceText);
					replacedCount++;
				} catch (error) {
				}
			}
		});

		if (success && replacedCount > 0) {
			await document.save();

			for (const chunk of chunks) {
				this.removeResult(chunk.file, chunk.line, chunk.matchStart, chunk.matchEnd, false);
			}
			this.updateResults();
			this.updateStatus();

			vscode.window.showInformationMessage(`Replaced ${replacedCount} occurrence(s) in ${file.split(/[/\\]/).pop()}`);
		}
	}

	public dispose() {
		this.disposed = true;
		if (this.updateTimeout) {
			clearTimeout(this.updateTimeout);
			this.updateTimeout = undefined;
		}
		if (this.searchEndTimeout) {
			clearTimeout(this.searchEndTimeout);
			this.searchEndTimeout = undefined;
		}
		this.results.clear();
		this.fileOrder = [];
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Search in Files</title>
	<style>
		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			padding: 10px;
			height: 100vh;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}

		.search-container {
			margin-bottom: 10px;
		}

		.search-input-container {
			display: flex;
			gap: 8px;
			align-items: center;
			margin-bottom: 8px;
		}

		.replace-container {
			margin-bottom: 8px;
		}

		.replace-toggle {
			display: flex;
			align-items: center;
			gap: 4px;
			cursor: pointer;
			user-select: none;
			padding: 2px 4px;
			border-radius: 2px;
			margin-bottom: 4px;
		}

		.replace-toggle:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.replace-toggle-icon {
			width: 16px;
			height: 16px;
			transition: transform 0.1s;
			color: var(--vscode-foreground);
		}

		.replace-toggle-icon.collapsed {
			transform: rotate(-90deg);
		}

		.replace-toggle-label {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
		}

		.replace-input-container {
			display: none;
			flex-direction: column;
			gap: 4px;
		}

		.replace-input-container.expanded {
			display: flex;
		}

		.replace-input-wrapper {
			display: flex;
			gap: 8px;
			align-items: center;
		}

		.search-input {
			flex: 1;
			padding: 4px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			border-radius: 2px;
		}

		.search-input:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}

		.search-options {
			display: flex;
			gap: 6px;
			align-items: center;
		}

		.replace-input {
			flex: 1;
			padding: 4px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			border-radius: 2px;
		}

		.replace-input:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}

		.replace-buttons {
			display: flex;
			gap: 4px;
		}

		.replace-button {
			padding: 4px 12px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			cursor: pointer;
			border-radius: 2px;
			font-size: 11px;
			height: 22px;
			white-space: nowrap;
		}

		.replace-button:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.replace-button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.files-input-container {
			display: flex;
			gap: 8px;
			margin-bottom: 8px;
		}

		.files-input-group {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 4px;
		}

		.files-input-label {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 2px;
		}

		.files-input {
			width: 100%;
			padding: 4px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			border-radius: 2px;
		}

		.files-input:focus {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: -1px;
		}

		.option-button {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 2px 8px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			cursor: pointer;
			border-radius: 2px;
			font-size: 11px;
			height: 22px;
		}

		.option-button:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.option-button.active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}

		.results-summary {
			padding: 8px;
			font-size: 12px;
			font-weight: 600;
			color: var(--vscode-foreground);
			border-top: 1px solid var(--vscode-panel-border);
			border-bottom: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editor-background);
		}

		.results-container {
			flex: 1;
			overflow-y: auto;
			padding-top: 8px;
		}

		.status {
			padding: 4px 8px;
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			border-top: 1px solid var(--vscode-panel-border);
			margin-top: 8px;
			padding-top: 8px;
		}

		.file-result {
			margin-bottom: 2px;
		}

		.file-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 2px 4px;
			cursor: pointer;
			user-select: none;
			min-height: 22px;
		}

		.file-header:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.chevron-icon {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
			transition: transform 0.1s;
			color: var(--vscode-foreground);
		}

		.chevron-icon.collapsed {
			transform: rotate(-90deg);
		}

		.file-icon {
			width: 16px;
			height: 16px;
			flex-shrink: 0;
		}

		.file-name-container {
			flex: 1;
			display: flex;
			align-items: center;
			gap: 6px;
			min-width: 0;
			overflow: hidden;
		}

		.file-name {
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			flex-shrink: 0;
		}

		.file-path {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			flex: 1;
			min-width: 0;
		}

		.file-count {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			margin-left: auto;
			flex-shrink: 0;
			padding-left: 8px;
		}

		.file-replace-button {
			margin-left: auto;
			padding: 2px 8px;
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			cursor: pointer;
			border-radius: 2px;
			font-size: 11px;
			height: 20px;
			margin-right: 8px;
			pointer-events: auto;
		}

		.file-replace-button:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.file-results {
			display: none;
			margin-left: 0;
		}

		.file-results.expanded {
			display: block;
		}

		.line-result {
			padding: 2px 8px 2px 24px;
			cursor: pointer;
			display: flex;
			gap: 8px;
			align-items: center;
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			min-height: 20px;
			pointer-events: auto;
			position: relative;
		}

		.line-result:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.line-result.selected {
			background: var(--vscode-list-activeSelectionBackground);
		}

		.line-result:hover .remove-btn {
			opacity: 1;
		}

		.line-result * {
			pointer-events: none;
		}

		.remove-btn {
			opacity: 0;
			cursor: pointer;
			pointer-events: auto;
			padding: 2px 4px;
			flex-shrink: 0;
			color: var(--vscode-icon-foreground);
			transition: opacity 0.1s;
			display: flex;
			align-items: center;
			justify-content: center;
			width: 16px;
			height: 16px;
		}

		.remove-btn:hover {
			background: var(--vscode-button-hoverBackground);
			border-radius: 2px;
		}

		.line-actions {
			display: flex;
			align-items: center;
			gap: 4px;
			margin-left: auto;
			flex-shrink: 0;
		}

		.replace-line-btn {
			opacity: 0;
			cursor: pointer;
			pointer-events: auto;
			padding: 2px 6px;
			flex-shrink: 0;
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 2px;
			font-size: 11px;
			transition: opacity 0.1s;
			white-space: nowrap;
		}

		.line-result:hover .replace-line-btn {
			opacity: 1;
		}

		.replace-line-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.line-number {
			color: var(--vscode-descriptionForeground);
			text-align: right;
			min-width: 50px;
			font-variant-numeric: tabular-nums;
			flex-shrink: 0;
		}

		.line-text {
			flex: 1;
			white-space: pre;
			overflow: hidden;
			text-overflow: ellipsis;
			min-width: 0;
		}

		.line-text.with-preview {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}

		.line-text-original {
			white-space: pre;
		}

		.line-text-preview {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			opacity: 0.8;
			white-space: pre;
		}

		.match {
			background: var(--vscode-editor-findMatchHighlightBackground);
			color: var(--vscode-editor-foreground);
			padding: 0 2px;
		}

		.replacement {
			background: var(--vscode-diffEditor-insertedTextBackground);
			color: var(--vscode-diffEditor-insertedTextForeground);
			padding: 0 2px;
		}

		.empty-state {
			padding: 20px;
			text-align: center;
			color: var(--vscode-descriptionForeground);
			font-size: 12px;
		}

		.loading {
			display: inline-block;
			width: 12px;
			height: 12px;
			border: 2px solid var(--vscode-descriptionForeground);
			border-top-color: transparent;
			border-radius: 50%;
			animation: spin 1s linear infinite;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
		}
	</style>
</head>
<body>
	<div class="search-container">
		<div class="search-input-container">
			<input type="text" class="search-input" id="searchInput" placeholder="Search" autocomplete="off" />
			<div class="search-options">
				<button class="option-button" id="caseSensitiveBtn" title="Match Case (Alt+C)">
					<span>Aa</span>
				</button>
				<button class="option-button" id="wholeWordBtn" title="Match Whole Word (Alt+W)">
					<span>Ab</span>
				</button>
				<button class="option-button" id="regexBtn" title="Use Regular Expression (Alt+R)">
					<span>.*</span>
				</button>
			</div>
		</div>
		<div class="replace-container">
			<div class="replace-toggle" id="replaceToggle">
				<span class="replace-toggle-icon" id="replaceToggleIcon">▼</span>
				<span class="replace-toggle-label">Replace</span>
			</div>
			<div class="replace-input-container" id="replaceInputContainer">
				<div class="replace-input-wrapper">
					<input type="text" class="replace-input" id="replaceInput" placeholder="Replace" autocomplete="off" />
					<div class="replace-buttons">
						<button class="replace-button" id="replaceAllBtn" title="Replace All">Replace All</button>
					</div>
				</div>
			</div>
		</div>
		<div class="files-input-container">
			<div class="files-input-group">
				<label class="files-input-label">Include files</label>
				<input type="text" class="files-input" id="includeFilesInput" placeholder="e.g. *.ts, *.js" autocomplete="off" />
			</div>
			<div class="files-input-group">
				<label class="files-input-label">Exclude files</label>
				<input type="text" class="files-input" id="excludeFilesInput" placeholder="e.g. node_modules, dist" autocomplete="off" />
			</div>
		</div>
	</div>
	<div class="results-summary" id="resultsSummary" style="display: none;"></div>
	<div class="results-container" id="resultsContainer">
		<div class="empty-state">No search results. Enter a search query above.</div>
	</div>
	<div class="status" id="status"></div>

	<script>
		const vscode = acquireVsCodeApi();
		const searchInput = document.getElementById('searchInput');
		const caseSensitiveBtn = document.getElementById('caseSensitiveBtn');
		const wholeWordBtn = document.getElementById('wholeWordBtn');
		const regexBtn = document.getElementById('regexBtn');
		const replaceToggle = document.getElementById('replaceToggle');
		const replaceToggleIcon = document.getElementById('replaceToggleIcon');
		const replaceInputContainer = document.getElementById('replaceInputContainer');
		const replaceInput = document.getElementById('replaceInput');
		const replaceAllBtn = document.getElementById('replaceAllBtn');
		const includeFilesInput = document.getElementById('includeFilesInput');
		const excludeFilesInput = document.getElementById('excludeFilesInput');
		const resultsContainer = document.getElementById('resultsContainer');
		const resultsSummary = document.getElementById('resultsSummary');
		const statusEl = document.getElementById('status');

		let replaceExpanded = false;
		let renderTimeout = null;

		let searchOptions = {
			caseSensitive: false,
			wholeWord: false,
			useRegex: false,
			includeFiles: '',
			excludeFiles: ''
		};

		let searchTimeout;
		searchInput.addEventListener('input', (e) => {
			currentSearchQuery = e.target.value;
			clearTimeout(searchTimeout);
			searchTimeout = setTimeout(() => {
				vscode.postMessage({
					type: 'search',
					query: e.target.value
				});
			}, 300);
		});

		searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				clearTimeout(searchTimeout);
				vscode.postMessage({
					type: 'search',
					query: e.target.value
				});
			}
		});

		caseSensitiveBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'toggleCaseSensitive' });
		});

		wholeWordBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'toggleWholeWord' });
		});

		regexBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'toggleRegex' });
		});

		let includeTimeout;
		includeFilesInput.addEventListener('input', (e) => {
			clearTimeout(includeTimeout);
			includeTimeout = setTimeout(() => {
				vscode.postMessage({
					type: 'updateIncludeFiles',
					value: e.target.value
				});
			}, 300);
		});

		let excludeTimeout;
		excludeFilesInput.addEventListener('input', (e) => {
			clearTimeout(excludeTimeout);
			excludeTimeout = setTimeout(() => {
				vscode.postMessage({
					type: 'updateExcludeFiles',
					value: e.target.value
				});
			}, 300);
		});

		replaceToggle.addEventListener('click', () => {
			replaceExpanded = !replaceExpanded;
			replaceInputContainer.classList.toggle('expanded', replaceExpanded);
			replaceToggleIcon.classList.toggle('collapsed', !replaceExpanded);
			if (replaceExpanded) {
				replaceInput.focus();
				renderResults(); 			} else {
				renderResults(); 			}
		});


		replaceAllBtn.addEventListener('click', () => {
			vscode.postMessage({
				type: 'replaceAll',
				replaceText: replaceInput.value
			});
		});

		replaceInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && e.ctrlKey && e.shiftKey) {
				replaceAllBtn.click();
			}
		});

		function updateOptions(options) {
			searchOptions = options;
			caseSensitiveBtn.classList.toggle('active', options.caseSensitive);
			wholeWordBtn.classList.toggle('active', options.wholeWord);
			regexBtn.classList.toggle('active', options.useRegex);
			if (options.includeFiles !== undefined) {
				includeFilesInput.value = options.includeFiles || '';
			}
			if (options.excludeFiles !== undefined) {
				excludeFilesInput.value = options.excludeFiles || '';
			}
		}

		function highlightMatch(text, matchStart, matchEnd, replaceText, useRegex) {
			const before = text.substring(0, matchStart);
			const match = text.substring(matchStart, matchEnd);
			const after = text.substring(matchEnd);
			const originalHtml = \`\${escapeHtml(before)}<span class="match">\${escapeHtml(match)}</span>\${escapeHtml(after)}\`;
			
			if (!replaceText || !replaceExpanded) {
				return originalHtml;
			}

			let previewText;
			if (useRegex && currentSearchQuery) {
				try {
					const flags = searchOptions.caseSensitive ? 'g' : 'gi';
					const regex = new RegExp(currentSearchQuery, flags);
					previewText = match.replace(regex, replaceText);
				} catch (e) {
										previewText = replaceText;
				}
			} else {
				previewText = replaceText;
			}

			const previewHtml = \`\${escapeHtml(before)}<span class="replacement">\${escapeHtml(previewText)}</span>\${escapeHtml(after)}\`;
			
			return {
				original: originalHtml,
				preview: previewHtml
			};
		}

		function escapeHtml(text) {
			const div = document.createElement('div');
			div.textContent = text;
			return div.innerHTML;
		}

		let expandedFiles = new Set();
		let allResults = [];
		let selectedChunk = null;
		let selectedElement = null;
		let currentSearchQuery = '';
		let fileElements = new Map(); 
		function toggleFile(filePath) {
			if (expandedFiles.has(filePath)) {
				expandedFiles.delete(filePath);
			} else {
				expandedFiles.add(filePath);
			}
			const fileEl = fileElements.get(filePath);
			if (fileEl) {
				const resultsDiv = fileEl.querySelector('.file-results');
				const chevron = fileEl.querySelector('.chevron-icon');
				if (resultsDiv) {
					resultsDiv.classList.toggle('expanded', expandedFiles.has(filePath));
				}
				if (chevron) {
					chevron.classList.toggle('collapsed', !expandedFiles.has(filePath));
				}
								if (expandedFiles.has(filePath) && resultsDiv && !resultsDiv.hasChildNodes()) {
					renderFileLines(filePath, fileEl.querySelector('.file-results'));
				}
			}
		}

		function renderFileLines(filePath, resultsDiv) {
			const fileResult = allResults.find(r => r.file === filePath);
			if (!fileResult || !resultsDiv) return;

						const chunks = fileResult.chunks;
			const CHUNK_SIZE = 50; 			let index = 0;

			function renderChunk() {
				const endIndex = Math.min(index + CHUNK_SIZE, chunks.length);
				const fragment = document.createDocumentFragment();

				for (let i = index; i < endIndex; i++) {
					const chunk = chunks[i];
					const lineDiv = document.createElement('div');
					lineDiv.className = 'line-result';
					lineDiv.dataset.file = fileResult.file;
					lineDiv.dataset.line = chunk.line;
					lineDiv.dataset.matchStart = chunk.matchStart;
					lineDiv.dataset.matchEnd = chunk.matchEnd;
					lineDiv.dataset.lineText = chunk.lineText;

					const lineNumSpan = document.createElement('span');
					lineNumSpan.className = 'line-number';
					lineNumSpan.textContent = chunk.line.toString().padStart(4, ' ');

					const lineTextSpan = document.createElement('div');
					
					const highlighted = highlightMatch(chunk.lineText, chunk.matchStart, chunk.matchEnd, replaceInput.value, searchOptions.useRegex);
					
					if (typeof highlighted === 'object' && highlighted.original && highlighted.preview) {
						lineTextSpan.className = 'line-text with-preview';
						const originalSpan = document.createElement('div');
						originalSpan.className = 'line-text-original';
						originalSpan.innerHTML = highlighted.original;
						
						const previewSpan = document.createElement('div');
						previewSpan.className = 'line-text-preview';
						previewSpan.innerHTML = highlighted.preview;
						
						lineTextSpan.appendChild(originalSpan);
						lineTextSpan.appendChild(previewSpan);
					} else {
						lineTextSpan.className = 'line-text';
						lineTextSpan.innerHTML = typeof highlighted === 'string' ? highlighted : (highlighted?.original || '');
					}

					const actionsDiv = document.createElement('div');
					actionsDiv.className = 'line-actions';

					const removeBtn = document.createElement('span');
					removeBtn.className = 'remove-btn';
					removeBtn.innerHTML = '×';
					removeBtn.title = 'Remove result';

					const replaceLineBtn = document.createElement('button');
					replaceLineBtn.className = 'replace-line-btn';
					replaceLineBtn.textContent = 'Replace';
					replaceLineBtn.title = 'Replace this result';
					replaceLineBtn.style.display = replaceExpanded && replaceInput.value ? 'block' : 'none';
					replaceLineBtn.disabled = !replaceInput.value;

					actionsDiv.appendChild(replaceLineBtn);
					actionsDiv.appendChild(removeBtn);

					lineDiv.appendChild(lineNumSpan);
					lineDiv.appendChild(lineTextSpan);
					lineDiv.appendChild(actionsDiv);

					fragment.appendChild(lineDiv);
				}

				resultsDiv.appendChild(fragment);
				index = endIndex;

								if (index < chunks.length) {
					requestAnimationFrame(renderChunk);
				}
			}

						renderChunk();
		}

		function renderResults() {
			if (allResults.length === 0) {
				return;
			}

						const fragment = document.createDocumentFragment();

			for (const fileResult of allResults) {
				const isExpanded = expandedFiles.has(fileResult.file);
				const fileName = fileResult.file.split(/[/\\\\]/).pop() || fileResult.file;
				const lastSep = Math.max(fileResult.file.lastIndexOf('/'), fileResult.file.lastIndexOf('\\\\'));
				const fileDir = lastSep >= 0 ? fileResult.file.substring(0, lastSep) : '';
				
								let fileResultDiv = fileElements.get(fileResult.file);
				
				if (!fileResultDiv) {
					fileResultDiv = document.createElement('div');
					fileResultDiv.className = 'file-result';
					fileResultDiv.dataset.file = fileResult.file;

					const header = document.createElement('div');
					header.className = 'file-header';
					
					const chevron = document.createElement('span');
					chevron.className = 'chevron-icon';
					chevron.innerHTML = '▼';
					
					const fileIcon = document.createElement('span');
					fileIcon.className = 'file-icon';
					fileIcon.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16"><path d="M13.5 2H6.5L5 0.5H2.5C1.67 0.5 1 1.17 1 2V14C1 14.83 1.67 15.5 2.5 15.5H13.5C14.33 15.5 15 14.83 15 14V3.5C15 2.67 14.33 2 13.5 2Z"/></svg>';

					const nameContainer = document.createElement('div');
					nameContainer.className = 'file-name-container';
					nameContainer.style.cursor = 'pointer';
					
					const nameSpan = document.createElement('span');
					nameSpan.className = 'file-name';
					nameSpan.textContent = fileName;
					
					const pathSpan = document.createElement('span');
					pathSpan.className = 'file-path';
					pathSpan.textContent = fileDir;
					
					nameContainer.appendChild(nameSpan);
					if (fileDir) {
						nameContainer.appendChild(document.createTextNode(' • '));
						nameContainer.appendChild(pathSpan);
					}

					const countSpan = document.createElement('span');
					countSpan.className = 'file-count';
					countSpan.textContent = \`\${fileResult.chunks.length} \${fileResult.chunks.length === 1 ? 'result' : 'results'}\`;

					const fileReplaceBtn = document.createElement('button');
					fileReplaceBtn.className = 'file-replace-button';
					fileReplaceBtn.textContent = 'Replace';
					fileReplaceBtn.style.display = replaceExpanded && replaceInput.value ? 'block' : 'none';

					header.appendChild(chevron);
					header.appendChild(fileIcon);
					header.appendChild(nameContainer);
					header.appendChild(countSpan);
					header.appendChild(fileReplaceBtn);

					const resultsDiv = document.createElement('div');
					resultsDiv.className = 'file-results';

					fileResultDiv.appendChild(header);
					fileResultDiv.appendChild(resultsDiv);
					
										fileElements.set(fileResult.file, fileResultDiv);
				} else {
										const countSpan = fileResultDiv.querySelector('.file-count');
					if (countSpan) {
						countSpan.textContent = \`\${fileResult.chunks.length} \${fileResult.chunks.length === 1 ? 'result' : 'results'}\`;
					}
				}
				
				const chevron = fileResultDiv.querySelector('.chevron-icon');
				const resultsDiv = fileResultDiv.querySelector('.file-results');
				if (chevron) {
					chevron.classList.toggle('collapsed', !isExpanded);
				}
				if (resultsDiv) {
					resultsDiv.classList.toggle('expanded', isExpanded);
					if (isExpanded && !resultsDiv.hasChildNodes()) {
						renderFileLines(fileResult.file, resultsDiv);
					}
				}

				fragment.appendChild(fileResultDiv);
			}

						const existingFiles = new Set();
			Array.from(resultsContainer.children).forEach(el => {
				if (el.dataset.file) existingFiles.add(el.dataset.file);
			});
			const newFiles = new Set(allResults.map(r => r.file));
			
						for (const file of existingFiles) {
				if (!newFiles.has(file)) {
					const fileEl = resultsContainer.querySelector(\`[data-file="\${file}"]\`);
					if (fileEl) {
						fileEl.remove();
						fileElements.delete(file);
					}
				}
			}
			
						const toAdd = [];
			for (let i = 0; i < fragment.children.length; i++) {
				const child = fragment.children[i];
				if (child.dataset.file && !existingFiles.has(child.dataset.file)) {
					toAdd.push(child);
				}
			}
			
						if (resultsContainer.children.length === 0) {
				resultsContainer.innerHTML = '';
				resultsContainer.appendChild(fragment);
			} else {
								for (const child of toAdd) {
					resultsContainer.appendChild(child);
				}
			}
		}

				resultsContainer.addEventListener('click', (e) => {
			const target = e.target;
			const lineResult = target.closest('.line-result');
			const fileHeader = target.closest('.file-header');
			const removeBtn = target.closest('.remove-btn');
			const replaceBtn = target.closest('.replace-line-btn');
			const nameContainer = target.closest('.file-name-container');
			const fileReplaceBtn = target.closest('.file-replace-button');
			
			if (removeBtn && lineResult) {
				e.stopPropagation();
				const file = lineResult.dataset.file;
				const line = parseInt(lineResult.dataset.line);
				const matchStart = parseInt(lineResult.dataset.matchStart);
				const matchEnd = parseInt(lineResult.dataset.matchEnd);
				vscode.postMessage({
					type: 'removeResult',
					file: file,
					line: line,
					matchStart: matchStart,
					matchEnd: matchEnd
				});
				return;
			}
			
			if (replaceBtn && lineResult) {
				e.stopPropagation();
				const file = lineResult.dataset.file;
				const line = parseInt(lineResult.dataset.line);
				const matchStart = parseInt(lineResult.dataset.matchStart);
				const matchEnd = parseInt(lineResult.dataset.matchEnd);
				vscode.postMessage({
					type: 'replace',
					chunk: {
						file: file,
						line: line,
						lineText: lineResult.dataset.lineText,
						matchStart: matchStart,
						matchEnd: matchEnd
					},
					replaceText: replaceInput.value
				});
				return;
			}
			
			if (nameContainer && fileHeader) {
				e.stopPropagation();
				const fileEl = fileHeader.closest('.file-result');
				if (fileEl) {
					vscode.postMessage({
						type: 'openFileHeader',
						file: fileEl.dataset.file
					});
				}
				return;
			}
			
			if (fileReplaceBtn && fileHeader) {
				e.stopPropagation();
				const fileEl = fileHeader.closest('.file-result');
				if (fileEl) {
					vscode.postMessage({
						type: 'replaceFile',
						file: fileEl.dataset.file,
						replaceText: replaceInput.value
					});
				}
				return;
			}
			
			if (fileHeader) {
								const fileEl = fileHeader.closest('.file-result');
				if (fileEl && !nameContainer && !fileReplaceBtn) {
					toggleFile(fileEl.dataset.file);
				}
				return;
			}
			
			if (lineResult && !removeBtn && !replaceBtn) {
								const file = lineResult.dataset.file;
				const line = parseInt(lineResult.dataset.line);
				const matchStart = parseInt(lineResult.dataset.matchStart);
				const matchEnd = parseInt(lineResult.dataset.matchEnd);
				
				selectedChunk = {
					file: file,
					line: line,
					matchStart: matchStart,
					matchEnd: matchEnd,
					lineText: lineResult.dataset.lineText
				};
				
				if (selectedElement) {
					selectedElement.classList.remove('selected');
				}
				selectedElement = lineResult;
				lineResult.classList.add('selected');
				
				vscode.postMessage({
					type: 'openFile',
					chunk: selectedChunk
				});
			}
		});

		function updateResults(results, isSearching, resultCount) {
									if (isSearching && results.length === 0 && resultCount === 0) {
				resultsContainer.innerHTML = '<div class="empty-state"><span class="loading"></span> Searching...</div>';
				allResults = [];
				fileElements.clear();
				return;
			}

			if (!isSearching && results.length === 0) {
				resultsContainer.innerHTML = '<div class="empty-state">No results found</div>';
				allResults = [];
				expandedFiles.clear();
				fileElements.clear();
				return;
			}

						if (results.length > 0) {
				const hasEmptyState = resultsContainer.querySelector('.empty-state');
				if (hasEmptyState) {
					resultsContainer.innerHTML = '';
				}
			}

						const wasEmpty = allResults.length === 0;
			const oldFiles = new Set(allResults.map(r => r.file));
			allResults = results;
			
						if (wasEmpty) {
				expandedFiles.clear();
				for (const fileResult of results) {
					expandedFiles.add(fileResult.file);
				}
			} else {
								const newExpanded = new Set();
				for (const fileResult of results) {
					if (expandedFiles.has(fileResult.file) && oldFiles.has(fileResult.file)) {
						newExpanded.add(fileResult.file);
					}
				}
				expandedFiles = newExpanded;
			}

						if (renderTimeout) {
				clearTimeout(renderTimeout);
			}
			
			renderTimeout = setTimeout(() => {
								requestAnimationFrame(() => {
					renderResults();
										selectedChunk = null;
					selectedElement = null;
				});
			}, wasEmpty ? 0 : 50); 		}

		function updateStatus(isSearching, resultCount, fileCount) {
						if (resultCount > 0) {
				const displayText = \`\${resultCount} \${resultCount === 1 ? 'result' : 'results'} in \${fileCount} \${fileCount === 1 ? 'file' : 'files'}\`;
				statusEl.textContent = displayText;
				resultsSummary.textContent = displayText;
				resultsSummary.style.display = 'block';
				replaceAllBtn.disabled = isSearching;
			} else if (isSearching) {
								statusEl.textContent = 'Searching...';
				resultsSummary.style.display = 'none';
				replaceAllBtn.disabled = true;
			} else {
								statusEl.textContent = 'No results found';
				resultsSummary.style.display = 'none';
				replaceAllBtn.disabled = true;
			}
		}

				replaceInput.addEventListener('input', () => {
			if (replaceExpanded) {
								document.querySelectorAll('.replace-line-btn').forEach(btn => {
					btn.style.display = replaceInput.value ? 'block' : 'none';
					btn.disabled = !replaceInput.value;
				});
				document.querySelectorAll('.file-replace-button').forEach(btn => {
					btn.style.display = replaceInput.value ? 'block' : 'none';
				});
				renderResults();
			}
		});

		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.type) {
				case 'updateOptions':
					updateOptions(message.options);
					break;
				case 'updateResults':
					updateResults(message.results, message.isSearching, message.resultCount);
					break;
				case 'updateStatus':
					updateStatus(message.isSearching, message.resultCount, message.fileCount);
					break;
				case 'focus':
					searchInput.focus();
					break;
			}
		});
	</script>
	</body>
</html>`;
	}
}

export function useSearchView(context: vscode.ExtensionContext): SearchViewProvider {
	if (!globalThis.gmodSearchView) {
		globalThis.gmodSearchView = new SearchViewProvider(context);
	}
	return globalThis.gmodSearchView;
}

declare global {
	var gmodSearchView: SearchViewProvider | undefined;
}


