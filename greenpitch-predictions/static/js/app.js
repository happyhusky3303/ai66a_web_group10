const formatPoints = (points) => new Intl.NumberFormat().format(points);

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
      else if (Array.isArray(body.detail)) message = body.detail.map((issue) => issue.msg).join(" ");
    } catch {
      // Keep the HTTP status message when the server response isn't JSON.
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function showNotice(element, message, kind = "error") {
  if (!element) return;
  element.textContent = message;
  element.className = `notice notice-${kind}`;
}

function hideNotice(element) {
  if (!element) return;
  element.textContent = "";
  element.classList.add("hidden");
}

async function loadMatches() {
  const loading = document.querySelector("#matches-loading");
  const empty = document.querySelector("#matches-empty");
  const count = document.querySelector("#match-count");
  const notice = document.querySelector("#app-message");

  const ongoingBody = document.querySelector("#ongoing-matches-body");
  const upcomingBody = document.querySelector("#upcoming-matches-body");
  const endedBody = document.querySelector("#ended-matches-body");

  const ongoingEmpty = document.querySelector("#ongoing-empty");
  const upcomingEmpty = document.querySelector("#upcoming-empty");
  const endedEmpty = document.querySelector("#ended-empty");

  const ongoingCount = document.querySelector("#ongoing-count");
  const upcomingCount = document.querySelector("#upcoming-count");
  const endedCount = document.querySelector("#ended-count");

  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  ongoingBody?.replaceChildren();
  upcomingBody?.replaceChildren();
  endedBody?.replaceChildren();
  hideNotice(notice);

  try {
    const data = await apiRequest("/api/matches");
    const matches = data.matches || [];
    count.textContent = `${matches.length} fixture${matches.length === 1 ? "" : "s"}`;
    if (matches.length === 0) empty.classList.remove("hidden");

    populateLeagues(matches);

    const ongoing = [];
    const upcoming = [];
    const ended = [];

    for (const match of matches) {
      if (match.status === "Ongoing") {
        ongoing.push(match);
      } else if (match.status === "Before") {
        upcoming.push(match);
      } else {
        ended.push(match);
      }
    }

    // Ongoing group
    if (ongoingCount) ongoingCount.textContent = `${ongoing.length} live`;
    if (ongoing.length === 0) ongoingEmpty?.classList.remove("hidden");
    else ongoingEmpty?.classList.add("hidden");
    for (const match of ongoing) ongoingBody?.append(createMatchRow(match));

    // Upcoming group
    if (upcomingCount) upcomingCount.textContent = `${upcoming.length} upcoming`;
    if (upcoming.length === 0) upcomingEmpty?.classList.remove("hidden");
    else upcomingEmpty?.classList.add("hidden");
    for (const match of upcoming) upcomingBody?.append(createMatchRow(match));

    // Ended group
    if (endedCount) endedCount.textContent = `${ended.length} ended`;
    if (ended.length === 0) endedEmpty?.classList.remove("hidden");
    else endedEmpty?.classList.add("hidden");
    for (const match of ended) endedBody?.append(createMatchRow(match));

    applyMatchFilter();
  } catch (error) {
    count.textContent = "Unavailable";
    showNotice(notice, error.message);
  } finally {
    loading.classList.add("hidden");
  }
}

function populateLeagues(matches) {
  const leagueSelect = document.querySelector("#match-league-filter");
  if (!leagueSelect) return;
  const currentSelection = leagueSelect.value;
  const leagues = Array.from(new Set(matches.map((m) => m.competition).filter(Boolean))).sort();
  if (leagues.length === 0) return;

  leagueSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All leagues";
  leagueSelect.append(allOption);
  for (const league of leagues) {
    const option = document.createElement("option");
    option.value = league;
    option.textContent = league;
    leagueSelect.append(option);
  }
  if (currentSelection && (currentSelection === "all" || leagues.includes(currentSelection))) {
    leagueSelect.value = currentSelection;
  }
}

function applyMatchFilter() {
  const ongoingGroup = document.querySelector("#ongoing-group");
  const upcomingGroup = document.querySelector("#upcoming-group");
  const endedGroup = document.querySelector("#ended-group");
  const count = document.querySelector("#match-count");

  const typeSelect = document.querySelector("#match-type-filter");
  const leagueSelect = document.querySelector("#match-league-filter");

  const selectedType = typeSelect ? typeSelect.value : "all";
  const selectedLeague = leagueSelect ? leagueSelect.value : "all";

  const groups = [
    {
      key: "ongoing",
      element: ongoingGroup,
      countEl: document.querySelector("#ongoing-count"),
      emptyEl: document.querySelector("#ongoing-empty"),
      suffix: "live",
      defaultEmptyText: "No matches currently ongoing.",
    },
    {
      key: "upcoming",
      element: upcomingGroup,
      countEl: document.querySelector("#upcoming-count"),
      emptyEl: document.querySelector("#upcoming-empty"),
      suffix: "upcoming",
      defaultEmptyText: "No upcoming fixtures scheduled.",
    },
    {
      key: "ended",
      element: endedGroup,
      countEl: document.querySelector("#ended-count"),
      emptyEl: document.querySelector("#ended-empty"),
      suffix: "ended",
      defaultEmptyText: "No ended matches for this period.",
    },
  ];

  let totalVisible = 0;

  for (const { key, element, countEl, emptyEl, suffix, defaultEmptyText } of groups) {
    if (!element) continue;

    const isGroupTypeVisible = selectedType === "all" || selectedType === key;
    if (!isGroupTypeVisible) {
      element.classList.add("hidden");
      continue;
    }

    element.classList.remove("hidden");
    const rows = element.querySelectorAll("tbody tr");
    let visibleInGroup = 0;

    rows.forEach((row) => {
      const matchesLeague = selectedLeague === "all" || row.dataset.competition === selectedLeague;
      if (matchesLeague) {
        row.classList.remove("hidden");
        visibleInGroup++;
      } else {
        row.classList.add("hidden");
      }
    });

    if (countEl) countEl.textContent = `${visibleInGroup} ${suffix}`;

    if (visibleInGroup === 0) {
      if (emptyEl) {
        emptyEl.textContent = selectedLeague === "all"
          ? defaultEmptyText
          : `No ${suffix} matches in ${selectedLeague}.`;
        emptyEl.classList.remove("hidden");
      }
    } else {
      emptyEl?.classList.add("hidden");
    }

    totalVisible += visibleInGroup;
  }

  if (count) {
    if (selectedType === "all") {
      count.textContent = `${totalVisible} fixture${totalVisible === 1 ? "" : "s"}`;
    } else if (selectedType === "ongoing") {
      count.textContent = `${totalVisible} live`;
    } else if (selectedType === "upcoming") {
      count.textContent = `${totalVisible} upcoming`;
    } else if (selectedType === "ended") {
      count.textContent = `${totalVisible} ended`;
    }
  }
}

function createMatchRow(match) {
  const row = document.createElement("tr");
  row.dataset.competition = match.competition || "";
  row.dataset.status = match.status || "";
  const matchCell = document.createElement("td");
  matchCell.className = "match-cell";
  const competition = document.createElement("span");
  competition.className = "competition-name";
  competition.textContent = match.competition;
  const teams = document.createElement("strong");
  teams.className = "team-pair";
  teams.textContent = `${match.home_team}  —  ${match.away_team}`;
  matchCell.append(competition, teams);

  const dateCell = document.createElement("td");
  dateCell.className = "mono date-cell";
  dateCell.textContent = match.utc_date
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(match.utc_date))
    : "—";

  const statusCell = document.createElement("td");
  const status = document.createElement("span");
  const statusClass = match.status.toLowerCase();
  status.className = `status status-${statusClass}`;
  status.textContent = match.status;
  statusCell.append(status);

  const predictCell = document.createElement("td");
  predictCell.className = "prediction-cell";
  if (match.status === "Before" && currentUser) {
    const choices = document.createElement("div");
    choices.className = "prediction-choices";
    for (const [value, label] of [["home", "H"], ["draw", "D"], ["away", "A"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice-button";
      button.textContent = label;
      button.title = `Predict ${label === "H" ? match.home_team : label === "A" ? match.away_team : "a draw"}`;
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => submitPrediction(match.id, value, button));
      choices.append(button);
    }
    predictCell.append(choices);
  } else if (match.status === "Before") {
    const link = document.createElement("a");
    link.href = "/login";
    link.className = "sign-in-prompt";
    link.textContent = "Sign in to predict";
    predictCell.append(link);
  } else if (match.home_score !== null && match.away_score !== null) {
    const score = document.createElement("span");
    score.className = "mono score";
    score.textContent = `${match.home_score} — ${match.away_score}`;
    predictCell.append(score);
  } else if (match.status === "Ongoing") {
    const liveText = document.createElement("span");
    liveText.className = "mono muted";
    liveText.textContent = "Live";
    predictCell.append(liveText);
  } else {
    predictCell.textContent = "—";
  }

  row.append(matchCell, dateCell, statusCell, predictCell);
  return row;
}

async function submitPrediction(matchId, winner, button) {
  const notice = document.querySelector("#app-message");
  const buttons = button.parentElement.querySelectorAll("button");
  buttons.forEach((choice) => { choice.disabled = true; });
  hideNotice(notice);
  try {
    await apiRequest("/api/predict", {
      method: "POST",
      body: JSON.stringify({ user_id: currentUser.id, match_id: matchId, predicted_winner: winner }),
    });
    showNotice(notice, "Prediction saved. You can only predict each match once.", "success");
    buttons.forEach((choice) => { choice.textContent = choice === button ? "✓" : "·"; });
  } catch (error) {
    showNotice(notice, error.message);
    buttons.forEach((choice) => { choice.disabled = false; });
  }
}

async function loadLeaderboard() {
  const loading = document.querySelector("#leaderboard-loading");
  const list = document.querySelector("#leaderboard-list");
  const empty = document.querySelector("#leaderboard-empty");
  loading.classList.remove("hidden");
  list.replaceChildren();
  empty.classList.add("hidden");
  try {
    const data = await apiRequest("/api/leaderboard");
    if (data.leaderboard.length === 0) empty.classList.remove("hidden");
    for (const entry of data.leaderboard) {
      const item = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank mono";
      rank.textContent = String(entry.rank).padStart(2, "0");
      const username = document.createElement("span");
      username.className = "leader-name";
      username.textContent = entry.username;
      const points = document.createElement("span");
      points.className = "leader-points mono";
      points.textContent = formatPoints(entry.points);
      item.append(rank, username, points);
      list.append(item);
    }
  } catch (error) {
    empty.textContent = error.message;
    empty.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
}

let currentUser = null;

async function loadCurrentUser() {
  let loadError = null;
  try {
    const result = await apiRequest("/auth/me");
    currentUser = result.authenticated ? result.user : null;
  } catch (error) {
    currentUser = null;
    loadError = error;
  }
  const authLink = document.querySelector("#auth-link");
  const logoutButton = document.querySelector("#logout-button");
  const name = document.querySelector("#user-name");
  const points = document.querySelector("#user-points");
  if (authLink) {
    if (currentUser) {
      authLink.classList.add("hidden");
      logoutButton?.classList.remove("hidden");
      if (name) name.textContent = currentUser.username;
      if (points) points.textContent = formatPoints(currentUser.points);
    } else {
      authLink.classList.remove("hidden");
      logoutButton?.classList.add("hidden");
      if (name) name.textContent = "Sign in to track your score";
      if (points) points.textContent = "—";
    }
  }
  if (loadError) showNotice(document.querySelector("#app-message") || document.querySelector("#my-app-message"), loadError.message);
}

async function initDashboard() {
  document.querySelector("#refresh-button").addEventListener("click", loadMatches);
  document.querySelector("#match-type-filter")?.addEventListener("change", applyMatchFilter);
  document.querySelector("#match-league-filter")?.addEventListener("change", applyMatchFilter);
  document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      window.location.reload();
    } catch (error) {
      showNotice(document.querySelector("#app-message"), error.message);
    }
  });
  await loadCurrentUser();
  await Promise.all([loadMatches(), loadLeaderboard()]);
}

