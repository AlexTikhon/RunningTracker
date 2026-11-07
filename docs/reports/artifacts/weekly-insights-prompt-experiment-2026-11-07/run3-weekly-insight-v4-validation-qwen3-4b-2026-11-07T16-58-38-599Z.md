# Weekly insight model evaluation

Prompt weekly-insight-v4, policy weekly-insight-policy-2, validation set (10 synthetic weeks per model). Provider calls: 10 of a limit of 11 (0 refused by the limit). Small sample: percentages and p95 are indicative only.

| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | timeouts | cold | warm median | warm p95 (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:4b | 100% | 1/10 | 9 | 0 | 0 | 0 | 10 (0 / 0) | 0 | 65.8 s | 65.0 s | 83.7 s (9) |

Grounding failures by kind (cases with at least one):

- qwen3:4b: number_in_prose 8, day_in_prose 2

## qwen3:4b: per case

| case | status | reason / violations | attempts | duration |
| --- | --- | --- | --- | --- |
| val_mood_soreness_only (cold) | failed_grounding | number_in_prose×3 | 1 | 65.8 s |
| val_single_day_short_night | ready | suggestion dropped (extreme week) | 1 | 54.6 s |
| val_complete_stable_weight | failed_grounding | day_in_prose×1 | 1 | 74.9 s |
| val_weight_up_manual_runs | failed_grounding | number_in_prose×12 | 1 | 83.7 s |
| val_extreme_long_sleep | failed_grounding | number_in_prose×1 | 1 | 54.0 s |
| val_extreme_soreness_active | failed_grounding | number_in_prose×11, suggestion dropped (extreme week) | 1 | 66.5 s |
| val_mixed_zones_gps | failed_grounding | number_in_prose×5 | 1 | 65.0 s |
| val_overlap_two_runs | failed_grounding | number_in_prose×8, day_in_prose×1 | 1 | 78.4 s |
| val_gps_distance_unavailable | failed_grounding | number_in_prose×3 | 1 | 61.5 s |
| val_activities_no_check_ins | failed_grounding | number_in_prose×2 | 1 | 50.4 s |

### qwen3:4b, val_mood_soreness_only (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 5
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 5
        }
      ],
      "text": "Mood and soreness were logged on the same days, so the averages describe those nights only."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.strength.count",
          "unit": "count",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.duration",
          "unit": "minutes",
          "value": 50
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 0
        }
      ],
      "text": "You have a strength session and a 50-minute activity, but no GPS runs."
    }
  ],
  "suggestion": "Try adding a short check-in each evening to make sure all days are covered.",
  "summary": "You checked in on 5 days and logged mood and soreness each time. One strength session and a 50-minute activity were the only exercises."
}
```

### qwen3:4b, val_single_day_short_night (ready), verbatim model answer

```json
{
  "summary": "You checked in on only one day and logged sleep and soreness that night. Sleep was very short and soreness was low but logged.",
  "observations": [
    {
      "text": "Sleep was logged on the only night with a check-in, so the sleep figures describe that single night.",
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
          "value": 200,
          "unit": "minutes",
          "direction": "none",
          "day": "Thursday"
        },
        {
          "factId": "sleep.longest",
          "value": 200,
          "unit": "minutes",
          "direction": "none",
          "day": "Thursday"
        }
      ]
    },
    {
      "text": "No activities or runs were recorded this week, so there's nothing to track.",
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
    },
    {
      "text": "Check-ins were only on one day, so the averages don't cover the whole week.",
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
    }
  ],
  "suggestion": "null"
}
```

### qwen3:4b, val_complete_stable_weight (failed_grounding), verbatim model answer

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
          "value": 7
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 0
        }
      ],
      "text": "All days had a check-in, so the sleep and mood figures cover the whole week."
    },
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
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "Sleep and mood were logged on every day, so the averages describe the full week."
    },
    {
      "claims": [
        {
          "day": "Monday",
          "direction": "none",
          "factId": "weight.first",
          "unit": "kg",
          "value": 80.4
        },
        {
          "day": "Sunday",
          "direction": "none",
          "factId": "weight.last",
          "unit": "kg",
          "value": 80.4
        },
        {
          "day": "none",
          "direction": "same",
          "factId": "weight.change",
          "unit": "kg",
          "value": 0
        }
      ],
      "text": "Weight stayed the same from the first to last weigh-in."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 1.4
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 2
        }
      ],
      "text": "Soreness was low on most days, with the highest soreness on Tuesday."
    }
  ],
  "suggestion": "Try adding a short walk to your daily routine to build up your activity levels.",
  "summary": "You checked in every day and logged sleep, mood, soreness and weight consistently. Sleep and mood were tracked on all days, with no missing data. Weight stayed the same from the first to last weigh-in."
}
```

