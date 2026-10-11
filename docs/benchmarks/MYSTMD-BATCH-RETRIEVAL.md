# MyST retrieval benchmark after batch reads

Date: 2026-10-11.

Across three fresh runs per condition, the updated CLI arm used less uncached input plus output than Bash alone. MCP did not show a token advantage. All runs answered the 13 questions. The strict 59-point rubric found two omitted details in CLI answers; the required source was returned in both cases.

## Method

- Corpus: 89 Markdown documents in [jupyter-book/mystmd docs](https://github.com/jupyter-book/mystmd/tree/59fb1f4d0578c84df4cd6f30e0a546515d617c70/docs), pinned to `59fb1f4d0578c84df4cd6f30e0a546515d617c70`.
- The same 13 questions and preregistered 59-point rubric as the [earlier comparison](MYSTMD-RETRIEVAL.md). Questions cover definitions versus mentions, repeated headings, metadata, tables/figures, notebook settings, and cross-document labels.
- Nine fresh agents without inherited conversation or previous answers. Every recorded model context was `gpt-6.1-sol` with `xhigh` reasoning.
- Three concurrent agents per round. Spawn order rotates: Bash/CLI/MCP, CLI/MCP/Bash, MCP/Bash/CLI. This balances order; it does not control provider caching.
- Identical read-only shell tools in all conditions. CLI/MCP are optional additions. Mixed agents receive the updated batch-read contract, but choose their own searches, selections, and verification.
- Each agent first loads its own instruction file in one setup call, then uses the logging harness. This setup is included in the primary usage/time totals and excluded from the 55-retrieval-invocation limit.
- Maximum 5,000 output tokens per shell tool call, with the default aggregate output cap. A harness invocation can contain several native commands. Source inspection is restricted to the corpus; no builds, index construction, cache reads, memory, network, or other agents.
- Separate CLI/MCP caches for every round. Every warm refresh reused all 89 documents with zero reparses. MCP uses the actual SDK-connected stdio server through a local bridge. Index creation and MCP startup are excluded; per-invocation CLI startup is included. Native client tool-schema injection costs are not modeled directly by this bridge.
- Per-response provider usage is deduplicated by response ID. Output already includes reasoning; reasoning is not added twice. Parent setup, grading, and verification are excluded.
- Manual, non-blind factual review against every rubric item. Equivalent wording and supported alternate source locations are accepted. Exact heading spelling and prose Markdown wrappers are outside fact-point scoring.
- Corpus source hashes and built CLI/MCP hashes remained unchanged. All agents respected the tool restrictions and retrieval limit; self-reported invocation counts match logs.

## Mean results

Tokens here mean `input_tokens - cached_input_tokens + output_tokens`. They include instruction-file setup, prompt loading, tool use, reasoning, and the final answer. They are not a price estimate.

| Condition | Fact points across 3 runs | Mean tokens | Versus Bash | Mean time | Mean retrieval invocations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bash | 177/177 | 40,473 | baseline | 94.6 s | 14.3 |
| Bash + CLI | 175/177 | 32,380 | -20.0% | 109.7 s | 13.3 |
| Bash + MCP | 177/177 | 40,999 | +1.3% | 105.5 s | 11.7 |

CLI was lower in each round, but took longer than Bash. MCP used fewer retrieval invocations without reducing mean tokens or elapsed time.

## Prompt/cache sensitivity

The first two responses comprise the instruction-file loading response and the first planning response after loading the benchmark prompt. Excluding them gives the following sensitivity calculation:

| Condition | Mean tokens after first two responses | Versus Bash | Range across 3 runs |
| --- | ---: | ---: | ---: |
| Bash | 34,615 | baseline | 30,716–36,745 |
| Bash + CLI | 29,650 | -14.3% | 27,119–32,637 |
| Bash + MCP | 38,434 | +11.0% | 35,347–43,239 |

CLI's reduction changes from 20.0% to 14.3%; MCP's comparison changes from 1.3% higher to 11.0% higher. Initial uncached input plus output averaged 5,858 tokens for Bash, 2,729 for CLI, and 2,565 for MCP. Cached input is provider-controlled and was not equalized. Removing these responses also removes their initial planning/output, so this is not an isolated estimate of prompt cost. Later cache differences remain. This subtraction is a sensitivity check, not a controlled rerun or proof of a causal batch-read effect.

The earlier single trial used an inline benchmark prompt rather than the instruction-file setup step. Direct old-versus-new absolute token/time comparisons therefore also include a protocol difference. These new runs provide their own Bash baseline.

## Every trial

| Round | Condition | Fact points | Tokens including setup | Tokens after first 2 responses | Time | Retrieval invocations |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Bash | 59/59 | 43,295 | 30,716 | 97.9 s | 9 |
| 1 | Bash + CLI | 58/59 | 30,027 | 27,119 | 116.1 s | 12 |
| 1 | Bash + MCP | 59/59 | 37,829 | 35,347 | 108.5 s | 11 |
| 2 | Bash | 59/59 | 39,173 | 36,745 | 84.0 s | 15 |
| 2 | Bash + CLI | 58/59 | 31,978 | 29,195 | 101.3 s | 14 |
| 2 | Bash + MCP | 59/59 | 45,799 | 43,239 | 96.1 s | 10 |
| 3 | Bash | 59/59 | 38,952 | 36,385 | 102.0 s | 19 |
| 3 | Bash + CLI | 59/59 | 35,134 | 32,637 | 111.7 s | 14 |
| 3 | Bash + MCP | 59/59 | 39,368 | 36,716 | 111.8 s | 14 |

## Retrieval and model work

| Condition | Batch reads across 3 runs | Mean model responses | Mean output tokens | Mean reasoning subset | Mean cumulative input + output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bash | 0 | 7.3 | 4,449 | 1,394 | 294,383 |
| Bash + CLI | 7 | 6.7 | 5,024 | 1,885 | 249,510 |
| Bash + MCP | 12 | 6.7 | 4,783 | 1,748 | 262,993 |

Cumulative tokens include repeatedly cached input and are not interchangeable with the uncached-input-plus-output metric. Reasoning is a subset of output.

CLI used natural-name batch reads 2/3/2 times per round; MCP used them 4/3/5 times. No read-budget omissions or per-item selection errors occurred. Mixed arms still supplemented structural reads with shell searches. MCP listed all 15 tool schemas once per run, returning 13,863 UTF-8 bytes each time. This contributes input, but its total token effect was not isolated. It is not sufficient to explain all differences between conditions.

Agent-visible tool-result bytes, including instruction-file setup and tool wrappers, averaged 110,276 for Bash, 84,914 for CLI, and 109,103 for MCP. These are byte counts, not token estimates; actual model usage is reported above.

## Accuracy and completeness

All 39 question answers per condition contained substantively correct responses. The stricter rubric gave Bash and MCP 177/177 fact points, and CLI 175/177. In CLI rounds 1 and 2, Q11 identified all five referring documents but did not state that PDF template parts can be required. Both the shell search and returned source contained that sentence. This was an answer-completeness omission, not missing retrieval evidence. Q11 asks for brief referral topics, so interpret this detail penalty conservatively. CLI round 3 included it.

Bash rounds 1 and 3 used a literal backslash-n in compact `show-index` examples; replace it with an actual newline when copying the directive. This formatting issue is outside factual scoring.

The root retains upstream indexing diagnostics. CLI had 3/4/3 partial responses; MCP had 3/4/6. Successful source remained available, with no budget omissions or item errors. The project-wide backlink query returned `complete: false`, so shell verification remains appropriate. The label fix returned all five referring documents, including all three `website-navigation.md` links to `#parts:site`; no missing referral was found in any answer.

These are three trials on one corpus and question set, without a feature ablation or cache control. They support a lower measured CLI retrieval cost in this workflow, while MCP still needs investigation. They do not establish a universal advantage over grep/rg or show that batching alone caused the reduction.

Detailed prompts, usage events, commands, answers, and protocol logs are in the ignored `artifacts/benchmarks/20261011-mystmd-batch-r1`, `-r2`, and `-r3` directories. Aggregated metrics, grading, and audits are in `artifacts/benchmarks/20261011-mystmd-batch`. This public report omits machine paths and session identifiers.
