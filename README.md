# 클로드 타운 (Claude Town)

내 컴퓨터에서 도는 Claude Code 세션과 서브에이전트를 2D 픽셀 사무실로 보여주는 로컬 도구입니다.
일하는 세션은 책상에 앉고, 답을 기다리는 세션은 호출 벨 앞에 서고, 끝난 세션은 휴게실에서 쉽니다.

> A tiny local app that shows your running Claude Code sessions and subagents as pixel characters in an office. Working sessions sit at desks, blocked ones ring the bell, finished ones chill in the lounge. Read-only, localhost-only, zero dependencies. The UI is in Korean for now; translations are welcome.

![클로드 타운 화면](docs/screenshot.png)

이 프로젝트는 Anthropic 과 관련이 없는 비공식 개인 프로젝트입니다. (Unofficial. Not affiliated with or endorsed by Anthropic.)

## 필요한 것

- macOS (브라우저로만 볼 거라면 Node 가 도는 어떤 OS 든 됩니다)
- Node.js 18 이상. 설치할 패키지는 없습니다.
- Claude Code. 백그라운드 세션(`claude --bg`)을 쓰면 하는 일 요약, 토큰 수, PR 링크까지 나옵니다. 터미널에서 직접 연 세션만 있다면 캐릭터는 나오지만 정보가 적습니다.
- 맥 앱으로 만들려면 Xcode Command Line Tools (`xcode-select --install`)

## 시작하기

```bash
git clone https://github.com/unknownstarter/claude-town.git
cd claude-town

# 방법 1: 브라우저로 보기
node server.mjs          # http://localhost:4777 을 엽니다

# 방법 2: 맥 앱으로 만들기 (독립 창, 항상 위에 두기 가능)
./build-app.sh           # "클로드 타운.app" 이 생깁니다
open "클로드 타운.app"
```

- VS Code 나 Cursor 안에서 보려면 서버를 켠 뒤 명령 팔레트의 "Simple Browser: Show" 에 `http://localhost:4777` 을 넣습니다.
- 주소 끝에 `?demo=1` 을 붙이면 가짜 세션으로 모든 자리와 가구를 미리 볼 수 있습니다.
- 앱 메뉴 "보기"에 "항상 위에 두기"(Cmd+T)와 "작은 창으로"(Cmd+1)가 있습니다.
- 앱은 직접 빌드해서 쓰는 방식입니다. 서명되지 않은 앱이라 빌드한 컴퓨터에서만 바로 열립니다.

## 화면 읽는 법

| 장소 | 뜻 |
| --- | --- |
| 작업실 책상 | 일하는 중인 세션입니다. 말풍선은 지금 하는 일, 대괄호는 최근에 쓴 도구입니다. |
| 책상 옆 작업모 쓴 조수 | 그 세션이 부른 서브에이전트입니다. 둘까지 그리고 나머지는 이름표에 +N 으로 표시합니다. 누르면 맡은 일이 나옵니다. |
| 빨간 카펫(호출 벨) | 사용자의 답을 기다리며 멈춰 있는 세션입니다. 탭 제목에도 숫자가 뜹니다. |
| 휴게실 | 끝난 세션입니다. TV 소파, 벽난로 옆 소파, 오락기, 빈백에 나눠 앉습니다. 하루 안에 끝났으면 깨어 있고, 오래됐으면 잡니다. 이름표는 마우스를 올리면 나옵니다. |
| 왕관 | 백그라운드 작업이 아니라 터미널에서 직접 연 세션입니다. |

- 칸반 보드의 쪽지 수, 서버 랙의 깜빡임 속도, 벽시계, 창밖 하늘은 실제 상태와 시각을 따릅니다.
- 오른쪽 위 "캐릭터: 도트 / 기본" 버튼으로 MetroCity 도트 캐릭터와 코드로 그린 기본 캐릭터를 오갑니다.
- 캐릭터를 누르면 받은 요청, 토큰 수(레벨), PR 링크가 나오고 별명, 몸, 머리, 옷을 바꿀 수 있습니다. 꾸민 내용은 그 창에 저장됩니다.
- 화면에서 사용자를 부르는 호칭은 기본이 "마스터"입니다. 주소에 `?owner=대장` 처럼 붙이면 바뀌고 그 뒤로 기억합니다.

## 동작 원리와 안전

```
~/.claude/jobs/*/state.json      세션 상태, 하는 일 요약, 토큰 수, PR 링크
~/.claude/sessions/*.json        살아 있는 프로세스
~/.claude/projects/**/*.jsonl    최근에 쓴 도구, 서브에이전트 기록
        │  (읽기만 함)
        ▼
server.mjs  →  GET /api/sessions  →  index.html 이 2초마다 받아 캔버스에 그림
```

- 읽기 전용입니다. `~/.claude` 에 아무것도 쓰지 않고, 세션을 끄거나 켜지도 않습니다. 대신 캐릭터 패널에 `claude attach`, `claude logs`, `claude stop` 명령을 복사 버튼으로 보여줍니다.
- 서버는 `127.0.0.1` 에만 열리고, 다른 호스트 이름으로 온 요청은 거절합니다. 데이터는 컴퓨터 밖으로 나가지 않습니다(글꼴만 CDN 에서 받습니다).
- 위 파일들은 Claude Code 의 공개 규격이 아닙니다. Claude Code 2.1.27x 에서 확인했으며, 버전이 오르면 `server.mjs` 의 읽는 부분을 손봐야 할 수 있습니다.
- 도구 호출은 끝난 뒤에야 기록되므로 "실행 중인 도구"가 아니라 "최근에 쓴 도구"를 보여줍니다. 서브에이전트는 최근 90초 안에 기록이 있으면 일하는 중으로 봅니다.

## 고쳐 쓰기

| 파일 | 역할 |
| --- | --- |
| `server.mjs` | `~/.claude` 를 읽어 JSON 으로 내보내는 서버 |
| `index.html` | 화면 전부(배치, 가구, 캐릭터, 패널). 빌드 단계가 없습니다 |
| `app/main.swift`, `build-app.sh` | 서버를 띄우고 화면을 WKWebView 로 보여주는 맥 앱 |
| `assets/` | MetroCity 캐릭터와 가구 조각 |

`server.mjs` 나 `index.html` 을 고친 뒤에는 `./build-app.sh` 를 다시 돌려야 앱에 반영됩니다. 브라우저로 볼 때는 새로 고침만 하면 됩니다.

해보면 좋을 것들: 영어 등 다른 언어, Windows 와 Linux 용 창, 새 가구와 방, 세션별 고정 자리, 다른 코딩 에이전트 지원.

## 에셋과 라이선스

- 코드: MIT (`LICENSE`)
- 캐릭터와 가구 그림: JIK-A-4 의 [MetroCity Free Top Down Character Pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) 과 [MetroCity Free Top Down Interior](https://jik-a-4.itch.io/metrocity), 둘 다 CC0. 표기 의무는 없지만 고마운 마음으로 밝혀 둡니다. 자세한 내용은 `assets/*/CREDITS.txt` 에 있습니다.
- 오락기, 자판기, 수족관, 서버 랙, 정수기, 고양이, 네온사인, 칸반 보드는 코드로 직접 그린 것입니다.
- 글꼴: [Galmuri](https://github.com/quiple/galmuri) (OFL-1.1), CDN 에서 불러옵니다.
- 기획과 방향은 사람이, 코드는 Claude Code 가 썼습니다.
