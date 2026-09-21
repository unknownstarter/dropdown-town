# Dropdown Town

**내 컴퓨터에서 일하는 Claude Code 세션들을 픽셀 사무실로 구경하는 앱** (앱 안에서의 이름은 "클로드 타운"입니다)

**Watch your Claude Code sessions work in a tiny pixel office.** [English guide below](#english)

![Dropdown Town 화면](docs/screenshot.png)

> 지금은 **macOS 전용**입니다. Anthropic 과 관련 없는 비공식 개인 프로젝트입니다.



## 한국어

### 이게 뭔가요

Claude Code 로 여러 세션을 동시에 돌리다 보면 누가 일하고 있고 누가 내 답을 기다리는지 놓치기 쉽습니다. Dropdown Town 은 그 세션들을 픽셀 캐릭터로 바꿔 사무실 한 장면으로 보여줍니다.

| 어디에 있나 | 무슨 뜻인가 |
| --- | --- |
| 작업실 책상 | 일하는 중입니다. 말풍선에 지금 하는 일과 최근에 쓴 도구가 나옵니다. |
| 책상 옆 작업모 쓴 조수 | 그 세션이 부른 서브에이전트입니다. |
| 빨간 카펫의 호출 벨 | 내 답을 기다리며 멈춰 있습니다. 가장 먼저 챙겨야 할 세션입니다. |
| 휴게실 | 일을 끝냈습니다. 소파에서 TV 를 보거나, 오락기를 하거나, 오래됐으면 잡니다. |
| 왕관 | 터미널에서 내가 직접 연 세션입니다. |

캐릭터를 누르면 받은 요청, 토큰 수(레벨), PR 링크가 나오고 별명과 생김새를 바꿀 수 있습니다.


### 설치하기

**1단계. 준비물 확인**

| 준비물 | 확인 방법 | 없다면 |
| --- | --- | --- |
| macOS | | 지금은 맥에서만 됩니다 |
| Node.js 18 이상 | 터미널에 `node -v` | [nodejs.org](https://nodejs.org) 에서 설치 |
| Claude Code | 터미널에 `claude --version` | [설치 안내](https://claude.com/claude-code) |
| Xcode 명령어 도구 (앱으로 만들 때만) | 터미널에 `xcode-select -p` | `xcode-select --install` |

따로 설치할 패키지는 없습니다.

**2단계. 내려받기**

```bash
git clone https://github.com/unknownstarter/dropdown-town.git
cd dropdown-town
```

**3단계. 실행하기 (둘 중 하나)**

방법 A. 맥 앱으로 쓰기 (추천)

```bash
./build-app.sh
open "클로드 타운.app"
```

- 폴더에 `클로드 타운.app` 이 생깁니다. 응용 프로그램 폴더나 Dock 으로 끌어다 놓으면 됩니다.
- 메뉴 "보기"에서 **항상 위에 두기**(Cmd+T), **작은 창으로**(Cmd+1)를 쓸 수 있습니다. 코드 편집기 옆에 띄워 두기 좋습니다.

방법 B. 브라우저로 보기

```bash
node server.mjs
```

- 브라우저에서 `http://localhost:4777` 을 엽니다.
- VS Code 나 Cursor 안에서 보려면 명령 팔레트의 "Simple Browser: Show" 에 같은 주소를 넣습니다.

**4단계. 잘 되는지 보기**

- Claude Code 세션이 하나도 없으면 사무실이 비어 있습니다. 주소 끝에 `?demo=1` 을 붙이면(`http://localhost:4777/?demo=1`) 가짜 세션으로 전체 모습을 볼 수 있습니다.
- 백그라운드 세션(`claude --bg "시킬 일"`)을 쓰면 하는 일 요약과 토큰 수까지 나옵니다. 터미널에서 직접 연 세션만 있으면 캐릭터는 나오지만 정보가 적습니다.


### 자주 막히는 곳

| 증상 | 해결 |
| --- | --- |
| 앱을 열었는데 "서버와 연결이 끊겼어요" | Node 를 설치하거나 바꾼 뒤라면 `./build-app.sh` 를 다시 실행합니다(앱이 Node 위치를 빌드할 때 기억합니다). |
| 4777 포트를 이미 쓰고 있다 | `PORT=5000 node server.mjs` 처럼 다른 포트로 띄웁니다. |
| 코드를 고쳤는데 앱에 반영이 안 된다 | `./build-app.sh` 를 다시 실행합니다. 브라우저로 볼 때는 새로 고침이면 됩니다. |
| 호칭 "마스터"를 바꾸고 싶다 | 주소에 `?owner=대장` 처럼 붙이면 바뀌고 그 뒤로 기억합니다. |
| 예전 기본 캐릭터가 더 좋다 | 오른쪽 위 "캐릭터: 도트 / 기본" 버튼을 누릅니다. |


### 안전한가요

- **읽기만 합니다.** `~/.claude` 폴더의 세션 상태 파일을 읽을 뿐 아무것도 쓰지 않고, 세션을 끄거나 켜지도 않습니다. 대신 캐릭터 패널에 `claude attach`, `claude logs`, `claude stop` 명령을 복사 버튼으로 보여줍니다.
- **내 컴퓨터 안에서만 돕니다.** 서버는 `127.0.0.1` 에만 열리고 세션 정보는 밖으로 나가지 않습니다(글꼴만 CDN 에서 받습니다).
- 읽는 파일들은 Claude Code 의 공개 규격이 아닙니다. Claude Code 2.1.27x 에서 확인했고, 버전이 오르면 `server.mjs` 를 손봐야 할 수 있습니다.


### 로드맵

이 프로젝트의 목표는 **가상 오피스를 기반으로, 어디서든 내 세션에 접근하는 것**입니다. 지금은 그 첫걸음입니다.

| 단계 | 내용 | 상태 |
| --- | --- | --- |
| 1 | 내 맥에서 도는 세션과 서브에이전트를 사무실로 구경하기 | 지금 여기 |
| 2 | 사무실 안에서 세션 다루기 (이어서 보기, 멈추기, 새 일 시키기) | 예정 |
| 3 | 사무실 안에 시뮬레이터(웹, 앱)와 브라우저 넣기. 에이전트가 만든 결과를 그 자리에서 확인 | 예정 |
| 4 | 어디서든 접근. 휴대폰이나 다른 컴퓨터에서 내 사무실에 들어가기 | 예정 |
| 5 | Windows, Linux 지원과 다국어 | 예정 |


### 기여, 라이선스, 크레딧

- 기여는 언제나 환영합니다. 방법은 [CONTRIBUTING.md](CONTRIBUTING.md) 에 있습니다.
- 코드는 MIT 라이선스입니다([LICENSE](LICENSE)). 에셋과 글꼴의 라이선스는 [NOTICE.md](NOTICE.md) 에 정리했습니다.
- 캐릭터와 가구 그림은 JIK-A-4 의 [MetroCity 캐릭터 팩](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)과 [MetroCity 인테리어 팩](https://jik-a-4.itch.io/metrocity)이며 둘 다 CC0 입니다. 오락기, 자판기, 수족관, 서버 랙, 고양이, 네온사인은 코드로 직접 그렸습니다.
- 글꼴은 [Galmuri](https://github.com/quiple/galmuri)(OFL-1.1)입니다.
- 기획과 방향은 사람이, 코드는 Claude Code 가 썼습니다.



<a id="english"></a>

## English

### What is this

When you run several Claude Code sessions at once, it is easy to lose track of who is working and who is waiting for you. Dropdown Town turns those sessions into pixel characters in a small office.

| Where they are | What it means |
| --- | --- |
| At a desk in the work room | Working. The bubble shows what it is doing and the last tool it used. |
| Hard-hat helper next to a desk | A subagent spawned by that session. |
| Red carpet by the bell | Blocked, waiting for your answer. Check these first. |
| Lounge | Finished. Watching TV, playing the arcade, or asleep if it has been a while. |
| Crown | A session you opened yourself in a terminal. |

Click a character to see its prompt, token count (shown as a level), PR links, and to change its nickname and look. The UI is in Korean for now. Translations are welcome.

> **macOS only** for now. Unofficial project, not affiliated with or endorsed by Anthropic.


### Install

**Step 1. Check requirements**

| You need | How to check | If missing |
| --- | --- | --- |
| macOS | | macOS only for now |
| Node.js 18+ | `node -v` | Install from [nodejs.org](https://nodejs.org) |
| Claude Code | `claude --version` | [Install guide](https://claude.com/claude-code) |
| Xcode Command Line Tools (only to build the app) | `xcode-select -p` | `xcode-select --install` |

There are no packages to install.

**Step 2. Download**

```bash
git clone https://github.com/unknownstarter/dropdown-town.git
cd dropdown-town
```

**Step 3. Run (pick one)**

Option A. As a Mac app (recommended)

```bash
./build-app.sh
open "클로드 타운.app"
```

- This creates `클로드 타운.app` in the folder. Drag it to Applications or the Dock.
- The View menu has **Always on top** (Cmd+T) and **Compact window** (Cmd+1), handy next to your editor.

Option B. In a browser

```bash
node server.mjs
```

- Open `http://localhost:4777`.
- Inside VS Code or Cursor, run "Simple Browser: Show" from the command palette with the same URL.

**Step 4. Check that it works**

- With no Claude Code sessions the office is empty. Add `?demo=1` to the URL (`http://localhost:4777/?demo=1`) to see it filled with fake sessions.
- Background sessions (`claude --bg "your task"`) show a summary of the work and token counts. Sessions opened directly in a terminal still appear, with less detail.


### Troubleshooting

| Symptom | Fix |
| --- | --- |
| The app says it cannot reach the server | If you installed or changed Node, run `./build-app.sh` again. The app remembers the Node path at build time. |
| Port 4777 is taken | Use another port: `PORT=5000 node server.mjs` |
| Code changes do not show up in the app | Run `./build-app.sh` again. In a browser, just reload. |
| You want a different title than "마스터" | Add `?owner=Boss` to the URL. It is remembered afterwards. |
| You prefer the simple built-in characters | Click the "캐릭터" button at the top right. |


### Is it safe

- **Read-only.** It reads session state files under `~/.claude`, writes nothing, and never starts or stops sessions. The character panel shows `claude attach`, `claude logs` and `claude stop` commands with copy buttons instead.
- **Local only.** The server binds to `127.0.0.1` and no session data leaves your machine. Only the font is loaded from a CDN.
- The files it reads are not a public Claude Code format. Verified on Claude Code 2.1.27x. A future version may require changes in `server.mjs`.


### Roadmap

The goal is **access to your sessions from anywhere, built around a virtual office**. This is the first step.

| Stage | What | Status |
| --- | --- | --- |
| 1 | Watch local sessions and subagents in the office | You are here |
| 2 | Control sessions from the office (attach, stop, start new work) | Planned |
| 3 | Simulators (web, app) and a browser inside the office, to check what agents built on the spot | Planned |
| 4 | Access from anywhere: enter your office from a phone or another computer | Planned |
| 5 | Windows and Linux support, more languages | Planned |


### Contributing, license, credits

- Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
- Code is MIT licensed ([LICENSE](LICENSE)). Asset and font licenses are summarized in [NOTICE.md](NOTICE.md).
- Character and furniture art is by JIK-A-4: the [MetroCity character pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) and the [MetroCity interior pack](https://jik-a-4.itch.io/metrocity), both CC0. The arcade cabinets, vending machine, aquarium, server rack, cat and neon sign are drawn in code.
- Font: [Galmuri](https://github.com/quiple/galmuri) (OFL-1.1).
- Direction and design by a human, code written with Claude Code.
