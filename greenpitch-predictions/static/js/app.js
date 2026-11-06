const formatPoints = (points) => new Intl.NumberFormat().format(points);
const PREDICTION_LIMIT = 10;
let predictedMatchIds = new Set();
let predictionQuotaRemaining = PREDICTION_LIMIT;
let predictionQuotaResetAt = null;
let predictionQuotaTimer = null;

function renderPredictionQuota() {
  const quota = document.querySelector("#prediction-quota");
  if (!quota) return;

  const resetSeconds = predictionQuotaResetAt === null
    ? null
    : Math.max(0, Math.ceil((predictionQuotaResetAt - Date.now()) / 1000));
  const resetText = resetSeconds === null
    ? "resets every minute"
    : `resets in ${Math.floor(resetSeconds / 60)}m ${String(resetSeconds % 60).padStart(2, "0")}s`;

  quota.textContent = `Predictions left: ${predictionQuotaResetAt === null ? "up to " : ""}${predictionQuotaRemaining} · ${resetText} · shared network`;
  document.querySelectorAll(".choice-button, .prediction-option").forEach((button) => {
    button.disabled = predictionQuotaRemaining === 0 || button.dataset.predictionSubmitted === "true";
  });

  if (resetSeconds === 0) {
    predictionQuotaRemaining = PREDICTION_LIMIT;
    predictionQuotaResetAt = null;
    quota.textContent = `Predictions left: up to ${PREDICTION_LIMIT} · resets every minute · shared network`;
    document.querySelectorAll(".choice-button, .prediction-option").forEach((button) => {
      button.disabled = button.dataset.predictionSubmitted === "true";
    });
    if (predictionQuotaTimer !== null) {
      window.clearInterval(predictionQuotaTimer);
      predictionQuotaTimer = null;
    }
  }
}

function updatePredictionQuota(headers) {
  const remaining = Number.parseInt(headers.get("X-RateLimit-Remaining"), 10);
  const resetSeconds = Number.parseInt(headers.get("X-RateLimit-Reset"), 10);
  if (!Number.isInteger(remaining) || !Number.isInteger(resetSeconds)) return;

  predictionQuotaRemaining = Math.max(0, remaining);
  predictionQuotaResetAt = Date.now() + Math.max(0, resetSeconds) * 1000;
  renderPredictionQuota();
  if (predictionQuotaTimer === null) {
    predictionQuotaTimer = window.setInterval(renderPredictionQuota, 1000);
  }
}

