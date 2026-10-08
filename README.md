# Markdown Chroma

VS Code의 기본 Markdown Preview에서 Obsidian과 MyST 문법을 함께 렌더링하는 확장입니다.

## MyST / Jupyter Book 2 문법

**VS Code 기본 Markdown Preview**에서 MyST를 바로 렌더링합니다. `myst.yml`이 있으면 가장 가까운 설정의 `project` 값(수식 매크로·번호 매기기·abbreviations·bibliography·parser 옵션)을 읽고, 없으면 기본값을 사용합니다. 문서 frontmatter가 프로젝트 값을 덮어쓰며, 로컬 `extends`도 지원합니다. 프로젝트 생성, 별도 서버, Node/npm 설치가 필요하지 않습니다. 저장 전 편집 내용도 기본 Preview에 반영됩니다. 공식 `myst-parser 1.7.4`와 `myst-transforms` 및 공식 directive 확장을 확장 안에 포함하고, 결과 AST를 VS Code Preview용 HTML로 표시합니다. 별도 Markdown editor는 제공하지 않습니다.

| Authoring 문법 | 기본 Preview에서의 동작 |
| --- | --- |
| Typography / Blocks / Inline Options | role, directive의 YAML·colon·인라인 옵션, 라벨, div/span, 주석, 블록 메타데이터 |
| Callouts & Admonitions | 중첩 callout, dropdown 접기 |
| Images, Figures & Videos | 이미지 크기·정렬, 캡션·번호·참조, MP4, 로컬 이미지 wildcard |
| Math & Equations | KaTeX 수식, 레이블과 식 참조 |
| Tables / Code | 표, list-table, 코드·캡션 |
| Cross-references | 문서 내 `[](#label)`·`@label`·`{ref}`·`{numref}`·`{eq}`, 자동 문구와 번호·`{name}`·`{number}`·`%s` 치환; 문서 링크는 기본 Markdown 탐색, 내용 hover 팝업은 미지원 |
| Embed & Include Content | 로컬 include/literalinclude, 레이블 embed, 저장된 Jupyter notebook 출력 |
| Citations & Bibliography | 문서 frontmatter의 `bibliography` 또는 bibliography directive의 로컬 BibTeX 파일 |
| Proofs / Exercises | 정리·증명·연습문제·해답과 번호 |
| Diagrams | Mermaid |
| Asides & Margins | aside/margin/sidebar/topic; 좁은 Preview에서는 본문 안에 배치 |
| Grids, Tabs & Cards | 반응형 grid, 전환 가능한 tabs, cards |
| Glossaries, Terms & Index | glossary/term 참조와 index 메타데이터 |

