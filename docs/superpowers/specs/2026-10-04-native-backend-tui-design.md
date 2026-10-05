# Office Desks: 자체 백엔드와 TUI 멀티플렉서 (Orca 의존 제거)

## Context

지금 office-desks는 Orca가 실행 중이어야만 동작합니다. 모든 bridge 동작이 `orca` CLI 호출이기 때문입니다.
- 워크트리와 에이전트 목록, 에이전트 상태
- 화면 읽기, 키 입력
- 워크트리·에이전트 생성, 보드 상태
- 대화 파일 찾기, 사용량

사용자 목표는 두 가지입니다.
1. **Orca 없는 사람도 쓸 수 있게.** Orca는 "있으면 붙는 백엔드 중 하나"가 됩니다.
2. **우리만의 에이전트 터미널 매니저(TUI)를 키우기.** 지금 웹(office-desk)이 그 위의 뷰가 됩니다.

합의된 결정은 다음과 같습니다.
- **TUI 형태:** 풀 멀티플렉서. TUI 앱이 에이전트 PTY의 주인입니다.
- **프로세스:** `office-desks`를 켜면 TUI가 뜨고, 같은 프로세스가 웹 서버(127.0.0.1:4317)도 엽니다. Orca와 같은 모델이라 **TUI를 끄면 그 안의 에이전트도 종료됩니다.** 다만 코어(PTY 관리)와 TUI 렌더링은 모듈로 분리해, 나중에 데몬으로 떼어낼 여지를 남깁니다.
- **스택:** TypeScript/Node, 기존 bridge를 그대로 재사용합니다. PTY는 `node-pty@1.1.x`로 띄웁니다. darwin-x64/arm64, win32-x64/arm64 prebuilt를 동봉해 빌드 도구 없이 설치됩니다(확인함). 화면 버퍼는 `@xterm/headless`(6.x)가 맡습니다.
- **순서(리스크 순):** M1 백엔드 인터페이스 → M2 자체 백엔드(웹 전용) → M3 TUI → M4 동등성 순입니다.
- **크로스 플랫폼:** macOS와 Windows 필수, npm scripts만 씁니다. 메모리 규칙입니다.

### 사전 확인된 사실
- bridge의 Orca 접점은 모두 `OrcaRunner = (args) => Promise<unknown>`(`bridge/src/orcaCli.ts:30`)입니다. 다만 타입이 없고, 18곳에서 CLI 인자를 직접 조립합니다.
  - `server.ts`: 87, 215, 295, 375, 399, 421, 433, 438, 441, 465, 473
  - `poller.ts`: 75, 97
  - `usage.ts`: 55
  - `sessionResolver.ts`: 94
  - `hire.ts`: 24, 34
- `demo.ts`의 `createDemoRunner()`가 이미 완전한 가짜 Orca입니다. 그 밖에 `server.ts` 곳곳에 `DEMO` 분기가 있습니다.
- `claude`는 `--settings <file-or-json>`(훅 주입)과 `--session-id <uuid>`(세션 ID 고정)를 지원합니다. 덕분에 상태 감지와 대화 파일 찾기를 Orca 없이 할 수 있습니다.

---

## Orca 기능 → 자체 구현 매핑

