const formatPoints = (points) => new Intl.NumberFormat().format(points);
let predictedMatchIds = new Set();
function updatePredictionControls() {
  const stakeInput = document.querySelector("#prediction-stake");
  if (!stakeInput) return;
  const stake = Number(stakeInput.value);
  const valid = Number.isSafeInteger(stake) && stake > 0 && currentUser && stake <= currentUser.points;
  const preview = document.querySelector("#stake-preview");
  const balance = document.querySelector("#prediction-balance");
  if (balance && currentUser) balance.textContent = formatPoints(currentUser.points);
  if (valid) {
    preview.textContent = `Win: payout ${formatPoints(stake * 2)} pts (net +${formatPoints(stake)}); loss: −${formatPoints(stake)} pts.`;
  } else {
    preview.textContent = currentUser
      ? "Enter a whole-number stake within your available balance."
      : "Sign in to place a prediction.";
  }
  document.querySelectorAll(".prediction-option").forEach((button) => {
    button.disabled = !valid
      || button.dataset.predictionSubmitted === "true";
  });
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
  const awaitingBody = document.querySelector("#awaiting-matches-body");

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
  awaitingBody?.replaceChildren();
  document.querySelector("#awaiting-group")?.classList.add("hidden");
  hideNotice(notice);

  try {
    const data = await apiRequest("/api/matches", { signal: AbortSignal.timeout(15000) });
    const matches = data.matches || [];
    if (data.live_data_unavailable) showNotice(notice, "Live fixtures are temporarily unavailable. Showing simulated matches.");
    count.textContent = `${matches.length} fixture${matches.length === 1 ? "" : "s"}`;
    if (matches.length === 0) empty.classList.remove("hidden");

    populateLeagues(matches);

    const ongoing = [];
    const upcoming = [];
    const ended = [];
    const awaiting = [];

    for (const match of matches) {
      if (match.status === "Ongoing") {
        ongoing.push(match);
      } else if (match.status === "Before") {
        upcoming.push(match);
      } else if (match.status === "Awaiting result") {
        awaiting.push(match);
      } else {
        ended.push(match);
      }
    }

    // Ongoing group
    if (ongoingCount) ongoingCount.textContent = `${ongoing.length} live`;
    if (ongoing.length === 0) ongoingEmpty?.classList.remove("hidden");
    else ongoingEmpty?.classList.add("hidden");
    renderFixtureWeeks(ongoingBody, ongoing);

    // Upcoming group
    if (upcomingCount) upcomingCount.textContent = `${upcoming.length} upcoming`;
    if (upcoming.length === 0) upcomingEmpty?.classList.remove("hidden");
    else upcomingEmpty?.classList.add("hidden");
    renderFixtureWeeks(upcomingBody, upcoming);

    // Ended group
    if (endedCount) endedCount.textContent = `${ended.length} ended`;
    if (ended.length === 0) endedEmpty?.classList.remove("hidden");
    else endedEmpty?.classList.add("hidden");
    renderFixtureWeeks(endedBody, ended, true);

    renderFixtureWeeks(awaitingBody, awaiting);
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
      key: "awaiting",
      element: document.querySelector("#awaiting-group"),
      countEl: document.querySelector("#awaiting-count"),
      emptyEl: document.querySelector("#awaiting-empty"),
      suffix: "pending",
      defaultEmptyText: "No simulated matches are awaiting a result.",
    },
    {
      key: "ended",
      element: endedGroup,
      countEl: document.querySelector("#ended-count"),
      emptyEl: document.querySelector("#ended-empty"),
      suffix: "ended",
      defaultEmptyText: "No ended matches.",
    },
  ];

  let totalVisible = 0;

  for (const { key, element, countEl, emptyEl, suffix, defaultEmptyText } of groups) {
    if (!element) continue;

    const isGroupTypeVisible = selectedType === key || (selectedType === "all"
      && (key !== "awaiting" || element.querySelector(".fixture-card")));
    if (!isGroupTypeVisible) {
      element.classList.add("hidden");
      continue;
    }

    element.classList.remove("hidden");
    const rows = element.querySelectorAll(".fixture-card");
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

    for (const week of element.querySelectorAll(".fixture-week")) {
      week.classList.toggle("hidden", !week.querySelector(".fixture-card:not(.hidden)"));
    }

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

function renderFixtureWeeks(container, matches, newestFirst = false) {
  if (!container) return;
  const weeks = new Map();
  for (const match of matches) {
    const kickoff = new Date(match.utc_date || NaN);
    const monday = new Date(kickoff);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
    const key = Number.isNaN(+monday) ? Infinity : +monday;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(match);
  }

  const datedWeeks = [...weeks.keys()].filter(Number.isFinite).sort((a, b) => newestFirst ? b - a : a - b);
  if (weeks.has(Infinity)) datedWeeks.push(Infinity);
  for (const key of datedWeeks) {
    const section = document.createElement("section");
    section.className = "fixture-week";
    const heading = document.createElement("h4");
    heading.textContent = "Kickoff date unavailable";
    if (Number.isFinite(key)) {
      const monday = new Date(key);
      // The Thursday of an ISO week determines its week-year.
      const thursday = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3));
      const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
      const weekNumber = Math.floor((thursday - yearStart) / (7 * 86400000)) + 1;
      heading.textContent = `Week ${weekNumber}`;
    }
    section.append(heading);
    for (const match of weeks.get(key)) section.append(createMatchRow(match));
    container.append(section);
  }
}

