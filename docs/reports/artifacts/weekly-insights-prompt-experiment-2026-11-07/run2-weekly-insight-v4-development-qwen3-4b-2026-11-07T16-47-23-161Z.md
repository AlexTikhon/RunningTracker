# Weekly insight model evaluation

Prompt weekly-insight-v4, policy weekly-insight-policy-2, development set (10 synthetic weeks per model). Provider calls: 10 of a limit of 11 (0 refused by the limit). Small sample: percentages and p95 are indicative only.

| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | timeouts | cold | warm median | warm p95 (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:4b | 100% | 5/10 | 5 | 0 | 0 | 0 | 10 (0 / 0) | 0 | 105.2 s | 56.3 s | 76.2 s (9) |

Grounding failures by kind (cases with at least one):

- qwen3:4b: number_in_prose 5

## qwen3:4b: per case

| case | status | reason / violations | attempts | duration |
| --- | --- | --- | --- | --- |
| complete (cold) | failed_grounding | number_in_prose×2 | 1 | 105.2 s |
| sparse | failed_grounding | number_in_prose×5 | 1 | 65.1 s |
| empty | ready | - | 1 | 22.6 s |
| extreme_soreness | failed_grounding | number_in_prose×6, suggestion dropped (extreme week) | 1 | 76.2 s |
| extreme_short_sleep | ready | suggestion dropped (extreme week) | 1 | 50.3 s |
| weight_change | ready | - | 1 | 56.3 s |
| mixed_time_zones | failed_grounding | number_in_prose×1 | 1 | 39.6 s |
| overlapping_runs | ready | - | 1 | 70.3 s |
| stale_gps_summary | ready | - | 1 | 55.2 s |
| cross_training | failed_grounding | number_in_prose×7 | 1 | 57.0 s |

### qwen3:4b, complete (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 7
        },
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
        }
      ],
      "text": "Sleep was logged every day, so the average and shortest/longest nights describe the full week."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 7
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "Mood and soreness were logged every day, so the averages reflect the full week."
    },
    {
      "claims": [
        {
          "day": "Monday",
          "direction": "none",
          "factId": "weight.first",
          "unit": "kg",
          "value": 71.8
        },
        {
          "day": "Sunday",
          "direction": "none",
          "factId": "weight.last",
          "unit": "kg",
          "value": 72.1
        },
        {
          "day": "none",
          "direction": "up",
          "factId": "weight.change",
          "unit": "kg",
          "value": 0.3
        }
      ],
      "text": "Weight went up from the first to the last weigh-in."
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
          "factId": "gps.runs",
          "unit": "count",
          "value": 2
        }
      ],
      "text": "You did two manual activities and two GPS runs, with walks and strength sessions."
    }
  ],
  "suggestion": "Try adding a short walk to your routine to help with weight management.",
  "summary": "You checked in every day and logged sleep, mood, soreness and weight consistently. Sleep and mood stayed steady with a healthy average quality and no extreme soreness. Weight went up slightly from the first to the last weigh-in."
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
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_minutes",
          "unit": "minutes",
          "value": 438
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.average_hours",
          "unit": "hours",
          "value": 7.3
        }
      ],
      "text": "Sleep was logged on two nights, so the average describes those two nights only."
    },
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
      "text": "Check-ins were only on two days, so the coverage is low."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 1
        }
      ],
      "text": "Mood was logged on one day, so the average is based on a single day."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 1
        }
      ],
      "text": "Soreness was low but only recorded on one day."
    }
  ],
  "suggestion": "Try checking in twice a week to get more data points.",
  "summary": "You checked in on only two days and logged sleep and mood on one day each. Soreness was low but not recorded on most days."
}
```

### qwen3:4b, empty (ready), verbatim model answer

```json
{
  "summary": "No check-ins were recorded this week, and there were no activities or runs logged.",
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
    }
  ],
  "suggestion": "Try checking in once a day to start logging your week."
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
          "factId": "sleep.nights_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 400
        },
        {
          "day": "Monday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 430
        }
      ],
      "text": "Sleep was logged on some days, with a shortest and longest night."
    },
    {
      "claims": [
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 9
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 6.7
        }
      ],
      "text": "Soreness was high on some days, with a highest score of 9."
    },
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
      "text": "You checked in on only a few days, with 3 days having check-ins and 4 missing."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.duration",
          "unit": "minutes",
          "value": 70
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.distance",
          "unit": "km",
          "value": 13.4
        }
      ],
      "text": "There was one GPS run that lasted 70 minutes and covered 13.4 km."
    }
  ],
  "suggestion": "null",
  "summary": "You checked in on only a few days and logged sleep and soreness each time. Soreness was high on some days, and there were no manual activities."
}
```

### qwen3:4b, extreme_short_sleep (ready), verbatim model answer

```json
{
  "summary": "You checked in on only a few days and logged sleep and mood each time. Sleep was short on some nights and long on others, but no activities were recorded.",
  "observations": [
    {
      "text": "Sleep was logged on the check-in days, so the sleep figures describe those nights only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 3,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 210,
          "unit": "minutes",
          "direction": "none",
          "day": "Monday"
        },
        {
          "factId": "sleep.longest",
          "value": 390,
          "unit": "minutes",
          "direction": "none",
          "day": "Thursday"
        }
      ]
    },
    {
      "text": "Some days have no check-in, so the averages leave part of the week out.",
      "claims": [
        {
          "factId": "check_ins.days_with_data",
          "value": 3,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.days_missing",
          "value": 4,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "No activities were recorded this week.",
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
  "suggestion": "null"
}
```

### qwen3:4b, weight_change (ready), verbatim model answer

```json
{
  "summary": "You checked in on only a few days and logged sleep on one night. Weight went down from the first to the last weigh-in, and no activities were recorded.",
  "observations": [
    {
      "text": "Sleep was logged on one night, so the sleep figures describe that single night only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 1,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 450,
          "unit": "minutes",
          "direction": "none",
          "day": "Sunday"
        },
        {
          "factId": "sleep.longest",
          "value": 450,
          "unit": "minutes",
          "direction": "none",
          "day": "Sunday"
        }
      ]
    },
    {
      "text": "Some days have no check-in, so the averages leave part of the week out.",
      "claims": [
        {
          "factId": "check_ins.days_with_data",
          "value": 3,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.days_missing",
          "value": 4,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "Weight went down from the first to the last weigh-in.",
      "claims": [
        {
          "factId": "weight.first",
          "value": 74.2,
          "unit": "kg",
          "direction": "none",
          "day": "Monday"
        },
        {
          "factId": "weight.last",
          "value": 71.9,
          "unit": "kg",
          "direction": "none",
          "day": "Sunday"
        },
        {
          "factId": "weight.change",
          "value": 2.3,
          "unit": "kg",
          "direction": "down",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try checking in once a day to get more data for next week."
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
      "text": "Sleep was logged on all check-in days, so the sleep figures describe those nights only."
    },
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
          "factId": "manual.activities",
          "unit": "count",
          "value": 0
        }
      ],
      "text": "Check-ins were spread across the week, but no activities were recorded."
    }
  ],
  "suggestion": "Try adding a short walk or activity today to start recording movement.",
  "summary": "You checked in on 4 days and logged sleep and mood each time. No activities were recorded this week."
}
```

### qwen3:4b, overlapping_runs (ready), verbatim model answer

```json
{
  "summary": "You checked in on only one day and logged sleep and mood that day. Soreness was low but logged, and a run was the only activity.",
  "observations": [
    {
      "text": "Sleep was logged on the single check-in day, so the sleep figures describe that night only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 1,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 450,
          "unit": "minutes",
          "direction": "none",
          "day": "Tuesday"
        },
        {
          "factId": "sleep.longest",
          "value": 450,
          "unit": "minutes",
          "direction": "none",
          "day": "Tuesday"
        }
      ]
    },
    {
      "text": "Check-ins were sparse, so the averages leave most of the week out.",
      "claims": [
        {
          "factId": "check_ins.days_with_data",
          "value": 1,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.days_missing",
          "value": 6,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "Soreness was low but logged on the single check-in day.",
      "claims": [
        {
          "factId": "soreness.highest",
          "value": 3,
          "unit": "score_0_10",
          "direction": "none",
          "day": "Tuesday"
        },
        {
          "factId": "soreness.average",
          "value": 3,
          "unit": "score_0_10",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "A run was logged, but manual and GPS runs may be the same.",
      "claims": [
        {
          "factId": "manual.run.count",
          "value": 1,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "gps.runs",
          "value": 1,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try checking in every evening to cover more days next week."
}
```

### qwen3:4b, stale_gps_summary (ready), verbatim model answer

```json
{
  "summary": "You checked in on only one day and logged sleep and mood that day. GPS runs were recorded but one run has no distance yet.",
  "observations": [
    {
      "text": "Sleep and mood were logged on the single check-in day, so the figures describe that night only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 1,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 420,
          "unit": "minutes",
          "direction": "none",
          "day": "Wednesday"
        },
        {
          "factId": "sleep.longest",
          "value": 420,
          "unit": "minutes",
          "direction": "none",
          "day": "Wednesday"
        }
      ]
    },
    {
      "text": "Check-ins were sparse, so the averages don't cover the whole week.",
      "claims": [
        {
          "factId": "check_ins.days_with_data",
          "value": 1,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "check_ins.days_missing",
          "value": 6,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "GPS runs were recorded but one run has no distance yet.",
      "claims": [
        {
          "factId": "gps.runs_without_current_distance",
          "value": 1,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "gps.runs",
          "value": 2,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try checking in every day to get more data for next week."
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
      "text": "Sleep was logged on three nights, with a shortest night of 455 minutes and a longest of 500 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 3
        }
      ],
      "text": "Check-ins were recorded on three days, so the averages only cover those nights."
    },
    {
      "claims": [
        {
          "day": "Thursday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 2
        }
      ],
      "text": "Soreness was low on most days, with a highest score of 2."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 2
        }
      ],
      "text": "Two activities were recorded: a ride and a swim."
    }
  ],
  "suggestion": "Try checking in every evening to cover more days next week.",
  "summary": "You checked in on only a few days and logged sleep and mood each time. Soreness was low on most days, and two activities were recorded."
}
```
