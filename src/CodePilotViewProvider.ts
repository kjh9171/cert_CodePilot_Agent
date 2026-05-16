import * as vscode from 'vscode';
import axios from 'axios';

type WorkMode = 'plan' | 'build' | 'auto';
type BuildPhase = 'plan' | 'implement' | 'review';

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
	private _workMode: WorkMode = 'auto';
	private _buildPhase: BuildPhase = 'plan';
	private _buildPlan = '';

	private readonly seniorSystemPrompt = `당신은 시니어 풀스택 개발자이자 보안 리서처입니다. 디자인 감각도 뛰어나며, 최신 보안 트렌드와 모던한 UI/UX 패턴을 이해합니다. 또한 지속적인 학습과 자기 개선을 통해 발전하는 AI 에이전트입니다.

## 역할
- 시니어 풀스택 개발자: Frontend, Backend, DevOps를 포함한 전체 스택을 설계하고 구현
- 보안 리서처: OWASP Top 10 (2021/2024), CVE 모니터링, Secure Coding Practices 적용, 취약점 분석
- 디자이너: 현대적인 UI/UX 원칙 적용, 반응형 디자인, 접근성 고려 (WCAG 2.1)
- 학습자: 새로운 기술, 프레임워크, 보안 트렌드를 지속적으로 학습하고 적용

## 지속적인 학습 원칙
1. 새로운 기술/보안 이슈 발견 시 연구하고 적용
2. 코드 작성 후 피드백을 통해 학습
3. 최신 개발 트렌드 (AI/ML, Web3, Edge Computing 등) 추적
4. 보안 취약점 발견 시 즉시 수정 및 개선
5. 성능 최적화와 베스트 프랙티스 적용

## 작업 모드

### 플랜모드 (Plan)
사용자의 요구사항을 분석하고 구현 계획을 수립합니다:
1. 요구사항 분석 및 명확화
2. 기술 스택 선정 (보안, 확장성, 성능 고려) - 최신 기술 우선
3. 아키텍처 설계 및 파일 구조 정의
4. 구현 단계별 작업 계획
5. 예상되는 문제점과 해결 방안
6. 보안 리스크 평가 및 완화 전략

### 빌드모드 (Build)
플랜모드에서 수립한 계획에 따라 실제로 코드를 작성합니다:
1. 파일 생성/수정/삭제
2. 보안 취약점 체크 및 수정 (입력 검증, 인증, 암호화 등)
3. 코드 리팩토링 및 최적화
4. 테스트 코드 작성 (단위 테스트, 통합 테스트)
5. 성능 및 보안 최종 검토
6. 문서화 및 코드 코멘트 작성

## 도구 사용
- read_file: 파일 내용 읽기 (파라미터: path)
- write_file: 파일 생성/수정 (파라미터: path, content)
- list_files: 디렉토리 구조 확인 (파라미터: path)
- run_command: 터미널 명령어 실행 (파라미터: command)

## 응답 형식
도구를 사용할 때는 다음 형식으로 출력하세요:
<tool_name>{"path": "파일경로", "content": "내용"}</tool_name>

코드 블록은 \`\`\`language 형태로 감싸기
설명은 간결하고 명확하게
보안 이슈 발견 시 즉시 경고
새로운 기술/방법 적용 시 그 이유와 benefits 설명`;

	private _learningHistory: string[] = [];

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
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};
		(webviewView as any).options = { retainContextWhenHidden: true };
		this._getHtmlForWebview(webviewView.webview).then(html => {
			webviewView.webview.html = html;
		});

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

	private async checkModelStatus() {
		await this.refreshFileList();

		try {
			const response = await axios.get(this._lmStudioUrl + '/models', { timeout: 5000 });
			const models = response.data.data;

			if (models && models.length > 0) {
				this._availableModels = models.map((m: any) => m.id);
				if (!this._selectedModel || !this._availableModels.includes(this._selectedModel)) {
					this._selectedModel = this._availableModels[0];
				}
				this._view?.webview.postMessage({
					type: 'updateModels',
					models: this._availableModels,
					selected: this._selectedModel
				});
			} else {
				this._view?.webview.postMessage({
					type: 'modelStatus',
					value: '모델 없음',
					online: false
				});
			}
		} catch {
			this._view?.webview.postMessage({
				type: 'modelStatus',
				value: 'LM Studio 오프라인',
				online: false
			});
			setTimeout(() => this.checkModelStatus(), 5000);
		}
	}

	private async refreshFileList() {
		try {
			const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
			const fileOptions = files.map(f => ({
				label: vscode.workspace.asRelativePath(f),
				value: f.fsPath
			}));
			this._view?.webview.postMessage({
				type: 'updateFiles',
				files: fileOptions
			});
		} catch {
			// ignore
		}
	}

	private async executeTool(toolName: string, argsStr: string): Promise<string> {
		let args: any = {};
		try {
			args = JSON.parse(argsStr.trim());
		} catch {
			if (toolName === 'write_file') {
				const pathMatch = argsStr.match(/"path"\s*:\s*"([^"]+)"/);
				const contentMatch = argsStr.match(/"content"\s*:\s*"([\s\S]*?)"\s*/);

				if (pathMatch) args.path = pathMatch[1];
				if (contentMatch) {
					let rawContent = contentMatch[1];
					if (rawContent.startsWith('^') && rawContent.endsWith('')) rawContent = rawContent.slice(1, -1);
					args.content = rawContent.replace(/\\n/g, '\\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
				}
			} else {
				args = { path: argsStr.trim().replace(/['"{}]/g, '').split(':').pop()?.trim() || argsStr.trim() };
			}
		}

		const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		this._view?.webview.postMessage({
			type: 'toolStatus',
			tool: toolName,
			status: 'running'
		});

		try {
			switch (toolName) {
				case 'read_file': {
					const filePath = args.path || args;
					const uri = vscode.Uri.file(rootPath + '/' + filePath);
					const content = await vscode.workspace.fs.readFile(uri);
					const text = Buffer.from(content).toString('utf8');
					const truncated = text.length > 8000 ? text.substring(0, 8000) + '\n...(truncated)' : text;
					return '[read_file 완료] ' + filePath + ':\n' + truncated;
				}
				case 'write_file': {
					const filePath = args.path;
					const fileContent = args.content;
					if (!filePath || !fileContent) { return '[write_file 오류] path와 content가 필요합니다.'; }
					const uri = vscode.Uri.file(rootPath + '/' + filePath);
					await vscode.workspace.fs.writeFile(uri, Buffer.from(fileContent, 'utf8'));
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
			this._view?.webview.postMessage({
				type: 'toolStatus',
				tool: toolName,
				status: 'done'
			});
		}
	}

	private async applyCodeToEditor(code: string) {
		let editor = this._lastActiveEditor || vscode.window.activeTextEditor;
		if (this._selectedFileUri) {
			try {
				const doc = await vscode.workspace.openTextDocument(this._selectedFileUri);
				editor = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
			} catch { /* fallback */ }
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

	private async gatherContext(): Promise<{ fileName: string; languageId: string; fullText: string; selectedText: string }> {
		let editor = vscode.window.activeTextEditor || this._lastActiveEditor;
		let document = editor?.document;

		if (!document) {
			return { fileName: '', languageId: '', fullText: '', selectedText: '' };
		}

		const fullText = document.getText();
		const selectedText = String(editor?.selection.start.character || 0);
		const context = {
			fileName: document.fileName,
			languageId: document.languageId,
			fullText: fullText,
			selectedText: selectedText,
		};

		return context;
	}

	private async handleUserMessage(userMessage: string, mode: string) {
		this._isProcessing = true;
		this._workMode = mode === 'plan' ? 'plan' : mode === 'build' ? 'build' : 'auto';

		if (this._workMode === 'build' && !this._buildPlan) {
			this._view?.webview.postMessage({ type: 'message', content: '⚠️ 빌드모드를 실행하려면 먼저 플랜모드에서 계획을 세워주세요.' });
			this._isProcessing = false;
			return;
		}

		const context = await this.gatherContext();
		const targetInfo = this._targetMode === 'file' ? '타겟 파일: ' + (this._selectedFileUri?.fsPath || '') :
			this._targetMode === 'project' ? '프로젝트 레벨 작업' : '자동 모드';

		let systemPrompt = '';
		if (this._workMode === 'plan') {
			systemPrompt = this.seniorSystemPrompt + '\n\n## 현재 작업\n- 모드: 플랜모드 (계획 수립)\n- ' + targetInfo + '\n- 파일: ' + (context.fileName || '없음') + '\n\n사용자의 요구사항을 분석하고 상세한 구현 계획을 세워주세요.';
		} else if (this._workMode === 'build') {
			systemPrompt = this.seniorSystemPrompt + '\n\n## 현재 작업\n- 모드: 빌드모드 (구현)\n- ' + targetInfo + '\n- 이전 계획:\n' + this._buildPlan + '\n\n 수립된 계획에 따라 코드를 작성/수정해주세요.';
		} else {
			systemPrompt = this.seniorSystemPrompt + '\n\n## 현재 작업\n- ' + targetInfo + '\n- 파일: ' + (context.fileName || '없음') + '\n\n사용자 요청: ' + userMessage;
		}

		try {
			this._view?.webview.postMessage({ type: 'message', content: '🤔 thinking...' });

			let loopCount = 0;
			let fullResponse = '';
			let lastToolCall = '';

			while (loopCount < this._maxAgentLoops) {
				const response = await this.callLMStudio(
					this._workMode === 'plan' ? '플랜모드: ' + userMessage :
						this._workMode === 'build' ? '빌드모드: ' + userMessage : userMessage,
					systemPrompt,
					fullResponse + (lastToolCall ? '\n도구 결과: ' + lastToolCall : '')
				);

				fullResponse += response;
				const toolCalls = this.extractToolCalls(response);

				if (toolCalls.length === 0) {
					break;
				}

				for (const toolCall of toolCalls) {
					lastToolCall = await this.executeTool(toolCall.name, toolCall.args);
					fullResponse += '\n[' + toolCall.name + ' 결과]\n' + lastToolCall;
				}
				loopCount++;
			}

			if (this._workMode === 'plan') {
				this._buildPlan = fullResponse;
				this._buildPhase = 'implement';
				this._view?.webview.postMessage({
					type: 'planReady',
					plan: fullResponse,
					nextAction: '이제 빌드모드로 전환하여 구현을 진행할 수 있습니다.'
				});
			} else {
				this._view?.webview.postMessage({ type: 'message', content: fullResponse });
			}

		} catch (error: any) {
			this._view?.webview.postMessage({
				type: 'message',
				content: '❌ 오류가 발생했습니다: ' + error.message
			});
		}

		this._isProcessing = false;
	}

	private async callLMStudio(prompt: string, systemPrompt: string, history: string): Promise<string> {
		try {
			const response = await axios.post(this._lmStudioUrl + '/chat/completions', {
				model: this._selectedModel,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: history + '\n\n' + prompt }
				],
				temperature: 0.7,
				max_tokens: 2000,
			}, { timeout: 120000 });

			return response.data.choices[0].message.content;
		} catch (error: any) {
			throw new Error('LM Studio 통신 실패: ' + error.message);
		}
	}

	private extractToolCalls(response: string): { name: string; args: string }[] {
		const toolCalls: { name: string; args: string }[] = [];
		const regex = new RegExp('<(read_file|write_file|list_files|run_command)>([\\s\\S]*?)<\\/\\1>', 'g');
		let match;

		while ((match = regex.exec(response)) !== null) {
			toolCalls.push({
				name: match[1],
				args: match[2].trim()
			});
		}

		return toolCalls;
	}

	private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.html');
		const fileData = await vscode.workspace.fs.readFile(htmlPath);
		const htmlContent = Buffer.from(fileData).toString('utf8');
		return htmlContent;
	}
}