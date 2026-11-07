# Weekly insight model evaluation

Prompt weekly-insight-v3, policy weekly-insight-policy-2, development set (10 synthetic weeks per model). Provider calls: 10 of a limit of 11 (0 refused by the limit). Small sample: percentages and p95 are indicative only.

| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | timeouts | cold | warm median | warm p95 (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:4b | 100% | 1/10 | 9 | 0 | 0 | 0 | 10 (0 / 0) | 0 | 65.9 s | 47.9 s | 76.4 s (9) |

Grounding failures by kind (cases with at least one):

- qwen3:4b: number_in_prose 9, day_in_prose 1

## qwen3:4b: per case

| case | status | reason / violations | attempts | duration |
| --- | --- | --- | --- | --- |
| complete (cold) | failed_grounding | number_in_prose×10, day_in_prose×2 | 1 | 65.9 s |
| sparse | failed_grounding | number_in_prose×7 | 1 | 36.2 s |
| empty | ready | - | 1 | 20.5 s |
| extreme_soreness | failed_grounding | number_in_prose×5, suggestion dropped (extreme week) | 1 | 32.7 s |
| extreme_short_sleep | failed_grounding | number_in_prose×6, suggestion dropped (extreme week) | 1 | 37.3 s |
| weight_change | failed_grounding | number_in_prose×4 | 1 | 48.1 s |
| mixed_time_zones | failed_grounding | number_in_prose×16 | 1 | 51.6 s |
| overlapping_runs | failed_grounding | number_in_prose×5 | 1 | 66.2 s |
| stale_gps_summary | failed_grounding | number_in_prose×3 | 1 | 47.9 s |
| cross_training | failed_grounding | number_in_prose×7 | 1 | 76.4 s |

### qwen3:4b, complete (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "Monday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 420
        },
        {
          "day": "Sunday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 480
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "Sleep was logged on all seven nights, with a shortest night of 420 minutes and a longest of 480 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 3.4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "Mood was logged every day with an average score of 3.4."
    },
    {
      "claims": [
        {
          "day": "Wednesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "Soreness was logged every day but peaked at a 4 on Wednesday."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "up",
          "factId": "weight.change",
          "unit": "kg",
          "value": 0.3
        }
      ],
      "text": "Weight went up slightly from the first to the last weigh-in."
    }
  ],
  "suggestion": "Try adding a short walk after dinner to help with sleep quality.",
  "summary": "Your week had consistent check-ins across all days, with sleep logged every night. Average sleep was around 7.5 hours, and mood stayed steady at a 3.4 score. Soreness was low but peaked slightly on Wednesday."
}
```

### qwen3:4b, sparse (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 5
        }
      ],
      "text": "Check-ins were recorded on only two days, missing five days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 2
        },
        {
          "day": "Friday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 410
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 465
        }
      ],
      "text": "Sleep was logged on two days with a shortest night of 410 minutes and a longest night of 465 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 1
        }
      ],
      "text": "Mood and soreness were each logged only once this week."
    }
  ],
  "suggestion": "Try checking in at least once each day to help track your health.",
  "summary": "This week had few check-ins and no physical activities logged. Sleep was tracked on two days with average sleep around seven hours. Mood and soreness were only recorded once each."
}
```

### qwen3:4b, empty (ready), verbatim model answer

```json
{
  "summary": "This week had no check-ins and no activities recorded. The week was incomplete with all days missing check-ins and no runs or manual activities logged.",
  "observations": [
    {
      "text": "No check-ins were recorded this week.",
      "claims": [
        {
          "factId": "check_ins.days_with_data",
          "value": 0,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.days_missing",
          "value": 7,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.coverage",
          "value": 0,
          "unit": "percent",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "No activities or runs were logged this week.",
      "claims": [
        {
          "factId": "manual.activities",
          "value": 0,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "gps.runs",
          "value": 0,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Check in at least once this week to start logging your week."
}
```