async function apiRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("Không thể kết nối tới máy chủ. Vui lòng kiểm tra mạng và thử lại.");
  }
  if (url === "/api/predict") updatePredictionQuota(response.headers);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let body = {};
    try {
      body = await response.json();
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.detail === "string") message = body.detail;
      else if (body.detail && typeof body.detail.message === "string") message = body.detail.message;
      else if (Array.isArray(body.detail)) message = body.detail.map((issue) => issue.msg).join(" ");
    } catch {
      // Use a generic HTTP message if the error response isn't valid JSON.
    }
    const error = new Error(response.status >= 500
      ? "Hệ thống đang bảo trì hoặc gặp sự cố. Vui lòng thử lại sau."
      : message);
    const fields = body.errors || body.detail?.errors;
    error.code = body.code || body.detail?.code;
    error.fields = Array.isArray(fields) ? fields : [];
    error.status = response.status;
    throw error;
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
    const showPredicted = document.querySelector("#show-predicted-filter")?.checked || false;

    rows.forEach((row) => {
      const matchesLeague = selectedLeague === "all" || row.dataset.competition === selectedLeague;
      const matchesPredictionFilter = showPredicted || row.dataset.predicted !== "true";
      if (matchesLeague && matchesPredictionFilter) {
        row.classList.remove("hidden");
        visibleInGroup++;
      } else {
        row.classList.add("hidden");
      }
    });

    if (countEl) countEl.textContent = `${visibleInGroup} ${suffix}`;

    if (visibleInGroup === 0) {
      if (emptyEl) {
        const leagueRows = Array.from(rows).filter(
          (row) => selectedLeague === "all" || row.dataset.competition === selectedLeague,
        );
        if (
          !showPredicted
          && leagueRows.length > 0
          && leagueRows.every((row) => row.dataset.predicted === "true")
        ) {
          emptyEl.textContent = "No unpredicted matches in this group. Turn on “Show predicted” to include them.";
        } else {
          emptyEl.textContent = selectedLeague === "all"
            ? defaultEmptyText
            : `No ${suffix} matches in ${selectedLeague}.`;
        }
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

function getTeamInitials(teamName) {
  return teamName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function createTeamBadge(teamName, crest, side) {
  const team = document.createElement("span");
  team.className = `team-badge team-badge-${side}`;

  const name = document.createElement("span");
  name.className = "team-name";
  name.textContent = teamName || "Team";

  const logo = crest ? document.createElement("img") : document.createElement("span");
  logo.className = "team-logo";
  if (crest) {
    logo.src = crest;
    logo.alt = "";
    logo.loading = "lazy";
    logo.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "team-logo team-logo-fallback";
      fallback.textContent = getTeamInitials(teamName || "Team");
      logo.replaceWith(fallback);
    }, { once: true });
  } else {
    logo.classList.add("team-logo-fallback");
    logo.textContent = getTeamInitials(teamName || "Team");
    logo.setAttribute("aria-hidden", "true");
  }

  if (side === "home") team.append(name, logo);
  else team.append(logo, name);
  return team;
}

function createTeamPair(homeName, homeCrest, awayName, awayCrest, centerText = "vs") {
  const pair = document.createElement("div");
  pair.className = "team-pair";
  pair.setAttribute(
    "aria-label",
    centerText === "vs"
      ? `${homeName} versus ${awayName}`
      : `${homeName} ${centerText} ${awayName}`,
  );

  const separator = document.createElement("span");
  separator.className = centerText === "vs" ? "team-versus" : "team-score";
  separator.textContent = centerText;

  pair.append(
    createTeamBadge(homeName, homeCrest, "home"),
    separator,
    createTeamBadge(awayName, awayCrest, "away"),
  );
  return pair;
}

function createMatchRow(match) {
  const row = document.createElement("tr");
  row.dataset.competition = match.competition || "";
  row.dataset.status = match.status || "";
  row.dataset.predicted = String(predictedMatchIds.has(String(match.id)));
  const matchCell = document.createElement("td");
  matchCell.className = "match-cell";
  const competition = document.createElement("span");
  competition.className = "competition-name";
  competition.textContent = match.competition;
  const isEnded = match.status === "Ended";
  const resultText = isEnded
    ? typeof match.home_score === "number" && typeof match.away_score === "number"
      ? `${match.home_score}–${match.away_score}`
      : "FT"
    : "vs";
  const teams = createTeamPair(
    match.home_team,
    match.home_crest,
    match.away_team,
    match.away_crest,
    resultText,
  );
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

  const detailsCell = document.createElement("td");
  detailsCell.className = "prediction-cell";
  if (isEnded) {
    const prediction = myPredictionChoices.get(String(match.id));
    const points = document.createElement("div");
    points.className = "received-points";
    const label = document.createElement("span");
    label.className = "received-points-label";
    label.textContent = "Points received";
    const result = document.createElement("strong");
    result.className = "received-points-value";
    if (prediction && !match.winner) {
      result.textContent = "Pending";
      result.classList.add("muted");
    } else {
      const pointsReceived = prediction
        ? prediction === match.winner ? 100 : -100
        : 0;
      result.textContent = `${pointsReceived > 0 ? "+" : ""}${pointsReceived} pts`;
      result.classList.add(pointsReceived > 0 ? "text-green" : pointsReceived < 0 ? "text-red" : "muted");
    }
    points.append(label, result);
    detailsCell.append(points);
  } else {
    const viewLink = document.createElement("a");
    viewLink.href = `/match/${encodeURIComponent(match.id)}`;
    viewLink.className = "button button-primary view-match-button";
    viewLink.textContent = "View match";
    detailsCell.append(viewLink);
  }

  row.append(matchCell, dateCell, statusCell, detailsCell);
  return row;
}

async function submitPrediction(matchId, winner, button) {
  const notice = document.querySelector("#app-message") || document.querySelector("#detail-message");
  const buttons = button.parentElement.querySelectorAll("button");
  buttons.forEach((choice) => { choice.disabled = true; });
  hideNotice(notice);
  try {
    await apiRequest("/api/predict", {
      method: "POST",
      body: JSON.stringify({ user_id: currentUser.id, match_id: matchId, predicted_winner: winner }),
    });
    buttons.forEach((choice) => { choice.dataset.predictionSubmitted = "true"; });
    renderPredictionQuota();
    if (document.body.dataset.page === "match-detail") {
      const predictionPanel = document.querySelector("#prediction-panel");
      const locked = document.querySelector("#prediction-locked");
      const team = winner === "home"
        ? document.querySelector("#detail-home-team").textContent
        : winner === "away"
          ? document.querySelector("#detail-away-team").textContent
          : null;
      predictionPanel.classList.add("hidden");
      locked.classList.remove("hidden");
      locked.textContent = team ? `You predicted ${team} to win.` : "You predicted a draw.";
      return;
    }
    showNotice(notice, "Prediction saved. You can only predict each match once.", "success");
    buttons.forEach((choice) => { choice.textContent = choice === button ? "✓" : "·"; });
  } catch (error) {
    showNotice(notice, error.message);
    buttons.forEach((choice) => {
      choice.disabled = predictionQuotaRemaining === 0 || choice.dataset.predictionSubmitted === "true";
    });
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
let myPredictionChoices = new Map();

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
      document.querySelector("#prediction-quota")?.classList.remove("hidden");
      if (name) name.textContent = currentUser.username;
      if (points) points.textContent = formatPoints(currentUser.points);
    } else {
      authLink.classList.remove("hidden");
      logoutButton?.classList.add("hidden");
      document.querySelector("#prediction-quota")?.classList.add("hidden");
      if (name) name.textContent = "Sign in to track your score";
      if (points) points.textContent = "—";
    }
  }
  if (loadError) {
    showNotice(
      document.querySelector("#app-message")
        || document.querySelector("#my-app-message")
        || document.querySelector("#home-app-message")
        || document.querySelector("#detail-message"),
      loadError.message,
    );
  }
}