| Orca 기능 | 사용처 | 자체 백엔드(M2~M4) |
|---|---|---|
| `worktree ps`: 워크트리 목록 | poller | `git worktree list --porcelain` + 로컬 레지스트리(`~/.office-desks/state.json`: 등록 repo, 워크트리 메타) |
| `worktree ps`: 에이전트 상태·도구·프롬프트 | stateMapper | **Claude 훅**입니다. spawn할 때 `--settings`로 UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification 훅을 주입하고, 훅이 `POST 127.0.0.1:4317/hook/<agentId>?token=`로 알립니다. 결과는 기존 `CharacterState`로 매핑합니다. 보조로 화면 휴리스틱(`screen.ts`)도 씁니다 |
| `terminal list`: paneKey→handle | stateMapper | 불필요합니다. 우리가 PTY id를 직접 발급합니다 |
| `terminal read --screen` | readScreen, answer | `@xterm/headless` 버퍼에서 줄을 뽑습니다. **같은 `string[]` 형태를 반환**하므로 `screen.ts`, `answer.ts`, `test/fixtures/screens` 테스트가 그대로 유지됩니다 |
| `terminal send --text/--enter` | send, keys, answer, queue | `pty.write()`. 긴 텍스트는 bracketed paste로 보냅니다 |
| `agent_prompt_blocked` + retry | deliver | 보내기 전에 `composerState`(screen.ts)로 입력 가능 여부를 확인하고, 불가면 같은 409 `agent_busy` 응답을 줍니다. retry는 서버 내부 큐로 처리합니다 |
| `terminal switch` | /api/focus | M2에서는 no-op, M3에서는 TUI 포커스 이동입니다 |
| `terminal create` / `worktree create --agent` | hire | `git worktree add` + `pty.spawn(agentCmd, {cwd})`입니다. Claude에는 `--session-id`와 `--settings`를 붙입니다 |
| `terminal wait --for=tui-idle` | hire 후 프롬프트 | 훅 `SessionStart`를 받거나, 화면에 composer가 보일 때까지 대기합니다 |
| `worktree set` (status/comment) | /api/worktree | 로컬 레지스트리 JSON에 저장합니다 |
| `search` (세션 파일 찾기) | sessionResolver | 불필요합니다. `--session-id`로 경로가 결정적입니다(`~/.claude/projects/<인코딩된 cwd>/<id>.jsonl`) |
| `search --scope=conversation` | /api/search | **M4**. 우리 에이전트들의 JSONL을 직접 grep합니다. M2에서는 빈 결과(데모와 동일)입니다 |
| `account list` (사용량) | usage | **M4**. Claude statusline 훅 등 대안을 조사합니다. M2에서는 사용량 바를 숨깁니다(degraded) |
| Codex 에이전트 | 전반 | **M4**. Codex 상태 감지는 별도로 조사합니다. M2/M3은 Claude Code만 1급 지원하고, 그 외 명령은 "상태 없는 터미널"로 표시합니다 |

---

## M1: 타입 있는 백엔드 인터페이스 (순수 리팩터, 동작 변화 없음)

**목표:** Orca가 "백엔드 중 하나"가 됩니다. 이것만으로도 목표 1의 구조가 갖춰집니다.

1. **`bridge/src/backend/types.ts`에 `OfficeBackend` 인터페이스를 추가합니다.**
   - 읽기: `snapshot(): Promise<OfficeSnapshot>`(enrich 전 단계), `readScreen(handle): Promise<string[]>`
   - 입력: `sendText(handle, text, {enter, retryId?})`, `sendKeys(handle, bytes)`, `focus(handle)`
   - 생성·대기: `hire(req: HireRequest)`, `waitIdle(handle, ms)`
   - 보드: `setBoard(worktreeId, {status?, comment?})`
   - 대화·사용량: `findSession(key)`, `searchConversations(q)`, `usage(): Promise<UsageSnapshot | null>`
   - `capabilities: { usage, search, board, hire, focus }`. 웹이 기능을 숨기는 데 씁니다.
   - 에러: `BackendBusyError(requestId)`. 지금 `agent_prompt_blocked` 처리를 일반화한 것입니다.
2. **`bridge/src/backend/orca.ts`에 `OrcaBackend`를 만듭니다.** 아래를 흡수합니다.
   - `OrcaRunner`와 `poller.ts`의 ps/terminal-list 조회
   - `stateMapper.toSnapshot`
   - `hire.ts`의 인자 빌더
   - `usage.ts`의 `account list`
   - `sessionResolver`의 `orca search`
   - `server.ts:213-235`의 blocked/retry 맵
   - `server.ts:461`의 "코멘트 비우기 = 공백 한 칸" 해킹