function createMatchRow(match) {
  const row = document.createElement("article");
  row.className = "fixture-card";
  row.dataset.competition = match.competition || "";
  row.dataset.status = match.status || "";
  row.dataset.predicted = String(predictedMatchIds.has(String(match.id)));
  const matchCell = document.createElement("div");
  matchCell.className = "match-cell";
  const competition = document.createElement("span");
  competition.className = "competition-name";
  competition.textContent = match.source === "simulated" ? match.competition + " · Simulated" : match.competition;
  const isEnded = match.status === "Ended";
  const hasScore = typeof match.home_score === "number" && typeof match.away_score === "number";
  const resultText = (isEnded || match.status === "Ongoing") && hasScore
    ? `${match.home_score}–${match.away_score}`
    : isEnded ? "FT" : "vs";
  const teams = createTeamPair(
    match.home_team,
    match.home_crest,
    match.away_team,
    match.away_crest,
    resultText,
  );
  const matchup = document.createElement("a");
  matchup.href = "/match/" + encodeURIComponent(match.id);
  matchup.className = "fixture-matchup";
  matchup.append(teams);
  matchCell.append(competition, matchup);

  const dateCell = document.createElement("div");
  dateCell.className = "mono date-cell";
  dateCell.textContent = match.utc_date
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(match.utc_date))
    : "—";

  const statusCell = document.createElement("div");
  const status = document.createElement("span");
  const statusClass = match.status.toLowerCase().replaceAll(" ", "-");
  status.className = `status status-${statusClass}`;
  status.textContent = match.status;
  statusCell.append(status);

  const detailsCell = document.createElement("div");
  detailsCell.className = "prediction-cell";
  if (isEnded) {
    const prediction = myPredictionChoices.get(String(match.id));
    const points = document.createElement("div");
    points.className = "received-points";
    const label = document.createElement("span");
    label.className = "received-points-label";
    const result = document.createElement("strong");
    result.className = "received-points-value";
    if (prediction && !match.winner) {
      result.textContent = "Pending";
      result.classList.add("muted");
    } else {
      const netPoints = prediction
        ? prediction.predicted_winner === match.winner
          ? prediction.stake === null ? 100 : prediction.stake
          : prediction.stake === null ? -100 : -prediction.stake
        : 0;
      result.textContent = `${netPoints > 0 ? "+" : ""}${netPoints} pts`;
      result.classList.add(netPoints > 0 ? "text-green" : netPoints < 0 ? "text-red" : "muted");
    }
    label.textContent = "Net points";
    points.append(label, result);
    detailsCell.append(points);
  }

  const meta = document.createElement("div");
  meta.className = "fixture-meta";
  meta.append(dateCell);
  if (match.status !== "Before") meta.append(statusCell);
  meta.append(detailsCell);
  row.append(matchCell, meta);
  return row;
}

