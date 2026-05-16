# CodePilot Agent v1.1.0

로컬 LLM 기반 자율 코딩 에이전트 - LM Studio와 연동되는 VS Code 확장

## 개요

CodePilot Agent는 LM Studio에서 실행되는 로컬 Large Language Model을 활용하여 개발자를 지원하는 VS Code 확장입니다. 시니어 풀스택 개발자, 보안 리서처, 디자이너의 역할을 수행하며 지속적인 학습을 통해 발전합니다.

## 주요 기능

### 🤖 AI 역할
- **시니어 풀스택 개발자**: Frontend, Backend, DevOps 전체 스택 설계 및 구현
- **보안 리서처**: OWASP Top 10 (2021/2024), CVE 모니터링, 보안 취약점 분석
- **디자이너**: 최신 UI/UX 트렌드, 반응형 디자인, 접근성 (WCAG 2.1) 고려

### 📋 작업 모드

| 모드 | 설명 |
|------|------|
| **자동 (Auto)** | 사용자 요청을 분석하여 자동으로 코드 생성/수정 |
| **플랜 (Plan)** | 요구사항 분석, 기술 스택 선정, 아키텍처 설계, 구현 계획 수립 |
| **빌드 (Build)** | 플랜 기반 실제 코드 작성, 보안 체크, 리팩토링, 테스트 |

### 🔄 자체 학습 시스템
- 새로운 기술/보안 트렌드 지속 학습
- 코드 작성 후 피드백을 통한 자기 개선
- 최신 개발 트렌드 (AI/ML, Web3, Edge Computing 등) 추적
- 보안 취약점 발견 시 즉시 수정 및 최적화

### 🛠️ 도구 사용
- `read_file`: 파일 내용 읽기
- `write_file`: 파일 생성/수정
- `list_files`: 디렉토리 구조 확인
- `run_command`: 터미널 명령어 실행

## 아키텍처 구조

```
codepilot-agent/
├── src/
│   ├── extension.ts          # 확장 시작점
│   └── CodePilotViewProvider.ts   # 메인 로직
│       ├── LM Studio 연동       # 로컬 모델 통신
│       ├── Plan Mode           # 계획 수립
│       ├── Build Mode           # 코드 구현
│       └── Agent Core          # 에이전트 로직
├── resources/
│   ├── icon.svg              # 확장 아이콘
│   └── webview.html          # UI 템플릿
├── package.json              # 확장 설정
└── tsconfig.json             # TypeScript 설정
```

### 컴포넌트 설명

| 컴포넌트 | 설명 |
|---------|------|
| `extension.ts` | VS Code 확장 활성화 및 뷰 프로바이더 등록 |
| `CodePilotViewProvider` | 메인 클래스로 모든 기능 관리 |
| `LM Studio 연동` | http://localhost:1234/v1 API 통신 |
| `Plan Mode` | 요구사항 분석 → 기술 선정 → 아키텍처 설계 |
| `Build Mode` | 코드 작성 → 보안 체크 → 리팩토링 → 테스트 |
| `Webview UI` | 채팅 인터페이스, 모델/파일 선택자 |

## 시작하기

### 필수 요구사항
- VS Code 1.80.0+
- LM Studio (로컬 서버 실행 필요)

### 설치 및 실행

```bash
# 1. 의존성 설치
npm install

# 2. 컴파일
npm run compile

# 3. VS Code에서 테스트 (F5)
```

### 빌드 및 설치

```bash
# VSIX 패키지 생성
vsce package

# VS Code에 설치
code --install-extension codepilot-agent-1.1.0.vsix
```

### LM Studio 설정

1. LM Studio 실행
2. 원하는 모델 로드 (예: CodeLlama, Mistral 등)
3. 서버 시작 (기본 포트: 1234)
4. CodePilot Agent에서 모델 선택

## 사용 방법

1. VS Code 사이드바에서 CodePilot 아이콘 클릭
2. 작업 모드 선택 (자동/플랜/빌드)
3. 모델 선택 및 필요시 타겟 파일 선택
4. 메시지 입력 후 전송
5. AI가 분석 및 코드 생성/수정

### 플랜모드 → 빌드모드 workflow

```
1. 플랜모드에서 요구사항 입력
2. AI가 계획 수립 (파일 구조, 기술 스택 등)
3. 빌드모드로 전환
4. 계획에 따라 코드 자동 생성
5. 보안/성능 검토 후 최종 적용
```

## 버전 변경 이력

### v1.1.0 (현재)
- 자체 학습 시스템 추가
- 시니어 개발자 + 보안 리서처 + 디자이너 역할 통합
- OWASP Top 10 2021/2024 적용
- WCAG 2.1 접근성 고려
- 플랜모드: 보안 리스크 평가 추가
- 빌드모드: 테스트 코드 작성, 문서화 단계 추가

### v1.0.0
- 초기 버전
- LM Studio 연동
- 기본 코딩 기능

## 20250517 업데이트 내용:
- 
버전: v1.1.0
- 
개요: 로컬 LLM 기반 자율 코딩 에이전트 설명
- 
주요 기능: AI 역할, 작업 모드, 자체 학습 시스템, 도구 사용
- 
아키텍처 구조: 컴포넌트별 설명 및 다이어그램
- 
시작하기: 설치, 빌드, LM Studio 설정
- 
사용 방법: 플랜→빌드 workflow 포함
- 
버전 변경 이력