function addLogoutHandler() {
  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      window.location.assign("/");
    } catch (error) {
      showNotice(
        document.querySelector("#app-message")
          || document.querySelector("#home-app-message")
          || document.querySelector("#detail-message"),
        error.message,
      );
    }
  });
}

async function initMatchCenter() {
  document.querySelector("#refresh-button").addEventListener("click", loadMatches);
  document.querySelector("#match-type-filter")?.addEventListener("change", applyMatchFilter);
  document.querySelector("#match-league-filter")?.addEventListener("change", applyMatchFilter);
  document.querySelector("#show-predicted-filter")?.addEventListener("change", applyMatchFilter);
  addLogoutHandler();
  await loadCurrentUser();
  let predictionLoadError = null;
  if (currentUser) {
    try {
      const data = await apiRequest("/api/my-predictions");
      predictedMatchIds = new Set(data.predictions.map((item) => String(item.match_id)));
      myPredictionChoices = new Map(
        data.predictions.map((item) => [String(item.match_id), item.predicted_winner]),
      );
      document.querySelector("#show-predicted-control")?.classList.remove("hidden");
    } catch (error) {
      predictionLoadError = error;
    }
  }
  await loadMatches();
  if (predictionLoadError) {
    showNotice(
      document.querySelector("#app-message"),
      `Could not load your existing predictions, so predicted matches may be included: ${predictionLoadError.message}`,
    );
  }
}