async function submitPrediction(matchId, winner, button) {
  const notice = document.querySelector("#app-message") || document.querySelector("#detail-message");
  const stakeInput = document.querySelector("#prediction-stake");
  const stake = Number(stakeInput?.value);
  if (!Number.isSafeInteger(stake) || stake <= 0 || !currentUser || stake > currentUser.points) {
    showNotice(notice, "Enter a whole-number stake within your available points.");
    return;
  }
  const buttons = button.parentElement.querySelectorAll("button");
  buttons.forEach((choice) => { choice.disabled = true; });
  if (stakeInput) stakeInput.disabled = true;
  hideNotice(notice);
  try {
    const result = await apiRequest("/api/predict", {
      method: "POST",
      body: JSON.stringify({ user_id: currentUser.id, match_id: matchId, predicted_winner: winner, stake }),
    });
    currentUser.points = result.user_points;
    renderNavAccount();
    updatePredictionControls();
    buttons.forEach((choice) => { choice.dataset.predictionSubmitted = "true"; });
    buttons.forEach((choice) => { choice.disabled = true; });
    updatePredictionControls();
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
      locked.textContent = `${team ? `You predicted ${team} to win` : "You predicted a draw"} with a ${formatPoints(stake)}-point stake. Available balance: ${formatPoints(currentUser.points)} pts.`;
      return;
    }
    showNotice(notice, "Prediction saved. You can only predict each match once.", "success");
    buttons.forEach((choice) => { choice.textContent = choice === button ? "✓" : "·"; });
  } catch (error) {
    showNotice(notice, error.message);
    if (stakeInput) stakeInput.disabled = false;
    updatePredictionControls();
  }
}

async function loadLeaderboard() {
  const loading = document.querySelector("#leaderboard-loading");
  const list = document.querySelector("#leaderboard-list");
  const empty = document.querySelector("#leaderboard-empty");
  loading.classList.remove("hidden");
  list.replaceChildren();
  empty.textContent = "No players available.";
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
let currentUserIsAdmin = false;
let myPredictionChoices = new Map();

let dailyGift = null;
let giftBusy = false;
let giftBalanceRevision = 0;
const promptedGiftDays = new Set();

function renderDailyGift() {
  const claim = document.querySelector("#daily-gift-claim");
  if (!claim || !dailyGift || !currentUser) return;
  document.querySelector("#daily-gift-description").textContent = dailyGift.claimed
    ? "You’ve collected today’s gift."
    : `Claim ${formatPoints(dailyGift.points)} bonus points.`;
  document.querySelector("#daily-gift-points").textContent = formatPoints(currentUser.points);
  claim.disabled = giftBusy || dailyGift.claimed;
  claim.textContent = dailyGift.claimed ? "Come back tomorrow" : giftBusy ? "Please wait…" : "Claim";
}

function updateDailyGift(reward) {
  dailyGift = currentUser && reward ? reward : null;
  const trigger = document.querySelector("#daily-gift-button");
  const dialog = document.querySelector("#daily-gift-dialog");
  if (!trigger || !dialog) return;
  trigger.classList.toggle("hidden", !dailyGift);
  if (!dailyGift) {
    if (dialog.open) dialog.close();
    return;
  }
  renderDailyGift();
  if (dailyGift.claimed) return;
  const key = `greenpitch:daily-gift:${currentUser.id}:${dailyGift.day}`;
  if (promptedGiftDays.has(key)) return;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "shown");
  } catch {
    // The in-memory set still prevents repeated prompts on this page.
  }
  promptedGiftDays.add(key);
  if (!dialog.open) dialog.showModal();
}