function initAuthPage() {
  const form = document.querySelector("#auth-form");
  const toggle = document.querySelector("#auth-toggle");
  let registering = false;
  toggle.addEventListener("click", () => {
    registering = !registering;
    document.querySelector("#auth-heading").textContent = registering ? "Create your account" : "Welcome back";
    document.querySelector("#auth-description").textContent = registering
      ? "Join the match center. Your account starts with 1,000 points."
      : "Sign in to submit predictions and follow your points.";
    document.querySelector("#auth-submit").textContent = registering ? "Create account" : "Sign in";
    document.querySelector("#auth-switch-label").textContent = registering ? "Already have an account?" : "New to GreenPitch?";
    toggle.textContent = registering ? "Sign in" : "Create an account";
    document.querySelector("#password").autocomplete = registering ? "new-password" : "current-password";
    hideNotice(document.querySelector("#auth-message"));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = document.querySelector("#auth-submit");
    const message = document.querySelector("#auth-message");
    submit.disabled = true;
    submit.textContent = registering ? "Creating account…" : "Signing in…";
    hideNotice(message);
    const formData = new FormData(form);
    try {
      await apiRequest(registering ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
        }),
      });
      window.location.assign("/");
    } catch (error) {
      showNotice(message, error.message);
      submit.disabled = false;
      submit.textContent = registering ? "Create account" : "Sign in";
    }
  });
}