### qwen3:4b, val_weight_up_manual_runs (failed_grounding), verbatim model answer

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
          "value": 430
        }
      ],
      "text": "Sleep was logged on three nights, with a shortest night of 380 minutes and a longest of 430 minutes."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 3.5
        }
      ],
      "text": "Mood was logged on two days, so the average mood reflects only those days."
    },
    {
      "claims": [
        {
          "day": "Monday",
          "direction": "none",
          "factId": "weight.first",
          "unit": "kg",
          "value": 77.1
        },
        {
          "day": "Saturday",
          "direction": "none",
          "factId": "weight.last",
          "unit": "kg",
          "value": 77.9
        },
        {
          "day": "none",
          "direction": "up",
          "factId": "weight.change",
          "unit": "kg",
          "value": 0.8
        }
      ],
      "text": "Weight went up from the first to the last weigh-in, with the first weight at 77.1 kg and the last at 77.9 kg."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 3
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.run.count",
          "unit": "count",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.walk.count",
          "unit": "count",
          "value": 1
        }
      ],
      "text": "You did three manual activities, including two runs and one walk."
    }
  ],
  "suggestion": "Try adding a check-in on a day you missed to improve coverage next week.",
  "summary": "You checked in on four days and logged sleep and mood on some days. Weight went up from the first to the last weigh-in, and you did three manual activities."
}
```

### qwen3:4b, val_extreme_long_sleep (failed_grounding), verbatim model answer

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
          "value": 450
        },
        {
          "day": "Saturday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 760
        }
      ],
      "text": "Sleep was logged on every check-in day, so the sleep figures describe those nights only."
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
      "text": "Some days have no check-in, so the averages leave part of the week out."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.average",
          "unit": "score_1_5",
          "value": 2.7
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "mood.days_reported",
          "unit": "days",
          "value": 3
        }
      ],
      "text": "Mood was low on most days, but only three days had mood logged."
    }
  ],
  "suggestion": null,
  "summary": "You checked in on only a few days and logged sleep and mood each time. Sleep was very long on some nights, and your mood was low on most days."
}
```

### qwen3:4b, val_extreme_soreness_active (failed_grounding), verbatim model answer

```json
{
  "observations": [
    {
      "claims": [
        {
          "day": "Wednesday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 8
        }
      ],
      "text": "Soreness was logged on all days with soreness data, so the highest soreness level is clear."
    },
    {
      "claims": [
        {
          "day": "Wednesday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 405
        },
        {
          "day": "Saturday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 470
        }
      ],
      "text": "Sleep was logged on four nights, with a shortest night of 405 minutes and a longest of 470 minutes."
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
          "value": 240
        }
      ],
      "text": "You had two manual activities: a walk and a hike, totaling 240 minutes of time."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.average",
          "unit": "score_0_10",
          "value": 5.5
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 4
        }
      ],
      "text": "Soreness levels were recorded on four days, with an average of 5.5."
    }
  ],
  "suggestion": "null",
  "summary": "You logged check-ins on four days and sleep and mood on four days, with soreness levels that reached a high of 8. A walk and a hike were the only activities recorded."
}
```

