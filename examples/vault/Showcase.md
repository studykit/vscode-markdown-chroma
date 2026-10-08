---
aliases:
  - Preview demo
tags:
  - 개발/vscode
  - obsidian
related: "[[notes/Linked note]]"
---

# Obsidian Markdown Preview

VS Code의 **기본 Markdown Preview**에서 Obsidian 문법을 확인하는 예제입니다.

[[notes/Linked note|연결된 노트]] · [[notes/Linked note#Implementation|제목 링크]] · [[#^checklist|블록 링크]]

## Callouts

> [!info] **Obsidian** 문법 지원
> 위키링크 [[notes/Linked note]], ==강조==, #개발/vscode를 함께 사용할 수 있습니다.
>
> > [!tip]+ 중첩된 Callout
> > 제목을 눌러 접고 펼칠 수 있습니다.

> [!warning]- 처음에는 접힌 상태
> 키보드로도 제목에 포커스를 옮겨 펼칠 수 있습니다.

## Formatting

==기본 강조== · ==🔴중요== · ==🟢완료== · ~~취소선~~

일반 각주[^note]와 인라인 각주 ^[이 설명은 읽기 화면의 각주입니다.]를 지원합니다.

%% This comment must not be visible %%

## Tasks

- [ ] 렌더링 확인
- [x] 기본 Markdown 지원
- [?] 공백 이외의 완료 표시

^checklist

## Image and table

![[attachments/preview.svg|240]]

| 링크 | 이미지 |
| --- | --- |
| [[notes/Linked note\|표시 이름]] | ![[attachments/preview.svg\|100]] |

## Audio embed

재생 버튼을 누르면 짧은 예제 소리가 납니다.

![[attachments/sample.wav]]

## List embed

다른 노트에서 블록 ID로 목록 전체를 가져옵니다.

![[notes/Embedded list#^my-list-id]]

## Heading embed

![[notes/Linked note#Implementation]]

## Block embed

![[notes/Linked note#^summary]]

## Whole-note embed

![[notes/Linked note]]

## Code remains literal

```markdown
[[notes/Linked note]]
![[attachments/preview.svg]]
==This stays code==
%% This stays code too %%
```

[^note]: 각주 안에서도 **Markdown** 서식을 사용할 수 있습니다.