let myPredictionsData = [];

async function initMyMatches() {
  document.querySelector("#my-refresh-button")?.addEventListener("click", loadMyMatches);
  document.querySelector("#my-matches-filter")?.addEventListener("change", applyMyMatchesFilter);
  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      window.location.assign("/");
    } catch (error) {
      showNotice(document.querySelector("#my-app-message"), error.message);
    }
  });

  await loadCurrentUser();
  await loadMyMatches();
}

async function loadMyMatches() {
  const loading = document.querySelector("#my-matches-loading");
  const authRequired = document.querySelector("#my-auth-required");
  const empty = document.querySelector("#my-matches-empty");
  const filteredEmpty = document.querySelector("#my-matches-filtered-empty");
  const table = document.querySelector("#my-matches-table");
  const body = document.querySelector("#my-matches-body");
  const count = document.querySelector("#my-matches-count");
  const notice = document.querySelector("#my-app-message");

  const statTotal = document.querySelector("#stat-total");
  const statActive = document.querySelector("#stat-active");
  const statWon = document.querySelector("#stat-won");
  const statLost = document.querySelector("#stat-lost");
  const userPointsEl = document.querySelector("#user-points");

  loading?.classList.remove("hidden");
  authRequired?.classList.add("hidden");
  empty?.classList.add("hidden");
  filteredEmpty?.classList.add("hidden");
  body?.replaceChildren();
  hideNotice(notice);

  if (!currentUser) {
    loading?.classList.add("hidden");
    authRequired?.classList.remove("hidden");
    table?.classList.add("hidden");
    if (count) count.textContent = "Sign in required";
    return;
  }

  table?.classList.remove("hidden");

  try {
    const data = await apiRequest("/api/my-matches");
    myPredictionsData = data.predictions || [];

    if (userPointsEl && data.user_points !== undefined) {
      userPointsEl.textContent = formatPoints(data.user_points);
    }

    let incomingCount = 0;
    let ongoingCount = 0;
    let wonCount = 0;
    let lostCount = 0;

    for (const p of myPredictionsData) {
      if (p.status === "Before") incomingCount++;
      else if (p.status === "Ongoing") ongoingCount++;
      else if (p.won === true) wonCount++;
      else if (p.won === false) lostCount++;
    }

    if (statTotal) statTotal.textContent = String(myPredictionsData.length);
    if (statActive) statActive.textContent = String(incomingCount + ongoingCount);
    if (statWon) statWon.textContent = String(wonCount);
    if (statLost) statLost.textContent = String(lostCount);

    if (myPredictionsData.length === 0) {
      empty?.classList.remove("hidden");
      table?.classList.add("hidden");
      if (count) count.textContent = "0 predictions";
      return;
    }

    applyMyMatchesFilter();
  } catch (error) {
    if (count) count.textContent = "Unavailable";
    showNotice(notice, error.message);
  } finally {
    loading?.classList.add("hidden");
  }
}

