---
title: 용어집과 용어 참조
---

# 용어집과 용어 참조

[공식 MyST glossary 문서](https://mystmd.org/guide/glossaries-and-terms)의
용어 정의와 참조 문법을 확인하는 예제입니다. `myst.yml` 없이 기본 Markdown Preview로 볼 수 있습니다.

## 본문에서 용어 참조

{term}`MyST Markdown`은 {term}`지시문 <Directive>`과 {term}`역할 <Role>`을 사용해
Markdown을 확장합니다. 용어 링크를 클릭하면 아래의 해당 정의로 이동합니다.

용어의 원래 이름을 표시할 때는 {term}`Directive`, 표시 이름을 바꿀 때는
{term}`블록 지시문 <Directive>`처럼 참조합니다. 두 링크는 같은 정의를 가리킵니다.

정의보다 먼저 나오는 {term}`AST` 참조도 사용할 수 있습니다.
용어의 뜻을 한곳에 모은 목록은 {term}`용어집 <Glossary>`이라고 부릅니다.

## 작성 문법의 용어집

:::{glossary}
MyST Markdown
: 과학·기술 문서를 작성하기 위한 **Markdown 확장 문법**입니다.

Directive
: Callout, 그림, 표처럼 **블록 단위의 콘텐츠**를 표현하는 지시문입니다.

    - 그림에는 이미지와 캡션을 함께 지정할 수 있습니다.
    - Callout에는 제목과 여러 문단을 넣을 수 있습니다.

Role
: 수식이나 용어 참조처럼 **문장 안의 콘텐츠**를 표현하는 역할입니다.
:::

## 처리와 문서 구조의 용어집

```{glossary}
AST
: Abstract Syntax Tree의 약자로, 문서 구조를 표현하는 **추상 구문 트리**입니다.

Glossary
: 용어와 정의를 모아 놓은 목록입니다.

    정의 안에서도 {term}`AST`나 {term}`MyST Markdown`처럼 다른 용어를 참조할 수 있습니다.
```