예제: [`examples/myst/index.md`](examples/myst/index.md), [`layout.md`](examples/myst/layout.md), [`syntax.md`](examples/myst/syntax.md), [`glossary.md`](examples/myst/glossary.md). Glossary 예제에서는 여러 용어집, `{term}` 참조, 표시 이름 변경, 정의보다 먼저 나오는 참조를 확인할 수 있습니다. 공식 [Authoring 문서](https://mystmd.org/guide), [asides](https://mystmd.org/guide/asides), [figures](https://mystmd.org/guide/figures)를 기준으로 합니다.

Preview는 로컬 파일을 표시하며 코드를 실행하지 않습니다. DOI·외부 프로젝트의 자동 조회, 사용자 프로젝트 플러그인, Jupyter 실행, `.tex` 문서 변환, PDF/EPS/TIFF 이미지 변환과 PDF·Word 출판은 MyST CLI의 빌드 기능에 해당하며 이 Preview에서 실행하지 않습니다. 외부 iframe은 기본 Preview의 보안 정책에 맞춰 링크로 표시합니다. 지원하지 않거나 잘못된 directive는 원문 대신 오류 안내를 표시합니다. Frontmatter와 Obsidian 각주는 기존 표시 방식을 유지합니다.

## 사용 방법

1. Obsidian vault 폴더를 VS Code에서 엽니다.
2. Markdown 노트를 엽니다.
3. `Markdown: Open Preview to the Side` 또는 `Markdown Chroma: Open Preview to the Side` 명령을 실행합니다. macOS에서는 `Cmd+K V`, Windows/Linux에서는 `Ctrl+K V`를 사용할 수 있습니다.

별도의 미리보기 편집기를 만들지 않으므로 VS Code의 기본 Markdown 테마, 미리보기 탐색, 스크롤 동기화와 함께 사용할 수 있습니다.

## 지원 문법

| 기능 | 예시 |
| --- | --- |
| 위키링크·표시 이름 | `[[Note]]`, `[[folder/Note\|표시 이름]]` |
| 제목·중첩 제목 링크 | `[[Note#Heading]]`, `[[Note#Parent#Child]]`, `[[#Heading]]` |
| 블록 링크·식별자 | `[[Note#^id]]`, `문단 내용 ^id` |
| 전체·제목·블록 임베드 | `![[Note]]`, `![[Note#Heading]]`, `![[Note#^id]]` |
| 이미지·크기 | `![[image.png\|240]]`, `![[image.png\|240x120]]`, `![250](https://example.com/image.png)`, `![alt\|240](image.png)` |
| 목록 임베드 | 목록 뒤의 블록 ID를 참조하는 `![[Note#^my-list-id]]` |
| Callout | `> [!note] 제목`, `[!warning]-`, `[!tip]+`, 중첩 Callout |
| 강조·색상 | `==강조==`, `==🔴빨강==`, `==🟢초록==` 등 6색 |
| 주석 | `%%인라인 주석%%`, 여러 줄의 `%%…%%` |
| 각주 | 자체 파서로 `[^id]` + `[^id]: 설명`, `^[인라인 각주]` 지원. 각주 끝의 `↑1 ↑2 …`를 클릭하면 각주별 참조 순서에 따라 해당 본문으로 이동; 마우스를 올리면 본문 문장 표시 |
| 작업 목록 | `- [ ]`, `- [x]`, `- [?]`, `- [-]` |
| 태그 | `#태그`, `#분류/하위분류` |
| Properties | 파일 맨 위 YAML frontmatter는 VS Code 기본 렌더러로 표시 |
| 오디오·비디오 | `![[audio.mp3]]`, `![[video.mp4]]` |

표 안의 파이프는 `\|`로 이스케이프합니다. 일반 본문에서는 `[[Note|표시 이름]]`처럼 작성합니다. 파일명에 `.md`를 생략할 수 있으며, Properties의 `aliases`도 링크 대상으로 찾습니다.

노트 임베드는 한 줄에 단독으로 작성합니다. 제목 임베드는 해당 제목과 하위 제목을 포함하고, 다음 같은 수준 또는 상위 제목에서 끝납니다. 문단의 블록 ID는 끝에 붙이고, 목록·인용·Callout·표 전체의 ID는 블록 뒤에 빈 줄을 두고 별도 줄에 작성합니다.

## 노트·이미지·오디오·목록 임베드

[Obsidian 임베드 문서](https://obsidian.md/help/embeds)의 네 가지 기능을 지원합니다.

```markdown
![[My note]]
![[My note#Heading]]
![[My note#^block-id]]

![[image.png]]
![[image.png|100]]
![[image.png|100x145]]
![250](https://example.com/image.png)

![[recording.wav]]

![[My note#^my-list-id]]
```

이미지의 너비만 지정하면 비율을 유지하고, 너비와 높이를 함께 지정하면 해당 크기로 표시합니다. 오디오는 재생·일시정지·탐색 컨트롤을 갖춘 플레이어로 표시합니다. `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.webm`, `.aac`, `.opus`를 인식하며 실제 재생은 VS Code의 미디어 코덱 지원을 따릅니다.

목록 원본 노트에는 아래처럼 목록 다음에 빈 줄을 두고 ID를 작성합니다. 임베드에는 목록 전체가 표시되며, 중첩 목록·번호 목록·작업 목록의 서식도 유지합니다.

```markdown
- list item 1
- list item 2

^my-list-id
```

`examples/vault/Showcase.md`에서 로컬 이미지, 재생 가능한 WAV 파일, 다른 노트의 목록 임베드를 확인할 수 있습니다.

## Callout 모양과 아이콘

Callout 제목에는 Lucide SVG 아이콘이 표시됩니다. `[!info]+`는 펼친 상태, `[!info]-`는 접힌 상태로 시작하며, 제목 옆 화살표와 제목을 클릭하거나 키보드로 접고 펼칠 수 있습니다.

Obsidian과 같은 `.callout`, `.callout-title`, `.callout-icon`, `.callout-content` CSS 선택자를 지원합니다. 사용자 CSS 파일을 VS Code의 `markdown.styles`에 등록하면 색상과 아이콘을 바꿀 수 있습니다. 예를 들어 workspace의 `callouts.css`를 등록합니다.

```json
{
  "markdown.styles": ["callouts.css"]
}
```

```css
.callout[data-callout="custom-question-type"] {
  --callout-color: #8b5cf6;
  --callout-icon: lucide-alert-circle;
  --callout-border-width: 1px;
  --callout-border-opacity: 0.25;
}
```

노트에서는 `> [!custom-question-type]+ 제목`으로 사용합니다. 색상은 HEX·`rgb()` 등 CSS 색상과 기존 Obsidian의 RGB 숫자 세 개 형식을 지원합니다. 아이콘은 번들에 포함된 Lucide 아이콘 이름 또는 `--callout-icon: '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor"/></svg>';`처럼 지정한 SVG를 사용할 수 있습니다. SVG의 도형 속성을 사용하며 스크립트·이벤트·외부 리소스는 허용하지 않습니다. 아이콘은 로컬 번들에서 제공하므로 미리보기에서 네트워크로 불러오지 않습니다.

## Vault와 설정

기존 설정과 단축키의 호환을 위해 설정 키와 명령 ID는 `obsidianMarkdown.*`을 유지합니다.

열린 문서에서 가장 가까운 `.obsidian` 폴더의 부모를 vault 루트로 사용합니다. 없으면 해당 VS Code workspace 폴더를 사용합니다. 파일만 단독으로 연 경우 `.obsidian`을 찾거나 파일의 폴더를 사용합니다.

| 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `obsidianMarkdown.vaultRoot` | `""` | workspace 내부의 상대·절대 경로로 루트를 지정. 현재 문서를 포함해야 함 |
| `obsidianMarkdown.maxEmbedDepth` | `5` | 중첩 노트 임베드의 최대 깊이 |
| `markdown.preview.frontMatter` | `"table"` | VS Code 기본 설정. `"table"`, `"codeBlock"`, `"hide"`로 frontmatter 표시 방식 선택 |
| `markdown.preview.breaks` | `false` | VS Code 기본 설정. `true`이면 단일 줄바꿈도 화면에 표시 |

`folder/Note`는 vault 루트 기준, `./Note`와 `../Note`는 현재 문서 기준입니다. 파일명만 있으면 같은 폴더, vault 루트, vault 내 유일한 파일명·별칭 순서로 찾습니다. 대상이 여러 개이면 모호한 링크로 표시하므로 폴더 경로를 지정하세요. 존재하지 않는 노트를 자동으로 만들지는 않습니다.

열린 노트의 저장 전 변경 사항도 임베드에 반영됩니다. 파일 생성·변경·삭제와 설정 변경 시 미리보기를 갱신합니다. 수동 재색인은 `Markdown Chroma: Refresh Vault Index` 명령으로 실행합니다. `.git`, `.obsidian`, `node_modules`, 숨김 파일·폴더와 심볼릭 링크는 색인에서 제외합니다.

## 현재 범위

- VS Code 기본 읽기 미리보기를 확장합니다. 편집기 내부의 Obsidian Live Preview는 포함하지 않습니다.
- 체크박스는 읽기 전용이고, 태그는 표시만 합니다. 체크박스 수정과 태그 검색은 포함하지 않습니다.
- PDF·Canvas 등 별도 뷰어가 필요한 첨부는 파일 링크로 표시합니다.
- Dataview·Templater·Bases·검색 쿼리 실행, Obsidian 테마·CSS snippet 자동 로딩은 포함하지 않습니다. 일반 코드 블록은 기존 렌더러로 전달합니다.
- 데스크톱의 로컬 파일 vault를 대상으로 합니다. 가상 파일 시스템과 웹 확장은 지원하지 않습니다.
- 노트별 읽기 한도는 2 MiB, 미리보기별 임베드 한도는 100개/4 MiB입니다. 순환 참조는 중단하고 미리보기에 원인을 표시합니다.
- HTML은 VS Code 기본 Markdown 렌더러와 보안 설정을 따릅니다.

## 개발·검증

```sh
npm install
npm run check
npm run package
```

F5로 Extension Development Host를 실행하면 `examples/vault`가 열립니다. `Showcase.md`의 기본 Markdown Preview에서 문법을 확인할 수 있습니다.

실제 VS Code 호스트 테스트는 설치된 실행 파일을 지정해 실행합니다. VS Code를 다운로드하지 않습니다.

```sh
VSCODE_EXECUTABLE_PATH='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm run test:integration
```

VSIX는 `artifacts/markdown-chroma-0.1.0.vsix`에 생성됩니다. VS Code의 `Extensions: Install from VSIX...` 명령으로 설치할 수 있습니다.

파싱 규칙은 파일을 읽지 않고 토큰을 만듭니다. 렌더링 시 VS Code가 제공하는 현재 문서 URI를 사용해 링크와 임베드를 해석하므로 토큰 캐시와 다중 문서 미리보기에서도 기준 문서가 유지됩니다.

## 참고

- [Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown)
- [기본 문법](https://obsidian.md/help/syntax), [내부 링크](https://obsidian.md/help/links), [임베드](https://obsidian.md/help/embeds), [Callouts](https://obsidian.md/help/callouts), [Properties](https://obsidian.md/help/properties)
- [VS Code Markdown Extension API](https://code.visualstudio.com/api/extension-guides/markdown-extension)
