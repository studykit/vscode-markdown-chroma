# Markdown Chroma CLI v1 색인과 구조 조회

Markdown과 MyST 문서에서 필요한 노트를 찾고, 문서의 섹션·표·이미지·용어집·용어 목록을 확인한 뒤 선택한 섹션·용어 정의·용어집의 원문을 읽는 CLI를 제공한다. 태그·frontmatter 속성 검색과 백링크 조회에 필요한 색인을 디스크에 저장한다. LLM이 줄 번호를 추측해 파일을 읽는 대신 문서 구조와 의미가 있는 콘텐츠 항목을 이용해 내용을 조회하는 것이 목적이다.

상태: CLI v1 구현 명세. 구현 시작 시 초안의 기본 제안을 적용했으며, 아래의 미정 항목은 v1 결정으로 정리했다.

## 확정 범위

- CLI를 먼저 제공한다. 공용 조회 API·MCP 서버·VS Code MCP provider 연결은 [MCP 문서](MCP.md)에 설명한다. 별도 조회 UI는 후속 작업이다.
- 태그·속성 검색, 백링크 색인, 디스크 저장을 제공한다.
- CLI `watch`와 MCP background watcher가 같은 코어로 저장 파일 변경을 감지하고 기존 증분 갱신을 호출한다.
- 섹션 목록 조회와 특정 섹션의 원문 추출을 제공한다.
- 표와 이미지의 목록 조회를 제공한다.
- MyST `glossary`와 용어 정의를 색인하고 `{term}` 참조를 해석한다.
- 파일을 지정하지 않고 루트 전체의 용어집·용어 목록을 조회한다. 용어 이름이나 목록에서 받은 ID로 정의 원문을 직접 읽는 기능을 v1에 포함한다.
- 선택한 여러 용어의 정의와 여러 용어집 전체를 읽는다. 용어와 용어집을 함께 선택한 요청도 지원한다.
- MyST의 레이아웃 제어 directive 자체는 독립 색인 항목으로 만들지 않는다. 내부의 색인 대상 콘텐츠는 계속 수집한다.
- 일반 Markdown, MyST, Obsidian 문법이 섞인 문서를 대상으로 한다.
- `.obsidian/` 등 Obsidian이 생성한 설정·색인 파일에 의존하지 않는다. Obsidian 문법 사용 여부와 프로젝트 루트는 별개다.
- Obsidian `%%…%%` 주석은 사용하지 않는 것으로 가정하며 전용 처리를 구현하지 않는다. 주석으로 숨기는 효과를 보장하지 않는다.
- `myst-parser` 라이브러리는 수정하거나 포크하지 않는다. 공개 API와 프로젝트 내부 래퍼를 사용한다.

## 프로젝트와 파일 범위

작업 루트는 `--root <directory>`로 지정하고, 생략하면 현재 디렉터리를 사용한다. 모든 파일 인자는 이 루트를 기준으로 해석한다. 파일명만 주어진 링크의 해석과 CLI의 파일 인자 해석은 구분한다. CLI 파일 인자는 정확한 상대 경로이며, 모호한 파일명을 자동 선택하지 않는다.

루트 아래의 `.md`와 `.markdown` 파일을 재귀적으로 색인한다. 기본적으로 숨김 파일·폴더, `.git`, `.obsidian`, `node_modules`, `_build`와 심볼릭 링크를 제외한다. 루트 밖의 파일을 읽거나 색인하지 않는다. 루트 자체가 심볼릭 링크이면 실제 경로로 정규화한 뒤 동일한 경계 규칙을 적용한다.

루트 안의 가장 가까운 `myst.yml`에서 문서 파싱에 필요한 설정을 읽는다. 문서 frontmatter가 해당 값을 덮어쓴다. 설정 파일이 없어도 기본 MyST 설정으로 동작한다. 프로젝트 설정으로 루트를 자동 변경하지 않는다. 원격 설정·외부 프로젝트·사용자 실행 코드나 플러그인을 불러오지 않는다.

CLI는 저장된 파일 내용을 조회한다. VS Code의 저장 전 편집 내용은 이 단계의 범위에 포함하지 않는다.

## 저장 파일 변경 감지

`markdown-chroma watch --root <directory>`는 시작 시 색인을 갱신하고 계속 실행한다. MCP의 stdio·HTTP도 기본적으로 같은 `startIndexWatch`를 사용하며 `--no-watch`로 background 감지만 끌 수 있다. 별도 CLI watch와 MCP가 같이 실행되어도 root별 캐시 잠금을 공유한다.

- 감지 대상은 저장된 Markdown·MyST 설정·BibTeX·attachment의 생성·수정·이름 변경·삭제이다. 저장 전 편집 내용은 제외한다.
- 숨김 경로, `node_modules`, `_build`, symlink와 해당 root의 캐시 하위 경로를 색인과 같은 규칙으로 제외한다. 캐시 쓰기로 반복 갱신하지 않는다.
- 제외되지 않은 디렉터리에 `fs.watch`를 등록하고 기본 300 ms debounce로 이벤트를 모은다. 폴더 생성·이동·교체 후에는 watcher를 재등록한다.
- 이벤트 이후 기존 갱신을 재사용한다. 파일 목록·source/config/bibliography hash는 전체 확인하지만 바뀐 문서만 재파싱한다. 링크·백링크 해석도 다시 갱신한다.
- 기본 30초 주기 갱신으로 OS 이벤트 누락·watcher 오류·디렉터리 교체를 보완한다. 조회 시 전체 hash 검사는 그대로 유지한다.
- CLI watch의 `--debounce-ms`, `--poll-interval-ms`는 1 이상 2147483647 이하의 정수이다. MCP는 기본값을 사용한다.
- 시작 시 snapshot과 generation이 달라진 snapshot을 `event: "indexed"`가 추가된 색인 결과 JSON Lines로 stdout에 출력한다. 진단은 결과에 포함하고 watcher 실패는 stderr에 출력한 뒤 재시도한다.
- SIGINT/SIGTERM 또는 stdio EOF에서 timer·watcher를 해제하고 대기 중인 캐시 잠금을 취소한다. 진행 중인 동기 파싱은 중간에 중단하지 않는다.

