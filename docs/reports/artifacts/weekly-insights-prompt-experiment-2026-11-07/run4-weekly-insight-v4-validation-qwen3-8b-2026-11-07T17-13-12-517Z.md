# Weekly insight model evaluation

Prompt weekly-insight-v4, policy weekly-insight-policy-2, validation set (10 synthetic weeks per model). Provider calls: 10 of a limit of 10 (0 refused by the limit). Small sample: percentages and p95 are indicative only.

| model | schema pass | ready | global grounding | scoped grounding | unit/direction | safety | attempts (schema / transport failures) | timeouts | cold | warm median | warm p95 (n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3:8b | 100% | 8/10 | 2 | 0 | 0 | 0 | 10 (0 / 0) | 0 | 117.8 s | 77.7 s | 109.4 s (9) |

Grounding failures by kind (cases with at least one):

- qwen3:8b: number_in_prose 2

## qwen3:8b: per case

| case | status | reason / violations | attempts | duration |
| --- | --- | --- | --- | --- |
| val_mood_soreness_only (cold) | failed_grounding | number_in_prose×1 | 1 | 117.8 s |
| val_single_day_short_night | ready | - | 1 | 67.6 s |
| val_complete_stable_weight | ready | - | 1 | 109.4 s |
| val_weight_up_manual_runs | ready | - | 1 | 101.4 s |
| val_extreme_long_sleep | ready | - | 1 | 69.6 s |
| val_extreme_soreness_active | ready | - | 1 | 83.3 s |
| val_mixed_zones_gps | ready | - | 1 | 70.4 s |
| val_overlap_two_runs | ready | - | 1 | 87.4 s |
| val_gps_distance_unavailable | ready | - | 1 | 70.5 s |
| val_activities_no_check_ins | failed_grounding | number_in_prose×1 | 1 | 77.7 s |

### qwen3:8b, val_mood_soreness_only (failed_grounding), verbatim model answer

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
      "text": "Check-ins were recorded on most days, but some days were missed."
    },
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
      "text": "Mood and soreness were logged on all check-in days."
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
          "factId": "manual.strength.duration",
          "unit": "minutes",
          "value": 50
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.activities",
          "unit": "count",
          "value": 1
        }
      ],
      "text": "A strength session and a manual activity were logged, each lasting about half an hour."
    }
  ],
  "suggestion": "Try adding a short movement break during the day to keep your activity levels consistent.",
  "summary": "You checked in on most days and logged mood and soreness each time. A strength session and a manual activity were recorded."
}
```

### qwen3:8b, val_single_day_short_night (ready), verbatim model answer

```json
{
  "summary": "A check-in was recorded on one day, and sleep was logged on that day. No activities were recorded, and mood and soreness were logged on the same day as the check-in.",
  "observations": [
    {
      "text": "Sleep was logged on the check-in day, so the sleep figures describe that night only.",
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
      "text": "Check-in coverage was low, so the averages leave most of the week out.",
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
        },
        {
          "factId": "check_ins.coverage",
          "value": 14,
          "unit": "percent",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "Mood and soreness were logged on the same day as the check-in.",
      "claims": [
        {
          "factId": "mood.average",
          "value": 2,
          "unit": "score_1_5",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "soreness.highest",
          "value": 3,
          "unit": "score_0_10",
          "direction": "none",
          "day": "Thursday"
        }
      ]
    }
  ],
  "suggestion": null
}
```

### qwen3:8b, val_complete_stable_weight (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded every day, and sleep, mood, and soreness were logged each day. Weight stayed the same from the first to the last weigh-in, and GPS runs were recorded.",
  "observations": [
    {
      "text": "Sleep was logged every day, so the sleep figures describe all nights.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 7,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 425,
          "unit": "minutes",
          "direction": "none",
          "day": "Wednesday"
        },
        {
          "factId": "sleep.longest",
          "value": 455,
          "unit": "minutes",
          "direction": "none",
          "day": "Monday"
        }
      ]
    },
    {
      "text": "Mood and soreness were logged every day, so the averages describe all days.",
      "claims": [
        {
          "factId": "mood.average",
          "value": 3.6,
          "unit": "score_1_5",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "soreness.average",
          "value": 1.4,
          "unit": "score_0_10",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "soreness.highest",
          "value": 2,
          "unit": "score_0_10",
          "direction": "none",
          "day": "Tuesday"
        }
      ]
    },
    {
      "text": "Weight stayed the same from the first to the last weigh-in.",
      "claims": [
        {
          "factId": "weight.first",
          "value": 80.4,
          "unit": "kg",
          "direction": "none",
          "day": "Monday"
        },
        {
          "factId": "weight.last",
          "value": 80.4,
          "unit": "kg",
          "direction": "none",
          "day": "Sunday"
        },
        {
          "factId": "weight.change",
          "value": 0,
          "unit": "kg",
          "direction": "same",
          "day": "none"
        }
      ]
    },
    {
      "text": "GPS runs were recorded, but no manual activities were logged.",
      "claims": [
        {
          "factId": "gps.runs",
          "value": 3,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "gps.duration",
          "value": 165,
          "unit": "minutes",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "gps.distance",
          "value": 28.56,
          "unit": "km",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try adding a short manual activity, like a walk, to your routine to track more types of movement."
}
```

