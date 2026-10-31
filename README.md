# opencode Pane

[![build](https://github.com/explainpark101/opencode-pane/actions/workflows/build.yml/badge.svg)](https://github.com/explainpark101/opencode-pane/actions/workflows/build.yml)
[![release](https://github.com/explainpark101/opencode-pane/actions/workflows/release.yml/badge.svg)](https://github.com/explainpark101/opencode-pane/actions/workflows/release.yml)

opencode의 **공식 웹 UI**를 Cursor의 사이드 패널에 도킹하는 로컬 확장입니다.
터미널 pane 대신, `opencode serve`가 제공하는 웹 UI를 Webview 안에 iframe으로 넣습니다.

```
Cursor 오른쪽 패널 (WebviewView)
  └─ iframe → http://127.0.0.1:<proxyPort>/?auth_token=...
       ├─ 확장이 주입한 bridge.js (키보드/드래그 이벤트 → 확장)
       └─ opencode 공식 웹 UI
            └─ /api/* → http://127.0.0.1:<serverPort> (확장이 실행/관리)
```

opencode 웹 UI는 원래 확장 Webview와 **다른 origin**의 iframe이라서 바깥에서 키보드/드래그
이벤트를 가로챌 수 없습니다. 그래서 확장이 `opencode serve` 앞에 로컬 투명 프록시를 두고,
같은 origin으로 서빙되는 HTML에 `bridge.js`를 주입합니다. 프록시는 정적 파일·API·WebSocket을
그대로 전달하며 비밀번호를 새로 넣지 않습니다. (UI가 스스로 `Authorization` 헤더를 붙입니다.)

## 요구 사항

- Windows (로컬)
- Cursor 1.96+ (3.27에서 검증)
- `opencode` 2.2+ (`opencode serve` 지원)
  - `opencode --version`으로 확인
  - PATH에 없으면 설정 `opencode-pane.executablePath`로 지정

## 설치

릴리즈 페이지에서 최신 `.vsix`를 받아 설치하거나, 로컬에서 직접 빌드합니다.

```powershell
# 릴리즈에서 받은 파일 설치
cursor --install-extension opencode-pane-0.3.0.vsix --force

# 또는 로컬 빌드
npm install
npm run build
npm run package
cursor --install-extension opencode-pane-0.3.0.vsix --force
```

설치 후 Cursor를 reload 합니다. (`Developer: Reload Window`)

## 사용

1. Activity Bar의 opencode 아이콘을 클릭합니다.
2. 처음 한 번, Activity Bar 아이콘을 **오른쪽 Secondary Side Bar로 드래그**합니다.
   - 아이콘 우클릭 → `Move View Container To` → `Secondary Side Bar`
   - 또는 `View: Move View` 명령으로 view를 옮길 수 있습니다.
   - Cursor 3.27은 `viewsContainers.secondarySidebar` 기여를 막기 때문에, 최초 1회 드래그가 필요합니다.
3. 이후에는 Cursor 채팅 탭 옆에 opencode 탭으로 유지됩니다.

> 드래그 위치는 Cursor의 레이아웃 상태로 저장되므로 창을 reload해도 유지됩니다.

## 동작 방식

- 뷰를 처음 열 때 `opencode serve --port <port> --hostname 127.0.0.1`를 실행합니다.
  - `cwd`는 첫 번째 workspace 폴더입니다.
  - 비밀번호는 32바이트 랜덤 값을 `SecretStorage`에 저장해 재시작 간에 유지합니다.
  - 기본 포트는 `47821`. 사용 중이면 랜덤 포트로 대체합니다.
- stdout의 `server listening on http://127.0.0.1:<port>`를 파싱하고 `/api/info`로 준비 상태를 확인합니다.
- 서버가 준비되면 로컬 투명 프록시를 띄우고, 그 주소를 iframe `src`로 사용합니다.
  - iframe URL에 `?auth_token=base64url("opencode:<password>")`를 붙여 인증합니다.
  - 프록시가 HTML에 `bridge.js`를 주입해 키보드 단축키, 입력창 삽입, 드래그앤드롭을 중계합니다.
- 뷰를 닫아도 서버는 유지됩니다. (에이전트 작업이 계속 실행될 수 있도록)
- 창 reload / 확장 deactivate 시 프록시와 서버 프로세스 트리를 함께 종료합니다. (`taskkill /T /F`)

## 확인된 동작 (Cursor 3.27.22, Windows)

- Activity Bar에서 뷰를 열면 `onView`로 확장이 활성화되고 `opencode serve --port 47821 --hostname 127.0.0.1`이 spawn됩니다.
- 서버 응답: `/api/info` 200 (opencode 2.2.1), `/` 200 (웹 UI HTML).
- iframe이 UI를 로드하면 Cursor renderer가 서버로 연결(SSE/WebSocket)을 맺는 것을 확인했습니다.
- 창을 reload하면 `deactivate`가 실행되어 서버 프로세스 트리가 종료됩니다.

## 알려진 제한

- Webview의 바깥 iframe sandbox에 `allow-popups`, `allow-modals`가 없습니다. 따라서 opencode UI 안에서 여는 `window.open`(예: OAuth 로그인 팝업)과 네이티브 `alert`/`confirm`은 차단됩니다. 이런 흐름은 `opencode: Open Web UI in Browser`로 우회하세요.
- Cursor(Chromium)는 webview iframe에 `clipboard-read`/`clipboard-write` 권한을 위임하므로, iframe(`allow="clipboard-read; clipboard-write"`) 안의 복사/붙여넣기는 정상 동작합니다. (Firefox 기반은 해당 없음)
- WSL/SSH 원격 폴더는 아직 지원하지 않습니다.

## 에디터 연동

패널을 열어 두면 Cursor의 편집기와 다음처럼 연결됩니다. 단축키는 **패널(iframe)에 포커스가
있어도** `bridge.js`가 이벤트를 잡아서 동작합니다.

**1) 세션은 현재 프로젝트 기준**

- `opencode serve`는 첫 번째 워크스페이스 폴더를 cwd로 실행되고, `GET /api/location`도 그 폴더를 반환합니다.
  따라서 웹 UI에서 새 세션을 만들면 항상 현재 열려 있는 프로젝트에 속합니다.
- `Ctrl+Alt+N` (`opencode: New Session in Current Project`)은 현재 프로젝트에 세션을 만들고
  패널을 `/server/<key>/session/<id>`로 이동시킵니다.
- Cursor에서 워크스페이스 폴더를 바꾸면 서버를 자동으로 재시작해 cwd를 새 프로젝트로 맞추고,
  이전 프로젝트의 서버/라우트 상태를 지운 뒤 패널을 홈으로 되돌립니다.
  (패널을 열 때 cwd가 어긋나 있어도 자동으로 재시작합니다.)

**2) 현재 파일/선택 영역 첨부**

- 편집기에서 `Ctrl+Alt+K` (`opencode: Attach Current File / Selection`)를 누르면
  `@src/foo.ts#L12-30` 형식의 참조가 **채팅 입력창에 바로 삽입**됩니다.
- 선택 영역이 없으면 `@src/foo.ts`만 삽입됩니다.
- 아직 세션이 열려 있지 않으면 현재 프로젝트에 새 세션을 만든 뒤 그 입력창에 삽입합니다.
- 삽입에 실패하면(브리지 로드 전 등) 참조를 클립보드에 복사하고 상태바로 알려 줍니다.
  이때는 패널 입력창에서 `Ctrl+V`로 붙여넣으면 됩니다.

**3) 파일 드래그앤드롭**

- Cursor Explorer나 파일 탐색기에서 파일을 끌어다 **opencode 채팅 입력창 위에 놓으면**
  워크스페이스 기준 `@경로` 참조로 삽입됩니다.
- 여러 파일을 한 번에 놓으면 공백으로 구분해 모두 삽입합니다.
- 드래그 중에는 "Drop files to attach to opencode" 안내 오버레이가 표시됩니다.
- 경로를 읽을 수 없는 형식이면 클립보드 fallback 대신 경고를 표시합니다.

**4) opencode의 파일 수정을 Cursor diff로 검토**

