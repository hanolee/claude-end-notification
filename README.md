# claude-end-notification

Claude Code가 **작업을 끝냈을 때**와 **질문·권한을 요청할 때** macOS·Windows
시스템 알림을 띄워주는 Claude Code 플러그인.

긴 작업을 돌려놓고 다른 창으로 넘어가도, 돌아와야 할 때를 OS 알림으로 알려줍니다.

| 상황 | 트리거 | 알림 예시 |
|------|--------|-----------|
| 한 턴의 작업 완료 | `Stop` 훅 | ✅ Claude Code · my-app — 작업을 마쳤어요 |
| 권한 요청 | `Notification` (`permission_prompt`) | 🔐 Claude Code · my-app — Bash 실행 권한을 기다리는 중이에요 |
| 입력 대기 / 질문 | `Notification` (`idle_prompt` / `elicitation_dialog`) | 💬 Claude Code · my-app — 입력을 기다리고 있어요 |
| 토큰 한도로 중단 | `Stop` (`stop_reason: max_tokens`) | ⚠️ Claude Code · my-app — 토큰 한도로 응답이 중단됐어요 |

추가 의존성은 없습니다. macOS는 `osascript`, Windows는 PowerShell 네이티브
토스트를 사용하며, `terminal-notifier`(macOS)나 `BurntToast`(Windows)가 설치돼
있으면 자동으로 그쪽을 우선 사용합니다.

---

## 설치

이 저장소는 플러그인이면서 동시에 마켓플레이스입니다.

```
/plugin marketplace add hanolee/claude-end-notification
/plugin install claude-end-notification@hano-tools
```

로컬에서 바로 테스트하려면 저장소 경로를 그대로 추가하면 됩니다.

```
/plugin marketplace add /Users/hano/dev/my/claude-end-notification
/plugin install claude-end-notification@hano-tools
```

설치 후 Claude Code를 재시작하면 훅이 활성화됩니다.

---

## 설정

`config.example.json`이 기본값입니다. 값을 바꾸려면 이 파일을 `config.json`으로
복사해 수정하세요. 플러그인은 다음 순서로 설정을 찾습니다.

1. `${CLAUDE_PLUGIN_DATA}/config.json` — 플러그인 업데이트 후에도 유지됨 (권장)
2. `<플러그인 루트>/config.json`
3. `<플러그인 루트>/config.example.json` — 기본값

| 키 | 기본값 | 설명 |
|----|--------|------|
| `enabled` | `true` | 전체 on/off 마스터 스위치 |
| `events.stop` | `true` | 작업 완료 알림 on/off |
| `events.notification` | `true` | 질문·권한 알림 on/off |
| `notificationTypes.*` | 일부 `true` | `Notification` 세부 타입별 on/off (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `auth_success` 등) |
| `sound` | `"default"` | 알림음 이름. `"none"`이면 무음. macOS는 `"Glass"` 같은 시스템 사운드명도 가능 |
| `skipWhenFocused` | `false` | 터미널 창이 최전면이면 알림 생략 (노이즈 감소, **켜는 것을 권장**) |
| `focusedApps` | 터미널 앱 목록 | "터미널"로 간주할 앱/프로세스 이름 (대소문자 무시) |
| `cooldownSeconds` | `0` | 직전 작업 완료 알림 후 이 시간(초) 안에는 재알림 억제. 질문·권한 알림은 항상 표시 |
| `macBackend` | `"auto"` | `auto` \| `osascript` \| `terminal-notifier` |
| `winBackend` | `"auto"` | `auto` \| `powershell` \| `burnttoast` |

> 💡 `Stop` 훅은 **턴이 끝날 때마다** 발생합니다. 알림이 많다고 느껴지면
> `skipWhenFocused: true`로 두거나 `cooldownSeconds`를 늘리세요.

---

## 플랫폼별 참고

### macOS
- 기본 백엔드 `osascript`로 띄운 알림은 시스템에서 **"스크립트 편집기(Script
  Editor)"** 이름으로 표시됩니다. 알림이 보이지 않으면
  *시스템 설정 → 알림*에서 해당 항목의 알림을 허용하세요.
- 더 나은 UX(전용 아이콘, 클릭 동작 등)를 원하면 `terminal-notifier`를
  설치하세요. 설치돼 있으면 자동으로 사용합니다.
  ```
  brew install terminal-notifier
  ```
- `assets/icon.png`를 두면 `terminal-notifier` 사용 시 아이콘으로 적용됩니다.

### Windows
- 기본은 PowerShell 네이티브 토스트입니다. 더 안정적인 토스트를 원하면
  `BurntToast` 모듈을 설치하세요. 설치돼 있으면 자동으로 사용합니다.
  ```powershell
  Install-Module -Name BurntToast -Scope CurrentUser
  ```

### Linux
- 베스트에포트로 `notify-send`를 사용합니다(있을 때만). 1차 지원 대상은 아닙니다.

---

## 동작 확인 / 디버깅

Claude Code 없이 훅 스크립트를 직접 테스트할 수 있습니다.

```bash
echo '{"cwd":"/tmp/demo","stop_reason":"end_turn"}' | node scripts/notify.js stop

echo '{"cwd":"/tmp/demo","notification_type":"permission_prompt","notification_data":{"tool_name":"Bash"}}' \
  | node scripts/notify.js notification
```

`CEN_DEBUG=1` 환경변수를 주면 어떤 판단을 했는지 stderr로 출력합니다.

```bash
echo '{}' | CEN_DEBUG=1 node scripts/notify.js stop
```

스크립트는 **항상 exit 0**이며 stdout에는 아무것도 출력하지 않습니다. 알림이
실패해도 Claude의 턴을 막거나 오류를 내지 않습니다.

---

## 구조

```
claude-end-notification/
├── .claude-plugin/
│   ├── plugin.json          # 플러그인 메타데이터
│   └── marketplace.json     # 단일 저장소 마켓플레이스 정의
├── hooks/
│   └── hooks.json           # Stop / Notification 훅 등록
├── scripts/
│   └── notify.js            # 크로스플랫폼 알림 디스패처 (Node, 의존성 없음)
├── assets/                  # (선택) icon.png
├── config.example.json      # 기본 설정 / 설정 템플릿
├── 기획서.md                # 설계 문서
└── README.md
```

자세한 설계 배경은 [`기획서.md`](./기획서.md)를 참고하세요.

## 라이선스

MIT
