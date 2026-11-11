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

  function matchRecord(match, openState) {
    const teams = match.home_team + " vs " + match.away_team;
    const kickoff = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
      .format(new Date(match.utc_date));
    const status = match.status === "Before" ? "Upcoming" : match.status;
    const row = record(teams, match.competition + " · " + kickoff + " · " + status);
    if (match.home_score !== null && match.away_score !== null) {
      row.firstElementChild.append(element("p", match.home_score + "–" + match.away_score, "mono"));
    }
    if (match.status === "Ended") {
      row.append(element("p", match.settled_count + " settled", "muted"));
    } else {
      const edit = button("Update status and score");
      edit.setAttribute("aria-haspopup", "dialog");
      edit.setAttribute("aria-label", "Update status and score for " + teams);
      edit.addEventListener("click", () => openState(match));
      row.append(edit);
    }
    return row;
  }

  function publishPayload(form) {
    const fields = new FormData(form);
    const data = {
      home_team: fields.get("home_team"),
      away_team: fields.get("away_team"),
      competition: fields.get("competition"),
      kickoff: new Date(fields.get("kickoff")).toISOString(),
    };
    const extra = fields.get("provider_json").trim();
    let details;
    try {
      details = extra ? JSON.parse(extra) : {};
    } catch {
      throw new Error("Additional match data must be valid JSON.");
    }
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      throw new Error("Additional match data must be a JSON object.");
    }

    // Named form fields take precedence over the same keys in the optional JSON.
    for (const [key, input] of fields) {
      const value = input.trim();
      if (!value || ["home_team", "away_team", "competition", "kickoff", "provider_json", "referee"].includes(key)) continue;
      const [group, field] = key.split(".");
      if (field) {
        const nested = details[group];
        details[group] = { ...(nested && typeof nested === "object" && !Array.isArray(nested) ? nested : {}), [field]: value };
      } else {
        details[group] = key === "matchday" ? Number(value) : value;
      }
    }
    const referee = fields.get("referee").trim();
    if (referee) {
      const [first, ...remaining] = Array.isArray(details.referees) ? details.referees : [];
      details.referees = [{ ...(first && typeof first === "object" ? first : {}), name: referee }, ...remaining];
    }
    return { ...data, details };
  }

  function initMatches() {
    const list = document.querySelector("#admin-fixtures");
    const refresh = document.querySelector("#refresh-fixtures");
    const publishDialog = document.querySelector("#publish-dialog");
    const stateDialog = document.querySelector("#match-state-dialog");
    const publishForm = document.querySelector("#publish-match");
    const stateForm = document.querySelector("#match-state-form");
    const publishError = document.querySelector("#publish-error");
    const stateError = document.querySelector("#match-state-error");
    const kickoffField = document.querySelector("#reschedule-field");
    const scoreFields = document.querySelector("#match-score-fields");
    const stateHint = document.querySelector("#match-state-hint");
    const { status, kickoff, home_score, away_score } = stateForm.elements;
    let selectedMatch;
    let loadVersion = 0;

    function updateStateFields() {
      const upcoming = status.value === "upcoming";
      const ended = status.value === "ended";
      kickoffField.classList.toggle("hidden", !upcoming);
      kickoff.disabled = !upcoming;
      scoreFields.classList.toggle("hidden", upcoming);
      scoreFields.disabled = upcoming;
      home_score.required = away_score.required = ended;
      stateHint.textContent = upcoming
        ? "A future kick-off reopens predictions and clears any live score."
        : ended ? "Saving the final score settles predictions and locks the result."
          : "Predictions close when the match goes ongoing. You can leave the live score blank.";
    }

    function openState(match) {
      selectedMatch = match;
      document.querySelector("#match-state-teams").textContent = match.home_team + " vs " + match.away_team;
      const date = new Date(match.utc_date);
      kickoff.value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      status.value = match.status === "Before" ? "upcoming" : match.status === "Ongoing" ? "ongoing" : "ended";
      home_score.value = match.home_score ?? "";
      away_score.value = match.away_score ?? "";
      hideNotice(stateError);
      updateStateFields();
      stateDialog.showModal();
    }

    async function load() {
      const version = ++loadVersion;
      refresh.disabled = true;
      list.textContent = "Loading simulated fixtures…";
      try {
        const matches = await apiRequest("/api/admin/simulated-matches", { signal: timeout() });
        if (version !== loadVersion) return;
        list.replaceChildren(...matches.map(match => matchRecord(match, openState)));
        if (!matches.length) list.textContent = "No simulated fixtures yet.";
      } catch (error) {
        if (version === loadVersion) list.textContent = error.message;
      } finally {
        if (version === loadVersion) refresh.disabled = false;
      }
    }

    function bindDialog(dialog, form, errorNotice, save) {
      const submit = form.querySelector("[type=submit]");
      const cancel = form.querySelector("[data-close-dialog]");
      cancel.addEventListener("click", () => dialog.close());
      dialog.addEventListener("cancel", event => { if (submit.disabled) event.preventDefault(); });
      form.addEventListener("submit", async event => {
        event.preventDefault();
        hideNotice(errorNotice);
        submit.disabled = cancel.disabled = true;
        try {
          const successMessage = await save();
          if (!successMessage) return;
          dialog.close();
          showNotice(message, successMessage, "success");
          await load();
        } catch (error) {
          showNotice(errorNotice, error.message);
        } finally {
          submit.disabled = cancel.disabled = false;
        }
      });
    }

    refresh.addEventListener("click", load);
    document.querySelector("#open-publish").addEventListener("click", () => {
      hideNotice(publishError);
      publishDialog.showModal();
    });
    status.addEventListener("change", updateStateFields);

    bindDialog(publishDialog, publishForm, publishError, async () => {
      await post("/simulated-matches", publishPayload(publishForm));
      publishForm.reset();
      publishForm.querySelector("details").open = false;
      return "Simulated fixture published.";
    });
    bindDialog(stateDialog, stateForm, stateError, async () => {
      const data = { status: status.value };
      if (status.value === "upcoming") {
        data.kickoff = new Date(kickoff.value).toISOString();
      } else {
        data.home_score = home_score.value === "" ? null : home_score.valueAsNumber;
        data.away_score = away_score.value === "" ? null : away_score.valueAsNumber;
        if ((data.home_score === null) !== (data.away_score === null)) {
          throw new Error("Enter both scores or leave both blank.");
        }
      }
      if (data.status === "ended") {
        const score = selectedMatch.home_team + " " + data.home_score + "–" + data.away_score + " " + selectedMatch.away_team;
        if (!window.confirm("Finalize " + score + " and settle predictions?")) return;
      }
      const result = await post("/simulated-matches/" + selectedMatch.id + "/state", data);
      return data.status === "ended" ? "Final score saved. Predictions settled."
        : result.status === "Ongoing" ? "Ongoing status and score saved." : "Upcoming status saved.";
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
