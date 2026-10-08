---
title: 공식 docs의 문법 예제
---

# 공식 docs의 문법 예제

[공식 MyST docs](https://github.com/jupyter-book/mystmd/tree/main/docs)의
syntax overview, typography, blocks, glossaries 문법을 확인합니다.

## YAML directive 옵션

```{note}
---
label: yaml-options-note
class: dropdown
---

**YAML 옵션 본문**입니다.
```

## 인라인 directive·role 옵션

:::{tip #inline-options-tip .dropdown}
**인라인 옵션 본문**입니다.
:::

{span #inline-options-span .font-semibold}`인라인 span 본문`을 표시합니다.

## Glossary와 term

:::{glossary}
MyST Preview
: 공식 MyST 파서를 사용하는 VS Code 기본 Markdown Preview입니다.
:::

용어 참조: {term}`미리보기 <MyST Preview>`.

## Index와 블록 메타데이터

:::{index} preview; MyST
:::

+++ {"label": "metadata-block", "class": "font-semibold"}

이 문장은 **블록 메타데이터 본문**입니다.

+++

## Div와 인라인 서식

:::{div}
:class: rounded border p-4

Div 본문에는 {u}`밑줄`, {del}`삭제`, {sub}`아래첨자`, {sup}`위첨자`를 사용할 수 있습니다.
:::

## Mermaid

```{mermaid}
flowchart LR
  Markdown --> MyST --> Preview
```
