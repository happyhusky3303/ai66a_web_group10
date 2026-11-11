# Football Score Predictor

A lightweight web application for predicting football match outcomes using
real-time sports data and in-app points. It does not use real money.

## Core Features

- **Points-based predictions**: Users stake available points on upcoming match outcomes; wins pay 2× the stake and losses forfeit it.
- **Live match data**: Automatically fetches fixtures, team statistics, and live match results via Football API.
- **Leaderboard & scoring system**: Tracks available point balances and prediction accuracy to rank participants.
- **Lightweight UI**: Fast-loading, framework-free interface.

## Tech Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript (Fetch API)
- **Backend**: Python, FastAPI, Uvicorn
- **Data Source**: Football API (API-Football / football-data.org)
