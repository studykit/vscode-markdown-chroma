# MyST retrieval benchmark and token analysis

Date: 2026-10-11.

For the later nine-run comparison with natural-name batches and corrected label backlinks, see [the batch-read benchmark](MYSTMD-BATCH-RETRIEVAL.md). The results below describe the earlier single trial.

This exploratory comparison measured Bash alone, Bash + Markdown Chroma CLI, and Bash + Markdown Chroma MCP. All three agents recovered the 59 required facts across 13 questions. Adding Chroma did not establish a token or speed advantage in this trial. Cache differences materially affected the uncached-token comparison.

## Setup

- Corpus: 89 Markdown files in [jupyter-book/mystmd docs](https://github.com/jupyter-book/mystmd/tree/59fb1f4d0578c84df4cd6f30e0a546515d617c70/docs), pinned to revision `59fb1f4d0578c84df4cd6f30e0a546515d617c70`.
- Three fresh agents, each recorded as `gpt-6.1-sol` with `xhigh` reasoning. One trial per arm; agents ran concurrently.
- All arms could use the same read-only shell tools, including grep, rg, sed, awk, and cat. Chroma use was optional in the mixed arms.
- CLI and MCP were preindexed. Warm checks reused all 89 documents with zero reparses. Index construction was excluded from task timing and model usage.
- The MCP server and SDK connection were initialized before the task. The agent's tools/list request was included. CLI startup on each invocation was included.
- The same 13 questions covered glossary definitions, term/index syntax, code options, CSV tables, frontmatter, notebook labels and execution, document referrals, figures, and related glossary concepts.
- All agents had the same limit of 55 logged retrieval invocations and 5,000 output tokens per shell tool call, with the default aggregate output cap. A shell invocation could contain several native commands.
- Source access was restricted to the corpus. Agents could not consult previous answers, implementation files, web sources, or index caches.

## Results

| Arm | Factual questions | Fact points | Cumulative tokens | Cached input | Uncached input + output | Task time | Retrieval invocations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bash | 13/13 | 59/59 | 316,810 | 280,192 | 36,618 | 84.0 s | 12 |
| Bash + CLI | 13/13 | 59/59 | 300,673 | 253,952 | 46,721 | 127.8 s | 24 |
| Bash + MCP | 13/13 | 59/59 | 312,293 | 278,144 | 34,149 | 110.8 s | 19 |

Cumulative tokens sum input and output over the eight model responses in each task, including repeated cached context. Uncached input plus output is `input - cached_input + output`; it is not a price estimate. Output already includes reasoning tokens. Prompt loading and the final answer are included. Parent setup, grading, integration checks, and transport replay are excluded.

Factual grading was a manual, non-blind review against the preregistered 59-point rubric. Equivalent wording and supported alternative source locations were accepted. Exact source-heading spelling and prose Markdown wrappers were outside that rubric. Bash and MCP answers added outer backticks around two inline MyST role examples; those wrappers need cleanup before copying the syntax.

## Cache sensitivity

The first response loaded the task prompt before corpus retrieval. Its input size was almost identical across arms, but MCP had substantially more cached input.

| Arm | First-response input | First-response cached input | Uncached input + output excluding first response |
| --- | ---: | ---: | ---: |
| Bash | 23,468 | 19,840 | 32,923 |
| Bash + CLI | 23,467 | 19,840 | 43,026 |
| Bash + MCP | 23,469 | 23,168 | 33,780 |

MCP's first-response uncached input plus output was 369 tokens, compared with 3,695 for Bash and CLI. Removing that initial response changes MCP's comparison from 6.7% fewer to 2.6% more uncached input plus output; CLI becomes 30.7% higher.

This is a sensitivity calculation, not a cache-controlled rerun. Subsequent cache differences remain. The original MCP reduction cannot be attributed to Chroma itself.

## Retrieval and model work

| Arm | Bash invocations | Chroma invocations | Generated tokens | Reasoning subset |
| --- | ---: | ---: | ---: | ---: |
| Bash | 12 | 0 | 3,970 | 1,106 |
| Bash + CLI | 8 | 16 | 6,228 | 2,626 |
| Bash + MCP | 8 | 11 | 5,255 | 2,140 |

CLI used 12 section reads, two term reads, one backlink query, and one section outline. MCP used seven section reads, one term read, one property search, one backlink query, and tools/list. Neither agent chose raw line reads, frontmatter reads, table listings, or image listings.

The mixed arms retained substantial shell retrieval and source verification while generating more command, reasoning, and answer tokens. All arms made eight model responses, so the higher retrieval counts did not increase the number of model responses in this trial.

CLI's increase of 10,103 uncached input plus output tokens consisted of 7,845 more uncached input tokens and 2,258 more output tokens. Reasoning alone increased by 1,520 tokens. This identifies contributors to the measured increase without isolating a causal tool cost.

## Accuracy limitations

The index reported 166 diagnostics across 36 documents. Each mixed arm made six Chroma calls returning partial-result status with useful content. This was included in the experiment rather than treated as a complete index.

The backlink query for `document-parts.md` omitted a referral from `website-navigation.md` through a text-bearing `#parts:site` link. Both mixed agents supplemented the result with shell searches and recovered all five referring documents. Accurate label resolution is necessary before relying on these backlinks to eliminate source verification.

The follow-up implementation fixes explicit project-label resolution for these links. A pinned-corpus regression now recovers all five referring documents, including all three `website-navigation.md` references. These fixes and natural-name batch reads were added after this trial; the token results above remain measurements of the earlier behavior.

The MCP arm also issued one shell search with a nonexistent filename and recovered through subsequent retrieval. Its warning and recovery were included in usage.

## Follow-up comparisons

To isolate extraction costs, hold lexical search candidates and selected source locations constant, then compare shell, CLI, and MCP reads of the same evidence. Measure tool descriptions, arguments, returned content, model output, reasoning, and cache usage separately. Use repeated trials with balanced execution order.

Evaluate more demanding questions separately: repeated headings, global labels, definition-versus-mention selection, and multi-document evidence. Score factual coverage and source accuracy alongside tokens. A useful retrieval improvement should reduce unnecessary source reading or verification while retaining every required fact and reporting incomplete evidence.

Detailed local prompts, usage events, commands, responses, and grading records are kept under the ignored `artifacts/benchmarks/20261011-mystmd-bash-hybrid` directory. This document omits machine-specific paths and session identifiers.

## Fixed-selection batch regression

A follow-up source-level check holds four selections constant: “Add website parts” with children, its “Share the same part across multiple sites” child, “Glossaries,” and the `glossary` definition within it. Separate reads use the same section ranges as the batch. The batch preserves every selected source exactly, merging the two overlapping pairs.

| Measurement | Separate reads | Natural-name batch |
| --- | ---: | ---: |
| Read requests | 4 | 1 |
| Returned source characters | 5,027 | 3,912 |

The 1,115-character reduction (22.2%) comes from overlapping source. It excludes metadata, arguments, tool descriptions, and model reasoning. It is not an LLM token measurement. CLI JSON, stdio MCP, and HTTP MCP return identical concise batch data, with the same 15 MCP tools.

A 106-character budget omits the entire 2,218-character website section while retaining the later 106-character glossary definition. The response explicitly reports the omission and remains partial. The corpus was already indexed; the warm refresh reparsed zero of its 89 documents. Local verification code and results are under the ignored `artifacts/benchmarks/20261011-retrieval-batch` directory.
