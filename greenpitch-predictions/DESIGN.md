# GreenPitch Design Notes

GreenPitch is a technical, reliable football-prediction dashboard, not a social
network or a gambling product. Predictions use points only; the app has no
deposits, wagers, or real-money features.

## Visual system

- Use a dark `#121212` page background and `#1E1E1E` card surfaces.
- Cards have a subtle `#2C2C2E` border, a 16px radius, and 20px padding.
- Green `#32D74B` is the primary action and normal/live status color. Red
  `#FF453A` indicates losses and errors. Primary text is `#FFFFFF`, and muted
  text is `#98989D`.
- Use Inter or a system sans-serif for interface copy and a monospace font for
  points, scores, and other numeric metrics.
- Use a responsive 12-column analytics dashboard with compact KPI cards and
  charts; stack content on narrow screens.
- Keep table separators subtle, use an understated hover state, and maintain
  visible keyboard focus and readable contrast.

## Interaction

- The home dashboard presents the signed-in user's points, prediction KPIs,
  outcome charts, a confusion matrix, and recent activity.
- Match Center is a fixtures-only view. Each fixture opens its detail page;
  prediction choices are the primary action on an upcoming match's detail page.
- Prediction choices are Home, Draw, or Away and are available only to signed-in
  users while a match is Before.
- Login and registration use the same dark card system.
- Show loading, empty, API configuration, and request-error states explicitly.
- Predictions are free, score-only outcomes. A correct prediction earns 100
  points and an incorrect one loses 100 points.