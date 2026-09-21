# 기여 안내 (Contributing)

[English below](#english)

기여해 주셔서 고맙습니다. 이 저장소는 관리자 한 명이 검토하고 머지합니다. 누구나 제안할 수 있고, 반영 여부는 관리자가 결정합니다.

## 기여하는 순서

1. 큰 변경이라면 먼저 Issue 를 열어 방향을 이야기합니다. 작은 수정은 바로 PR 을 보내도 됩니다.
2. 이 저장소를 Fork 하고, 내 Fork 에서 브랜치를 만듭니다(예: `feat/english-ui`).
3. 고친 뒤 확인합니다.
   - `node server.mjs` 를 켜고 `http://localhost:4777/?demo=1` 에서 화면이 깨지지 않는지 봅니다.
   - 앱 쪽을 고쳤다면 `./build-app.sh` 가 끝까지 도는지 봅니다.
4. `main` 을 향해 Pull Request 를 엽니다. 화면이 바뀌면 스크린샷을 붙여 주세요.

## 지켜 주세요

- **의존성 없음을 유지합니다.** npm 패키지나 빌드 단계를 추가하지 않습니다.
- **로컬 전용과 안전 장치를 유지합니다.** `~/.claude` 에 직접 쓰거나, 세션 정보를 컴퓨터 밖으로 보내는 변경은 받지 않습니다. 세션 제어는 공식 `claude` 명령만 부르고, 토큰 검사와 상태 확인, 확인 창을 없애지 않습니다. 내부 소켓이나 비공개 규격으로 권한 요청에 대신 답하는 변경은 받지 않습니다.
- **그림 에셋은 CC0 또는 직접 그린 것만** 받습니다. 출처와 라이선스를 `CREDITS.txt` 에 적어 주세요. 재배포가 금지된 유료 팩은 넣을 수 없습니다.
- 한 PR 에는 한 가지 목적만 담습니다.
- 기여한 코드는 이 저장소의 MIT 라이선스로 배포되는 데 동의하는 것으로 봅니다.



<a id="english"></a>

# Contributing

Thank you for contributing. This repository has a single maintainer who reviews and merges. Anyone can propose changes. The maintainer decides what goes in.

## How to contribute

1. For larger changes, open an Issue first to discuss the direction. Small fixes can go straight to a PR.
2. Fork this repository and create a branch in your fork (for example `feat/english-ui`).
3. Check your change.
   - Run `node server.mjs` and open `http://localhost:4777/?demo=1` to make sure the scene still renders.
   - If you touched the app, make sure `./build-app.sh` completes.
4. Open a Pull Request against `main`. Attach a screenshot for visual changes.

## Ground rules

- **Keep it dependency-free.** No npm packages, no build step.
- **Keep it local-only and keep the guards.** Changes that write to `~/.claude` directly or send session data off the machine will not be accepted. Session control must only call official `claude` commands and must keep the token check, state validation and confirmation dialogs. Changes that answer permission prompts through internal sockets or private formats will not be accepted.
- **Art assets must be CC0 or your own work.** Record the source and license in a `CREDITS.txt`. Paid packs that forbid redistribution cannot be included.
- One purpose per PR.
- By contributing you agree that your code is distributed under this repository's MIT license.