### qwen3:4b, extreme_soreness (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 4
        }
      ],
      "text": "Check-ins were logged on three days but missed on four days."
    },
    {
      "claims": [
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 9
        }
      ],
      "text": "Soreness reached a high score of 9 on one day."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 6.9
        }
      ],
      "text": "Sleep was logged on three nights with an average of about 7 hours."
    }
  ],
  "suggestion": "null",
  "summary": "This week had some check-ins and sleep tracking, but few check-ins were recorded. Soreness was high on at least one day, and sleep patterns varied."
}
```

### qwen3:4b, extreme_short_sleep (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 4
        }
      ],
      "text": "Check-ins were recorded on three days but missed on four days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "Monday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 210
        },
        {
          "day": "Thursday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 390
        }
      ],
      "text": "Sleep was logged on three nights with a shortest night of 210 minutes and a longest night of 390 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 3
        }
      ],
      "text": "Mood was logged on three days but not every day."
    }
  ],
  "suggestion": "null",
  "summary": "This week had some check-ins and sleep logged, but few activities were recorded. The sleep patterns showed both short and long nights. Mood was logged on a few days but not consistently."
}
```

### qwen3:4b, weight_change (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 4
        }
      ],
      "text": "Check-ins were recorded on only three days, missing four days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 0
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 0
        }
      ],
      "text": "No physical activities or runs were logged."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7.5
        }
      ],
      "text": "Sleep was logged on one night with an average of seven and a half hours."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "down",
          "factId": "weight.change",
          "unit": "kg",
          "value": 2.3
        }
      ],
      "text": "Weight went down from the first to the last weigh-in."
    }
  ],
  "suggestion": "Try checking in on more days to improve tracking.",
  "summary": "This week had few check-ins and no physical activity logged. Sleep was recorded on one night, but the average sleep duration was short. Weight dropped significantly from the first to the last weigh-in."
}
```

### qwen3:4b, mixed_time_zones (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 3
        }
      ],
      "text": "Check-ins were recorded on four days but missed on three days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 4
        },
        {
          "day": "Wednesday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 380
        },
        {
          "day": "Saturday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 470
        }
      ],
      "text": "Sleep was logged on four nights, with a shortest night of 380 minutes and a longest night of 470 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 4
        }
      ],
      "text": "Mood was logged on four days with an average score of four."
    }
  ],
  "suggestion": "Try checking in on a day you feel most awake to help track your patterns.",
  "summary": "This week had check-ins on four days and missed three days, with a 57% check-in coverage. Sleep was logged on four nights, averaging about seven hours with a shortest night of 380 minutes and a longest night of 470 minutes. Mood was logged on four days with an average score of four."
}
```

### qwen3:4b, overlapping_runs (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 6
        }
      ],
      "text": "Check-ins were recorded on only one day, with six days missing."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7.5
        }
      ],
      "text": "Sleep was logged for only one night, with an average of seven and a half hours."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 1
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 3
        }
      ],
      "text": "Mood and soreness were both recorded on one day, with the highest soreness level being three."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.run.distance",
          "unit": "km",
          "value": 5
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.distance",
          "unit": "km",
          "value": 5.08
        }
      ],
      "text": "Manual and GPS runs both show a distance of five kilometers but may be the same activity."
    }
  ],
  "suggestion": "Try checking in on more days to improve your data coverage.",
  "summary": "Your week had limited check-ins and only one night of sleep logged. Mood and soreness were both recorded on a single day, with no significant changes noted. Manual and GPS runs both show similar distances but may overlap."
}
```

### qwen3:4b, stale_gps_summary (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 6
        }
      ],
      "text": "Check-ins were recorded on only one day, with six days missing."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7
        }
      ],
      "text": "Sleep was logged for one night, with an average of seven hours."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 0
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 2
        }
      ],
      "text": "Mood was recorded once, but no activities or runs were logged."
    }
  ],
  "suggestion": "Try checking in on two days this week to improve your data coverage.",
  "summary": "Your week had limited check-ins and only one night of sleep logged. Mood was recorded once, but no activities or runs were logged manually or via GPS."
}
```

### qwen3:4b, cross_training (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 4
        }
      ],
      "text": "Check-ins were recorded on three days, but missed on four days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "Thursday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 455
        },
        {
          "day": "Sunday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 500
        }
      ],
      "text": "Sleep was logged on three days, with a shortest night of 455 minutes and a longest night of 500 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "Thursday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 2
        }
      ],
      "text": "Mood and soreness were logged on three days each, with soreness staying low."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.duration",
          "unit": "minutes",
          "value": 130
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 0
        }
      ],
      "text": "Manual activities and swims were logged, but no GPS runs were recorded."
    }
  ],
  "suggestion": "Try checking in on more days to keep your week consistent.",
  "summary": "Your week had some check-ins but not enough to be consistent. Sleep was logged on three days, with a shortest night and a longest night. Mood and soreness were tracked on a few days, but not all."
}
```
