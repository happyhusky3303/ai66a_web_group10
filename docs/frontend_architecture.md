# Frontend Specifications

## 1. Tech Stack
*   HTML5 structure.
*   Vanilla CSS (`style.css`) for styling. No heavy UI frameworks (e.g., Bootstrap) to maintain custom aesthetic control.
*   Vanilla JavaScript (`app.js`) for API calls and DOM manipulation.

## 2. Design System (WattVision Inspired)
The UI must strictly adhere to the rules defined in `design-md-sistema-de-monitoreo-el-ctrico-wattvision-DESIGN.md`.
*   **Atmosphere:** Technical, reliable dashboard (not a social media app).
*   **Background:** `#121212` (Dark Mode).
*   **Cards/Surfaces:** `#1E1E1E` background, `16px` border-radius, `20px` padding, subtle `1px solid #2C2C2E` border.
*   **Accents:** Primary is Green (`#32D74B`) for interactive elements, KPIs, and normal status. Alert/Loss is Red (`#FF453A`). Text is White (`#FFFFFF`) or Grey (`#98989D` for muted labels).
*   **Typography:** 'Inter' for headers/body, monospace ('JetBrains Mono' or 'Fira Code') for all metrics, points, and numeric data.

## 3. Core Views (Single Page Application or Multi-page)
1.  **Dashboard/Home:** 
    *   Top row: User KPI (Total Points).
    *   Main column (span 8): Table of upcoming/ongoing/ended matches with Prediction buttons.
    *   Side column (span 4): Global Leaderboard table.
2.  **Login/Register Modal or Page:** Simple forms adopting the dark/green card styling.

## 4. Coding Agent Instructions
*   Use CSS Grid (12-column layout) and variables (`:root`) for the color palette.
*   Implement async `fetch` calls in JS to communicate with the FastAPI backend. Handle loading states and errors gracefully.