(() => {
  const csrfToken = document.querySelector('meta[name="admin-csrf"]').content;
  const message = document.querySelector("#admin-message");
  const timeout = () => AbortSignal.timeout(10000);

  function newRequestId() {
    // getRandomValues is available on local HTTP as well as HTTPS.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }

  function post(path, payload) {
    return apiRequest("/api/admin" + path, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "X-CSRF-Token": csrfToken },
      signal: timeout(),
    });
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text) {
    const control = element("button", text, "button button-quiet");
    control.type = "button";
    return control;
  }

  function record(title, summary) {
    const row = element("article", "", "admin-record");
    const info = document.createElement("div");
    info.append(element("h3", title), element("p", summary, "muted"));
    row.append(info);
    return row;
  }

  function matchRecord(match) {
    const teams = match.home_team + " vs " + match.away_team;
    const kickoff = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(match.utc_date));
    const summary = match.competition + " · " + kickoff + " · " + match.status;
    const row = record(teams, summary);
    if (match.status === "Ended") {
      row.append(element("p", match.home_score + "–" + match.away_score
        + " · " + match.settled_count + " predictions settled", "mono"));
    } else if (match.status === "Awaiting result") {
      const form = element("form", "", "admin-score-form");
      const fields = [match.home_team, match.away_team].map(team => {
        const label = element("label", team + " score");
        const input = element("input", "", "select-input");
        Object.assign(input, { type: "number", min: "0", max: "2147483647", step: "1", required: true });
        label.append(input);
        form.append(label);
        return input;
      });
      const submit = element("button", "Finalize score", "button button-primary");
      form.append(submit);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const [home_score, away_score] = fields.map(input => input.valueAsNumber);
        const outcome = home_score === away_score ? "Draw" : (home_score > away_score ? match.home_team : match.away_team) + " wins";
        const score = match.home_team + " " + home_score + "–" + away_score + " " + match.away_team;
        if (!window.confirm("Finalize " + score + "? " + outcome + ". This will settle predictions.")) return;
        submit.disabled = true;
        try {
          const result = await post("/simulated-matches/" + match.id + "/finalize", { home_score, away_score });
          row.replaceWith(matchRecord(result));
          showNotice(message, score + ". Predictions settled.", "success");
        } catch (error) {
          showNotice(message, error.message);
        } finally {
          submit.disabled = false;
        }
      });
      row.append(form);
    }
    return row;
  }

  function initMatches() {
    const list = document.querySelector("#admin-fixtures");
    const refresh = document.querySelector("#refresh-fixtures");
    const form = document.querySelector("#publish-match");
    const publish = form.querySelector("button");
    async function load() {
      refresh.disabled = true;
      list.textContent = "Loading simulated fixtures…";
      try {
        const matches = await apiRequest("/api/admin/simulated-matches", { signal: timeout() });
        list.replaceChildren(...matches.map(matchRecord));
        if (!matches.length) list.textContent = "No simulated fixtures yet.";
      } catch (error) {
        list.textContent = error.message;
      } finally {
        refresh.disabled = false;
      }
    }
    refresh.addEventListener("click", load);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.kickoff = new Date(data.kickoff).toISOString();
      publish.disabled = true;
      try {
        await post("/simulated-matches", data);
        form.reset();
        showNotice(message, "Simulated fixture published.", "success");
        await load();
      } catch (error) {
        showNotice(message, error.message);
      } finally {
        publish.disabled = false;
      }
    });
    load();
  }

  function initUsers() {
    const list = document.querySelector("#admin-users");
    const search = document.querySelector("#search-users");
    const previous = document.querySelector("#previous-users");
    const next = document.querySelector("#next-users");
    const dialog = document.querySelector("#account-dialog");
    const form = document.querySelector("#change-account");
    const action = form.elements.action;
    const delta = form.elements.delta;
    const errorNotice = document.querySelector("#account-error");
    const preview = document.querySelector("#account-preview");
    const submit = form.querySelector("[type=submit]");
    const cancel = document.querySelector("#cancel-account");
    let page = 1;
    let query = "";
    let loadVersion = 0;
    let selected;
    let pending;
    let submitting = false;

    function updatePreview() {
      const isPoints = action.value === "points";
      document.querySelector("#point-adjustment").classList.toggle("hidden", !isPoints);
      delta.disabled = !isPoints;
      preview.textContent = isPoints && Number.isInteger(delta.valueAsNumber)
        ? "New balance: " + formatPoints(selected.points + delta.valueAsNumber) + " pts"
        : "";
    }

    function open(user) {
      selected = user;
      pending = null;
      submit.disabled = false;
      form.reset();
      hideNotice(errorNotice);
      document.querySelector("#account-title").textContent = user.username;
      document.querySelector("#account-balance").textContent = formatPoints(user.points) + " available points";
      document.querySelector("#account-status-option").textContent = user.active ? "Deactivate account" : "Reactivate account";
      updatePreview();
      dialog.showModal();
    }

    async function load() {
      const version = ++loadVersion;
      previous.disabled = next.disabled = true;
      list.textContent = "Loading accounts…";
      document.querySelector("#user-page").textContent = "Page " + page;
      try {
        const data = await apiRequest("/api/admin/users?" + new URLSearchParams({ q: query, page }), { signal: timeout() });
        if (version !== loadVersion) return;
        list.replaceChildren(...data.users.map(user => {
          const status = !user.active ? "Inactive" : user.locked ? "Locked" : "Active";
          const row = record(user.username, [user.email, status, formatPoints(user.points) + " pts"].filter(Boolean).join(" · "));
          const manage = button("Manage account");
          manage.setAttribute("aria-label", "Manage " + user.username);
          manage.addEventListener("click", () => open(user));
          row.append(manage);
          return row;
        }));
        if (!data.users.length) list.textContent = "No accounts found.";
        next.disabled = !data.has_next;
      } catch (error) {
        if (version === loadVersion) list.textContent = error.message;
      } finally {
        if (version === loadVersion) previous.disabled = page === 1;
      }
    }

    search.addEventListener("submit", event => {
      event.preventDefault();
      query = search.elements.query.value;
      page = 1;
      load();
    });
    previous.addEventListener("click", () => { page--; load(); });
    next.addEventListener("click", () => { page++; load(); });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
    action.addEventListener("change", updatePreview);
    delta.addEventListener("input", updatePreview);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const kind = action.value;
      const payload = { reason: form.elements.reason.value };
      if (kind === "points") {
        payload.delta = delta.valueAsNumber;
        payload.expected_balance = selected.points;
      }
      if (kind === "status") payload.active = !selected.active;
      const signature = JSON.stringify([kind, payload]);
      if (pending?.signature !== signature) pending = { signature, id: newRequestId() };
      submitting = true;
      let stale = false;
      submit.disabled = cancel.disabled = true;
      hideNotice(errorNotice);
      try {
        const result = await post("/users/" + selected.id + "/" + kind, { ...payload, request_id: pending.id });
        dialog.close();
        showNotice(message, result.username + " updated · " + formatPoints(result.points) + " available points.", "success");
        await load();
      } catch (error) {
        stale = error.status === 409;
        showNotice(errorNotice, stale ? error.message + " Reopen the account to review the latest values." : error.message);
        if (stale) await load();
      } finally {
        submitting = false;
        cancel.disabled = false;
        submit.disabled = stale;
      }
    });
    load();
  }

  addLogoutHandler();
  if (document.body.dataset.page === "create-match") initMatches();
  else initUsers();
})();
