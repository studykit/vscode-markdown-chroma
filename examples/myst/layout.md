---
title: Asides와 Figures
---

# Asides와 Figures

[공식 Asides 문서](https://mystmd.org/guide/asides)와
[Figures 문서](https://mystmd.org/guide/figures)의 기능을 확인하는 예제입니다.

## Aside·margin·sidebar·topic

본문과 간접적으로 관련된 설명을 여백에 표시합니다. 패널이 좁으면 본문 안에 표시됩니다.

:::{aside} Aside 설명
:label: layout-aside

**Aside 본문**은 본문 옆 여백에 나타납니다. 이미지와 Markdown도 포함할 수 있습니다.

![Aside 안의 이미지](assets/preview.svg)
:::

:::{margin} Margin 설명

**Margin 본문**은 여백의 보조 설명입니다.
:::

:::{sidebar} Sidebar 설명

**Sidebar 본문**은 별도의 보조 설명입니다.
:::

:::{topic} Topic 설명

**Topic 본문**은 제목이 있는 독립적인 주제를 표시합니다.
:::

{ref}`Aside 참조 <layout-aside>`도 사용할 수 있습니다.

## Image directive

```{image} assets/preview.svg
:alt: 크기와 정렬이 있는 이미지
:width: 160px
:align: center
```

## Figure directive와 번호 참조

```{figure} assets/preview.svg
:label: layout-figure
:alt: 캡션과 번호가 있는 그림
:width: 240px
:align: center

**그림 캡션**에는 Markdown 서식을 사용할 수 있습니다.
```

자동 번호: [](#layout-figure). 사용자 표시 이름: [그림 보기](#layout-figure).

## Subfigure와 개별 참조

:::{figure}
:label: layout-subfigures
:class: grid grid-cols-2 items-end gap-4

(layout-first-image)=
![첫 번째 하위 그림](assets/preview.svg)

![두 번째 하위 그림](assets/preview.svg)

두 이미지를 포함한 **전체 그림 캡션**입니다.
:::

전체: [](#layout-subfigures), 명시적 하위 레이블: [](#layout-first-image),
자동 하위 레이블: [](#layout-subfigures-b).

## 반응형 그림 그리드

::::{figure}
:label: layout-grid-figure

:::{grid} 1 1 2 2
![그리드 왼쪽 이미지](assets/preview.svg)

![그리드 오른쪽 이미지](assets/preview.svg)
:::

좁은 화면에서는 한 열, 넓은 화면에서는 두 열로 표시하는 그림입니다.
::::

## 확장자 wildcard

![포맷을 자동 선택한 이미지](assets/preview.*)

## 밝은·어두운 테마별 이미지

```{image} assets/preview.svg
:alt: 밝은 테마 이미지
:width: 120px
:class: dark:hidden
```

```{image} assets/preview.svg
:alt: 어두운 테마 이미지
:width: 120px
:class: hidden dark:block
```

## Video figure

:::{figure} assets/sample.mp4
:label: layout-video
:alt: 1초 길이의 예제 비디오

**비디오 캡션**도 그림처럼 표시됩니다.
:::

비디오 번호 참조: [](#layout-video).