function renderBarChart(container, entries, total) {
  container.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = entry.label;
    const track = document.createElement("span");
    track.className = "bar-track";
    const bar = document.createElement("span");
    bar.className = `bar-fill ${entry.className || ""}`;
    bar.style.width = `${total > 0 ? Math.max(entry.value > 0 ? 4 : 0, (entry.value / total) * 100) : 0}%`;
    track.append(bar);
    const value = document.createElement("strong");
    value.className = "bar-value mono";
    value.textContent = String(entry.value);
    row.append(label, track, value);
    container.append(row);
  }
}

function renderHomeAnalytics(data) {
  const predictions = data.predictions || [];
  const resolved = predictions.filter((item) => item.won === true || item.won === false);
  const won = resolved.filter((item) => item.won).length;
  const lost = resolved.length - won;
  const active = predictions.filter((item) => item.status === "Before" || item.status === "Ongoing").length;
  const earned = resolved.reduce((sum, item) => sum + Math.max(item.points_awarded || 0, 0), 0);
  const lostPoints = resolved.reduce((sum, item) => sum + Math.abs(Math.min(item.points_awarded || 0, 0)), 0);
  const accuracy = resolved.length > 0 ? Math.round((won / resolved.length) * 100) : null;

  document.querySelector("#kpi-points").textContent = formatPoints(data.user_points);
  document.querySelector("#kpi-earned").textContent = `+${formatPoints(earned)}`;
  document.querySelector("#kpi-lost-points").textContent = `−${formatPoints(lostPoints)}`;
  document.querySelector("#kpi-accuracy").textContent = accuracy === null ? "—" : `${accuracy}%`;
  document.querySelector("#kpi-resolved").textContent = `${resolved.length} resolved`;
  document.querySelector("#kpi-total").textContent = String(predictions.length);
  document.querySelector("#kpi-active").textContent = String(active);

  renderBarChart(document.querySelector("#outcome-chart"), [
    { label: "Correct", value: won, className: "bar-green" },
    { label: "Incorrect", value: lost, className: "bar-red" },
    { label: "Awaiting result", value: predictions.length - resolved.length, className: "bar-muted" },
  ], Math.max(predictions.length, 1));

  const picks = ["home", "draw", "away"].map((pick) => {
    const outcomes = resolved.filter((item) => item.predicted_winner === pick);
    const correct = outcomes.filter((item) => item.won).length;
    return {
      label: `${pick[0].toUpperCase()}${pick.slice(1)}`,
      value: outcomes.length > 0 ? Math.round((correct / outcomes.length) * 100) : 0,
      count: outcomes.length,
    };
  });
  const accuracyChart = document.querySelector("#pick-accuracy-chart");
  accuracyChart.replaceChildren();
  for (const pick of picks) {
    const row = document.createElement("div");
    row.className = "accuracy-row";
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = pick.label;
    const track = document.createElement("span");
    track.className = "bar-track";
    const bar = document.createElement("span");
    bar.className = "bar-fill bar-green";
    bar.style.width = `${pick.value}%`;
    track.append(bar);
    const value = document.createElement("strong");
    value.className = "bar-value mono";
    value.textContent = pick.count > 0 ? `${pick.value}%` : "—";
    row.append(label, track, value);
    accuracyChart.append(row);
  }

  const matrix = { home: { home: 0, draw: 0, away: 0 }, draw: { home: 0, draw: 0, away: 0 }, away: { home: 0, draw: 0, away: 0 } };
  for (const item of resolved) {
    if (matrix[item.actual_winner] && matrix[item.actual_winner][item.predicted_winner] !== undefined) {
      matrix[item.actual_winner][item.predicted_winner]++;
    }
  }
  const matrixBody = document.querySelector("#confusion-matrix-body");
  matrixBody.replaceChildren();
  for (const actual of ["home", "draw", "away"]) {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = actual.toUpperCase();
    row.append(heading);
    for (const pick of ["home", "draw", "away"]) {
      const cell = document.createElement("td");
      cell.textContent = String(matrix[actual][pick]);
      if (actual === pick && matrix[actual][pick] > 0) cell.className = "matrix-correct";
      row.append(cell);
    }
    matrixBody.append(row);
  }

  const recent = document.querySelector("#recent-predictions");
  const recentEmpty = document.querySelector("#recent-empty");
  recent.replaceChildren();
  recentEmpty.classList.toggle("hidden", predictions.length > 0);
  for (const item of predictions.slice(0, 5)) {
    const row = document.createElement("a");
    row.className = "recent-prediction";
    row.href = `/match/${encodeURIComponent(item.match_id)}`;
    const matchup = createTeamPair(
      item.home_team,
      item.home_crest,
      item.away_team,
      item.away_crest,
    );
    matchup.classList.add("recent-matchup");
    const detail = document.createElement("span");
    detail.className = "recent-detail";
    detail.textContent = `${item.predicted_label} pick · ${item.status}`;
    const result = document.createElement("strong");
    result.className = item.won === true ? "text-green" : item.won === false ? "text-red" : "muted";
    result.textContent = item.points_awarded === null ? "Pending" : `${item.points_awarded > 0 ? "+" : ""}${item.points_awarded} pts`;
    row.append(matchup, detail, result);
    recent.append(row);
  }
}

