# Markdown Chroma MCP

CLI와 동일한 저장 파일 색인·조회 기능을 stdio MCP로 제공합니다. MyST 라이브러리를 수정하지 않으며 `.obsidian/` 파일을 사용하지 않습니다.

## 실행

Node 20 이상에서 패키지를 설치한 뒤 실행합니다.

```sh
markdown-chroma mcp --root /absolute/path/to/notes
# 같은 서버의 독립 실행 이름
markdown-chroma-mcp --root /absolute/path/to/notes
# 소스에서 빌드한 경우
node dist/mcp.cjs --root /absolute/path/to/notes
```

`--root` 기본값은 실행 디렉터리입니다. `--cache-dir`로 디스크 색인 위치를 지정할 수 있습니다. 클라이언트의 서버 설정에는 실행 파일의 절대 경로를 사용하는 편이 안정적입니다. 다음은 VS Code의 수동 `mcp.json` 예시입니다. 확장의 자동 등록을 사용하면 이 설정은 필요하지 않습니다.

```json
{
  "servers": {
    "markdown-chroma": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dist/mcp.cjs", "--root", "/absolute/path/to/notes"]
    }
  }
}
```

서버는 네트워크 포트를 열지 않습니다. stdout은 MCP 프로토콜 전용이며 시작 오류는 stderr로 나갑니다. stdin이 닫히거나 SIGINT/SIGTERM을 받으면 연결을 종료합니다. SDK의 최신 프로토콜과 2025년 `initialize` 방식 모두 제공합니다.

## VS Code 확장 연결

안정화된 MCP provider API가 있는 VS Code에서는 신뢰하는 로컬 워크스페이스 폴더마다 `Markdown Chroma: <폴더 이름>` 서버를 제공합니다. VS Code의 `MCP: List Servers`에서 서버를 확인할 수 있습니다. 실행·중지와 도구 승인은 VS Code가 관리합니다. 확장에 포함된 서버와 호스트의 Node 실행 파일을 사용하므로 별도 Node/npm 설치가 필요하지 않습니다. API가 없는 구버전에서는 기존 미리보기 기능을 유지합니다.

| 설정 | 기본값 | 동작 |
| --- | --- | --- |
| `markdownChroma.mcp.enabled` | `true` | 폴더의 MCP 서버 제공 여부 |
| `markdownChroma.mcp.root` | `""` | 폴더 전체. 값이 있으면 폴더 기준 상대 경로나 폴더 내부 절대 경로 |

루트가 워크스페이스 밖이거나 존재하지 않으면 해당 서버를 제공하지 않고 `Markdown Chroma MCP` 출력 채널에 원인을 남깁니다. 폴더·설정·신뢰 상태 변경 시 정의를 갱신하고, 시작 직전에 현재 정의를 다시 확인합니다. 다중 루트 워크스페이스에서는 각 서버가 자신의 루트만 조회합니다. 미리보기의 `obsidianMarkdown.vaultRoot` 설정과는 별개입니다.

## 도구

파일 인자는 서버 루트 기준의 정확한 상대 경로입니다. 도구 호출에서 루트를 바꿀 수 없습니다. 선택 인자는 생략할 수 있으며, 아래 표에서 굵게 표시한 인자는 필수입니다.

| 도구 | 인자 | 결과 |
| --- | --- | --- |
| `index_documents` | `rebuild` | 캐시 갱신·전체 재파싱, 처리 통계 |
| `list_notes` | `unresolved` | 문서·태그·속성·참조·항목 수 |
| `search_notes` | `tags`, `exactTag`, `where`, `hasProperty` | AND 조건 검색. 태그 또는 속성 조건 하나 이상 필요 |
| `get_backlinks` | **`file`**, `term` | 문서 또는 용어에 들어오는 참조 |
| `list_sections` | **`file`** | 섹션 계층·ID·레이블·원본 hash |
| `read_section` | **`file`**, **`id` 또는 `label`**, `includeChildren`, `sourceHash` | 섹션 원문; 기본적으로 하위 섹션 포함 |
| `list_tables` | `file`, `section` | 표의 캡션·헤더·크기·위치 |
| `list_images` | `file`, `section` | 이미지 출처·대체 텍스트·figure 정보·위치 |
| `list_glossaries` | `file` | vault 전체 또는 파일의 용어집 |
| `list_terms` | `file`, `glossary`, `name` | vault 전체 또는 지정 범위의 용어 정의 |
| `read_terms` | **`names` 또는 `ids`**, `file`, `sourceHash` | 선택한 여러 정의; `file`은 이름 선택에서만 사용 |
| `read_glossaries` | **`ids`** | 선택한 여러 용어집 전체 원문 |
| `read_items` | **`ids`** | 용어와 용어집을 혼합해 원문 조회 |