3. **`demo.ts`를 `DemoBackend`로 바꿉니다.** `server.ts`의 `DEMO` 분기(enrichment, hire/search/diff 비활성)는 백엔드 capability와 DemoBackend 내부로 옮깁니다.
4. **`OfficePoller`가 `OrcaRunner` 대신 `OfficeBackend.snapshot()`을 받게 합니다.** enrich 훅(git 변경, 대화 읽기)은 백엔드 공통이라 poller/server에 그대로 둡니다.
5. **`server.ts`는 `backend.*`만 호출합니다.** 선택은 `OFFICE_DESKS_BACKEND=orca|demo`로 하고, 기본값은 orca입니다. `/api/snapshot` 또는 WS에 `capabilities`를 실어 보냅니다.
6. **테스트를 옮깁니다.**
   - `orcaCli.test.ts`, `poller.test.ts`, `stateMapper.test.ts`, `sessionResolver.test.ts`, `usage.test.ts`는 OrcaBackend 기준으로 이동하거나 수정합니다.
   - 가짜 runner를 주입하는 기존 패턴은 유지합니다.

**완료 기준:** `npm test`, `npm run typecheck`가 통과하고 `npm run demo` 화면과 동작이 이전과 같아야 합니다. Orca를 켠 상태의 `npm start`도 수동으로 확인합니다.

---

## M2: 자체 백엔드 `NativeBackend` (Orca 없이, 웹으로만 조작)

**목표:** Orca 없이 `npm start`만으로 웹에서 워크트리를 만들고 Claude 에이전트를 띄우고, 상태를 보고, 대화를 읽고, 지시를 보낼 수 있어야 합니다. 렌더링 작업 전에 어려운 미지수(PTY, 상태 감지)부터 검증하는 단계입니다.

모듈은 `bridge/src/native/` 아래에 둡니다. 각 모듈은 단일 책임이고 단위 테스트가 가능해야 합니다.
- **`ptyHost.ts`**
  - `node-pty`로 spawn·write·resize·kill을 하고, 에이전트마다 `@xterm/headless` Terminal에 출력을 흘려 넣습니다.
  - 제공 API는 `screenLines(id)`, `onData(id, cb)`(M3 TUI·웹 라이브 뷰용), `onExit`입니다.
  - Windows는 ConPTY를 씁니다. 명령 해석은 기존 `resolveWindowsCommand`(`orcaCli.ts`)를 재사용합니다.
- **`registry.ts`**
  - `~/.office-desks/state.json`에 등록 repo, 워크트리 메타(status/comment/displayName), 에이전트 레코드(id, type, cwd, sessionId, startedAt)를 저장합니다.
  - 원자적으로 씁니다(임시 파일 후 rename).
- **`worktrees.ts`**
  - `git worktree list --porcelain`을 파싱하고 `git worktree add -b <name> <path> [base]`를 실행합니다.
  - 경로 규칙은 `~/.office-desks/worktrees/<repo>/<name>`입니다. git 실행은 `gitInfo.ts`의 spawn 패턴을 재사용합니다.
- **`hooks.ts`**
  - Claude spawn 인자를 만듭니다: `--session-id <uuid>`, `--settings '<json>'`.
  - 훅 command는 node 원라이너로 stdin JSON을 `http://127.0.0.1:PORT/hook/<agentId>`에 POST합니다. curl이 없는 Windows를 고려한 선택입니다.
  - 서버에 `/hook/:agentId` 엔드포인트를 둡니다. 접근은 per-agent 랜덤 토큰으로 제한하고, 기존 `security.ts` 원칙을 따릅니다.
  - 이벤트를 상태로 매핑합니다(`stateMapper.mapAgentState`와 같은 규칙).
    - PreToolUse(tool) → reading/running/typing
    - Stop → done
    - Notification → waiting
    - UserPromptSubmit → typing
    - 프롬프트와 마지막 메시지는 훅 payload와 대화 파일에서 채웁니다.
- **`backend/native.ts`**
  - 위 모듈을 조합해 `OfficeBackend`를 구현합니다.
  - `findSession`은 `--session-id`로 경로를 결정적으로 계산합니다. `searchConversations`는 빈 결과를, `usage`는 null을 반환하고, `capabilities`에서 usage와 search는 false입니다.