## 혼합 문법 파싱

MyST 파서가 제목, directive, role, 코드, 수식, 주석 등 문서 구조를 판단한다. 프로젝트 내부 래퍼가 Obsidian 위키링크·임베드·태그를 추가로 인식한다. 인덱싱에 필요한 정보만 공통 레코드로 모으며 전체 AST를 디스크에 저장하지 않는다.

`myst-parser`의 `createTokenizer()`로 토큰 규칙을 추가하고, `tokensToMyst()`의 `handlers`로 추가 토큰을 구조화할 수 있다. `mystParse()`는 사용자 tokenizer를 받지 않으므로 해당 편의 함수에 직접 규칙을 주입하는 방식은 사용하지 않는다. MyST AST와 추가 토큰 정보를 조합하는 래퍼가 directive·role의 기존 처리와 원본 위치를 유지해야 한다.

| 문법 | 색인 처리 |
| --- | --- |
| Markdown 제목 | 섹션과 제목 경로 수집 |
| MyST 제목 레이블 | 제목과 연결된 레이블 수집 |
| MyST 그림·수식 등 블록 레이블 | 참조 해석용 대상으로 수집. 제목 섹션 목록과 구분 |
| Markdown 표와 MyST 표 | 목록 조회용 표 정보와 원본 범위 수집 |
| Markdown 이미지와 MyST 이미지·figure | 목록 조회용 이미지 정보와 figure 관계 수집 |
| MyST glossary와 내부 용어 정의 | 용어집·용어 목록과 정의의 원본 범위 수집 |
| MyST term 참조 | 대상 용어 정의와 연결하고 백링크 수집 |
| 일반 Markdown 로컬 링크 | 출처·대상·fragment 수집 |
| MyST 문서·레이블 참조 | 문맥에 맞게 대상 수집 |
| Obsidian 위키링크 | 파일·제목 경로·표시 이름 수집 |
| Obsidian 임베드 | 포함 참조로 수집. 일반 링크와 구분 |
| frontmatter 속성 | 검색할 수 있는 속성 값 수집 |
| frontmatter와 본문의 태그 | 문서별 태그 수집 |
| Obsidian callout과 MyST directive | 본문 구조를 유지하고 내부의 유효한 표·이미지·참조·태그 수집 |
| MyST 레이아웃 directive | 컨테이너 자체의 색인 항목은 생성하지 않음. 자식 콘텐츠 순회 |
| 코드·인라인 코드·수식·파서가 인식한 주석 | 내부 문자열을 링크·태그·문서 제목으로 수집하지 않음 |
| Obsidian 블록 ID | v1 제외. 파일 수준 백링크와 `fragmentStatus: "notIndexed"` 제공 |

`@name`을 일괄적으로 백링크로 처리하지 않는다. MyST가 인식한 참조·인용 정보와 프로젝트의 레이블·bibliography 정보를 구분해서 사용한다. 인용은 문서 백링크에서 제외하고, 분류가 확정되지 않은 항목은 진단 정보에 남긴다.

MyST 명시적 레이블을 우선하며, 제목의 암시적 레이블은 설치된 MyST 정규화 규칙을 적용하고 출처 문서 안의 대상을 먼저 확인한다. Markdown fragment가 정확한 섹션 ID이면 그 섹션을 선택한다. 위키링크의 제목 이름·경로가 여러 제목에 대응하면 fragment의 모호함을 보존한다.

Obsidian 구문을 재파싱할 때 이스케이프, 코드 영역, 서식으로 분할된 문자열을 고려한다. 예를 들어 위키링크 안의 강조 문법 때문에 MyST AST의 텍스트 노드가 나뉘어도 원본의 참조 범위를 놓치지 않아야 한다. MyST directive가 원문과 파싱된 자식을 함께 보유하는 경우 같은 참조를 두 번 수집하지 않는다.

레이아웃과 콘텐츠의 구분은 directive 이름과 파싱된 의미를 기준으로 한다. `grid`, `grid-item`, `tab-set`, `tab-item`, `div` 등 배치·표시를 위한 컨테이너는 목록에 노출하지 않는다. 그 안의 표·이미지·용어집·참조·태그는 수집한다. 내부 제목의 섹션 노출 여부는 섹션 목록 규칙을 따른다. `table`, `list-table`, `figure`, `image`, `glossary`는 콘텐츠 항목이므로 색인하며, `width`, `align`, CSS class 같은 표시 옵션이 있다는 이유로 제외하지 않는다.

레이아웃 directive에 붙은 레이블은 v1의 조회 가능한 콘텐츠 대상으로 등록하지 않는 것으로 제안한다. 이에 대한 참조를 지원할지는 별도 결정 사항이다. 원문 추출에서는 레이아웃 directive도 그대로 보존한다.

## CLI 명령

명령 이름은 `markdown-chroma`이다. Node 20 이상에서 동작하는 CLI 진입점을 npm 패키지의 `bin`으로 제공하고, 공유 색인 모듈은 `markdown-chroma/index`로 내보낸다. CLI와 색인 번들은 VSIX에도 포함하며 VS Code 명령 연결은 후속 작업이다.

