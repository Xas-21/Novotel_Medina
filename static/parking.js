(function(){
  const ICON_CALENDAR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
  const ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';

  let spots = [];
  let modal = null;
  let form = { room: '', isVisitor: false, date: '', time: '' };
  let filters = { spot: '', date: '', user: '' };
  let filterTimer = null;
  let loadToken = 0;

  function escapeHtml(s){ return (s == null ? '' : s).toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function role(){ return window.state && window.state.user ? window.state.user.role : ''; }
  function canEdit(){ return !!window.canWrite(role(), 'parking'); }
  function today(){ return window.todayStr(); }
  function tomorrow(){
    const d = new Date(today() + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA');
  }
  function errorText(res){
    if (res && typeof res.detail === 'string') return res.detail;
    return 'Could not save. Please try again.';
  }

  function renderParkingSection(){
    const state = window.state;
    if (!state || state.section !== 'parking') return '';
    modal = null;
    if (state.view === 'logs') {
      queueMicrotask(loadLogs);
      return `
        <div class="dmr-headline"><h1>Activity Logs</h1></div>
        <div class="dmr-sub">Every check-in, check-out, and extension on the parking floors</div>
        <div class="dmr-card parking-filters">
          <div class="dmr-field"><label>Parking Number</label><input id="parkFilterSpot" data-filter="spot" placeholder="e.g. B2-5" value="${escapeHtml(filters.spot)}"></div>
          <div class="dmr-field"><label>Filter by Date</label><input type="date" data-filter="date" value="${escapeHtml(filters.date)}"></div>
          <div class="dmr-field"><label>Filter by User</label><input data-filter="user" placeholder="Name" value="${escapeHtml(filters.user)}"></div>
          <button type="button" class="dmr-btn dmr-btn-ghost" id="parkFilterClear">Clear Filters</button>
        </div>
        <div class="dmr-card parking-logs" id="parkingLogs"><div class="dmr-empty">Loading logs…</div></div>`;
    }
    queueMicrotask(loadSpots);
    return `
      <div class="dmr-headline"><h1>Manage Parkings</h1></div>
      <div class="dmr-sub">Tap a free spot to check a car in. Tap a taken spot to check it out or extend the stay.</div>
      <div class="parking-legend">
        <span><i class="parking-swatch available"></i>Available</span>
        <span><i class="parking-swatch occupied"></i>Occupied</span>
        <span><i class="parking-swatch due-today"></i>Checks out today</span>
        <span><i class="parking-swatch overdue"></i>Overdue (past checkout time)</span>
        <span><i class="parking-swatch handicap"></i>Accessible ♿</span>
        <span><b>S</b> / <b>L</b> Small / Large</span>
      </div>
      <div id="parkingFloors"><div class="dmr-empty"><h3>Loading parking spots…</h3></div></div>
      <div id="parkingModal"></div>`;
  }

  async function loadSpots(){
    const data = await window.apiFetch('/api/parking/spots');
    if (!Array.isArray(data)) return;
    spots = data;
    paintSpots();
  }

  function riyadhNow(){
    return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Riyadh' }).slice(0, 16);
  }
  function isOverdue(spot){
    return spot.status === 'occupied' && !!spot.dateOut && (spot.dateOut + ' ' + (spot.timeOut || '00:00')) <= riyadhNow();
  }
  function spotClass(spot){
    if (spot.status === 'available') return 'available';
    if (isOverdue(spot)) return 'overdue';
    if (spot.dateOut && spot.dateOut === today()) return 'due-today';
    return 'occupied';
  }

  function paintSpots(){
    const el = document.getElementById('parkingFloors');
    if (!el) return;
    const floors = [...new Set(spots.map(s => s.floor))];
    el.innerHTML = floors.map(floor => {
      const list = spots.filter(s => s.floor === floor);
      const free = list.filter(s => s.status === 'available').length;
      const overdue = list.filter(isOverdue).length;
      return `
        <div class="dmr-card dmr-section-card parking-floor">
          <div class="parking-floor-head"><h3>Floor ${escapeHtml(floor)}</h3><span>${free} of ${list.length} free${overdue ? ` · <b class="parking-overdue-count">${overdue} overdue</b>` : ''}</span></div>
          <div class="parking-grid">
            ${list.map(spot => `
              <button type="button" class="parking-spot ${spotClass(spot)}${spot.isHandicap ? ' handicap' : ''}" data-spot="${escapeHtml(spot.id)}" aria-label="Spot ${escapeHtml(spot.id)} ${spot.status === 'available' ? 'available' : 'taken by ' + escapeHtml(spot.room)}${isOverdue(spot) ? ', overdue' : ''}">
                ${isOverdue(spot) ? '<span class="parking-flag">OVERDUE</span>' : ''}
                <span class="parking-size">${escapeHtml(spot.size)}</span>
                <span class="parking-num">${spot.number}</span>
                ${spot.isHandicap ? '<span class="parking-icon">♿</span>' : ''}
                ${spot.status === 'occupied' ? `<span class="parking-room">${escapeHtml(spot.room)}</span>` : ''}
              </button>`).join('')}
          </div>
        </div>`;
    }).join('');
    el.onclick = e => {
      const btn = e.target.closest('[data-spot]');
      if (btn) openSpot(btn.dataset.spot);
    };
  }

  function openSpot(id){
    const spot = spots.find(s => s.id === id);
    if (!spot) return;
    if (spot.status === 'available') {
      if (!canEdit()) return;
      form = { room: '', isVisitor: false, date: tomorrow(), time: '12:00' };
      modal = { spotId: id, type: 'checkin' };
    } else {
      modal = { spotId: id, type: 'checkout' };
    }
    paintModal();
  }

  function dateTimeFields(dateLabel, timeLabel){
    return `
      <div class="dmr-row">
        <div class="dmr-field"><label>${dateLabel}</label><input type="date" data-form="date" value="${escapeHtml(form.date)}"></div>
        <div class="dmr-field"><label>${timeLabel}</label><input type="time" data-form="time" value="${escapeHtml(form.time)}"></div>
      </div>`;
  }

  function paintModal(){
    const host = document.getElementById('parkingModal');
    if (!host) return;
    const spot = modal && spots.find(s => s.id === modal.spotId);
    if (!spot) { host.innerHTML = ''; return; }
    const id = escapeHtml(spot.id);
    let body = '';
    if (modal.type === 'checkin') {
      body = `
        <h3>Check In - Spot ${id}</h3>
        <label class="parking-check"><input type="checkbox" data-form="isVisitor" ${form.isVisitor ? 'checked' : ''}> Visitor (No Room #)</label>
        ${form.isVisitor ? '' : `<div class="dmr-field"><label>Room Number</label><input data-form="room" inputmode="numeric" placeholder="e.g. 101" value="${escapeHtml(form.room)}"></div>`}
        ${dateTimeFields('Checkout Date', 'Time')}
        <div class="night-note" id="parkErr"></div>
        <div class="dmr-dialog-actions">
          <button type="button" class="dmr-btn dmr-btn-ghost" data-park="close">Cancel</button>
          <button type="button" class="dmr-btn dmr-btn-primary" data-park="checkin">Confirm</button>
        </div>`;
    } else if (modal.type === 'checkout') {
      body = `
        <h3>Check Out - Spot ${id}</h3>
        <div class="parking-guest">${spot.isVisitor ? 'VISITOR' : 'Room ' + escapeHtml(spot.room)}</div>
        <div class="parking-info">
          <strong>Expected Check-out:</strong>
          <span>${ICON_CALENDAR} ${escapeHtml(spot.dateOut)} &nbsp; ${ICON_CLOCK} ${escapeHtml(spot.timeOut)}</span>
          ${isOverdue(spot) ? '<span class="parking-overdue-note">Overdue — the expected check-out time has passed.</span>' : ''}
        </div>
        <div class="night-note" id="parkErr"></div>
        <div class="dmr-dialog-actions">
          <button type="button" class="dmr-btn dmr-btn-ghost" data-park="close">Cancel</button>
          ${canEdit() ? `
          <button type="button" class="dmr-btn parking-btn-warn" data-park="extend-open">Extend</button>
          <button type="button" class="dmr-btn parking-btn-danger" data-park="checkout">Check-Out</button>` : ''}
        </div>`;
    } else if (modal.type === 'extend') {
      body = `
        <h3>Extend Stay - ${id}</h3>
        ${dateTimeFields('New Date', 'New Time')}
        <div class="night-note" id="parkErr"></div>
        <div class="dmr-dialog-actions">
          <button type="button" class="dmr-btn dmr-btn-ghost" data-park="back">Back</button>
          <button type="button" class="dmr-btn parking-btn-warn" data-park="extend">Confirm</button>
        </div>`;
    }
    host.innerHTML = `<div class="parking-modal-bg" data-park="close"><div class="dmr-dialog parking-dialog" role="dialog" aria-modal="true">${body}</div></div>`;
    host.onclick = onModalClick;
    host.oninput = host.onchange = onModalInput;
  }

  function onModalInput(e){
    const key = e.target.dataset && e.target.dataset.form;
    if (!key) return;
    if (key === 'isVisitor') {
      form.isVisitor = e.target.checked;
      paintModal();
      return;
    }
    form[key] = e.target.value;
  }

  function closeModal(){
    modal = null;
    paintModal();
  }

  async function onModalClick(e){
    const btn = e.target.closest('[data-park]');
    if (!btn || (btn.classList.contains('parking-modal-bg') && e.target !== btn)) return;
    const action = btn.dataset.park;
    const spot = modal && spots.find(s => s.id === modal.spotId);
    if (!spot) return;
    if (action === 'close') { closeModal(); return; }
    if (action === 'back') { modal = { spotId: spot.id, type: 'checkout' }; paintModal(); return; }
    if (action === 'extend-open') {
      form = { room: '', isVisitor: false, date: spot.dateOut, time: spot.timeOut };
      modal = { spotId: spot.id, type: 'extend' };
      paintModal();
      return;
    }
    const err = document.getElementById('parkErr');
    if (action === 'checkin') {
      if (!form.isVisitor && !form.room.trim()) { err.textContent = 'Room Number required'; return; }
      if (!form.date || !form.time) { err.textContent = 'Date and Time required'; return; }
    }
    if (action === 'extend' && (!form.date || !form.time)) { err.textContent = 'Date and Time required'; return; }
    const url = '/api/parking/spots/' + encodeURIComponent(spot.id) + '/' + action;
    const body = action === 'checkin' ? form : (action === 'extend' ? { date: form.date, time: form.time } : null);
    btn.disabled = true;
    const res = await window.apiFetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' });
    btn.disabled = false;
    if (!res || !res.id) {
      if (err) err.textContent = errorText(res);
      loadSpots();
      return;
    }
    applySpot(res);
    closeModal();
  }

  function applySpot(fresh){
    const i = spots.findIndex(s => s.id === fresh.id);
    if (i >= 0) spots[i] = fresh;
    paintSpots();
  }

  async function loadLogs(){
    bindFilters();
    const token = ++loadToken;
    const query = new URLSearchParams();
    Object.keys(filters).forEach(key => { if (filters[key].trim()) query.set(key, filters[key].trim()); });
    const data = await window.apiFetch('/api/parking/logs?' + query.toString());
    if (token !== loadToken) return;
    paintLogs(data);
  }

  function paintLogs(data){
    const el = document.getElementById('parkingLogs');
    if (!el) return;
    const items = data && Array.isArray(data.items) ? data.items : [];
    const rows = items.length ? items.map(log => `
      <tr>
        <td>${escapeHtml(log.date)} ${escapeHtml(log.time)}</td>
        <td><strong>${escapeHtml(log.actor)}</strong></td>
        <td>${escapeHtml(log.spotId)}</td>
        <td>${escapeHtml(log.action)}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="parking-none">No logs found.</td></tr>';
    el.innerHTML = `
      <div class="parking-table-wrap">
        <table class="parking-table">
          <thead><tr><th>Date &amp; Time</th><th>User</th><th>Parking Spot</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${data && data.more ? `<div class="dmr-sub parking-more">Showing the latest ${items.length} entries. Use the filters to find older ones.</div>` : ''}`;
  }

  function bindFilters(){
    document.querySelectorAll('[data-filter]').forEach(input => {
      input.oninput = input.onchange = () => {
        filters[input.dataset.filter] = input.value;
        if (filterTimer) clearTimeout(filterTimer);
        filterTimer = setTimeout(loadLogs, 250);
      };
    });
    const clear = document.getElementById('parkFilterClear');
    if (clear) clear.onclick = () => {
      filters = { spot: '', date: '', user: '' };
      document.querySelectorAll('[data-filter]').forEach(input => { input.value = ''; });
      loadLogs();
    };
  }

  function onParkingUpdate(msg){
    const state = window.state;
    if (!state || state.section !== 'parking' || !msg.spot) return;
    if (state.view === 'logs') {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(loadLogs, 250);
      return;
    }
    applySpot(msg.spot);
  }

  setInterval(() => {
    const state = window.state;
    if (state && state.section === 'parking' && state.view !== 'logs') paintSpots();
  }, 60000);

  window.renderParkingSection = renderParkingSection;
  window.onParkingUpdate = onParkingUpdate;
})();