### qwen3:4b, val_mixed_zones_gps (failed_grounding), verbatim model answer

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
          "value": 5
        },
        {
          "day": "Tuesday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 350
        },
        {
          "day": "Sunday",
          "direction": "none",
          "factId": "sleep.longest",
          "unit": "minutes",
          "value": 500
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
          "value": 5
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 2
        }
      ],
      "text": "Some days have no check-in, so the averages leave part of the week out."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "sleep.quality_average",
          "unit": "score_1_5",
          "value": 3.6
        }
      ],
      "text": "Sleep quality was tracked consistently across the week."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.duration",
          "unit": "minutes",
          "value": 92
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.distance",
          "unit": "km",
          "value": 16.5
        }
      ],
      "text": "Two GPS runs were recorded, totaling 16.5 km and 92 minutes."
    }
  ],
  "suggestion": "Try adding one manual activity each day to build consistency.",
  "summary": "You checked in on 5 days and logged sleep and mood each time. Sleep quality and time were tracked consistently, but no manual activities were recorded."
}
```

### qwen3:4b, val_overlap_two_runs (failed_grounding), verbatim model answer

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
          "value": 440
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
          "factId": "soreness.days_reported",
          "unit": "days",
          "value": 3
        },
        {
          "day": "Thursday",
          "direction": "none",
          "factId": "soreness.highest",
          "unit": "score_0_10",
          "value": 5
        }
      ],
      "text": "Soreness was logged on three days, with the highest soreness on Thursday."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.run.count",
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
      "text": "Two manual runs and two GPS runs were recorded, but they might be the same activities."
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
      "text": "Check-ins were on only three days, so the averages leave part of the week out."
    }
  ],
  "suggestion": "Try checking in every day to get a fuller picture of your week.",
  "summary": "You checked in on only a few days and logged sleep and soreness on some nights. Two manual runs and two GPS runs were recorded, but they might be the same activities."
}
```

### qwen3:4b, val_gps_distance_unavailable (failed_grounding), verbatim model answer

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
          "day": "Friday",
          "direction": "none",
          "factId": "sleep.shortest",
          "unit": "minutes",
          "value": 425
        },
        {
          "day": "Sunday",
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
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 3
        }
      ],
      "text": "Some days have no check-in, so the averages leave part of the week out."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_with_data",
          "unit": "days",
          "value": 4
        }
      ],
      "text": "Weight change isn't tracked this week, so the weight trend isn't visible."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs_without_current_distance",
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
      "text": "Two GPS runs were recorded but their distance hasn't been added yet."
    }
  ],
  "suggestion": "Add distance to your GPS runs so the activity data is complete next week.",
  "summary": "You checked in on 4 days and logged sleep and mood each time. There were no manual activities, but 2 GPS runs were recorded with no distance yet."
}
```

### qwen3:4b, val_activities_no_check_ins (failed_grounding), verbatim model answer

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
          "value": 0
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.days_missing",
          "unit": "days",
          "value": 7
        }
      ],
      "text": "No check-ins were recorded this week, so the activities and runs are not tied to specific days."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.swim.count",
          "unit": "count",
          "value": 1
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.swim.duration",
          "unit": "minutes",
          "value": 45
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.walk.count",
          "unit": "count",
          "value": 1
        }
      ],
      "text": "Two swims and one walk were logged, but no check-ins mean the days aren't known."
    },
    {
      "claims": [
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs",
          "unit": "count",
          "value": 2
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs_without_current_distance",
          "unit": "count",
          "value": 1
        }
      ],
      "text": "GPS runs were recorded but one run lacks distance."
    }
  ],
  "suggestion": "Try checking in once a day to link your activities to specific days.",
  "summary": "No check-ins were recorded this week, but two swims and one walk were logged. GPS runs were recorded but one run lacks distance."
}
```