```sh
# 색인 생성 또는 변경 파일 갱신
markdown-chroma index --root ./docs

# 저장 파일 변경 감지와 자동 갱신
markdown-chroma watch --root ./docs

# 색인 전체 재생성
markdown-chroma index --root ./docs --rebuild

# 문서 목록
markdown-chroma notes --root ./docs

# 태그와 속성 조건으로 검색
markdown-chroma search --root ./docs --tag project
markdown-chroma search --root ./docs --where '{"status":"draft"}'
markdown-chroma search --root ./docs --has-property author
markdown-chroma search --root ./docs --tag project --where '{"status":"draft"}'

# 특정 문서로 들어오는 링크
markdown-chroma backlinks guide.md --root ./docs

# 섹션 목록 확인 후 ID 또는 MyST 제목 레이블로 추출
markdown-chroma sections guide.md --root ./docs
markdown-chroma read-section guide.md --root ./docs --id installation
markdown-chroma read-section guide.md --root ./docs --label setup
markdown-chroma read-section guide.md --root ./docs --id installation --no-children

# 문서 또는 프로젝트 전체의 표와 이미지 목록
markdown-chroma tables guide.md --root ./docs
markdown-chroma images guide.md --root ./docs
markdown-chroma tables --root ./docs
markdown-chroma images --root ./docs

# 특정 섹션 안의 표와 이미지 목록
markdown-chroma tables guide.md --root ./docs --section installation
markdown-chroma images guide.md --root ./docs --section installation

# 용어집과 용어 목록
markdown-chroma glossaries --root ./docs
markdown-chroma glossaries glossary.md --root ./docs
markdown-chroma terms --root ./docs
markdown-chroma terms glossary.md --root ./docs --glossary glossary-1
markdown-chroma terms --root ./docs --name 'MyST Markdown'
markdown-chroma terms --root ./docs --glossary 'glossary.md#glossary-1'

# 파일 지정 없이 용어 이름 또는 목록에서 받은 ID로 정의 읽기
markdown-chroma read-term 'MyST Markdown' --root ./docs
markdown-chroma read-term --id 'glossary.md#term-myst-markdown' --root ./docs

# 특정 문서로 범위를 제한하거나 메타데이터와 함께 정의 읽기
markdown-chroma read-term 'MyST Markdown' --root ./docs --file glossary.md
markdown-chroma read-term 'MyST Markdown' --root ./docs --json

# 여러 용어 정의 또는 여러 용어집 전체 읽기
markdown-chroma read-term 'AST' 'MyST Markdown' --root ./docs
markdown-chroma read-term --root ./docs --id 'glossary.md#term-ast' --id 'syntax.md#term-role'
markdown-chroma read-glossary --root ./docs --id 'glossary.md#glossary-1' --id 'syntax.md#glossary-1'

# 용어와 용어집을 함께 선택해 읽기
markdown-chroma read --root ./docs --id 'glossary.md#term-ast' --id 'syntax.md#glossary-1' --json

# 특정 용어 정의로 들어오는 참조
markdown-chroma backlinks glossary.md --root ./docs --term term-myst-markdown
```

목록·검색·백링크·색인 갱신 결과는 기본 JSON으로 반환한다. `read-section`, `read-term`, `read-glossary`, `read`는 기본 Markdown 원문을 반환하고, `--json`이면 항목 정보와 원문을 함께 반환한다. 진행 메시지와 진단은 stderr에 기록해 stdout을 결과 데이터로만 사용한다.

`--cache-dir`로 색인 저장 위치를 바꿀 수 있다. `--help`는 명령·인자·기본값·예제를 제공한다. JSON 결과에는 `schemaVersion`을 포함한다.

### 용어집과 용어 조회 흐름

용어집을 먼저 선택해서 조회할 수도 있고 루트 전체의 용어를 바로 조회할 수도 있다. 아래 ID는 목록에서 반환된 값의 예시이며, 실제 사용 시 각 목록의 ID를 다음 명령에 그대로 전달한다.

```sh
# 1. 루트 전체의 용어집 목록 확인
markdown-chroma glossaries --root ./notes

# 2. 선택한 용어집 안의 용어 목록 확인
markdown-chroma terms --root ./notes --glossary 'glossary.md#glossary-1'

# 3. 선택한 용어의 정의 읽기
markdown-chroma read-term --root ./notes --id 'glossary.md#term-ast'

# 여러 용어 정의 선택
markdown-chroma read-term --root ./notes --id 'glossary.md#term-ast' --id 'syntax.md#term-role'

# 여러 용어집 전체 선택
markdown-chroma read-glossary --root ./notes --id 'glossary.md#glossary-1' --id 'syntax.md#glossary-1'

# 용어와 용어집을 한 번에 선택
markdown-chroma read --root ./notes --id 'glossary.md#term-ast' --id 'syntax.md#glossary-1' --json

# 용어집을 선택하지 않고 루트 전체의 용어를 조회하는 방법
markdown-chroma terms --root ./notes
markdown-chroma read-term 'AST' --root ./notes
```

`glossaries`는 용어집 블록들의 목록, `terms`는 정의된 용어들의 목록을 반환한다. 본문에서 `{term}`을 사용한 위치는 정의 목록과 구분하며 백링크로 조회한다.

## 태그와 속성 검색

frontmatter의 `tags`는 문자열 또는 문자열 배열로 받는다. 본문에서는 코드·수식·주석을 제외한 영역의 `#tag`와 `#tag/subtag`를 인식한다. 태그는 Unicode NFC와 대소문자 정규화 후 검색하며, 표시용 원문도 보존한다. 숫자로만 이루어진 토큰과 URL fragment는 태그로 수집하지 않는다. 구체적인 태그 문자 범위는 테스트 예제로 확정한다.