`section` 필터에는 `file`도 필요합니다. `where`는 문자열·숫자·불리언·null 값을 가진 JSON 객체입니다. 값이 배열인 속성은 원소 일치로 검색합니다. `tags`는 기본적으로 하위 태그도 포함합니다.

1. `list_sections({"file":"guide.md"})`로 섹션을 확인합니다.
2. `read_section({"file":"guide.md","id":"setup","includeChildren":false})`로 해당 본문만 읽습니다.
3. `list_terms({})`, `list_glossaries({})`로 vault 전체의 항목을 확인합니다.
4. `read_items({"ids":["glossary.md#term-ast","glossary.md#glossary-1"]})`로 선택한 용어·용어집을 함께 읽습니다. 실제 ID는 목록 응답에서 가져옵니다.

## 결과와 갱신

공용 결과는 `schemaVersion: 1`, `complete`와 명령별 데이터입니다. MCP는 이를 `structuredContent`와 JSON 텍스트 `content` 양쪽에 반환합니다. 일부 문서를 처리하지 못하거나 선택 항목이 없으면 `complete: false`, `isError: true`와 함께 성공한 결과·진단·항목별 오류를 반환합니다. SDK 입력 검증 오류는 MCP의 텍스트 오류 응답으로 반환되므로 `structuredContent`가 없을 수 있습니다.

동명 용어는 임의 선택하지 않고 `ambiguousTerm`과 후보를 반환합니다. 파일로 범위를 좁히거나 목록에서 받은 전역 ID를 사용합니다. 여러 선택은 요청 순서를 유지하고 같은 항목의 반복 선택만 제거합니다. 포함 관계인 glossary와 term을 함께 선택하면 둘 다 반환합니다.

조회마다 디스크를 확인하고 변경된 파일만 재파싱합니다. 저장하지 않은 편집 내용은 포함하지 않습니다. 같은 서버의 동시 요청은 직렬 처리하고, 별도 CLI/서버끼리는 기존 캐시 잠금을 공유합니다. 대기 중 취소를 확인하며 캐시 잠금 대기는 취소할 수 있습니다. 이미 진행 중인 동기 파싱은 중간에 끊지 않습니다. 파일 전체 확인 비용은 vault 크기에 비례하며 watcher·페이지네이션은 아직 없습니다.

읽기 도구는 원본 Markdown을 반환합니다. 표·이미지는 목록과 위치까지만 제공하며 독립 원문 읽기나 이미지 바이너리 반환은 제공하지 않습니다. 나머지 제한과 색인 규칙은 [CLI 명세](CLI-INDEX-SPEC.md)를 따릅니다.

## 공용 Node API

`markdown-chroma/index`는 TypeScript 선언을 포함합니다. CLI와 MCP가 같은 `IndexService`를 사용합니다.

```js
const { IndexService } = require('markdown-chroma/index');
const service = new IndexService('/absolute/path/to/notes');
const sections = await service.execute({
  command: 'sections', arguments: { file: 'guide.md' }
});
const result = await service.execute({
  command: 'read-section',
  arguments: { file: 'guide.md', id: 'setup', includeChildren: false }
});
console.log(result.content);
```

명령별 입력은 `IndexQuery`와 `QueryArguments` 타입 및 `querySchemas`로 내보냅니다. `execute(query, { signal })`로 취소 신호를 전달할 수 있습니다. 라이브러리는 stdout/stderr에 결과를 출력하지 않습니다.

## 참고

- [VS Code MCP 확장 API](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [공식 TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