function animateGiftBalance(from, to) {
  const balance = document.querySelector("#daily-gift-points");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
    balance.textContent = formatPoints(to);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const start = performance.now();
    function frame(now) {
      const progress = Math.min(1, (now - start) / 550);
      balance.textContent = formatPoints(Math.round(from + (to - from) * progress));
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function initDailyGift() {
  const trigger = document.querySelector("#daily-gift-button");
  const dialog = document.querySelector("#daily-gift-dialog");
  const claim = document.querySelector("#daily-gift-claim");
  const message = document.querySelector("#daily-gift-status");
  if (!trigger || !dialog || !claim || !message) return;
  trigger.addEventListener("click", async () => {
    message.textContent = "";
    if (!dialog.open) dialog.showModal();
    if (giftBusy) return;
    giftBusy = true;
    renderDailyGift();
    try {
      const result = await apiRequest("/auth/me", { signal: AbortSignal.timeout(8000) });
      if (!result.authenticated) {
        dailyGift = null;
        claim.disabled = true;
        message.textContent = "Sign in again to claim your gift.";
        return;
      }
      currentUser = result.user;
      dailyGift = result.daily_reward;
    } catch {
      message.textContent = "Couldn’t check today’s gift. Close the panel and try again.";
    } finally {
      giftBusy = false;
      renderDailyGift();
    }
  });
  claim.addEventListener("click", async () => {
    if (giftBusy || !dailyGift || dailyGift.claimed || !currentUser) return;
    giftBusy = true;
    message.textContent = "";
    renderDailyGift();
    try {
      const previous = currentUser.points;
      const result = await apiRequest("/auth/daily-gift/claim", {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
      currentUser = result.user;
      dailyGift = result.daily_reward;
      giftBalanceRevision++;
      renderNavAccount();
      if (document.querySelector("#points-history")) void loadPointsHistory();
      for (const selector of ["#user-points", "#kpi-points"]) {
        const balance = document.querySelector(selector);
        if (balance) balance.textContent = formatPoints(currentUser.points);
      }
      updatePredictionControls();
      if (result.awarded) {
        await animateGiftBalance(previous, currentUser.points);
        message.textContent = `+${formatPoints(dailyGift.points)} points added.`;
      }
    } catch (error) {
      message.textContent = error.status === 401 ? "Sign in again to claim your gift." : "Couldn’t confirm your claim. You can try again.";
    } finally {
      giftBusy = false;
      renderDailyGift();
    }
  });
}

function renderNavAccount() {
  const account = document.querySelector("#nav-account");
  if (!account) return;
  account.classList.toggle("hidden", !currentUser);
  if (!currentUser) return;

  const avatar = account.querySelector("#nav-avatar");
  avatar.textContent = Array.from(currentUser.username)[0].toUpperCase();
  avatar.setAttribute("aria-label", currentUser.username);
  account.querySelector("#nav-points").textContent = formatPoints(currentUser.points) + " pts";
}

async function loadCurrentUser({ signal, propagateError = false } = {}) {
  let loadError = null;
  let dailyReward;
  try {
    const result = await apiRequest("/auth/me", { signal });
    currentUser = result.authenticated ? result.user : null;
    currentUserIsAdmin = Boolean(result.authenticated && result.is_admin);
    dailyReward = result.daily_reward;
  } catch (error) {
    currentUser = null;
    currentUserIsAdmin = false;
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
  document.querySelectorAll("[data-admin-link]").forEach(link => link.classList.toggle("hidden", !currentUserIsAdmin));
  renderNavAccount();
  updateDailyGift(dailyReward);
  if (loadError) {
    if (propagateError) throw loadError;
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
          || document.querySelector("#admin-message")
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
  await loadCurrentUser({ signal: AbortSignal.timeout(8000) });
  let predictionLoadError = null;
  if (currentUser) {
    try {
      const data = await apiRequest("/api/my-predictions", { signal: AbortSignal.timeout(8000) });
      predictedMatchIds = new Set(data.predictions.map((item) => String(item.match_id)));
      myPredictionChoices = new Map(
        data.predictions.map((item) => [String(item.match_id), item]),
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

function renderWeeklyResults(predictions) {
  const container = document.querySelector("#weekly-results");
  const day = 86400000;
  const now = new Date();
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    - ((now.getUTCDay() + 6) % 7) * day;
  const start = monday - 49 * day;
  const weeks = Array.from({ length: 8 }, () => ({ correct: 0, incorrect: 0 }));
  for (const item of predictions) {
    if (!item.is_resolved || typeof item.won !== "boolean" || !item.utc_date) continue;
    const index = Math.floor((Date.parse(item.utc_date) - start) / (7 * day));
    if (weeks[index]) weeks[index][item.won ? "correct" : "incorrect"]++;
  }
  container.replaceChildren();
  const max = Math.max(1, ...weeks.map(({ correct, incorrect }) => correct + incorrect));
  const axis = document.createElement("div");
  axis.className = "weekly-row weekly-axis";
  const scale = document.createElement("span");
  scale.className = "weekly-scale";
  scale.setAttribute("aria-label", "Prediction count scale");
  for (const tick of [0, max]) {
    const label = document.createElement("span");
    label.textContent = formatPoints(tick);
    scale.append(label);
  }
  axis.append(scale);
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  weeks.forEach(({ correct, incorrect }, index) => {
    const row = document.createElement("div");
    row.className = "weekly-row";
    const label = document.createElement("span");
    label.textContent = date.format(start + index * 7 * day);
    const track = document.createElement("span");
    track.className = "weekly-track";
    track.setAttribute("aria-hidden", "true");
    for (const [count, color] of [[correct, "green"], [incorrect, "red"]]) {
      const bar = document.createElement("span");
      bar.className = "bar-" + color;
      bar.style.width = (count / max * 100) + "%";
      track.append(bar);
    }
    const counts = document.createElement("span");
    counts.textContent = correct + " correct / " + incorrect + " incorrect";
    row.append(label, track, counts);
    container.append(row);
  });
  container.append(axis);
}

let pointsHistoryRequest = 0;

async function loadPointsHistory() {
  const container = document.querySelector("#points-history");
  if (!container) return;
  const request = ++pointsHistoryRequest;
  try {
    const data = await apiRequest("/api/points-history", { signal: AbortSignal.timeout(10000) });
    if (request !== pointsHistoryRequest) return;
    container.replaceChildren();

    const dates = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
    const labels = { opening: "Starting balance", stake: "Prediction stake", payout: "Winning payout",
      gift: "Daily gift", adjustment: "Admin adjustment", loss: "Prediction loss" };
    const events = data.events;
    const start = Date.parse(events[0].kind === "opening" ? events[0].at : data.since);
    const end = Date.now();
    const span = Math.max(1, end - start);
    const balances = [data.opening, ...events.map((event) => event.balance)];
    const min = balances.reduce((a, b) => Math.min(a, b));
    const max = balances.reduce((a, b) => Math.max(a, b));
    const step = 10 ** Math.ceil(Math.log10(Math.max(100, (max - min) / 3)));
    const lower = Math.floor(min / step) * step;
    const upper = Math.max(lower + step, Math.ceil(max / step) * step);
    const y = (balance) => 126 - 108 * (balance - lower) / (upper - lower);
    const ns = "http://www.w3.org/2000/svg";
    const chart = document.createElementNS(ns, "svg");
    chart.setAttribute("viewBox", "0 0 480 144");
    chart.setAttribute("class", "points-chart");
    chart.setAttribute("role", "img");
    const hasChanges = events.some((event) => event.delta);
    chart.setAttribute("aria-label", hasChanges
      ? "Points balance over time. See point changes for details."
      : "No point changes recorded in the last 30 days");

    const left = Math.max(formatPoints(lower).length, formatPoints(upper).length) * 8 + 12;
    const axis = document.createElementNS(ns, "line");
    for (const [key, value] of Object.entries({ x1: left, x2: left, y1: 18, y2: 126 })) {
      axis.setAttribute(key, value);
    }
    chart.append(axis);
    for (let tick = lower; tick <= upper; tick += step) {
      const grid = document.createElementNS(ns, "line");
      const label = document.createElementNS(ns, "text");
      for (const [key, value] of Object.entries({ x1: left, x2: 476, y1: y(tick), y2: y(tick) })) {
        grid.setAttribute(key, value);
      }
      label.setAttribute("x", left - 7);
      label.setAttribute("y", y(tick));
      label.setAttribute("text-anchor", "end");
      label.setAttribute("dominant-baseline", "middle");
      label.textContent = formatPoints(tick);
      chart.append(grid, label);
    }
    if (!hasChanges) {
      container.append(chart);
      return;
    }
    const path = document.createElementNS(ns, "path");
    let geometry = "M " + left + " " + y(data.opening);
    for (const event of events) {
      const x = left + (476 - left) * Math.min(1, Math.max(0, (Date.parse(event.at) - start) / span));
      geometry += " H " + x + " V " + y(event.balance);
    }
    path.setAttribute("d", geometry + " H 476");
    chart.append(path);

    const range = document.createElement("p");
    range.className = "muted";
    const axisDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    range.textContent = axisDate.format(start) + " – " + axisDate.format(end)
      + " · " + formatPoints(min) + "–" + formatPoints(max) + " pts";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "View point changes";
    const changes = document.createElement("ul");
    changes.className = "points-changes";
    for (const event of events.slice().reverse()) {
      const entry = document.createElement("li");
      const delta = event.delta ? (event.delta > 0 ? "+" : "−") + formatPoints(Math.abs(event.delta)) + " pts · " : "";
      entry.textContent = dates.format(new Date(event.at)) + " · " + labels[event.kind]
        + " · " + delta + formatPoints(event.balance) + " pts balance";
      changes.append(entry);
    }
    details.append(summary, changes);
    container.append(chart, range, details);
  } catch {
    if (request !== pointsHistoryRequest) return;
    container.textContent = "Points history is temporarily unavailable. ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "text-button";
    retry.textContent = "Retry";
    retry.addEventListener("click", loadPointsHistory, { once: true });
    container.append(retry);
  }
}

function renderHomeAnalytics(data) {
  const predictions = data.predictions || [];
  const resolved = predictions.filter((item) => item.won === true || item.won === false);
  const won = resolved.filter((item) => item.won).length;
  const lost = resolved.length - won;
  const active = predictions.filter((item) => ["Before", "Ongoing", "Awaiting result"].includes(item.status)).length;
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
    const netPoints = item.net_points ?? item.points_awarded;
    result.textContent = netPoints === null ? "Pending" : `${netPoints > 0 ? "+" : ""}${netPoints} pts`;
    row.append(detail, matchup, result);
    recent.append(row);
  }
}

async function initHome() {
  addLogoutHandler();
  document.querySelector("#leaderboard-refresh").addEventListener("click", loadLeaderboard);
  void loadLeaderboard();
  const loading = document.querySelector("#home-loading");
  const dashboard = document.querySelector("#home-dashboard");
  const authRequired = document.querySelector("#home-auth-required");
  const notice = document.querySelector("#home-app-message") || document.createElement("div");
  if (!notice.isConnected) (document.querySelector("main") || document.body).prepend(notice);
  notice.setAttribute("role", "status");

  async function loadDashboard() {
    loading?.classList.remove("hidden");
    dashboard?.classList.add("hidden");
    authRequired?.classList.add("hidden");
    hideNotice(notice);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12000);
    try {
      if (!dashboard || !authRequired) throw new Error("The dashboard page is incomplete. Reload the page and try again.");
      await loadCurrentUser({ signal: controller.signal, propagateError: true });
      if (!currentUser) {
        authRequired.classList.remove("hidden");
        return;
      }
      const username = document.querySelector("#home-username");
      if (username) username.textContent = currentUser.username ? `, ${currentUser.username}` : "";
      const balanceRevision = giftBalanceRevision;
      const data = await apiRequest("/api/my-matches", { signal: controller.signal });
      if (balanceRevision !== giftBalanceRevision) data.user_points = currentUser.points;
      currentUser.points = data.user_points;
      renderNavAccount();
      renderHomeAnalytics(data);
      renderWeeklyResults(data.predictions || []);
      void loadPointsHistory();
      dashboard.classList.remove("hidden");
      if (data.live_data_unavailable) showNotice(notice, "Showing saved results. Live match updates are temporarily unavailable.");
    } catch (error) {
      if (error.status === 401 && authRequired) {
        authRequired.classList.remove("hidden");
        document.querySelector("#auth-link")?.classList.remove("hidden");
        document.querySelector("#logout-button")?.classList.add("hidden");
        currentUser = null;
        renderNavAccount();
      } else {
        showNotice(notice, controller.signal.aborted ? "The dashboard took too long to load." : error.message);
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "button button-quiet";
        retry.textContent = "Retry dashboard";
        retry.addEventListener("click", loadDashboard, { once: true });
        notice.append(" ", retry);
      }
    } finally {
      clearTimeout(deadline);
      loading?.classList.add("hidden");
    }
  }

  await loadDashboard();
}

function renderMatchInformation(raw) {
  const group = /^GROUP_([A-Z]+)$/.exec(raw.group)?.[1];
  const round = {
    FINAL: "Final", THIRD_PLACE: "Third-place match", SEMI_FINALS: "Semi-final",
    QUARTER_FINALS: "Quarter-final", LAST_16: "Round of 16",
    LAST_32: "Round of 32", LAST_64: "Round of 64",
  }[raw.stage];
  const phase = group ? `Group ${group}` : round || (Number.isInteger(raw.matchday) ? `Matchweek ${raw.matchday}` : "");
  if (phase) document.querySelector("#detail-competition").append(` · ${phase}`);

  const scoreSummary = [];
  for (const [label, score] of [["Half-time", raw.score?.halfTime], ["Penalties", raw.score?.penalties]]) {
    if (Number.isInteger(score?.home) && Number.isInteger(score?.away)) {
      scoreSummary.push(`${label} ${score.home}–${score.away}`);
    }
  }
  if (scoreSummary.length) {
    const summary = document.querySelector("#detail-score-summary");
    summary.textContent = scoreSummary.join(" · ");
    summary.classList.remove("hidden");
  }

  const fields = document.querySelector("#match-information-fields");
  const referee = Array.isArray(raw.referees)
    ? raw.referees.find((person) => person?.type === "REFEREE")?.name : null;
  for (const [label, value] of [["Stadium", raw.venue], ["Referee", referee]]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const field = document.createElement("div");
    field.className = "match-data-field";
    const term = document.createElement("dt");
    term.className = "match-data-label";
    term.textContent = label;
    const description = document.createElement("dd");
    description.className = "match-data-value";
    description.textContent = value;
    field.append(term, description);
    fields.append(field);
  }
  if (fields.childElementCount) document.querySelector("#match-information").classList.remove("hidden");

  const goals = document.querySelector("#match-goal-list");
  for (const goal of Array.isArray(raw.goals) ? raw.goals : []) {
    if (!Number.isInteger(goal?.minute) || !goal.scorer?.name) continue;
    const item = document.createElement("li");
    const addedTime = goal.injuryTime > 0 ? `+${goal.injuryTime}` : "";
    const team = goal.team?.name ? ` · ${goal.team.name}` : "";
    const type = goal.type === "OWN" ? " (own goal)" : goal.type === "PENALTY" ? " (penalty)" : "";
    item.textContent = `${goal.minute}${addedTime}′ · ${goal.scorer.name}${type}${team}`;
    goals.append(item);
  }
  if (goals.childElementCount) document.querySelector("#match-goals").classList.remove("hidden");
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
        const data = await apiRequest(`/api/my-predictions?match_id=${encodeURIComponent(match.id)}`);
        existingPrediction = data.predictions.find((item) => String(item.match_id) === String(match.id)) || null;
      } catch (error) {
        predictionLookupFailed = true;
        showNotice(message, `Could not check your existing prediction: ${error.message}`);
      }
    }
    const raw = match.provider_data || {};
    const home = raw.homeTeam || {};
    const away = raw.awayTeam || {};
    const score = raw.score || {};
    const fullTime = score.fullTime || {};
    const status = match.status || "Unavailable";

    document.title = `${match.home_team} vs ${match.away_team} — GreenPitch`;
    document.querySelector("#detail-title").textContent = `${match.home_team} vs ${match.away_team}`;
    const timeZone = match.source === "simulated" ? undefined : "UTC";
    const timeSuffix = timeZone ? " UTC" : "";
    document.querySelector("#detail-subtitle").textContent = match.utc_date
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short", timeZone }).format(new Date(match.utc_date)) + timeSuffix
      : "Kick-off time unavailable";
    document.querySelector("#detail-competition").textContent = match.source === "simulated" ? match.competition + " · Simulated" : match.competition;
    const statusElement = document.querySelector("#detail-status");
    statusElement.textContent = status;
    statusElement.className = `status status-${status.toLowerCase().replaceAll(" ", "-")}`;
    document.querySelector("#detail-home-team").textContent = home.name || match.home_team;
    document.querySelector("#detail-away-team").textContent = away.name || match.away_team;
    const scoreElement = document.querySelector("#detail-score");
    const homeScore = match.home_score ?? fullTime.home;
    const awayScore = match.away_score ?? fullTime.away;
    scoreElement.textContent = typeof homeScore === "number" && typeof awayScore === "number"
      ? `${homeScore} — ${awayScore}`
      : "VS";
    document.querySelector("#detail-kickoff").textContent = match.utc_date
      ? new Date(match.utc_date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone }) + timeSuffix
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
      const pick = { home: match.home_team, away: match.away_team, draw: "Draw" }[existingPrediction.predicted_winner];
      const summary = [`Your pick: ${pick}`];
      if (existingPrediction.stake != null) summary.push(`${formatPoints(existingPrediction.stake)} pts staked`);
      if (typeof existingPrediction.won === "boolean") {
        const points = existingPrediction.net_points;
        summary.push(existingPrediction.won ? "Correct" : "Incorrect",
          `${points > 0 ? "+" : ""}${formatPoints(points)} pts net`);
      } else if (status === "Ongoing") {
        summary.push("In progress");
      } else if (status === "Ended" || status === "Awaiting result") {
        summary.push("Awaiting settlement");
      }
      locked.textContent = summary.join(" · ");
    } else if (predictionLookupFailed) {
      predictionPanel.classList.add("hidden");
      locked.classList.remove("hidden");
      locked.textContent = "Your prediction could not be verified. Refresh the page before trying again.";
    } else if (match.source === "simulated" && currentUserIsAdmin) {
      predictionPanel.classList.add("hidden");
      locked.classList.remove("hidden");
      locked.textContent = "Admins cannot predict simulated matches.";
    } else if (status === "Before" && currentUser) {
      const panel = document.querySelector("#detail-prediction-choices");
      const stakeInput = document.querySelector("#prediction-stake");
      stakeInput.max = String(currentUser.points);
      stakeInput.addEventListener("input", updatePredictionControls);
      for (const [outcome, label] of [["home", match.home_team], ["draw", "Draw"], ["away", match.away_team]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button prediction-option";
        button.textContent = label;
        button.addEventListener("click", () => submitPrediction(match.id, outcome, button));
        panel.append(button);
      }
      updatePredictionControls();
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

    renderMatchInformation(raw);
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
    const balanceRevision = giftBalanceRevision;
    const data = await apiRequest("/api/my-matches");
    myPredictionsData = data.predictions || [];

    if (userPointsEl && data.user_points !== undefined && balanceRevision === giftBalanceRevision) {
      currentUser.points = data.user_points;
      renderNavAccount();
      userPointsEl.textContent = formatPoints(data.user_points);
    }

    let incomingCount = 0;
    let ongoingCount = 0;
    let wonCount = 0;
    let lostCount = 0;

    for (const p of myPredictionsData) {
      if (p.status === "Before") incomingCount++;
      else if (p.status === "Ongoing" || p.status === "Awaiting result") ongoingCount++;
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
    if (selected === "ongoing") return item.status === "Ongoing" || item.status === "Awaiting result";
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
  competition.textContent = item.source === "simulated" ? item.competition + " · Simulated" : item.competition;
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
  if (item.stake !== null && item.stake !== undefined) {
    const stakeText = document.createElement("small");
    stakeText.className = "muted";
    stakeText.textContent = `Stake: ${formatPoints(item.stake)} pts`;
    badge.append(stakeText);
  }
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

  // Col 6: Net Points
  const pointsCell = document.createElement("td");
  pointsCell.className = "points-cell";
  if (["Before", "Ongoing", "Awaiting result"].includes(item.status)) {
    const pendingSpan = document.createElement("span");
    pendingSpan.className = "mono muted";
    pendingSpan.textContent = "—";
    pointsCell.append(pendingSpan);
  } else if ((item.net_points ?? item.points_awarded) !== null) {
    const netPoints = item.net_points ?? item.points_awarded;
    const pointsPill = document.createElement("span");
    if (netPoints > 0) {
      pointsPill.className = "points-pill points-pill-won mono";
      pointsPill.textContent = `+${netPoints} pts`;
    } else if (netPoints < 0) {
      pointsPill.className = "points-pill points-pill-lost mono";
      pointsPill.textContent = `${netPoints} pts`;
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
  initDailyGift();
  if (["create-match", "users"].includes(document.body.dataset.page)) void loadCurrentUser();
  if (document.body.dataset.page === "home") initHome();
  if (document.body.dataset.page === "match-center") initMatchCenter();
  if (document.body.dataset.page === "match-detail") initMatchDetail();
  if (document.body.dataset.page === "my-matches") initMyMatches();
  if (document.body.dataset.page === "auth") initAuthPage();
});