- **선택 로직(`bin/office-desks.mjs`, `server.ts`)**
  - `--backend native|orca|demo`로 고릅니다. 기본값은 `orca status`가 성공하면 orca, 아니면 native입니다.
- **웹(`web/src`)**
  - capabilities에 따라 사용량 바, 검색, 포커스 버튼을 숨깁니다.
  - "새 작업" 다이얼로그에 native 모드용 "repo 등록(경로 입력)"을 추가합니다.
  - 기존 터미널 화면, 키 입력, 질문 카드 UI는 수정 없이 동작해야 합니다. readScreen 형태가 같기 때문입니다.

**테스트**
- 단위 테스트: registry, porcelain 파서, 훅 이벤트→상태 매핑, spawn 인자 생성. 패턴은 기존 `bridge/test/*.test.ts`를 따릅니다.
- ptyHost 통합 테스트: `node -e` 에코 프로그램을 spawn한 뒤 write → screenLines 확인. macOS CI와 Windows에서 실행합니다.
- `.github/workflows/ci.yml`에 windows 매트릭스가 없으면 추가합니다.

---

## M3: TUI 멀티플렉서 (같은 프로세스)

M3·M4는 개요만 적습니다. M2가 끝나면 별도 spec과 plan을 씁니다.
- `bridge/src/tui/`에서 `ptyHost`의 headless 버퍼를 ANSI로 직접 그리는 자체 렌더러를 만듭니다. Ink 같은 React 계열은 터미널 패널을 그리기에 맞지 않습니다.
- v1 레이아웃: 왼쪽 사이드바(repo → 워크트리 → 에이전트, 상태 아이콘은 웹과 같은 `CharacterState`)와 오른쪽 전체 화면 패널 한 개(선택한 에이전트에 attach, 입력 패스스루)입니다.
- prefix 키(예: `Ctrl-b`)로 패널 전환, 새 에이전트, 새 워크트리, 종료를 처리합니다.
- 분할 패널과 탭은 v2로 미룹니다.
- `office-desks`(인자 없음)를 실행하면 TUI와 웹 서버가 함께 뜹니다. `--no-tui`를 주면 M2처럼 서버만 뜹니다.
- 웹 `/api/focus`는 TUI 포커스를 이동시킵니다.

## M4: 동등성

- 사용량 대안을 조사합니다(statusline 훅의 rate limit 정보 등).
- 우리 에이전트 JSONL에 대한 대화 검색을 붙입니다.
- Codex 상태 감지(Codex hooks 또는 세션 파일 tail)를 붙입니다.
- 앱 재시작 후 세션을 재개합니다(`claude --resume <sessionId>`). 레지스트리에 sessionId가 있어 가능합니다.

---

## 실행 첫 단계 (승인 후)

1. 이 문서를 `docs/superpowers/specs/2026-10-04-native-backend-tui-design.md`로 저장하고 커밋합니다.
2. writing-plans 스킬로 **M1 구현 계획**을 작성합니다.
3. M1 → M2 순으로 진행합니다. M3·M4는 각자 spec과 plan을 따로 만듭니다.

## 검증

- **M1:** `npm test && npm run typecheck`를 실행하고 `npm run demo`를 브라우저로 확인합니다. 화면, 대화, 질문 카드, 보내기가 이전과 같아야 합니다. Orca 실행 상태의 `npm start`도 회귀 확인합니다.
- **M2:** Orca를 끈 상태에서 `npm start -- --backend native`를 실행한 뒤 다음을 확인합니다(macOS 먼저, 이후 Windows).
  1. 웹에서 repo 등록
  2. 새 작업(워크트리+Claude) 생성 후 캐릭터 등장
  3. 프롬프트 전송 → typing/running → done 상태 전이
  4. 대화 패널에 JSONL 내용 표시
  5. 질문 카드 응답
  6. `/usage` 같은 메뉴 키 조작
- **M3:** TUI에서 에이전트를 만들고 attach해 입력하고, 같은 순간 웹 캐릭터가 동기화되는지 봅니다. 앱을 종료하면 PTY도 정리되는지 확인합니다.