`--tag project`는 `project`와 `project/...`를 함께 찾는 것으로 제안한다. `--exact-tag`를 지정하면 정확히 일치하는 태그만 찾는다. 여러 `--tag`와 속성 조건은 AND로 결합한다.

`--where`는 JSON 객체로 조건을 받는다. v1은 frontmatter 최상위 속성을 대상으로 한다. 문자열·숫자·boolean·null은 타입과 값이 모두 일치해야 한다. 문서 속성이 배열이면 조건의 단일 값이 배열에 포함되는지를 검사한다. `--has-property`는 값이 null인 경우도 포함해 키의 존재 여부를 검사한다.

속성 키는 대소문자를 구분한다. 날짜·숫자 범위, 부분 문자열, 중첩 속성 경로, OR 조건과 본문 전문 검색은 v1에 포함하지 않는 것으로 제안한다. 속성은 JSON으로 표현할 수 있는 값을 저장하며, 잘못된 YAML은 해당 문서의 속성 진단으로 보고한다. 본문 파싱이 가능하면 나머지 색인은 유지한다.

## 링크 해석과 백링크

문서를 색인할 때 outgoing 참조를 저장하고, 대상이 어느 파일·레이블인지 해석해 역방향 조회를 제공한다. 문서 추가·삭제·이름 변경이나 레이블 변경 시 변경되지 않은 출처 문서의 참조도 다시 해석해 백링크 결과를 갱신한다.

Obsidian 파일명 링크는 같은 폴더, 루트의 파일, 프로젝트 안의 유일한 파일명·frontmatter 별칭 순서로 해석한다. 경로를 지정한 위키링크는 루트 기준으로, `./`와 `../`는 출처 파일 기준으로 해석한다. 일반 Markdown 링크는 출처 파일 기준으로 해석한다. MyST 문서·레이블 참조는 해당 문법의 문맥과 프로젝트의 대상 정보를 사용한다.

여러 대상이 일치하면 후보를 반환하고 자동 선택하지 않는다. 외부 URL은 문서 백링크에서 제외한다. 임베드는 일반 링크와 동일한 대상 해석을 사용하되 `kind: "embed"`로 구분한다. frontmatter 속성 안의 위키링크는 v1 백링크에서 제외한다.

각 백링크는 다음 정보를 제공한다.

- 출처 파일, 출처 섹션 ID와 제목 경로, 원문 위치
- 참조 종류와 링크 원문
- 대상 파일, 요청한 fragment·레이블, 해석된 대상 종류
- 파일과 fragment의 해석 상태

`{term}` 참조는 `kind: "term"`으로 저장하고 용어 정의 항목을 대상으로 연결한다. `backlinks <file> --term <id>`는 지정한 문서의 특정 용어 정의에 대한 참조만 반환한다. 기본 문서 백링크 목록에도 용어 참조가 포함된다. 표시 이름을 바꾼 용어 참조에서도 표시 문자열과 실제 대상 이름을 구분한다.

미해결·모호한 참조도 outgoing 색인에 보존한다. `notes --unresolved`는 해당 참조가 있는 문서를 반환하고, 개별 참조 진단도 결과에 포함한다. 파일은 찾았지만 블록 fragment를 지원하지 않는 경우 파일 수준의 백링크를 유지하고 fragment 상태를 `notIndexed`로 구분한다.

## 섹션 목록

`sections <file>`은 문서 순서대로 섹션을 반환한다. 제목 원문으로 계산한 표시 이름, 제목 경로, 수준, 고유 ID, MyST 제목 레이블, 원본의 시작·끝 줄을 제공한다. 줄 번호는 1부터 시작하며 양 끝을 포함한다.

v1은 문서 수준의 제목을 섹션으로 제공하는 것으로 제안한다. ATX 제목과 Setext 제목을 지원한다. 코드 내부 제목은 제외한다. callout·directive 내부 제목은 독립 섹션으로 노출하지 않고 해당 컨테이너를 포함하는 섹션의 본문으로 취급한다. 내부 제목도 독립 섹션으로 제공할지는 미정이다.

제목 이전의 본문이 있으면 `preamble` 항목을 제공한다. frontmatter는 속성 조회 대상으로 분리하며 도입부에 포함하지 않는다. 제목이 없는 문서는 본문 전체를 `preamble` 하나로 제공한다. 빈 문서는 섹션 목록이 비어 있다.

ID는 제목에서 생성한 slug를 사용하고 중복 시 접미사로 구분한다. `preamble` 같은 예약 ID와도 충돌하지 않아야 한다. ID는 현재 문서 안에서 고유하며, 편집 후에도 동일하다고 보장하지 않는다. MyST 레이블은 별도 필드와 `--label` 조회키로 제공한다.

```json
{
  "schemaVersion": 1,
  "file": "guide.md",
  "sourceHash": "sha256:...",
  "sections": [
    {
      "id": "installation",
      "title": "Installation",
      "level": 2,
      "headingPath": ["Installation"],
      "labels": ["setup"],
      "startLine": 3,
      "endLine": 14
    },
    {
      "id": "macos",
      "title": "macOS",
      "level": 3,
      "headingPath": ["Installation", "macOS"],
      "labels": [],
      "startLine": 8,
      "endLine": 14
    }
  ]
}
```

부모 섹션의 범위는 다음 같은 수준 또는 상위 수준의 제목 직전까지이며, 하위 섹션을 포함한다. 제목 직전에 연결된 MyST 레이블은 섹션 시작 범위에 포함한다. 여러 레이블이나 메타데이터가 연결되는 경우에도 원본 구조가 유지되어야 한다.

## 섹션 원문 추출

