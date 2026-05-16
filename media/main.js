(function () {
    const vscode = acquireVsCodeApi();

    // ─── DOM References ───
    const chatMessages = document.getElementById('chat-messages');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const refactorBtn = document.getElementById('refactor-btn');
    const debugBtn = document.getElementById('debug-btn');
    const analyzeBtn = document.getElementById('analyze-btn');
    const modelSelect = document.getElementById('model-select');
    const fileSelect = document.getElementById('file-select');
    const refreshModelsBtn = document.getElementById('refresh-models-btn');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const modeLabel = document.getElementById('mode-label');

    // ─── State ───
    let currentResponseDiv = null;
    let isProcessing = false;

    // ─── Quick Actions ───
    refactorBtn.addEventListener('click', () => { userInput.value = '이 코드를 리팩토링해줘.'; sendMessage(); });
    debugBtn.addEventListener('click', () => { userInput.value = '이 코드의 오류를 분석하고 수정해줘.'; sendMessage(); });
    analyzeBtn.addEventListener('click', () => { userInput.value = '프로젝트 전체를 분석하고 개선점을 찾아서 구현해줘.'; sendMessage(); });

    // ─── Send ───
    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    function sendMessage() {
        const message = userInput.value.trim();
        if (!message || isProcessing) return;

        const activeTab = document.querySelector('.tab-btn.active').getAttribute('data-tab');
        addMessage(message, 'user');
        vscode.postMessage({ type: 'sendMessage', value: message, mode: activeTab });
        userInput.value = '';
        isProcessing = true;
        sendBtn.disabled = true;
        sendBtn.textContent = '처리 중...';
    }

    function unlockInput() {
        isProcessing = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '전송';
    }

    // ─── Tab Switching ───
    const modeLabels = {
        plan: '📋 Plan 모드',
        build: '🛠️ Build 모드'
    };
    const placeholders = {
        plan: '분석/기획을 지시하세요 (Plan 모드)',
        build: '코드 구현/실행을 지시하세요 (Build 모드)'
    };

    function switchTab(tabId) {
        tabBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tabId));
        tabContents.forEach(c => c.classList.toggle('active', c.id === tabId + '-tab'));
        if (modeLabel) modeLabel.textContent = modeLabels[tabId] || '';
        userInput.placeholder = placeholders[tabId] || '명령을 입력하세요...';
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
    });

    // ─── Tab Key: 입력창에서 Plan ↔ Build 전환 ───
    let currentMode = 'plan';

    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            currentMode = (currentMode === 'plan') ? 'build' : 'plan';
            switchTab(currentMode);
            userInput.focus();
        }
    });

    // ─── Selectors ───
    modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectModel', value: modelSelect.value }));
    fileSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectFile', value: fileSelect.value }));
    refreshModelsBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));

    // ─── Message Rendering ───
    function addMessage(text, role) {
        const div = document.createElement('div');
        div.className = 'message ' + role;

        const content = document.createElement('div');
        content.className = 'content';
        content.textContent = text;
        div.appendChild(content);

        // Add "Apply" button for code blocks
        if (role === 'assistant' && text.includes('```')) {
            const btn = document.createElement('button');
            btn.className = 'apply-btn';
            btn.textContent = '📥 에디터에 적용';
            btn.onclick = () => {
                const match = text.match(/```(?:\w+)?\n([\s\S]*?)\n```/) || text.match(/```([\s\S]*?)```/);
                vscode.postMessage({ type: 'applyCode', value: match ? match[1].trim() : text });
            };
            div.appendChild(btn);
        }

        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return div;
    }

    // ─── Streaming Message Handler ───
    window.addEventListener('message', event => {
        const msg = event.data;

        switch (msg.type) {
            case 'startMessage': {
                removeThinking();
                currentResponseDiv = addMessage('', 'assistant');
                break;
            }

            case 'chatChunk': {
                if (!currentResponseDiv) {
                    removeThinking();
                    currentResponseDiv = addMessage('', 'assistant');
                }
                const contentEl = currentResponseDiv.querySelector('.content');
                contentEl.textContent += msg.value;

                // ── Real-time Smart Routing to Plan/Build tabs ──
                const fullText = contentEl.textContent;

                // Route [P] Plan content to plan-viewer
                if (fullText.includes('[P] Plan')) {
                    const planMatch = fullText.match(/\[P\] Plan[:\s]*([\s\S]*?)(?=\[D\] Do|\[C\] Check|\[A\] Act|$)/);
                    if (planMatch && planMatch[1].trim()) {
                        document.getElementById('plan-viewer').textContent = planMatch[1].trim();
                    }
                }

                // Route [D] Do content to build-viewer
                if (fullText.includes('[D] Do')) {
                    const buildMatch = fullText.match(/\[D\] Do[:\s]*([\s\S]*?)(?=\[C\] Check|\[A\] Act|$)/);
                    if (buildMatch && buildMatch[1].trim()) {
                        document.getElementById('build-viewer').textContent = buildMatch[1].trim();
                    }
                }

                chatMessages.scrollTop = chatMessages.scrollHeight;
                break;
            }

            case 'addResponse': {
                removeThinking();
                if (msg.value.includes('다음 단계 진행 중') || msg.value.includes('도구 실행 완료')) {
                    const statusDiv = document.createElement('div');
                    statusDiv.className = 'message status-msg';
                    statusDiv.textContent = msg.value;
                    chatMessages.appendChild(statusDiv);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                } else {
                    currentResponseDiv = null;
                    addMessage(msg.value, 'assistant');
                }
                break;
            }

            case 'thinking': {
                addThinking();
                break;
            }

            case 'done': {
                removeThinking();
                currentResponseDiv = null;
                unlockInput();
                break;
            }

            case 'toolStatus': {
                const logEl = document.getElementById('tool-log');
                if (logEl) {
                    const entry = document.createElement('div');
                    entry.className = 'tool-entry ' + msg.status;
                    entry.textContent = (msg.status === 'running' ? '⚙️ ' : '✅ ') + msg.tool;
                    logEl.appendChild(entry);
                    logEl.scrollTop = logEl.scrollHeight;
                }
                // Auto-switch to Build tab when tools are running
                if (msg.status === 'running') {
                    switchTab('build');
                }
                break;
            }

            case 'updateModels': {
                modelSelect.innerHTML = '';
                msg.models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m; opt.text = m;
                    if (m === msg.selected) opt.selected = true;
                    modelSelect.appendChild(opt);
                });
                break;
            }

            case 'updateFiles': {
                if (msg.files) updateFileSelector(msg.files);
                break;
            }

            case 'modelStatus': {
                modelSelect.innerHTML = `<option>${msg.value}</option>`;
                break;
            }
        }
    });

    function updateFileSelector(files) {
        const val = fileSelect.value;
        fileSelect.innerHTML = '<option value="">(Auto: 활성 에디터)</option><option value="__PROJECT__">📁 전체 프로젝트</option>';
        files.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.value; opt.text = f.label;
            if (f.value === val) opt.selected = true;
            fileSelect.appendChild(opt);
        });
    }

    function addThinking() {
        if (document.querySelector('.thinking')) return;
        const div = document.createElement('div');
        div.className = 'message assistant thinking';
        div.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> 분석 중...';
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function removeThinking() {
        const el = document.querySelector('.thinking');
        if (el) el.remove();
    }
}());
