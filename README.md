# Football Score Predictor

A lightweight web application for predicting football match outcomes using
football fixtures and in-app points. It does not use real money.

## Core Features

- **Points-based predictions**: Users stake available points on upcoming match outcomes; wins pay 2× the stake and losses forfeit it.
- **Daily reward**: Users can claim 500 in-app points once per UTC calendar day.
- **Match data**: Displays fixtures and results from football-data.org, with provider data cached by the backend.
- **Leaderboard & scoring system**: Tracks available point balances and prediction accuracy to rank participants.
- **Lightweight UI**: Fast-loading, framework-free interface.

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (Fetch API)
- **Backend**: Python, FastAPI, Uvicorn
- **Data Source**: Football API (API-Football / football-data.org)