`read-section <file> --id <id>` 또는 `--label <label>`로 섹션을 선택한다. 두 선택 인자는 동시에 사용할 수 없다. 레이블이 제목 섹션이 아닌 그림·수식 등에 연결돼 있으면 대상 종류를 알려주고 섹션 선택 오류를 반환한다. 블록 추출은 별도 기능이다.

기본값은 제목과 하위 섹션을 포함하는 원문이다. `--no-children`이면 첫 하위 제목 직전까지만 반환한다. 빈 부모 본문이면 레이블과 제목만 반환한다. directive, callout, 링크, 수식과 코드의 원문을 유지하며 다시 렌더링하거나 문법을 변환하지 않는다.

`{include}`와 Obsidian 임베드는 참조 원문 그대로 반환한다. 대상 파일 내용을 펼치지 않는다. 섹션 밖의 각주 정의나 링크 정의를 자동으로 덧붙이지 않는다. 필요한 경우 별도의 조회로 원본 문서를 확인한다.

파일을 최신 상태로 확인한 뒤 현재 원문의 위치를 사용한다. `sections`에서 받은 `sourceHash`를 `--source-hash`로 전달할 수 있다. 문서가 변경됐으면 `documentChanged` 오류를 반환해 목록을 다시 조회하도록 한다. 오래된 색인의 줄 위치로 다른 내용을 잘라 반환하지 않는다.

`--json` 결과는 파일, 섹션 정보, `sourceHash`, 실제 반환 범위, `includeChildren`, `content`를 포함한다. 원본 줄바꿈 형식을 보존한다.

## 표와 이미지 목록

`tables [file]`과 `images [file]`로 문서에서 사용할 수 있는 콘텐츠 항목을 확인한다. 파일을 생략하면 프로젝트 전체를 조회하고 파일 경로와 원문 위치 순서로 반환한다. `--section <id>`는 파일을 지정한 경우에만 사용하며, 선택한 섹션과 하위 섹션에 속하는 항목을 반환한다. 해당 레이아웃 컨테이너 자체의 레코드를 생성하지 않아도 내부 표와 이미지는 목록에 나타나야 한다.

공통으로 항목 ID, 출처 파일, 소속 섹션 ID·제목 경로, MyST 레이블, 원본 범위와 문서 hash를 제공한다. 레이블이 없는 항목에도 `table-1`, `image-1` 같은 문서 내 고유 ID를 부여한다. ID는 현재 문서의 항목을 선택하기 위한 값이며 편집 후 동일하다고 보장하지 않는다. v1의 표·이미지 명령은 목록 조회이며, 해당 항목의 내용은 소속 섹션을 읽어 확인한다. 항목 하나의 원문만 추출하는 명령은 후속 결정 사항이다.

### 표 목록

일반 Markdown 파이프 표, MyST `table`·`list-table`, 본문에 데이터가 있는 `csv-table`, `figure`의 `kind: table`을 대상으로 한다. 표 컨테이너와 내부 AST의 `table` 노드를 같은 표로 중복 계산하지 않는다.

표에는 문법 종류, 캡션, 헤더 텍스트, 행·열 수를 추가한다. 행 수에는 헤더 행도 포함하며 헤더 행 수를 별도로 제공한다. 파서에서 확인할 수 없는 값은 null로 반환한다. 표의 캡션·레이블과 directive 전체의 원본 범위를 유지한다.

외부 CSV나 notebook 출력 등을 참조하는 표는 선언된 항목으로 목록에 남기되 `contentStatus: "referenceOnly"`로 표시한다. 데이터를 실행·다운로드·펼쳐서 행·열 수를 계산하지 않는다. 원문에 직접 포함된 표는 `contentStatus: "inline"`으로 구분한다.

```json
{
  "schemaVersion": 1,
  "tables": [
    {
      "id": "table-1",
      "file": "guide.md",
      "sectionId": "results",
      "headingPath": ["Results"],
      "syntax": "myst-list-table",
      "labels": ["comparison"],
      "caption": "Model comparison",
      "headers": ["Model", "Score"],
      "rowCount": 3,
      "headerRowCount": 1,
      "columnCount": 2,
      "contentStatus": "inline",
      "startLine": 20,
      "endLine": 30,
      "sourceHash": "sha256:..."
    }
  ]
}
```

### 이미지 목록

Markdown의 `![alt](source)`와 참조형 이미지, MyST `image`·`figure` 안의 이미지, Obsidian 이미지 임베드를 대상으로 한다. 이미지로 해석할 수 있는 임베드만 이미지 목록에 포함하고 노트 임베드와 구분한다.

각 이미지에는 참조 문법, 원래 이미지 경로·URL, alt, 이미지 자체의 레이블을 제공한다. 일반 Markdown·MyST의 로컬 경로는 출처 파일 기준으로, Obsidian 이미지 임베드는 위키링크 규칙으로 해석한다. 해석한 프로젝트 상대 경로와 존재 상태를 제공한다. 외부 URL을 다운로드해 이미지 내용을 분석하지 않는다.

같은 이미지가 여러 곳에서 사용되면 출현마다 별도 항목으로 기록한다. figure 안에 있으면 figure의 ID·레이블·캡션을 관련 정보로 제공한다. 여러 이미지를 포함하는 figure는 그룹으로 식별하고 figure 컨테이너 자체를 추가 이미지로 중복 계산하지 않는다.

이미지 크기는 파일에서 조사하지 않고 문서에 적힌 지정 값만 필요에 따라 기록한다. 이미지 파일의 존재 여부는 목록 조회 시 확인하고 외부 이미지는 미조회 상태로 구분한다. v1은 참조와 구조의 목록을 제공하며 OCR이나 이미지 내용 설명은 수행하지 않는다.

## 용어집과 용어 색인