- `Ctrl+Alt+D` (`opencode: Review Changes in Editor`)를 누르면 현재 프로젝트의 최신 세션에서
  opencode가 바꾼 파일들을 Cursor의 네이티브 diff 편집기로 엽니다.
- 왼쪽은 `GET /api/session/:id/diff`의 패치를 역적용해 복원한 **수정 전** 내용, 오른쪽은 **지금 디스크의 파일**입니다.
  그래서 diff 편집기의 되돌리기 화살표로 hunk 단위 부분 취소(= 거절)가 그대로 동작합니다.
- 패치를 역적용할 수 없는 파일은 `.diff` 텍스트로 대신 열고 로그에 남깁니다.

## 명령

| 명령 | 단축키 | 설명 |
| --- | --- | --- |
| `opencode: Open opencode Pane` | `Ctrl+Alt+O` | 패널 열기 |
| `opencode: New Session in Current Project` | `Ctrl+Alt+N` | 현재 프로젝트에 새 세션을 만들고 이동 |
| `opencode: Attach Current File / Selection` | `Ctrl+Alt+K` | `@경로#L구간`을 채팅 입력창에 삽입 |
| `opencode: Review Changes in Editor` | `Ctrl+Alt+D` | 최신 세션의 파일 변경을 diff로 열기 |
| `opencode: Restart opencode Server` | | 서버 재시작 |
| `opencode: Stop opencode Server` | | 서버 중지 |
| `opencode: Show Logs` | | 출력 채널 보기 |
| `opencode: Open Web UI in Browser` | | 인증 URL을 외부 브라우저로 열기 |
| `opencode: Open TUI in Terminal` | | 터미널에서 TUI 실행 (fallback) |
| `opencode: Open Settings` | | 확장 설정 열기 |