async function initHome() {
  addLogoutHandler();
  await loadCurrentUser();
  const loading = document.querySelector("#home-loading");
  const dashboard = document.querySelector("#home-dashboard");
  const authRequired = document.querySelector("#home-auth-required");
  if (!currentUser) {
    loading.classList.add("hidden");
    authRequired.classList.remove("hidden");
    return;
  }

  document.querySelector("#home-username").textContent = `, ${currentUser.username}`;
  try {
    const data = await apiRequest("/api/my-matches");
    renderHomeAnalytics(data);
    dashboard.classList.remove("hidden");
  } catch (error) {
    showNotice(document.querySelector("#home-app-message"), error.message);
  } finally {
    loading.classList.add("hidden");
  }
}

function appendProviderFields(container, value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendProviderFields(container, item, path ? `${path} / ${index + 1}` : String(index + 1)));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      appendProviderFields(container, nested, path ? `${path} / ${key}` : key);
    }
    return;
  }

  const field = document.createElement("div");
  field.className = "match-data-field";
  const label = document.createElement("span");
  label.className = "match-data-label";
  label.textContent = path.replaceAll("_", " ");
  const content = document.createElement("strong");
  content.className = "match-data-value";
  content.textContent = value === null || value === "" ? "—" : String(value);
  field.append(label, content);
  container.append(field);
}

