---
title: MyST 전체 미리보기
bibliography: references.bib
description: 기본 Markdown Preview에서 프로젝트 설정 없이 렌더링하는 예제
---

(myst-intro)=
# MyST 전체 미리보기

VS Code 기본 Markdown Preview에서 MyST 문법을 확인합니다. {abbr}`AST (Abstract Syntax Tree)`,
H{sub}`2`O, x{sup}`2`, {kbd}`Ctrl + Enter` 같은 인라인 역할도 지원합니다.

% 이 MyST 주석은 렌더링되지 않아야 합니다.

## 중첩·접기와 directive 옵션

::::{note} 공식 엔진을 사용하는 미리보기
:label: myst-note

본문의 **Markdown**, 수식 $E=mc^2$, [문서 간 참조](#linked-target)를 함께 처리합니다.

:::{warning} 중첩 경고
콜론 fence를 중첩할 때 바깥 fence를 더 길게 작성합니다.
:::
::::

```{admonition} 접고 펼치는 설명
:class: dropdown

이 내용은 제목을 클릭해 접거나 펼칠 수 있습니다.
```

## 수식·번호·상호 참조

인라인 수식 역할: {math}`a^2+b^2=c^2`.

```{math}
:label: pythagoras

a^2 + b^2 = c^2
```

{eq}`pythagoras`와 {ref}`다른 문서의 제목 <linked-target>`를 참조합니다.

## 그림과 표

```{figure} assets/preview.svg
:label: myst-figure
:width: 240px
:align: center
:alt: Obsidian과 VS Code 미리보기 로고

레이블과 캡션이 있는 그림입니다.
```

:::{list-table} 지원 항목
:header-rows: 1
:label: myst-table

* - 종류
  - 렌더링
* - 수식
  - KaTeX
* - 인용
  - BibTeX
:::

그림 [](#myst-figure)과 표 [](#myst-table)의 번호를 자동으로 참조합니다.

## 코드·정의 목록·각주

```{code-block} python
:linenos:
:emphasize-lines: 2
:caption: 간단한 Python 예제

value = 42
print(value)
```

MyST
: 과학 문서를 위한 Markdown 문법입니다.

각주를 참조합니다.[^myst-footnote]

[^myst-footnote]: MyST 각주 예제입니다.

## 탭·그리드·카드

::::{tab-set}
:::{tab-item} Python
```python
print("Hello MyST")
```
:::
:::{tab-item} JavaScript
```javascript
console.log("Hello MyST");
```
:::
::::

::::{grid} 1 1 2 2
:::{card} 첫 번째 카드
카드 본문에 **Markdown**을 쓸 수 있습니다.
:::
:::{card} 두 번째 카드
[연결된 문서](linked.md)
:::
::::

## 정리·증명·연습문제

```{prf:theorem} 양수의 합
:label: sum-theorem

양수 두 개의 합은 양수입니다.
```

```{prf:proof}

$a>0$, $b>0$이면 $a+b>0$입니다.
```

```{exercise} 덧셈
:label: addition-exercise

$1+1$을 계산하세요.
```

```{solution} addition-exercise
:class: dropdown

답은 $2$입니다.
```

## 다른 파일·노트북 포함

```{include} included.md
```

```{embed} notebook.ipynb#saved-output
:remove-input: true
```

## 인용과 참고문헌

로컬 BibTeX 인용: {cite:p}`knuth1984`.

```{bibliography}
```