function applyMyMatchesFilter() {
  const filterSelect = document.querySelector("#my-matches-filter");
  const selected = filterSelect ? filterSelect.value : "all";
  const body = document.querySelector("#my-matches-body");
  const filteredEmpty = document.querySelector("#my-matches-filtered-empty");
  const count = document.querySelector("#my-matches-count");
  const table = document.querySelector("#my-matches-table");

  body?.replaceChildren();

  const filtered = myPredictionsData.filter((item) => {
    if (selected === "incoming") return item.status === "Before";
    if (selected === "ongoing") return item.status === "Ongoing";
    if (selected === "ended") return item.status === "Ended" || item.status === "Unavailable";
    return true; // "all"
  });

  if (count) {
    count.textContent = `${filtered.length} prediction${filtered.length === 1 ? "" : "s"}`;
  }

  if (filtered.length === 0) {
    filteredEmpty?.classList.remove("hidden");
    table?.classList.add("hidden");
  } else {
    filteredEmpty?.classList.add("hidden");
    table?.classList.remove("hidden");
    for (const item of filtered) {
      body?.append(createMyMatchRow(item));
    }
  }
}

function createMyMatchRow(item) {
  const row = document.createElement("tr");

  // Col 1: Match
  const matchCell = document.createElement("td");
  matchCell.className = "match-cell";
  const competition = document.createElement("span");
  competition.className = "competition-name";
  competition.textContent = item.competition;
  const teams = document.createElement("strong");
  teams.className = "team-pair";
  teams.textContent = `${item.home_team}  —  ${item.away_team}`;
  matchCell.append(competition, teams);

  // Col 2: Kick-off
  const dateCell = document.createElement("td");
  dateCell.className = "mono date-cell";
  dateCell.textContent = item.utc_date
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.utc_date))
    : "—";

  // Col 3: Status
  const statusCell = document.createElement("td");
  const statusSpan = document.createElement("span");
  let displayStatus = item.status;
  let statusClass = "unavailable";
  if (item.status === "Before") {
    displayStatus = "Incoming";
    statusClass = "before";
  } else if (item.status === "Ongoing") {
    displayStatus = "Ongoing";
    statusClass = "ongoing";
  } else if (item.status === "Ended") {
    displayStatus = "Ended";
    statusClass = "ended";
  }
  statusSpan.className = `status status-${statusClass}`;
  statusSpan.textContent = displayStatus;
  statusCell.append(statusSpan);

  // Col 4: My Prediction
  const predCell = document.createElement("td");
  predCell.className = "prediction-cell";
  const badge = document.createElement("span");
  badge.className = "prediction-badge";
  const labelStrong = document.createElement("strong");
  labelStrong.textContent = item.predicted_label;
  const teamText = document.createElement("span");
  teamText.textContent = item.predicted_team;
  badge.append(labelStrong, teamText);
  predCell.append(badge);

  // Col 5: Result / Score
  const resultCell = document.createElement("td");
  resultCell.className = "result-cell";
  if (item.status === "Before") {
    const kickSoon = document.createElement("span");
    kickSoon.className = "mono muted";
    kickSoon.textContent = "Kick-off pending";
    resultCell.append(kickSoon);
  } else if (item.status === "Ongoing") {
    const liveWrap = document.createElement("div");
    liveWrap.className = "live-score-wrap";
    const scoreSpan = document.createElement("strong");
    scoreSpan.className = "mono score";
    scoreSpan.textContent = (item.home_score !== null && item.away_score !== null)
      ? `${item.home_score} — ${item.away_score}`
      : "Live";
    const dot = document.createElement("span");
    dot.className = "live-dot";
    liveWrap.append(scoreSpan, dot);
    resultCell.append(liveWrap);
  } else if (item.status === "Ended") {
    const scoreSpan = document.createElement("strong");
    scoreSpan.className = "mono score";
    scoreSpan.textContent = (item.home_score !== null && item.away_score !== null)
      ? `${item.home_score} — ${item.away_score}`
      : "Concluded";
    resultCell.append(scoreSpan);
  } else {
    resultCell.textContent = "—";
  }

  // Col 6: Points Received / Lost
  const pointsCell = document.createElement("td");
  pointsCell.className = "points-cell";
  if (item.status === "Before" || item.status === "Ongoing") {
    const pendingSpan = document.createElement("span");
    pendingSpan.className = "mono muted";
    pendingSpan.textContent = "—";
    pointsCell.append(pendingSpan);
  } else if (item.points_awarded !== null) {
    const pointsPill = document.createElement("span");
    if (item.points_awarded > 0) {
      pointsPill.className = "points-pill points-pill-won mono";
      pointsPill.textContent = `+${item.points_awarded} pts`;
    } else if (item.points_awarded < 0) {
      pointsPill.className = "points-pill points-pill-lost mono";
      pointsPill.textContent = `${item.points_awarded} pts`;
    } else {
      pointsPill.className = "points-pill points-pill-pending mono";
      pointsPill.textContent = "0 pts";
    }
    pointsCell.append(pointsPill);
  } else {
    pointsCell.textContent = "—";
  }

  row.append(matchCell, dateCell, statusCell, predCell, resultCell, pointsCell);
  return row;
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "dashboard") initDashboard();
  if (document.body.dataset.page === "my-matches") initMyMatches();
  if (document.body.dataset.page === "auth") initAuthPage();
});