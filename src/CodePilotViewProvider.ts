import * as vscode from 'vscode';
import axios from 'axios';

export class CodePilotViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'codepilot-chat';
	private _view?: vscode.WebviewView;
	private _lmStudioUrl = 'http://localhost:1234/v1';
	private _selectedModel = '';
	private _availableModels: string[] = [];
	private _selectedFileUri?: vscode.Uri;
	private _lastActiveEditor?: vscode.TextEditor;
	private _isProcessing = false;
	private _targetMode: 'auto' | 'file' | 'project' = 'auto';
	private _maxAgentLoops = 5;

	constructor(private readonly _extensionUri: vscode.Uri) {
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && editor.document.uri.scheme === 'file') {
				this._lastActiveEditor = editor;
			}
		});
		this._lastActiveEditor = vscode.window.activeTextEditor;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async data => {
			switch (data.type) {
				case 'sendMessage':
					if (!this._isProcessing) {
						await this.handleUserMessage(data.value, data.mode);
					}
					break;
				case 'applyCode':
					await this.applyCodeToEditor(data.value);
					break;
				case 'selectModel':
					this._selectedModel = data.value;
					break;
				case 'selectFile':
					if (data.value === '__PROJECT__') {
						this._selectedFileUri = undefined;
						this._targetMode = 'project';
					} else if (data.value) {
						this._selectedFileUri = vscode.Uri.file(data.value);
						this._targetMode = 'file';
					} else {
						this._selectedFileUri = undefined;
						this._targetMode = 'auto';
					}
					break;
				case 'refreshModels':
					await this.checkModelStatus();
					break;
			}
		});
		this.checkModelStatus();
	}

	// ─────────────── Model & Status ───────────────

	private async checkModelStatus() {
		// Step 1: Always load workspace files (independent of LM Studio)
		await this.refreshFileList();

		// Step 2: Try to connect to LM Studio
		try {
			const response = await axios.get(this._lmStudioUrl + '/models', { timeout: 5000 });
			const models = response.data.data;

			if (models && models.length > 0) {
				this._availableModels = models.map((m: any) => m.id);
				if (!this._selectedModel || !this._availableModels.includes(this._selectedModel)) {
					this._selectedModel = this._availableModels[0];
				}
				this._view?.webview.postMessage({
					type: 'updateModels', models: this._availableModels,
					selected: this._selectedModel
				});
			} else {
				this._view?.webview.postMessage({ type: 'modelStatus', value: '모델 없음', online: false });
			}
		} catch {
			this._view?.webview.postMessage({ type: 'modelStatus', value: 'LM Studio 오프라인', online: false });
			// Auto-retry after 5 seconds
			setTimeout(() => this.checkModelStatus(), 5000);
		}
	}

	private async refreshFileList() {
		try {
			const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
			const fileOptions = files.map(f => ({ label: vscode.workspace.asRelativePath(f), value: f.fsPath }));
			this._view?.webview.postMessage({ type: 'updateFiles', files: fileOptions });
		} catch { /* ignore */ }
	}

	// ─────────────── Tool Execution ───────────────

	private async executeTool(toolName: string, argsStr: string): Promise<string> {
		let args: any;
		try {
			args = JSON.parse(argsStr.trim());
		} catch {
			args = { path: argsStr.trim().replace(/['"{}]/g, '').split(':').pop()?.trim() || argsStr.trim() };
		}

		const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		this._view?.webview.postMessage({ type: 'toolStatus', tool: toolName, status: 'running' });

		try {
			switch (toolName) {
				case 'read_file': {
					const filePath = args.path || args;
					const uri = vscode.Uri.file(rootPath + '/' + filePath);
					const content = await vscode.workspace.fs.readFile(uri);
					const text = Buffer.from(content).toString('utf8');
					// Truncate very large files to prevent context overflow
					const truncated = text.length > 8000 ? text.substring(0, 8000) + '\n...(truncated)' : text;
					return '[read_file 완료] ' + filePath + ':\n' + truncated;
				}
				case 'write_file': {
					const filePath = args.path;
					const fileContent = args.content;
					if (!filePath || !fileContent) { return '[write_file 오류] path와 content가 필요합니다.'; }
					const uri = vscode.Uri.file(rootPath + '/' + filePath);
					await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, 'utf8'));
					// Open the file in editor so user can see it
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, { preview: false });
					return '[write_file 완료] ' + filePath + ' 파일이 생성/수정되었습니다.';
				}
				case 'list_files': {
					const dir = args.path || '.';
					const pattern = dir === '.' ? '**/*' : dir + '/**/*';
					const found = await vscode.workspace.findFiles(
						new vscode.RelativePattern(rootPath, pattern), '**/node_modules/**', 50
					);
					return '[list_files 완료] ' + dir + ':\n' + found.map(f => vscode.workspace.asRelativePath(f)).join('\n');
				}
				case 'run_command': {
					const cmd = args.command || args;
					const terminal = vscode.window.createTerminal('CodePilot Agent');
					terminal.show();
					terminal.sendText(String(cmd));
					return '[run_command 완료] 터미널에서 실행: ' + cmd;
				}
				default:
					return '[오류] 알 수 없는 도구: ' + toolName;
			}
		} catch (error: any) {
			return '[도구 실행 오류] ' + toolName + ': ' + error.message;
		} finally {
			this._view?.webview.postMessage({ type: 'toolStatus', tool: toolName, status: 'done' });
		}
	}

	// ─────────────── Code Application ───────────────

	private async applyCodeToEditor(code: string) {
		let editor = this._lastActiveEditor || vscode.window.activeTextEditor;
		if (this._selectedFileUri) {
			try {
				const doc = await vscode.workspace.openTextDocument(this._selectedFileUri);
				editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
			} catch { /* fallback to current editor */ }
		}
		if (!editor && vscode.window.visibleTextEditors.length > 0) {
			editor = vscode.window.visibleTextEditors[0];
		}
		if (editor) {
			await editor.edit(eb => {
				const sel = editor!.selection;
				if (!sel.isEmpty) { eb.replace(sel, code); }
				else { eb.insert(sel.active, code); }
			});
			vscode.window.showInformationMessage('코드가 에디터에 적용되었습니다.');
		} else {
			vscode.window.showErrorMessage('열린 에디터가 없습니다. 파일을 열거나 Target File을 선택하세요.');
		}
	}

	// ─────────────── Context Gathering ───────────────

	private async gatherContext(): Promise<{ fileName: string; languageId: string; fullText: string; selectedText: string }> {
		let editor = vscode.window.activeTextEditor || this._lastActiveEditor;
		let document = editor?.document;

		if (this._selectedFileUri) {
			try { document = await vscode.workspace.openTextDocument(this._selectedFileUri); } catch { /* ignore */ }
		}

		const selection = editor?.selection;
		const selectedText = (editor && document === editor.document && selection && !selection.isEmpty) ? document!.getText(selection) : '';
		const fullText = document?.getText() || '';
		const languageId = document?.languageId || 'plaintext';
		const fileName = document ? vscode.workspace.asRelativePath(document.uri) : '(파일 없음)';

		return { fileName, languageId, fullText, selectedText };
	}

	private async getWorkspaceStructure(): Promise<string> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) { return '열린 워크스페이스가 없습니다.'; }
		try {
			const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
			if (files.length === 0) { return '워크스페이스에 파일이 없습니다.'; }
			return '[프로젝트 파일 구조]:\n' + files.map(f => vscode.workspace.asRelativePath(f)).join('\n');
		} catch { return '파일 구조를 읽는 중 오류 발생'; }
	}

	private async readProjectFiles(): Promise<string> {
		const codeExts = ['ts', 'js', 'tsx', 'jsx', 'json', 'css', 'html', 'md', 'py', 'java', 'go', 'rs', 'vue', 'svelte'];
		const pattern = '**/*.{' + codeExts.join(',') + '}';
		const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
		let result = '';
		let totalChars = 0;
		const maxChars = 30000; // Context window limit

		for (const file of files) {
			if (totalChars >= maxChars) {
				result += '\n...(컨텍스트 한도 도달, 나머지 파일 생략)\n';
				break;
			}
			try {
				const data = await vscode.workspace.fs.readFile(file);
				const text = Buffer.from(data).toString('utf8');
				const relPath = vscode.workspace.asRelativePath(file);
				const truncated = text.length > 3000 ? text.substring(0, 3000) + '\n...(파일 일부 생략)' : text;
				result += '\n--- ' + relPath + ' ---\n' + truncated + '\n';
				totalChars += truncated.length;
			} catch { /* skip unreadable files */ }
		}
		return result;
	}

	private async getPersonaInstructions(): Promise<string> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders) { return ''; }
		for (const folder of folders) {
			for (const name of ['.codepilot.md', '.gemini.md']) {
				try {
					const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
					return '\n[Persona: ' + name + ']:\n' + Buffer.from(data).toString('utf8');
				} catch { /* continue */ }
			}
		}
		return '';
	}

	// ─────────────── System Prompt ───────────────

	private buildSystemPrompt(): string {
		return `당신은 CodePilot Agent v1.0.0, 자율형 에이전틱 코딩 에이전트입니다.
모든 응답은 반드시 **한국어**로 작성합니다.

## 핵심 원칙
당신은 단순한 챗봇이 아닙니다. 직접 파일을 읽고, 코드를 작성하고, 서비스를 완성하는 **자율 코딩 에이전트**입니다.

## 워크플로우 (PDCA - 매 응답 필수)

### [P] Plan (보고서 형태)
- 현재 상황 분석 (프로젝트 구조, 기술 스택, 문제점)
- 구체적 수정 계획 (어떤 파일을, 어떻게 수정할지)
- 예상 결과

### [D] Do (실제 구현 - 반드시 도구 사용)
- 계획에 따라 도구를 호출하여 실제 파일을 생성/수정/삭제합니다.
- 텍스트 설명만으로 끝내는 것은 금지입니다.

### [C] Check (검증)
- 구현 결과를 확인합니다.

### [A] Act (요약)
- 완료된 작업과 후속 작업을 정리합니다.

## 도구 사용법
도구를 호출할 때는 반드시 다음 형식을 사용하세요:
<tool_call name="도구이름">{"key": "value"}</tool_call>

사용 가능한 도구:
- read_file: {"path": "상대경로"} - 파일 읽기
- write_file: {"path": "상대경로", "content": "파일내용"} - 파일 쓰기
- list_files: {"path": "디렉토리"} - 파일 목록 조회
- run_command: {"command": "명령어"} - 터미널 명령 실행

## 행동 규칙 (위반 시 실패)
1. **"코드를 제공해주세요"라고 절대 말하지 마세요.** 대신 list_files와 read_file로 직접 찾으세요.
2. **[D] Do 단계에서는 반드시 tool_call을 포함하세요.** 텍스트만 쓰는 것은 실패입니다.
3. **사용자의 추가 확인을 기다리지 마세요.** Plan을 세웠다면 즉시 실행하세요.
4. **도구 호출의 JSON은 반드시 유효한 JSON이어야 합니다.**`;
	}

	// ─────────────── Main Agent Loop ───────────────

	private async handleUserMessage(text: string, mode: string = 'plan') {
		if (!this._view) { return; }
		this._isProcessing = true;

		// Build mode-specific prefix
		let modePrefix = '';
		if (mode === 'plan') {
			modePrefix = '[MODE: PLAN] 분석 및 기획에 집중하세요. [P] Plan을 상세한 보고서 형태로 작성하세요.\n';
		} else if (mode === 'build') {
			modePrefix = '[MODE: BUILD] 구현에 집중하세요. 반드시 도구를 사용하여 실제 파일을 수정하세요.\n';
		}

		// Gather all context
		const ctx = await this.gatherContext();
		const structure = await this.getWorkspaceStructure();
		const persona = await this.getPersonaInstructions();

		// Build context based on target mode
		let fileContext = '';
		if (this._targetMode === 'project') {
			this._view?.webview.postMessage({ type: 'chatChunk', value: '📂 전체 프로젝트 파일을 읽는 중...\n' });
			const projectContent = await this.readProjectFiles();
			fileContext = '[전체 프로젝트 소스 코드]:\n' + projectContent;
		} else if (ctx.fullText) {
			fileContext = '[활성 파일: ' + ctx.fileName + ']:\n```' + ctx.languageId + '\n'
				+ (ctx.fullText.length > 6000 ? ctx.fullText.substring(0, 6000) + '\n...(생략)' : ctx.fullText)
				+ '\n```';
		}

		let autoExplore = '';
		if (!fileContext && this._targetMode === 'auto') {
			autoExplore = '\n[자동 탐색 지시]: 활성 파일이 없습니다. list_files로 프로젝트를 탐색한 뒤 read_file로 핵심 파일을 읽어 분석을 시작하세요.\n';
		}

		const userPrompt = modePrefix + '사용자 명령: ' + text + '\n\n'
			+ autoExplore
			+ '### 현재 환경\n'
			+ '- 타겟 모드: ' + (this._targetMode === 'project' ? '전체 프로젝트' : this._targetMode === 'file' ? ctx.fileName : '자동') + '\n'
			+ '- 언어: ' + ctx.languageId + '\n\n'
			+ fileContext + '\n\n'
			+ (ctx.selectedText ? '[선택된 코드]:\n```\n' + ctx.selectedText + '\n```\n\n' : '')
			+ structure + '\n'
			+ persona;

		await this.runAgentLoop(userPrompt);
		this._isProcessing = false;
	}

	private async runAgentLoop(userPrompt: string, loopCount: number = 0) {
		if (!this._view || loopCount >= this._maxAgentLoops) {
			if (loopCount >= this._maxAgentLoops) {
				this._view?.webview.postMessage({ type: 'addResponse', value: '⚠️ 에이전트 루프 최대 횟수에 도달했습니다.' });
			}
			this._view?.webview.postMessage({ type: 'done' });
			return;
		}

		this._view.webview.postMessage({ type: 'thinking' });

		try {
			const response = await axios.post(this._lmStudioUrl + '/chat/completions', {
				model: this._selectedModel || 'local-model',
				messages: [
					{ role: 'system', content: this.buildSystemPrompt() },
					{ role: 'user', content: userPrompt }
				],
				temperature: 0.7,
				stream: true
			}, {
				timeout: 180000,
				responseType: 'stream'
			});

			this._view.webview.postMessage({ type: 'startMessage' });
			let fullResponse = '';

			// Step 1: Collect all text synchronously (NO async in data handler)
			await new Promise<void>((resolve) => {
				// Safety timeout — if stream hangs, force-resolve after 3 minutes
				const safetyTimer = setTimeout(() => {
					resolve();
				}, 180000);

				response.data.on('data', (chunk: Buffer) => {
					const lines = chunk.toString().split('\n');
					for (const line of lines) {
						if (!line.trim().startsWith('data: ')) { continue; }
						const jsonStr = line.replace('data: ', '').trim();
						if (jsonStr === '[DONE]') { continue; }
						try {
							const json = JSON.parse(jsonStr);
							const delta = json.choices?.[0]?.delta?.content || '';
							if (delta) {
								fullResponse += delta;
								this._view?.webview.postMessage({ type: 'chatChunk', value: delta });
							}
						} catch { /* incomplete JSON chunk, skip */ }
					}
				});

				response.data.on('end', () => { clearTimeout(safetyTimer); resolve(); });
				response.data.on('error', () => { clearTimeout(safetyTimer); resolve(); });
			});

			// Step 2: After stream is COMPLETE, find and execute all tool calls
			const toolRegex = /<tool_call name="([^"]+)">([\s\S]*?)<\/tool_call>/g;
			let toolMatch;
			const toolResults: string[] = [];

			while ((toolMatch = toolRegex.exec(fullResponse)) !== null) {
				const [, toolName, argsStr] = toolMatch;
				this._view?.webview.postMessage({
					type: 'chatChunk',
					value: '\n⚙️ [' + toolName + '] 실행 중...\n'
				});

				const result = await this.executeTool(toolName, argsStr);
				toolResults.push(result);

				this._view?.webview.postMessage({
					type: 'chatChunk',
					value: '✅ ' + result.split('\n')[0] + '\n'
				});
			}

			// Step 3: If tools ran, feed results back for next PDCA cycle
			if (toolResults.length > 0 && loopCount < this._maxAgentLoops - 1) {
				this._view.webview.postMessage({
					type: 'addResponse',
					value: '🔄 도구 실행 완료 (' + toolResults.length + '건). 다음 단계 진행 중...'
				});

				const continuationPrompt = '[이전 단계의 도구 실행 결과]:\n'
					+ toolResults.join('\n---\n')
					+ '\n\n위 결과를 바탕으로 PDCA 워크플로우의 다음 단계를 진행하세요.'
					+ ' 추가 도구 호출이 필요하면 계속 진행하고, 모든 작업이 완료되었으면 [A] Act로 최종 요약하세요.';

				await this.runAgentLoop(continuationPrompt, loopCount + 1);
				return; // Don't send 'done' yet — recursive call will handle it
			}

			// Step 4: All done — unlock the UI
			this._view?.webview.postMessage({ type: 'done' });

		} catch (error: any) {
			let msg = error.message || '알 수 없는 오류';
			if (error.code === 'ECONNABORTED') { msg = '응답 시간 초과. LM Studio를 확인하세요.'; }
			else if (error.code === 'ECONNREFUSED') { msg = 'LM Studio에 연결할 수 없습니다. LM Studio를 실행해주세요.'; }
			this._view?.webview.postMessage({ type: 'addResponse', value: '❌ 오류: ' + msg });
			this._view?.webview.postMessage({ type: 'done' });
		}
	}

	// ─────────────── Security ───────────────

	private isMalicious(text: string): boolean {
		return [/rm\s+-rf\s+\//i, /format\s+c:/i, /:(){ :\|:& };:/].some(p => p.test(text));
	}

	// ─────────────── HTML ───────────────

	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

		return `<!DOCTYPE html>
<html lang="ko">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>CodePilot Agent</title>
</head>
<body>
	<div class="main-container">
		<div class="header">
			<div class="title-row">
				<h1>🚀 CodePilot Agent <span class="version">v1.0.0</span></h1>
				<button id="refresh-models-btn" title="새로고침">🔄</button>
			</div>
			<div class="selector-group">
				<div class="selector-item">
					<label>Model</label>
					<select id="model-select"><option>연결 중...</option></select>
				</div>
				<div class="selector-item">
					<label>Target</label>
					<select id="file-select"><option value="">(Auto: 활성 에디터)</option><option value="__PROJECT__">📁 전체 프로젝트</option></select>
				</div>
			</div>
			<div class="mode-indicator">
				<span id="mode-label">📋 Plan 모드</span>
				<span class="mode-hint">Tab 키로 전환</span>
			</div>
		</div>

		<div class="workspace-body">
			<div class="chat-panel">
				<div id="chat-messages">
					<div class="message assistant welcome">
						<div class="welcome-title">🚀 CodePilot Agent v1.0.0</div>
						<div class="welcome-body">자율형 에이전틱 코딩 에이전트가 준비되었습니다.<br>
						<strong>Tab</strong> 키로 모드 전환 | <strong>Enter</strong> 전송<br><br>
						📋 <strong>Plan</strong> — 프로젝트 분석 및 기획 보고서<br>
						🛠️ <strong>Build</strong> — 코드 구현 및 파일 수정 실행</div>
					</div>
				</div>
			</div>

			<div class="artifact-panel">
				<div class="tab-bar">
					<button class="tab-btn active" data-tab="plan">📋 Plan</button>
					<button class="tab-btn" data-tab="build">🛠️ Build</button>
				</div>

				<div id="plan-tab" class="tab-content active">
					<div class="view-header">📊 분석 및 기획 보고서</div>
					<div id="plan-viewer" class="markdown-body">Plan 모드에서 명령을 입력하면 분석 보고서가 여기에 표시됩니다.</div>
				</div>

				<div id="build-tab" class="tab-content">
					<div class="view-header">⚡ 구현 및 도구 실행 로그</div>
					<div id="build-viewer" class="markdown-body">Build 모드에서 명령을 입력하면 구현 내용이 여기에 표시됩니다.</div>
					<div id="tool-log"></div>
				</div>
			</div>
		</div>

		<div class="input-area">
			<div class="input-wrapper">
				<textarea id="user-input" placeholder="명령을 입력하세요... (Tab: 모드 전환, Enter: 전송)" rows="2"></textarea>
				<button id="send-btn" class="send-btn">전송</button>
			</div>
			<div class="action-buttons">
				<button id="refactor-btn" class="action-btn">✨ 리팩토링</button>
				<button id="debug-btn" class="action-btn">🐞 디버그</button>
				<button id="analyze-btn" class="action-btn">🔍 전체 분석</button>
			</div>
		</div>
	</div>
	<script src="${scriptUri}"></script>
</body>
</html>`;
	}
}