MyST `glossary` directive를 의미가 있는 콘텐츠 항목으로 색인한다. 그 안의 `definitionTerm`과 해당 `definitionDescription`을 연결해 용어 정의를 색인한다. 여러 문단·목록·표·이미지가 포함된 정의도 원본 범위를 보존한다. 일반 본문의 정의 목록은 자동으로 glossary 용어로 간주하지 않는 것으로 제안한다.

`glossaries [file]`은 파일을 지정하지 않으면 루트 아래 모든 문서의 용어집 목록을 제공한다. 파일은 선택적인 범위 제한 인자다. 각 항목은 루트 전체에서 고유한 ID, 문서 내 ID, 출처 파일, 소속 섹션과 제목 경로, MyST 레이블, 용어 수, directive의 원본 범위와 문서 hash를 포함한다. 한 문서에 여러 용어집이 있거나 레이블이 없어도 각각 구분한다.

`terms [file]`은 파일을 지정하지 않으면 루트 전체의 정의된 용어 목록을 제공한다. 파일 인자나 `--glossary <id>`를 사용하면 해당 문서 또는 용어집으로 제한한다. 루트 전체 조회에서는 목록에서 받은 용어집의 전역 ID를 사용하고, 파일을 지정한 조회에서는 해당 문서 내 ID도 사용할 수 있다. `--name <name>`은 MyST의 용어 식별자 정규화 규칙에 따라 일치하는 정의들을 반환한다. 부분 문자열 검색이나 자연어 의미 검색은 포함하지 않는 것으로 제안한다.

각 용어 항목에는 다음 정보를 제공한다.

- 루트 전체에서 고유한 ID, 문서 내 ID와 MyST가 생성한 용어 식별자
- 원래 용어 이름과 표시용 텍스트
- 출처 파일, 용어집 ID, 소속 섹션과 제목 경로
- 용어 이름부터 정의 마지막까지의 원본 범위와 문서 hash
- 연결된 참조를 찾을 수 있는 대상 정보

전역 ID는 출처 파일과 문서 내 ID를 조합한다. 예를 들어 `glossary.md#term-myst-markdown`을 목록에서 받은 그대로 `read-term --id`에 전달할 수 있다. 경로의 구분 문자 등은 인코딩하며 사용자가 ID를 분해하거나 파일명을 따로 지정할 필요가 없도록 한다. 조회 결과는 파일 경로와 문서 내 정의 위치 순서로 반환한다. 같은 이름의 용어가 여러 문서에 있어도 목록에서 합치거나 누락하지 않는다.

```json
{
  "schemaVersion": 1,
  "terms": [
    {
      "id": "glossary.md#term-myst-markdown",
      "localId": "term-myst-markdown",
      "identifier": "term-myst markdown",
      "name": "MyST Markdown",
      "file": "glossary.md",
      "glossaryId": "glossary.md#glossary-1",
      "sectionId": "authoring-terms",
      "headingPath": ["Authoring terms"],
      "startLine": 12,
      "endLine": 17,
      "sourceHash": "sha256:..."
    }
  ]
}
```

`{term}` 역할의 대상 해석에는 설치 버전의 `glossaryTransform`과 term 역할이 사용하는 동일한 정규화 규칙을 사용한다. 예를 들어 `{term}` 뒤의 `` `표시 이름 <실제 용어>` `` 구문은 실제 용어를 대상으로 연결한다. 정의보다 앞에 나온 참조와 다른 문서의 정의도 프로젝트 색인이 완성된 뒤 해석한다.

동일한 용어가 여러 정의에 대응하면 후보 목록과 진단을 반환한다. 같은 파일의 정의라는 이유만으로 하나를 자동 선택하거나 문서의 순서로 덮어쓰지 않는다. 정의가 없으면 미해결 용어 참조로 기록한다. 정의 이름·내용·파일 위치가 바뀌면 관련 색인과 참조를 갱신한다.

약어, index directive·role과 show-index는 glossary·term과 구분하며 이번 범위에 자동으로 포함하지 않는다.

## 용어 정의 읽기

`read-term <name...>`은 파일을 지정하지 않고 루트 전체에서 선택한 용어들을 찾는다. 이름을 여러 개 전달하거나 `--id <id>`를 반복해 여러 정의를 선택할 수 있다. 이름과 ID는 동시에 지정할 수 없다. 이름 조회는 `--file <file>`로 범위를 제한할 수 있다.

용어 이름과 그에 연결된 정의의 Markdown 원문을 반환한다. 여러 문단·목록·표·이미지가 포함돼 있어도 정의 전체를 포함하며 다음 용어의 정의는 포함하지 않는다. 바깥 glossary directive나 소속 섹션 전체를 읽을 필요가 없어야 한다. 원래의 줄바꿈과 문법을 유지하고 include·임베드를 펼치지 않는다.

이름으로 여러 정의가 일치하면 `ambiguousTerm` 오류와 각 후보의 전역 ID·용어 이름·출처 파일·용어집 정보를 반환한다. 사용자는 후보 ID로 다시 조회한다. 일치하는 정의가 없으면 `termNotFound` 오류를 반환한다.

`--json`은 아래의 여러 항목 조회 형식을 사용한다. 정의 원문은 읽기 요청 시 파일에서 추출하며 디스크 색인에 본문 전체를 저장하지 않는다. 같은 문서의 항목들만 읽는 경우 `--source-hash`로 섹션 읽기와 같은 문서 변경 검증을 적용할 수 있다. 서로 다른 문서의 항목을 선택한 경우에는 단일 hash를 일괄 적용하지 않는다.

## 용어집 전체와 여러 항목 읽기