### qwen3:8b, val_weight_up_manual_runs (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded on several days, and sleep and mood were logged on some of those days. Weight increased from the first to the last weigh-in, and a few manual activities were recorded.",
  "observations": [
    {
      "text": "Sleep was logged on every check-in day, so the sleep figures describe those nights only.",
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
          "value": 380,
          "unit": "minutes",
          "direction": "none",
          "day": "Wednesday"
        },
        {
          "factId": "sleep.longest",
          "value": 430,
          "unit": "minutes",
          "direction": "none",
          "day": "Saturday"
        }
      ]
    },
    {
      "text": "Mood was logged on fewer days than check-ins, so the average mood may not reflect the full week.",
      "claims": [
        {
          "factId": "mood.average",
          "value": 3.5,
          "unit": "score_1_5",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "mood.days_reported",
          "value": 2,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "Weight went up from the first to the last weigh-in.",
      "claims": [
        {
          "factId": "weight.first",
          "value": 77.1,
          "unit": "kg",
          "direction": "none",
          "day": "Monday"
        },
        {
          "factId": "weight.last",
          "value": 77.9,
          "unit": "kg",
          "direction": "none",
          "day": "Saturday"
        },
        {
          "factId": "weight.change",
          "value": 0.8,
          "unit": "kg",
          "direction": "up",
          "day": "none"
        }
      ]
    },
    {
      "text": "Manual activities included runs and walks, but no GPS runs were recorded.",
      "claims": [
        {
          "factId": "manual.activities",
          "value": 3,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.run.count",
          "value": 2,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.walk.count",
          "value": 1,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try adding a short walk each day to increase activity and track progress."
}
```

### qwen3:8b, val_extreme_long_sleep (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded on only a few days, and sleep was logged each time. The average sleep time was longer than usual, with one night being significantly longer.",
  "observations": [
    {
      "text": "Sleep was logged on every check-in day, so the sleep figures describe those nights only.",
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
          "value": 450,
          "unit": "minutes",
          "direction": "none",
          "day": "Tuesday"
        },
        {
          "factId": "sleep.longest",
          "value": 760,
          "unit": "minutes",
          "direction": "none",
          "day": "Saturday"
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
      "text": "Average sleep time was longer than usual, with one night being significantly longer.",
      "claims": [
        {
          "factId": "sleep.average_minutes",
          "value": 563,
          "unit": "minutes",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.longest",
          "value": 760,
          "unit": "minutes",
          "direction": "none",
          "day": "Saturday"
        }
      ]
    }
  ],
  "suggestion": null
}
```

### qwen3:8b, val_extreme_soreness_active (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded on most days, and sleep and mood were logged each time. Soreness was reported on several days, with one instance reaching a high level.",
  "observations": [
    {
      "text": "Sleep was logged on every check-in day, so the sleep figures describe those nights only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 4,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 405,
          "unit": "minutes",
          "direction": "none",
          "day": "Wednesday"
        },
        {
          "factId": "sleep.longest",
          "value": 470,
          "unit": "minutes",
          "direction": "none",
          "day": "Saturday"
        }
      ]
    },
    {
      "text": "Soreness was reported on several days, with one instance reaching a high level.",
      "claims": [
        {
          "factId": "soreness.highest",
          "value": 8,
          "unit": "score_0_10",
          "direction": "none",
          "day": "Wednesday"
        },
        {
          "factId": "soreness.days_reported",
          "value": 4,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "Manual activities included rides and hikes, with time and distance logged for each.",
      "claims": [
        {
          "factId": "manual.ride.count",
          "value": 1,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.ride.duration",
          "value": 60,
          "unit": "minutes",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.ride.distance",
          "value": 22.5,
          "unit": "km",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": null
}
```

### qwen3:8b, val_mixed_zones_gps (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded on most days, and sleep and mood were logged each time. GPS runs were completed, but no manual activities were recorded.",
  "observations": [
    {
      "text": "Sleep was logged on every check-in day, so the sleep figures describe those nights only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 5,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 350,
          "unit": "minutes",
          "direction": "none",
          "day": "Tuesday"
        },
        {
          "factId": "sleep.longest",
          "value": 500,
          "unit": "minutes",
          "direction": "none",
          "day": "Sunday"
        }
      ]
    },
    {
      "text": "Mood was logged on all check-in days, so the average mood reflects those days only.",
      "claims": [
        {
          "factId": "mood.average",
          "value": 3.8,
          "unit": "score_1_5",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "mood.days_reported",
          "value": 5,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "GPS runs were completed, but no manual activities were recorded.",
      "claims": [
        {
          "factId": "gps.runs",
          "value": 2,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.activities",
          "value": 0,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try adding a manual activity, like a walk or stretch, to your routine to track more types of movement."
}
```

### qwen3:8b, val_overlap_two_runs (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded on only a few days, and sleep and mood were logged on some of those days. Manual and GPS runs were both recorded, and some runs may be the same.",
  "observations": [
    {
      "text": "Sleep was logged on some check-in days, so the sleep figures describe those nights only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 2,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 410,
          "unit": "minutes",
          "direction": "none",
          "day": "Tuesday"
        },
        {
          "factId": "sleep.longest",
          "value": 470,
          "unit": "minutes",
          "direction": "none",
          "day": "Friday"
        }
      ]
    },
    {
      "text": "Mood and soreness were logged on some days, but not all check-in days.",
      "claims": [
        {
          "factId": "mood.days_reported",
          "value": 2,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "soreness.days_reported",
          "value": 3,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "soreness.highest",
          "value": 5,
          "unit": "score_0_10",
          "direction": "none",
          "day": "Thursday"
        }
      ]
    },
    {
      "text": "Manual and GPS runs were both recorded, and they may describe the same runs.",
      "claims": [
        {
          "factId": "manual.run.count",
          "value": 2,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.run.duration",
          "value": 85,
          "unit": "minutes",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "manual.run.distance",
          "value": 15,
          "unit": "km",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try to check in every day so next week's summary covers all days."
}
```

### qwen3:8b, val_gps_distance_unavailable (ready), verbatim model answer

```json
{
  "summary": "Check-ins were recorded on most days, and sleep and mood were logged each time. GPS runs were recorded but some distances are pending.",
  "observations": [
    {
      "text": "Sleep was logged on every check-in day, so the sleep figures describe those nights only.",
      "claims": [
        {
          "factId": "sleep.nights_reported",
          "value": 4,
          "unit": "days",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "sleep.shortest",
          "value": 425,
          "unit": "minutes",
          "direction": "none",
          "day": "Friday"
        },
        {
          "factId": "sleep.longest",
          "value": 470,
          "unit": "minutes",
          "direction": "none",
          "day": "Sunday"
        }
      ]
    },
    {
      "text": "Mood was logged on all check-in days, so the average mood reflects those days only.",
      "claims": [
        {
          "factId": "mood.average",
          "value": 3.8,
          "unit": "score_1_5",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "mood.days_reported",
          "value": 4,
          "unit": "days",
          "direction": "none",
          "day": "none"
        }
      ]
    },
    {
      "text": "GPS runs were recorded but some distances are pending.",
      "claims": [
        {
          "factId": "gps.runs",
          "value": 2,
          "unit": "count",
          "direction": "none",
          "day": "none"
        },
        {
          "factId": "gps.runs_without_current_distance",
          "value": 2,
          "unit": "count",
          "direction": "none",
          "day": "none"
        }
      ]
    }
  ],
  "suggestion": "Try to log GPS run distances this week so they are complete for next week's summary."
}
```

### qwen3:8b, val_activities_no_check_ins (failed_grounding), verbatim model answer

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
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "check_ins.coverage",
          "unit": "percent",
          "value": 0
        }
      ],
      "text": "No check-ins were recorded this week."
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
          "value": 85
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "manual.walk.duration",
          "unit": "minutes",
          "value": 40
        }
      ],
      "text": "Manual activities included a walk and a swim, with a total time of about an hour and 10 minutes."
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
          "factId": "gps.distance",
          "unit": "km",
          "value": 6.4
        },
        {
          "day": "none",
          "direction": "none",
          "factId": "gps.runs_without_current_distance",
          "unit": "count",
          "value": 1
        }
      ],
      "text": "GPS runs were logged, but one run has no distance yet."
    }
  ],
  "suggestion": "Try adding a check-in each day to help track your progress and stay connected.",
  "summary": "No check-ins were recorded this week, but manual activities and GPS runs were logged. A swim and a walk were completed, along with some GPS runs."
}
```