async function initMatchDetail() {
  addLogoutHandler();
  await loadCurrentUser();
  const loading = document.querySelector("#detail-loading");
  const message = document.querySelector("#detail-message");
  const content = document.querySelector("#detail-content");
  const matchId = decodeURIComponent(window.location.pathname.split("/").pop());
  try {
    const match = await apiRequest(`/api/matches/${encodeURIComponent(matchId)}`);
    let existingPrediction = null;
    let predictionLookupFailed = false;
    if (currentUser) {
      try {
        const data = await apiRequest("/api/my-predictions");
        existingPrediction = data.predictions.find((item) => String(item.match_id) === String(match.id)) || null;
      } catch (error) {
        predictionLookupFailed = true;
        showNotice(message, `Could not check your existing prediction: ${error.message}`);
      }
    }
    const raw = match.provider_data || {};
    const home = raw.homeTeam || {};
    const away = raw.awayTeam || {};
    const competition = raw.competition || {};
    const score = raw.score || {};
    const fullTime = score.fullTime || {};
    const status = match.status || "Unavailable";

    document.title = `${match.home_team} vs ${match.away_team} — GreenPitch`;
    document.querySelector("#detail-title").textContent = `${match.home_team} vs ${match.away_team}`;
    document.querySelector("#detail-subtitle").textContent = match.utc_date
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }).format(new Date(match.utc_date)) + " UTC"
      : "Kick-off time unavailable";
    document.querySelector("#detail-competition").textContent = match.competition;
    const statusElement = document.querySelector("#detail-status");
    statusElement.textContent = status;
    statusElement.className = `status status-${status.toLowerCase()}`;
    document.querySelector("#detail-home-team").textContent = home.name || match.home_team;
    document.querySelector("#detail-away-team").textContent = away.name || match.away_team;
    const scoreElement = document.querySelector("#detail-score");
    scoreElement.textContent = typeof fullTime.home === "number" && typeof fullTime.away === "number"
      ? `${fullTime.home} — ${fullTime.away}`
      : "VS";
    document.querySelector("#detail-kickoff").textContent = match.utc_date
      ? new Date(match.utc_date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
      : "";

    for (const [id, source, teamName] of [
      ["detail-home-crest", home, match.home_team],
      ["detail-away-crest", away, match.away_team],
    ]) {
      const crest = document.getElementById(id);
      if (source.crest) {
        crest.src = source.crest;
        crest.alt = `${teamName} crest`;
        crest.classList.remove("hidden");
      }
    }

    const predictionPanel = document.querySelector("#prediction-panel");
    const locked = document.querySelector("#prediction-locked");
    if (existingPrediction) {
      predictionPanel.classList.add("hidden");
      locked.classList.remove("hidden");
      if (existingPrediction.predicted_winner === "home") {
        locked.textContent = `You predicted ${match.home_team} to win.`;
      } else if (existingPrediction.predicted_winner === "away") {
        locked.textContent = `You predicted ${match.away_team} to win.`;
      } else {
        locked.textContent = "You predicted a draw.";
      }
    } else if (predictionLookupFailed) {
      predictionPanel.classList.add("hidden");
      locked.classList.remove("hidden");
      locked.textContent = "Your prediction could not be verified. Refresh the page before trying again.";
    } else if (status === "Before" && currentUser) {
      const panel = document.querySelector("#detail-prediction-choices");
      for (const [outcome, label] of [["home", match.home_team], ["draw", "Draw"], ["away", match.away_team]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button prediction-option";
        button.disabled = predictionQuotaRemaining === 0;
        button.textContent = label;
        button.addEventListener("click", () => submitPrediction(match.id, outcome, button));
        panel.append(button);
      }
      document.querySelector("#prediction-quota").classList.remove("hidden");
    } else {
      predictionPanel.classList.add("hidden");
      locked.classList.remove("hidden");
      locked.textContent = status === "Before"
        ? "Sign in to submit a prediction."
        : status === "Ongoing"
          ? "Predictions are locked once a match starts."
          : "This match is no longer accepting predictions.";
      if (status === "Before" && !currentUser) {
        const signIn = document.createElement("a");
        signIn.href = "/login";
        signIn.className = "button button-primary";
        signIn.textContent = "Sign in";
        locked.append(" ", signIn);
      }
    }

    const fields = document.querySelector("#match-data-fields");
    appendProviderFields(fields, raw);
    document.querySelector("#provider-raw-data").textContent = JSON.stringify(raw, null, 2);
    if (competition.emblem) {
      document.querySelector("#detail-competition").textContent = competition.name || match.competition;
    }
    content.classList.remove("hidden");
  } catch (error) {
    showNotice(message, error.message);
  } finally {
    loading.classList.add("hidden");
  }
}