`read-glossary --id <id>`는 `glossaries` 목록에서 받은 전역 ID로 용어집 전체를 읽는다. `--id`를 반복하면 서로 다른 파일에 있는 여러 용어집도 선택할 수 있다. MyST 레이블, glossary directive의 시작·종료 구문과 내부 용어 정의 전체를 원문 그대로 반환한다.

`read --id <id>`는 선택한 항목의 종류를 색인에서 확인하며, 여러 용어 정의와 용어집을 함께 읽을 수 있다. v1에서 이 공통 명령이 지원하는 종류는 용어와 용어집이다. 섹션은 기존 `read-section`으로 읽고 표·이미지의 개별 원문 조회는 별도 미정 범위를 유지한다. 종류를 제한하고 이름으로 찾으려면 `read-term`을 사용한다.

여러 항목 조회는 지정한 순서로 결과를 반환한다. 동일 ID를 중복 선택하면 첫 번째 위치에서 한 번만 반환한다. 용어집과 그 안의 용어를 각각 선택한 경우에는 서로 다른 항목이므로 둘 다 반환한다. 자동으로 겹치는 내용을 삭제하지 않는다.

단일 항목의 기본 출력은 원문이다. 여러 항목의 Markdown 출력에서는 각 항목 앞에 종류·이름·출처 파일·ID를 표시해 경계를 구분하고, 항목의 `content`는 원문을 유지한다. `--json`은 단일·복수 모두 `items` 배열을 사용한다. 각 항목에는 `kind`, ID, 이름, 출처 파일, 소속 정보, 원본 범위, 문서 hash, 상태와 `content`를 제공한다.

```json
{
  "schemaVersion": 1,
  "complete": true,
  "items": [
    {
      "kind": "term",
      "id": "glossary.md#term-ast",
      "name": "AST",
      "file": "glossary.md",
      "glossaryId": "glossary.md#glossary-1",
      "status": "ok",
      "startLine": 12,
      "endLine": 14,
      "sourceHash": "sha256:...",
      "content": "AST\n: Abstract Syntax Tree입니다.\n"
    },
    {
      "kind": "glossary",
      "id": "syntax.md#glossary-1",
      "name": null,
      "file": "syntax.md",
      "termCount": 1,
      "status": "ok",
      "startLine": 20,
      "endLine": 23,
      "sourceHash": "sha256:...",
      "content": ":::{glossary}\nRole\n: 인라인 문법입니다.\n:::\n"
    }
  ]
}
```

일부 선택 항목이 없거나 모호하면 해당 항목에 오류·후보 정보를 반환하고, 다른 정상 항목은 함께 반환한다. 전체 결과는 `complete: false`와 비정상 종료 코드로 누락을 알린다. 모호한 이름을 여러 정의로 자동 확장하지 않는다.

## 디스크 색인과 갱신

기본 저장 위치는 운영체제의 사용자 캐시 디렉터리 아래 `markdown-chroma`이다. 프로젝트의 실제 루트 경로를 기준으로 별도 저장 공간을 사용한다. 노트 폴더에 색인 파일을 추가하지 않는다.

색인에는 스키마 버전, 파서·래퍼 버전, 루트 경로, 설정 fingerprint, 파일별 변경 정보와 내용 hash, 속성·태그·섹션·표·이미지·용어집·용어·레이블·outgoing 참조를 저장한다. 전체 본문, AST와 이미지 바이너리는 저장하지 않는다. 백링크는 이 데이터에서 조회할 수 있어야 한다.

첫 조회에서 색인이 없으면 생성한다. 이후 조회마다 파일 목록·변경 정보를 확인해 추가·변경·삭제를 반영한다. 변경 후보는 내용 hash를 확인하고 필요한 문서만 다시 파싱한다. CLI v1에는 상주 watcher를 두지 않는다.

파서·래퍼·스키마 버전이나 파싱 설정이 달라지면 영향을 받는 색인을 재생성한다. v1은 매 조회에서 전체 문서의 내용 hash를 확인하며 변경된 문서만 다시 파싱한다. 시간·크기가 같은 변경도 놓치지 않는다. `index --rebuild`는 캐시를 재사용하지 않고 전체 문서를 다시 파싱한다.

완성된 색인은 임시 파일에 쓴 뒤 원자적으로 교체한다. 여러 CLI 프로세스가 같은 색인을 갱신해도 서로의 결과를 덮어쓰지 않도록 잠금과 갱신 세대를 관리한다. 손상된 캐시는 재생성하고, 생성 실패 시 부분 결과를 정상 색인으로 저장하지 않는다.

## 실패와 진단

정상 조회와 빈 검색 결과는 종료 코드 0이다. 잘못된 인자, 없는 파일·섹션·용어, 모호한 선택, 문서 변경, 색인 저장 실패는 비정상 종료한다. `--json`에서는 기계가 구분할 수 있는 오류 코드와 메시지를 제공한다.

프로젝트 조회 중 일부 문서의 YAML·MyST 구문 오류나 읽기 실패는 문서별 진단으로 반환한다. 결과에는 `complete: false`를 표시하고 CLI는 비정상 종료해 누락을 알린다. 문서·설정·bibliography 파일은 각각 2 MiB까지 읽으며 초과 파일은 진단으로 보고한다. 미해결 참조 자체는 결과 누락이 아니므로 정상 색인에 상태를 보존한다. 정상 조회는 종료 코드 0, 부분 결과·조회 실패는 1, 잘못된 인자는 2이다. 설치된 파서가 지원하지 않는 외부 표 선언은 가능한 선언 정보를 `referenceOnly`로 보존하되 구문 진단을 함께 반환한다.

## 검증 기준

