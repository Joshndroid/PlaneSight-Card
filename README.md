# PlaneSight Flip Board

HACS Dashboard plugin layout for the PlaneSight split-flap board card.

```yaml
type: custom:planesight-card
entity: sensor.planesight_aircraft_list
```

When used with the PlaneSight integration entity, the header shows the current
aircraft count plus the unique aircraft seen today and yesterday.

The repository root must contain `planesight-card.js`, or the file must be under `dist/`.
