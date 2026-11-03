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
  const body = document.querySelector("#matches-body");
  const count = document.querySelector("#match-count");
  const notice = document.querySelector("#app-message");
  loading.classList.remove("hidden");
  empty.classList.add("hidden");
  body.replaceChildren();
  hideNotice(notice);

  try {
    const data = await apiRequest("/api/matches");
    const matches = data.matches;
    count.textContent = `${matches.length} fixture${matches.length === 1 ? "" : "s"}`;
    if (matches.length === 0) empty.classList.remove("hidden");
    for (const match of matches) body.append(createMatchRow(match));
  } catch (error) {
    count.textContent = "Unavailable";
    showNotice(notice, error.message);
  } finally {
    loading.classList.add("hidden");
  }
}

function createMatchRow(match) {
  const row = document.createElement("tr");
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
  } else if (match.status === "Ended" && match.home_score !== null && match.away_score !== null) {
    const score = document.createElement("span");
    score.className = "mono score";
    score.textContent = `${match.home_score} — ${match.away_score}`;
    predictCell.append(score);
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
  if (!authLink) return;
  if (currentUser) {
    authLink.classList.add("hidden");
    logoutButton.classList.remove("hidden");
    name.textContent = currentUser.username;
    points.textContent = formatPoints(currentUser.points);
  } else {
    authLink.classList.remove("hidden");
    logoutButton.classList.add("hidden");
    name.textContent = "Sign in to track your score";
    points.textContent = "—";
  }
  if (loadError) showNotice(document.querySelector("#app-message"), loadError.message);
}

async function initDashboard() {
  document.querySelector("#refresh-button").addEventListener("click", loadMatches);
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

document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "dashboard") initDashboard();
  if (document.body.dataset.page === "auth") initAuthPage();
});