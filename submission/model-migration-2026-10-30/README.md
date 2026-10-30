# Analyst model migration, 30 October 2026

Nebius retires `nvidia/nemotron-3-super-120b-a12b` from Token Factory Serverless on 9 November 2026 and names
`nvidia/Nemotron-3.5-Super-VL` as the replacement (docs.tokenfactory.nebius.com/model-deprecations-november-2026,
read 30 Oct). Both list at $0.30 in and $0.90 out per million tokens (`/v1/models`, read 30 Oct).

Two arms on commit d1ff7dc, with only `NEBIUS_ANALYST_MODEL` changed and no `TAVILY_API_KEY` in either, so the rate
questions fail in both. Under the override the trace still labels the analyst "Nemotron 3 Super" in the `new-*` files.

| Check | Nemotron 3 Super (`old-*`) | Super VL (`new-*`) |
| --- | --- | --- |
| 18 messages, 3 runs (`tools/eval-live.mjs --runs 3`) | 16.67 ± 0.58 per run | 17.00 ± 0.00 per run |
| Demo day, 3 runs (`--day --runs 3`) | 8 ± 0 of 9 | 8 ± 0 of 9 |
| Analyst calls, median time and mean cost | 8 calls, 5.2 s, $0.00102 | 7 calls, 8.3 s, $0.00158 |
| Forced fallback (`tools/escalation-check.mjs`, 2 messages x 3) | 0 of 6: Token Factory answered 400 every time (`escalation-old.txt`) | 4 of 6 by the script's check; the other 2 asked how the costs were paid instead of recording them (`escalation.txt`) |

The misses: the rand rate (3 per arm) and ZiG payment (3 per arm) need Tavily; one "two expenses" run in the old arm
was a Token Factory timeout on the router, before any analyst call.

The forced-fallback rows ran on this commit's code, not d1ff7dc: Super VL by the new default, Nemotron 3 Super by
`NEBIUS_ANALYST_MODEL=nvidia/nemotron-3-super-120b-a12b` (`escalation-old.txt` is the
re-run with the script that prints the analyst id on its first line).
The 400 with Nemotron 3 Super came after a broken tool call ("{not json") in the history; the cause was not isolated
further. The restock answers were read by hand in both arms; none states a figure that is not in the book. On the ZiG step,
which reaches the analyst only because the rate lookup is off, both models miscounted bread stock in some runs.