function initAuthPage() {
  const form = document.querySelector("#auth-form");
  const toggle = document.querySelector("#auth-toggle");
  const submit = document.querySelector("#auth-submit");
  const message = document.querySelector("#auth-message");
  const username = document.querySelector("#username");
  const password = document.querySelector("#password");
  const email = document.querySelector("#email");
  const confirmPassword = document.querySelector("#confirm-password");
  const signupFields = document.querySelector("#signup-fields");
  const confirmField = document.querySelector("#confirm-password-field");
  let registering = false;
  let submitting = false;

  const fieldError = (name) => document.querySelector(`#${name}-error`);
  const setFieldError = (name, text) => {
    const input = document.querySelector(`#${name === "confirm_password" ? "confirm-password" : name}`);
    const output = fieldError(name === "confirm_password" ? "confirm-password" : name);
    if (output) output.textContent = text || "";
    input?.setAttribute("aria-invalid", text ? "true" : "false");
  };
  const clearFieldErrors = () => ["username", "email", "password", "confirm-password"].forEach((name) => setFieldError(name, ""));

  const validate = () => {
    clearFieldErrors();
    let valid = true;
    const usernameValue = username.value.trim();
    if (!usernameValue) { setFieldError("username", "Tên đăng nhập không được để trống."); valid = false; }
    else if (registering && !/^[A-Za-z0-9_]{3,30}$/.test(usernameValue)) { setFieldError("username", "Username phải từ 3 đến 30 ký tự và chỉ gồm chữ cái, số hoặc dấu gạch dưới."); valid = false; }
    else if (!registering && usernameValue.length < 3) { setFieldError("username", "Nhập username hoặc email hợp lệ."); valid = false; }
    if (registering) {
      if (!email.value.trim()) { setFieldError("email", "Email không được để trống."); valid = false; }
      else if (!email.validity.valid) { setFieldError("email", "Email không đúng định dạng."); valid = false; }
      if (!password.value) { setFieldError("password", "Mật khẩu không được để trống."); valid = false; }
      else if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,128}$/.test(password.value)) { setFieldError("password", "Mật khẩu phải từ 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt."); valid = false; }
      if (!confirmPassword.value) { setFieldError("confirm-password", "Vui lòng nhập lại mật khẩu."); valid = false; }
      else if (confirmPassword.value !== password.value) { setFieldError("confirm-password", "Mật khẩu nhập lại không khớp."); valid = false; }
    } else if (!password.value) { setFieldError("password", "Mật khẩu không được để trống."); valid = false; }
    return valid;
  };

  form.querySelectorAll("input").forEach((input) => input.addEventListener("input", () => {
    setFieldError(input.name === "confirm_password" ? "confirm-password" : input.name, "");
    hideNotice(message);
  }));

  toggle.addEventListener("click", () => {
    if (submitting) return;
    registering = !registering;
    document.querySelector("#auth-heading").textContent = registering ? "Create your account" : "Welcome back";
    document.querySelector("#auth-description").textContent = registering
      ? "Join the match center. Your account starts with 1,000 points."
      : "Sign in to submit predictions and follow your points.";
    document.querySelector("#auth-submit").textContent = registering ? "Create account" : "Sign in";
    document.querySelector("#username-label").textContent = registering ? "Username" : "Username or email";
    signupFields.classList.toggle("hidden", !registering);
    confirmField.classList.toggle("hidden", !registering);
    email.required = registering;
    confirmPassword.required = registering;
    username.maxLength = registering ? 30 : 254;
    username.minLength = registering ? 3 : 3;
    document.querySelector("#auth-switch-label").textContent = registering ? "Already have an account?" : "New to GreenPitch?";
    toggle.textContent = registering ? "Sign in" : "Create an account";
    document.querySelector("#password").autocomplete = registering ? "new-password" : "current-password";
    hideNotice(document.querySelector("#auth-message"));
    clearFieldErrors();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !validate()) return;
    submitting = true;
    submit.disabled = true;
    submit.textContent = registering ? "Creating account…" : "Signing in…";
    hideNotice(message);
    const payload = registering
      ? { username: username.value.trim(), email: email.value.trim(), password: password.value, confirm_password: confirmPassword.value }
      : { username: username.value.trim(), password: password.value };
    try {
      await apiRequest(registering ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      window.location.assign("/");
    } catch (error) {
      if (error.fields?.length) {
        for (const issue of error.fields) setFieldError(issue.field, issue.message);
        if (error.code === "VALIDATION_ERROR") showNotice(message, "Vui lòng kiểm tra lại các trường được đánh dấu.");
        else showNotice(message, error.message);
      } else showNotice(message, error.message);
    } finally {
      submitting = false;
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
  const teams = createTeamPair(
    item.home_team,
    item.home_crest,
    item.away_team,
    item.away_crest,
  );
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
  if (document.body.dataset.page === "home") initHome();
  if (document.body.dataset.page === "match-center") initMatchCenter();
  if (document.body.dataset.page === "match-detail") initMatchDetail();
  if (document.body.dataset.page === "my-matches") initMyMatches();
  if (document.body.dataset.page === "auth") initAuthPage();
});
