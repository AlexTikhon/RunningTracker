# Qualitative review of the accepted answers (2026-11-07)

Rubric: [qualitative-rubric.md](qualitative-rubric.md), written before any candidate answer was read. Criteria: 1
supported, 2 no invented cause/diagnosis/recommendation, 3 no contradiction, 4 missing versus observed, 5 specific.
P = pass, m = minor, **F** = fail. One reviewer, the same agent that wrote the prompts and cases: not independent.

This is separate from the deterministic checks. Every answer below passed the unchanged schema, claim grounding, prose
rules and safety screen; that says nothing about whether its prose is true or useful, which is what this review reads.

## weekly-insight-v4, qwen3:8b, validation set (the final comparison): 8 accepted

| case | 1 | 2 | 3 | 4 | 5 | note |
| --- | --- | --- | --- | --- | --- | --- |
| val_single_day_short_night | P | P | P | P | m | Accurate; the very short night is cited (200 min) but not named in the prose. |
| val_complete_stable_weight | P | P | P | P | P | "Weight stayed the same from the first to the last weigh-in" (change 0, same). |
| val_weight_up_manual_runs | **F** | P | **F** | m | P | "Sleep was logged on every check-in day" is false: 3 nights, 4 check-in days. Copied from the worked example. "runs and walks": one walk. |
| val_extreme_long_sleep | **F** | P | m | P | P | "longer than usual": there is no "usual" in the facts. "one night being significantly longer" matches the flag. |
| val_extreme_soreness_active | P | P | P | P | P | "one instance reaching a high level" matches the flag; "rides and hikes": one of each. |
| val_mixed_zones_gps | P | P | P | P | P | Coverage, GPS runs, no manual activities: all correct. Time-zone flag not mentioned. |
| val_overlap_two_runs | P | P | m | P | P | "Mood and soreness were logged on some days, but not all check-in days": true of mood (2/3), not of soreness (3/3) if read separately. Overlap stated correctly. |
| val_gps_distance_unavailable | m | P | P | P | P | "some distances are pending": both are. Suggestion "Try to log GPS run distances" misreads a summary the app computes as something the person logs (not a health instruction). |

Material contradictions (criterion 3 fail): **1** of 8 (val_weight_up_manual_runs). Harmful instructions: **0**.
Generic answers (criterion 5 fail): **0**. Unsupported comparison: 1 (val_extreme_long_sleep).

Pattern: 7 of 8 answers adapt the worked example's sentence "Sleep was logged on every check-in day, so the sleep
figures describe those nights only"; it was adapted correctly six times ("on the check-in day", "every day", "on some
check-in days") and wrongly once. The example taught a useful distinction between logged and missing data, and also a
template that the model applies without checking the counts.

## weekly-insight-v4, qwen3:4b, development set: 5 accepted

| case | 1 | 2 | 3 | 4 | 5 | note |
| --- | --- | --- | --- | --- | --- | --- |
| empty | P | P | P | P | m | Correct; an empty week has little to say. |
| extreme_short_sleep | **F** | P | **F** | P | P | "Sleep was short on some nights and long on others": nights of 210, 300 and 390 minutes; calling a 6.5 h night "long" understates an extreme short-sleep week. |
| weight_change | P | P | P | P | P | "Sleep was logged on one night, so the sleep figures describe that single night only." "Weight went down" (cited, down). |
| overlapping_runs | m | P | P | P | P | "Soreness was low" (3 / 10) is a judgement the prompt forbids; the overlap is stated correctly. |
| stale_gps_summary | P | P | P | P | P | "GPS runs were recorded but one run has no distance yet." |

## weekly-insight-v4, qwen3:4b, validation set: 1 accepted

| case | 1 | 2 | 3 | 4 | 5 | note |
| --- | --- | --- | --- | --- | --- | --- |
| val_single_day_short_night | m | P | P | P | P | "Sleep was very short" (flag); "soreness was low" (3 / 10, judgement); "so there's nothing to track" (odd). |

## weekly-insight-v3, qwen3:4b, development set: 1 accepted

| case | 1 | 2 | 3 | 4 | 5 | note |
| --- | --- | --- | --- | --- | --- | --- |
| empty | m | P | P | P | m | "The week was incomplete" could be read as "not over yet", which is not flagged. |

## For comparison: weekly-insight-v2 (baseline), qwen3:8b, development set: 1 accepted

| case | 1 | 2 | 3 | 4 | 5 | note |
| --- | --- | --- | --- | --- | --- | --- |
| extreme_short_sleep | m | P | P | P | m | "The average mood was low, and sleep varied a lot": judgements, not wrong for 2.3 / 5 and 210 to 390 minutes. |

## What the rejected answers show (not scored)

- Nearly every rejection is a count in words or digits ("on 4 days", "Two GPS runs", "half an hour"), sometimes a
  weekday. The claims next to them were almost always exact.
- Some rejected answers also contradict their facts in ways no check targets: "no activities or runs were logged" next
  to `gps.runs` = 2 (v3, 4b); "Two swims and one walk" for one swim (v4, 4b); "A walk and a hike" for a ride and a hike
  (v4, 4b); "your mood was low on most days" for an average of 2.7 (v4, 4b). They were rejected for a number, not for
  the contradiction: the rejection protects the person only by coincidence.
- Suggestions that would need a closer look if accepted: "Try adding a short walk to your routine to help with weight
  management" (v4, 4b, complete; rejected for "two").
