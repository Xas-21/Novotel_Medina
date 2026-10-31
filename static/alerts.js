(function () {
  const STATUS = { open: "Open", progress: "In progress", closed: "Closed" };
  let people = [];
  let parking = [];
  let followItems = [];
  let followIndex = 0;
  let followClosed = false;
  let loadedFollow = false;
  let wasOut = true;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function signedIn() {
    const root = document.getElementById("dmrRoot");
    return !!(root && root.style.display !== "none" && window.state && window.state.token);
  }

  async function api(url, options) {
    if (!window.apiFetch) return null;
    return window.apiFetch(url, options || {});
  }

  function ensureHosts() {
    if (!document.getElementById("alertMenu")) {
      const menu = document.createElement("div");
      menu.className = "alert-bell-menu";
      menu.id = "alertMenu";
      menu.hidden = true;
      document.body.appendChild(menu);
    }
    if (!document.getElementById("alertDim")) {
      const dim = document.createElement("div");
      dim.className = "alert-dim";
      dim.id = "alertDim";
      dim.hidden = true;
      document.body.appendChild(dim);
    }
    if (!document.getElementById("alertFollow")) {
      const card = document.createElement("section");
      card.className = "alert-follow";
      card.id = "alertFollow";
      card.hidden = true;
      card.setAttribute("aria-label", "Follow-up");
      document.body.appendChild(card);
    }
  }

  function placeMenu() {
    const menu = document.getElementById("alertMenu");
    const bell = document.getElementById("alertBell");
    if (!menu || menu.hidden || !bell) return;
    const box = bell.getBoundingClientRect();
    menu.style.top = (box.bottom + 8) + "px";
    menu.style.left = Math.max(12, box.right - 400) + "px";
  }

  function paintParking() {
    const menu = document.getElementById("alertMenu");
    const badge = document.getElementById("alertBadge");
    if (!menu || !badge) return;
    badge.hidden = parking.length === 0;
    badge.textContent = String(parking.length);
    const rows = parking.map(function (item) {
      const who = [item.guestName, item.room].filter(Boolean).join(" · ");
      const meta = item.kind === "due" || item.kind === "overdue"
        ? "Expected " + (item.details && item.details.dateOut ? item.details.dateOut + " " + (item.details.timeOut || "") : item.createdAt)
        : (item.kind === "checkin" ? "Checked in" : item.kind === "checkout" ? "Checked out" : "Extended") + " by " + item.actorName + " · " + String(item.createdAt || "").replace("T", " ").slice(0, 16);
      return '<article class="alert-bell-row ' + esc(item.kind) + '"><span class="alert-kind"></span><div><h3>' + esc(item.title) + '</h3><p>' + esc(item.floor) + (who ? " · " + esc(who) : "") + '</p><p class="meta">' + esc(meta) + '</p><div class="alert-bell-actions"><button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-alert-details="' + esc(item.id) + '">Details</button><button type="button" class="dmr-btn dmr-btn-primary dmr-btn-sm" data-alert-ok="' + esc(item.id) + '">OK</button></div></div></article>';
    }).join("");
    menu.innerHTML = '<div class="alert-bell-head">Notifications</div>' + (rows || '<p class="alert-bell-empty">No notifications left for you.</p>');
    menu.querySelectorAll("[data-alert-ok]").forEach(function (button) {
      button.addEventListener("click", async function () {
        await api("/api/alerts/parking/" + encodeURIComponent(button.getAttribute("data-alert-ok")) + "/ok", { method: "POST" });
        parking = parking.filter(function (item) { return item.id !== button.getAttribute("data-alert-ok"); });
        paintParking();
      });
    });
    menu.querySelectorAll("[data-alert-details]").forEach(function (button) {
      button.addEventListener("click", function () {
        const item = parking.filter(function (row) { return row.id === button.getAttribute("data-alert-details"); })[0];
        if (item) openDetails(item);
      });
    });
  }

  function openDetails(item) {
    const menu = document.getElementById("alertMenu");
    if (menu) menu.hidden = true;
    const bell = document.getElementById("alertBell");
    if (bell) bell.setAttribute("aria-expanded", "false");
    const old = document.getElementById("alertLog");
    if (old) old.remove();
    const details = item.details || {};
    const rows = [
      ["Parking", item.title.split(" · ").pop()],
      ["Floor", item.floor],
      ["Name", item.guestName],
      ["Room", item.room],
      ["Registration", details.plate],
      ["Car", [details.carModel, details.carColour].filter(Boolean).join(", ")],
      ["Expected check-out", [details.dateOut, details.timeOut].filter(Boolean).join(" ")],
      ["By", item.actorName]
    ].filter(function (row) { return row[1]; });
    const dialog = document.createElement("div");
    dialog.className = "dmr-modal-bg";
    dialog.id = "alertLog";
    dialog.innerHTML = '<div class="dmr-dialog" role="dialog" aria-modal="true" style="max-width:440px"><h3>' + esc(item.title) + '</h3><ul class="alert-time">' + rows.map(function (row) { return "<li><i></i><span>" + esc(row[0]) + ": " + esc(row[1]) + "</span></li>"; }).join("") + '</ul><div class="dmr-dialog-actions"><button type="button" class="dmr-btn dmr-btn-primary" id="alertLogClose">Close</button></div></div>';
    document.body.appendChild(dialog);
    document.getElementById("alertLogClose").addEventListener("click", function () { dialog.remove(); });
    dialog.addEventListener("click", function (event) { if (event.target === dialog) dialog.remove(); });
  }

  function hideFollow() {
    const card = document.getElementById("alertFollow");
    const dim = document.getElementById("alertDim");
    if (card) card.hidden = true;
    if (dim) dim.hidden = true;
  }

  function paintFollow() {
    const card = document.getElementById("alertFollow");
    const dim = document.getElementById("alertDim");
    if (!card || !dim) return;
    const item = followItems[followIndex];
    if (followClosed || !item) {
      hideFollow();
      return;
    }
    card.hidden = false;
    dim.hidden = false;
    card.classList.toggle("has-photo", !!item.photo);
    const many = followItems.length > 1;
    const hasNext = followIndex < followItems.length - 1;
    const navHtml = many
      ? '<div class="alert-nav"><button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" id="alertFollowPrev"' + (followIndex === 0 ? " disabled" : "") + '>Previous</button><button type="button" class="dmr-btn dmr-btn-sm' + (hasNext ? " alert-next-more" : "") + '" id="alertFollowNext"' + (hasNext ? "" : " disabled") + '>Next</button></div>'
      : "";
    const peopleHtml = '<span class="alert-person brass"><small>Assigned by</small>' + esc(item.assignedBy || "—") + "</span>"
      + (item.assignedTo || []).map(function (name) { return '<span class="alert-person blue"><small>Assigned to</small>' + esc(name) + "</span>"; }).join("");
    card.innerHTML = ''
      + '<div class="alert-hero ' + esc(item.cls || "normal") + '"><div class="alert-pills"><span class="alert-pill">' + esc(item.priorityLabel || "Normal") + '</span><span class="alert-pill soft">' + esc(item.department || "") + '</span><span class="alert-pill state">' + esc(STATUS[item.status] || item.status) + '</span></div><button type="button" class="alert-x" id="alertFollowClose" aria-label="Close">×</button></div>'
      + '<p class="alert-step">Action ' + (followIndex + 1) + " of " + followItems.length + "</p>"
      + "<h2>" + esc(item.title) + "</h2>"
      + (item.text && item.text !== item.title ? '<p class="alert-copy">' + esc(item.text) + "</p>" : "")
      + (item.photo ? '<img class="alert-shot" alt="Action item photo" src="' + esc(item.photo) + '">' : '<div class="alert-nophoto">No photo on this item</div>')
      + '<div class="alert-people">' + peopleHtml + "</div>"
      + '<p class="alert-label">Timeline</p><ol class="alert-time" id="alertFollowTime">' + (item.lines || []).map(function (line) { return "<li><i></i><span>" + esc(line) + "</span></li>"; }).join("") + "</ol>"
      + '<div class="alert-comments"><p class="alert-label">Comments</p>' + ((item.comments || []).length ? (item.comments || []).map(function (comment) {
        return '<article class="alert-comment"><b>' + esc(comment.actor || "") + '</b><time>' + esc(comment.at || "") + '</time><p>' + esc(comment.body || "") + "</p></article>";
      }).join("") : '<p class="alert-comment-empty">No comments yet.</p>') + "</div>"
      + '<div class="alert-form"><label>Status<select id="alertFollowStatus"><option value="open"' + (item.status === "open" ? " selected" : "") + '>Open</option><option value="progress"' + (item.status === "progress" ? " selected" : "") + '>In progress</option><option value="closed"' + (item.status === "closed" ? " selected" : "") + '>Closed</option></select></label>'
      + '<label>Comment<textarea id="alertFollowComment" placeholder="I followed up, it is not finished yet"></textarea></label>'
      + '<p class="alert-error" id="alertFollowError" hidden>Change the status or type a comment, then press Save.</p>'
      + '<div class="alert-actions"><button type="button" class="dmr-btn dmr-btn-primary dmr-btn-sm" id="alertFollowSave">Save</button><button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" id="alertFollowReport">Open report</button></div></div>'
      + '<div class="alert-foot">' + navHtml
      + '<label class="alert-snooze">Remind me<select id="alertFollowSnooze"><option value="">Choose a time</option><option value="10">After 10 minutes</option><option value="30">After 30 minutes</option><option value="60">After 1 hour</option><option value="180">After 3 hours</option><option value="360">After 6 hours</option><option value="480">After 8 hours</option></select></label></div>';
    document.getElementById("alertFollowClose").addEventListener("click", function () { followClosed = true; hideFollow(); });
    const prev = document.getElementById("alertFollowPrev");
    const next = document.getElementById("alertFollowNext");
    if (prev) prev.addEventListener("click", function () { followIndex = Math.max(0, followIndex - 1); paintFollow(); });
    if (next) next.addEventListener("click", function () { followIndex = Math.min(followItems.length - 1, followIndex + 1); paintFollow(); });
    document.getElementById("alertFollowReport").addEventListener("click", function () {
      followClosed = true;
      hideFollow();
      if (window.openFollowReport) window.openFollowReport(item);
    });
    document.getElementById("alertFollowComment").addEventListener("input", function () { document.getElementById("alertFollowError").hidden = true; });
    document.getElementById("alertFollowSave").addEventListener("click", async function () {
      const status = document.getElementById("alertFollowStatus").value;
      const input = document.getElementById("alertFollowComment");
      const text = input.value.trim();
      const error = document.getElementById("alertFollowError");
      if (status === item.status && !text) {
        error.hidden = false;
        error.textContent = "Change the status or type a comment, then press Save.";
        return;
      }
      if (status !== item.status) {
        const updated = item.source === "duty"
          ? await api("/api/notes/" + encodeURIComponent(item.id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: status }) })
          : await api("/api/alerts/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: item.source, id: item.id, date: item.date, status: status }) });
        const ok = item.source === "duty" ? updated && updated.success : updated && updated.line;
        if (!ok) {
          error.hidden = false;
          error.textContent = (updated && updated.detail) || "Could not save the status.";
          return;
        }
      }
      if (text) {
        const saved = await api("/api/alerts/comment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: item.source, id: item.id, date: item.date, body: text }) });
        if (!saved || !saved.body) {
          error.hidden = false;
          error.textContent = (saved && saved.detail) || "Could not save the comment.";
          await window.refreshFollowLive();
          return;
        }
      }
      input.value = "";
      await window.refreshFollowLive();
    });
    document.getElementById("alertFollowSnooze").addEventListener("change", async function (event) {
      const minutes = Number(event.target.value);
      if (!minutes) return;
      await api("/api/alerts/snooze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: minutes }) });
      followClosed = true;
      hideFollow();
    });
  }

  window.refreshFollowLive = async function () {
    if (!signedIn() || followClosed) return;
    const current = followItems[followIndex];
    const data = await api("/api/alerts/followups");
    if (followClosed) return;
    const items = data && Array.isArray(data.items) ? data.items : [];
    followItems = items;
    if (!items.length) {
      hideFollow();
      return;
    }
    if (current) {
      const idx = items.findIndex(function (row) {
        return row.id === current.id && row.source === current.source && row.date === current.date;
      });
      followIndex = idx >= 0 ? idx : Math.min(followIndex, items.length - 1);
    }
    const typing = document.activeElement && (document.activeElement.id === "alertFollowComment" || document.activeElement.id === "alertFollowStatus");
    if (!typing) paintFollow();
  };

  window.refreshParkingAlerts = async function () {
    if (!signedIn()) return;
    const data = await api("/api/alerts/parking");
    parking = Array.isArray(data) ? data : [];
    paintParking();
  };

  function chosenIds(box) {
    return box && box.dataset.ids ? box.dataset.ids.split(",").filter(Boolean) : [];
  }

  function paintAssignBox(box) {
    if (!box) return;
    const ids = chosenIds(box);
    box.innerHTML = ids.length ? ids.map(function (id) {
      const name = window.alertName(id) || "Staff";
      return '<span class="assign-chip"><span>' + esc(name) + '</span><button type="button" class="assign-x" data-assign-remove="' + esc(id) + '" aria-label="Remove ' + esc(name) + '">×</button></span>';
    }).join("") : '<span class="assign-empty">None yet</span>';
  }

  function paintAssignMenus() {
    document.querySelectorAll(".assign-menu").forEach(function (menu) {
      const box = document.getElementById(menu.dataset.box);
      const chosen = chosenIds(box);
      const full = chosen.length >= 3;
      menu.innerHTML = people.length ? people.map(function (person) {
        const taken = chosen.indexOf(person.id) >= 0;
        return '<div class="assign-row"><span>' + esc(person.name) + '</span><button type="button" class="assign-plus" data-assign-add="' + esc(person.id) + '"' + (taken || full ? " disabled" : "") + ' aria-label="Assign ' + esc(person.name) + '">+</button></div>';
      }).join("") : '<div class="assign-row"><span>No people yet</span></div>';
    });
  }

  function closeAssignMenus() {
    document.querySelectorAll(".assign-menu").forEach(function (menu) { menu.hidden = true; });
    document.querySelectorAll(".assign-toggle").forEach(function (btn) { btn.setAttribute("aria-expanded", "false"); });
  }

  window.fillAlertAssigns = function () {
    const options = people.map(function (person) { return '<option value="' + esc(person.id) + '">' + esc(person.name) + "</option>"; }).join("");
    document.querySelectorAll("[data-duty-assign], [data-night-assign]").forEach(function (sel) {
      const selected = (sel.dataset.selected || "").split(",").filter(Boolean);
      const current = Array.from(sel.selectedOptions).map(function (option) { return option.value; });
      const keep = current.length ? current : selected;
      sel.innerHTML = options;
      Array.from(sel.options).forEach(function (option) { option.selected = keep.indexOf(option.value) >= 0; });
    });
    paintAssignMenus();
    document.querySelectorAll(".assign-box").forEach(paintAssignBox);
  };

  window.alertName = function (id) {
    const person = people.filter(function (item) { return item.id === id; })[0];
    return person ? person.name : "";
  };

  window.saveFollowStatus = function (item) {
    return api("/api/alerts/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
  };

  document.addEventListener("click", function (event) {
    const bell = document.getElementById("alertBell");
    const menu = document.getElementById("alertMenu");
    if (bell && event.target.closest && event.target.closest("#alertBell")) {
      event.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      bell.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) { placeMenu(); window.refreshParkingAlerts(); }
      return;
    }
    if (menu && !menu.hidden && !menu.contains(event.target)) {
      menu.hidden = true;
      if (bell) bell.setAttribute("aria-expanded", "false");
    }
    const plus = event.target.closest && event.target.closest("[data-assign-add]");
    if (plus && !plus.disabled) {
      event.preventDefault();
      const menu = plus.closest(".assign-menu");
      const box = menu && document.getElementById(menu.dataset.box);
      const ids = chosenIds(box);
      if (box && ids.length < 3 && ids.indexOf(plus.getAttribute("data-assign-add")) < 0) {
        ids.push(plus.getAttribute("data-assign-add"));
        box.dataset.ids = ids.join(",");
        paintAssignBox(box);
        paintAssignMenus();
      }
      return;
    }
    const remove = event.target.closest && event.target.closest("[data-assign-remove]");
    if (remove) {
      event.preventDefault();
      const box = remove.closest(".assign-box");
      const ids = chosenIds(box).filter(function (id) { return id !== remove.getAttribute("data-assign-remove"); });
      if (box) box.dataset.ids = ids.join(",");
      paintAssignBox(box);
      paintAssignMenus();
      return;
    }
    const toggle = event.target.closest && event.target.closest(".assign-toggle");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const menu = document.getElementById(toggle.getAttribute("aria-controls"));
      const willOpen = menu && menu.hidden;
      closeAssignMenus();
      if (willOpen) {
        menu.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        paintAssignMenus();
      }
      return;
    }
    if (!event.target.closest || !event.target.closest(".assign-pick")) closeAssignMenus();
    const add = event.target.closest && event.target.closest("[data-follow-add]");
    if (!add) return;
    const box = add.parentElement && add.parentElement.querySelector("[data-follow-comment]");
    if (!box) return;
    const text = box.value.trim();
    if (!text) return;
    api("/api/alerts/comment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: box.dataset.followSource, id: box.dataset.followComment, date: box.dataset.followDate, body: text }) });
    box.value = "";
  });

  document.addEventListener("change", async function (event) {
    const sel = event.target.closest && event.target.closest("[data-duty-assign]");
    if (!sel || !sel.multiple) return;
    if (sel.selectedOptions.length > 3) Array.from(sel.selectedOptions).slice(3).forEach(function (option) { option.selected = false; });
    if (!sel.dataset.dutyAssign) return;
    const ids = Array.from(sel.selectedOptions).map(function (option) { return option.value; }).slice(0, 3);
    const notes = window.state && window.state.report && window.state.report.notes;
    const note = notes && notes.filter(function (item) { return item.id === sel.dataset.dutyAssign; })[0];
    const saved = await api("/api/notes/" + encodeURIComponent(sel.dataset.dutyAssign), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignees: ids }) });
    if (note && saved && saved.success) note.assignees = ids;
  });

  async function loadFollow() {
    const data = await api("/api/alerts/followups");
    followItems = data && Array.isArray(data.items) ? data.items : [];
    followIndex = 0;
    followClosed = false;
    if (data && data.show) paintFollow();
    else hideFollow();
  }

  setInterval(async function () {
    ensureHosts();
    if (!signedIn()) {
      hideFollow();
      const menu = document.getElementById("alertMenu");
      if (menu) menu.hidden = true;
      wasOut = true;
      loadedFollow = false;
      return;
    }
    if (!people.length) {
      const list = await api("/api/alerts/people");
      people = Array.isArray(list) ? list : [];
      if (window.fillAlertAssigns) window.fillAlertAssigns();
    }
    if (wasOut) {
      wasOut = false;
      await window.refreshParkingAlerts();
      await loadFollow();
    }
  }, 800);
  window.addEventListener("resize", placeMenu);
})();