## 설정

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `opencode-pane.executablePath` | `""` | `opencode` 실행 파일 경로. 비우면 PATH에서 찾습니다. |
| `opencode-pane.port` | `47821` | 선호 포트. `0`이면 랜덤. 사용 중이면 랜덤으로 대체. |
| `opencode-pane.extraArgs` | `[]` | `opencode serve`에 추가할 인자. |

## 트러블슈팅

**"opencode could not start"**

- `opencode --version`이 2.2+인지 확인합니다.
- `opencode serve --port 47821 --hostname 127.0.0.1`를 터미널에서 직접 실행해 보세요.
- `opencode: Show Logs`로 stderr를 확인합니다.

**웹 UI가 비어 있거나 인증 오류가 납니다**

- `opencode: Restart opencode Server`를 실행합니다.
- 다른 opencode 서버가 같은 포트를 쓰고 있다면 `opencode-pane.port`를 바꿉니다.
- Webview DevTools: `Developer: Open Webview Developer Tools`

**오른쪽 패널로 드래그가 안 됩니다**

- 아이콘 우클릭 → `Move View Container To` 메뉴를 사용합니다.
- Cursor 버전에 따라 Secondary Side Bar로의 이동이 제한될 수 있습니다. 이 경우 Activity Bar에 두고 사용하세요.

**패널에 포커스가 있을 때 `Ctrl+Alt+N` / `Ctrl+Alt+K`가 안 됩니다**

- 0.3.0 이상인지 확인하고 `Developer: Reload Window`를 실행합니다.
- `opencode: Show Logs`에 `[proxy]` 줄이 있는지 확인합니다. 프록시가 뜨지 않으면 패널에
  "The local keyboard and drag-and-drop bridge could not start" 안내가 표시됩니다.
- Webview DevTools(`Developer: Open Webview Developer Tools`)에서 iframe 콘솔에
  `bridge.js` 로드 오류가 없는지 확인합니다.

**파일 드래그앤드롭이 안 됩니다**

- Cursor Explorer에서 파일을 끌어 **채팅 입력창 위**에 놓아야 합니다. 터미널 텍스트나
  편집기 선택 영역을 끌면 경로가 전달되지 않습니다.
- 경로를 읽을 수 없으면 경고가 표시됩니다. 이때는 `Ctrl+Alt+K` 또는 클립보드 붙여넣기를 사용하세요.

**원격(WSL/SSH)에서 사용**

- 아직 지원하지 않습니다. 로컬 폴더로 열어 주세요.

## 개발

```powershell
npm run watch      # esbuild watch
npm run typecheck  # tsc --noEmit
npm run test       # diff 역적용/리뷰 단위 테스트 + 프록시/브리지 + 실제 서버 API + mocked-vscode 하네스
npm run smoke      # opencode serve + /api/info + 웹 UI 확인
npm run smoke -- --chrome  # headless Chrome으로 렌더링까지 확인
npm run package
```

## CI / 릴리즈

GitHub Actions 워크플로우 두 개가 있습니다.

**`.github/workflows/build.yml`** — `main` push / PR / 수동 실행

1. `npm ci` → `npm run typecheck`
2. `node scripts/test-integration.mjs --skip-api` (diff 역적용 + 네이티브 diff 리뷰 + 프록시/브리지 단위 테스트)
3. `npm run package` → `opencode-pane-<version>.vsix`를 아티팩트로 업로드 (30일 보관)
4. 수동 실행 시 `run_integration`을 켜면 opencode를 설치해 실제 `opencode serve` 통합 테스트까지 실행

**`.github/workflows/release.yml`** — `v*` 태그 push (또는 수동 실행)

1. 태그와 `package.json`의 `version`이 일치하는지 검증 (불일치 시 실패)
2. typecheck + 단위 테스트 + 패키징
3. `.vsix`와 `.sha256`을 첨부해 GitHub Release 자동 생성 (릴리즈 노트 자동 생성)

릴리즈 절차:

```powershell
npm version 0.3.0 --no-git-tag-version   # package.json 버전 올리기
git commit -am "chore: 0.3.0"
git tag v0.3.0
git push origin main --tags              # 태그가 올라가면 release 워크플로우가 실행됩니다
```

## 라이선스

MIT