- 설정 디렉터리가 없는 프로젝트에서 일반 Markdown·MyST·Obsidian 혼합 문서를 색인한다.
- 기본 JSON 출력을 다른 프로그램이 바로 읽을 수 있고 진단이 stdout에 섞이지 않는다.
- 태그·타입별 속성·배열 포함·속성 존재 조건과 조건 결합을 검증한다.
- 코드·수식·MyST 주석·HTML 주석의 예시 링크와 태그를 수집하지 않는다.
- directive·callout 안의 실제 참조를 수집하고, AST의 중복 표현을 중복 색인하지 않는다.
- 레이아웃 directive 자체는 목록에 나타나지 않고 내부 표·이미지·참조·태그는 수집된다.
- Markdown 표, MyST의 캡션 표·list-table·figure의 표를 중복 없이 목록에 제공한다.
- 일반 이미지·MyST figure·Obsidian 이미지 임베드와 여러 이미지가 있는 figure의 관계를 검증한다.
- 레이블 없는 표·이미지, 같은 이미지의 여러 출현, 미해결 이미지 경로를 목록에 제공한다.
- 참조만 있는 표와 외부 이미지를 다운로드·실행·확장하지 않고 상태를 구분한다.
- 여러 glossary와 각 용어의 정의 범위·소속 섹션을 문서별·프로젝트별 목록으로 제공한다.
- 파일 지정 없이 루트 전체의 용어 목록을 조회하고 목록의 전역 ID로 정의를 직접 읽는다.
- 이름 조회, 문서 범위 제한, 다른 파일의 동명 용어 후보 반환을 검증한다.
- 여러 문단·목록·표·이미지를 포함한 정의 전체를 추출하며 인접 용어의 정의를 포함하지 않는다.
- 서로 다른 문서의 여러 용어·용어집을 선택해 원문을 읽고 입력 순서·출처·항목 종류를 유지한다.
- 용어집 전체 읽기에서 directive 구문과 모든 정의를 보존하고, 용어와 용어집을 섞은 요청을 처리한다.
- 중복 ID, 겹치는 용어집·용어 선택, 일부 미발견·모호한 선택의 결과를 검증한다.
- term의 표시 이름 변경, 정의 이전 참조, 다른 문서의 정의, 중복·미해결 용어를 검증한다.
- 용어 정의 내부의 코드 예시는 참조로 수집하지 않고 실제 참조·표·이미지는 수집한다.
- 용어 이름 변경·삭제 후 참조 대상과 용어 백링크를 갱신한다.
- 위키링크·임베드·일반 링크·MyST 참조·인용의 구분과 모호한 대상을 검증한다.
- 변경·삭제·이름 변경, 별칭·레이블 변경 후 백링크가 갱신된다.
- 섹션 목록의 중복 제목·레이블·한국어 제목·Setext·도입부를 검증한다.
- 레이블과 제목으로 선택한 섹션의 원문 범위, 하위 섹션 제외, CRLF 보존을 검증한다.
- 문서 변경 후 오래된 섹션 목록으로 읽을 때 지정된 hash 검증이 실패한다.
- 별도 CLI 프로세스에서 저장된 색인을 재사용하고 손상·버전 변경·동시 갱신을 처리한다.
- 기존 Markdown Chroma 미리보기 테스트를 통과해 공유 모듈 변경으로 인한 회귀를 확인한다.

## v1 결정

| 항목 | 초안의 제안 |
| --- | --- |
| 하위 태그 검색 | 기본 포함, `--exact-tag`로 제외 |
| 속성 검색 범위 | 최상위 속성의 존재·일치·배열 포함. 범위 비교는 후속 |
| Obsidian 블록 ID | v1 제외. 해당 파일 수준 백링크는 유지 |
| directive·callout 내부 제목 | 독립 섹션에서 제외. 컨테이너 원문은 부모 섹션에 포함 |
| 표·이미지 하나의 원문 추출 | 목록 조회와 부모 섹션 읽기를 먼저 제공. 별도 명령은 후속 |
| glossary 밖의 정의 목록 | glossary 용어로 자동 등록하지 않는 것으로 제안 |
| 레이아웃 directive 레이블 참조 | 레이아웃 자체를 조회 가능한 대상으로 등록하지 않는 것으로 제안 |
| frontmatter 속성 안의 위키링크 | 백링크에서 제외. 속성 값은 검색 가능 |
| 변경 확인의 정확도와 비용 | 조회마다 전체 hash 확인, 변경된 문서만 재파싱 |
| 자동 변경 감지 | CLI watch·MCP에서 공용 watcher 사용. 300 ms debounce, 30초 보완 검사, 기존 갱신 재사용 |
| 큰 파일 처리 | 문서·설정·bibliography 각각 2 MiB, 초과 파일 진단 |
| CLI 배포 | npm `bin`, Node 20 이상. CLI·공유 색인 모듈 번들을 VSIX에도 포함 |

## 파서 확장 참고 자료

- [MyST 개발 가이드](https://mystmd.org/guide/developer)
- [MyST 표 문법](https://mystmd.org/guide/tables)
- [MyST 이미지와 figure 문법](https://mystmd.org/guide/figures)
- [MyST glossary와 term 문법](https://mystmd.org/guide/glossaries-and-terms)
- [myst-parser 공개 API](https://github.com/jupyter-book/mystmd/blob/main/packages/myst-parser/src/index.ts)
- [tokenizer와 파싱 흐름](https://github.com/jupyter-book/mystmd/blob/main/packages/myst-parser/src/myst.ts)
- [AST 변환 핸들러](https://github.com/jupyter-book/mystmd/blob/main/packages/myst-parser/src/fromMarkdown.ts)

구현 기준은 프로젝트에 고정된 라이브러리 버전이다. 링크의 최신 소스와 설치 버전 사이에 차이가 있으면 설치 버전의 공개 API를 기준으로 검증한다.
