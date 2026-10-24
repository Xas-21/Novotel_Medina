(function(){
  const ICON_CALENDAR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
  const ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';

  const COLOURS = ['Black', 'Silver', 'White', 'Green', 'Red', 'Other'];
  const COLOUR_CSS = { Black: '#1f1f1f', Silver: '#c0c4c8', White: '#ffffff', Green: '#2e7d4c', Red: '#c62828', Other: 'conic-gradient(#e53935, #fdd835, #43a047, #1e88e5, #8e24aa, #e53935)' };

  let spots = [];
  let logItems = [];
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
      queueMicrotask(loadUserFilter);
      return `
        <div class="dmr-headline"><h1>Activity Logs</h1></div>
        <div class="dmr-sub">Every check-in, check-out, extension, and out-of-service change on the parking floors. Click an entry to see all its details.</div>
        <div class="dmr-card parking-filters">
          <div class="dmr-field"><label>Parking Number</label><input id="parkFilterSpot" data-filter="spot" placeholder="e.g. B2-5" value="${escapeHtml(filters.spot)}"></div>
          <div class="dmr-field"><label>Filter by Date</label><input type="date" data-filter="date" value="${escapeHtml(filters.date)}"></div>
          <div class="dmr-field"><label>Filter by User</label><select data-filter="user" id="parkFilterUser">${userOptions([])}</select></div>
          <button type="button" class="dmr-btn dmr-btn-ghost" id="parkFilterClear">Clear Filters</button>
        </div>
        <div class="dmr-card parking-logs" id="parkingLogs"><div class="dmr-empty">Loading logs…</div></div>
        <div id="parkingModal"></div>`;
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
        <span><i class="parking-swatch out-of-service"></i>Out of service</span>
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
  function isAdmin(){ return role() === 'admin'; }
  function outOfService(spot){
    return spot.status === 'available' && !!spot.oosFrom && spot.oosFrom <= today() && today() <= spot.oosTo;
  }
  function oosScheduled(spot){
    return !!spot.oosFrom && spot.oosFrom > today();
  }
  function shortDate(value){ return value ? value.slice(8, 10) + '/' + value.slice(5, 7) : ''; }
  function spotClass(spot){
    if (spot.status === 'available') return outOfService(spot) ? 'out-of-service' : 'available';
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
      const free = list.filter(s => s.status === 'available' && !outOfService(s)).length;
      const overdue = list.filter(isOverdue).length;
      return `
        <div class="dmr-card dmr-section-card parking-floor">
          <div class="parking-floor-head"><h3>Floor ${escapeHtml(floor)}</h3><span>${free} of ${list.length} free${overdue ? ` · <b class="parking-overdue-count">${overdue} overdue</b>` : ''}</span></div>
          <div class="parking-grid">
            ${list.map(spot => `
              <button type="button" class="parking-spot ${spotClass(spot)}${spot.isHandicap ? ' handicap' : ''}" data-spot="${escapeHtml(spot.id)}" aria-label="Spot ${escapeHtml(spot.id)} ${outOfService(spot) ? 'out of service from ' + escapeHtml(spot.oosFrom) + ' to ' + escapeHtml(spot.oosTo) : (spot.status === 'available' ? 'available' : 'taken by ' + escapeHtml(spot.room))}${isOverdue(spot) ? ', overdue' : ''}">
                ${isOverdue(spot) ? '<span class="parking-flag">OVERDUE</span>' : ''}
                <span class="parking-size">${escapeHtml(spot.size)}</span>
                <span class="parking-num">${spot.number}</span>
                ${spot.isHandicap ? '<span class="parking-icon">♿</span>' : ''}
                ${spot.status === 'occupied' ? `<span class="parking-room">${escapeHtml(spot.room)}</span>` : ''}
                ${outOfService(spot) ? `<span class="parking-oos">OUT OF SERVICE</span><span class="parking-oos">${shortDate(spot.oosFrom)}–${shortDate(spot.oosTo)}</span>` : ''}
              </button>`).join('')}
          </div>
        </div>`;
    }).join('');
    el.onclick = e => {
      const btn = e.target.closest('[data-spot]');
      if (btn) openSpot(btn.dataset.spot);
    };
  }

  function blankForm(){
    return {
      room: '', isVisitor: false, date: tomorrow(), time: '12:00',
      guestName: '', plate: '', carModel: '', colour: '', colourOther: '',
      oosFrom: today(), oosTo: tomorrow()
    };
  }

  function openSpot(id){
    const spot = spots.find(s => s.id === id);
    if (!spot) return;
    if (outOfService(spot)) {
      modal = { spotId: id, type: 'oos-view' };
    } else if (spot.status === 'available') {
      if (!canEdit()) return;
      form = blankForm();
      modal = { spotId: id, type: 'checkin' };
    } else {
      modal = { spotId: id, type: 'checkout' };
    }
    paintModal();
  }

  function textField(label, key, placeholder){
    return `<div class="dmr-field"><label>${label}</label><input data-form="${key}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(form[key])}"></div>`;
  }

  function colourField(){
    return `
      <div class="dmr-field">
        <label>Colour of the Car</label>
        <div class="parking-colours" role="radiogroup" aria-label="Colour of the car">
          ${COLOURS.map(c => `<label class="parking-colour"><input type="radio" name="parkColour" data-form="colour" value="${c}" ${form.colour === c ? 'checked' : ''}><i class="parking-dot" style="background:${COLOUR_CSS[c]}"></i>${c}</label>`).join('')}
        </div>
        ${form.colour === 'Other' ? `<input data-form="colourOther" placeholder="Type the colour" value="${escapeHtml(form.colourOther)}" style="margin-top:8px">` : ''}
      </div>`;
  }

  function carRows(car){
    return [
      ['Guest Name', car.guestName],
      ['Registration No.', car.plate],
      ['Car Model', car.carModel],
      ['Colour', car.carColour]
    ].filter(row => row[1]).map(row => `<div class="parking-detail"><span>${row[0]}</span><b>${escapeHtml(row[1])}</b></div>`).join('');
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
        ${oosScheduled(spot) ? `<div class="parking-info">Scheduled <strong>out of service</strong> from ${escapeHtml(spot.oosFrom)} to ${escapeHtml(spot.oosTo)}.</div>` : ''}
        <label class="parking-check"><input type="checkbox" data-form="isVisitor" ${form.isVisitor ? 'checked' : ''}> Visitor (No Room #)</label>
        ${form.isVisitor ? '' : `<div class="dmr-field"><label>Room Number</label><input data-form="room" inputmode="numeric" placeholder="e.g. 101" value="${escapeHtml(form.room)}"></div>`}
        ${textField('Guest Name', 'guestName', 'e.g. Omar Saleh')}
        <div class="dmr-row">
          ${textField('Registration No.', 'plate', 'e.g. ABC 1234')}
          ${textField('Car Model', 'carModel', 'e.g. Toyota Camry')}
        </div>
        ${colourField()}
        ${dateTimeFields('Checkout Date', 'Time')}
        <div class="night-note" id="parkErr"></div>
        <div class="dmr-dialog-actions">
          ${isAdmin() ? (oosScheduled(spot)
            ? '<button type="button" class="dmr-btn parking-btn-grey parking-btn-left" data-park="back-in-service">Cancel out of service</button>'
            : '<button type="button" class="dmr-btn parking-btn-grey parking-btn-left" data-park="oos-open">Out of service</button>') : ''}
          <button type="button" class="dmr-btn dmr-btn-ghost" data-park="close">Cancel</button>
          <button type="button" class="dmr-btn dmr-btn-primary" data-park="checkin">Confirm</button>
        </div>`;
    } else if (modal.type === 'oos') {
      body = `
        <h3>Out of Service - Spot ${id}</h3>
        <p>The spot turns grey and cannot be checked in between these dates. It comes back into service by itself after the To date.</p>
        <div class="dmr-row">
          <div class="dmr-field"><label>From</label><input type="date" data-form="oosFrom" value="${escapeHtml(form.oosFrom)}"></div>
          <div class="dmr-field"><label>To</label><input type="date" data-form="oosTo" value="${escapeHtml(form.oosTo)}"></div>
        </div>
        <div class="night-note" id="parkErr"></div>
        <div class="dmr-dialog-actions">
          <button type="button" class="dmr-btn dmr-btn-ghost" data-park="oos-back">Back</button>
          <button type="button" class="dmr-btn parking-btn-grey" data-park="out-of-service">Confirm</button>
        </div>`;
    } else if (modal.type === 'oos-view') {
      body = `
        <h3>Spot ${id}</h3>
        <div class="parking-guest">OUT OF SERVICE</div>
        <div class="parking-info parking-info-grey">
          <strong>Out of service:</strong>
          <span>${ICON_CALENDAR} ${escapeHtml(spot.oosFrom)} &nbsp;to&nbsp; ${ICON_CALENDAR} ${escapeHtml(spot.oosTo)}</span>
        </div>
        <div class="night-note" id="parkErr"></div>
        <div class="dmr-dialog-actions">
          <button type="button" class="dmr-btn dmr-btn-ghost" data-park="close">Close</button>
          ${isAdmin() ? '<button type="button" class="dmr-btn dmr-btn-primary" data-park="back-in-service">Back in service</button>' : ''}
        </div>`;
    } else if (modal.type === 'checkout') {
      body = `
        <h3>Check Out - Spot ${id}</h3>
        <div class="parking-guest">${spot.isVisitor ? 'VISITOR' : 'Room ' + escapeHtml(spot.room)}</div>
        ${carRows(spot) ? `<div class="parking-details">${carRows(spot)}</div>` : ''}
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
    const before = form[key];
    form[key] = e.target.value;
    if (key === 'colour' && before !== form.colour) paintModal();
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
    if (action === 'oos-open') { modal = { spotId: spot.id, type: 'oos' }; paintModal(); return; }
    if (action === 'oos-back') { modal = { spotId: spot.id, type: 'checkin' }; paintModal(); return; }
    if (action === 'extend-open') {
      form = Object.assign(blankForm(), { date: spot.dateOut, time: spot.timeOut });
      modal = { spotId: spot.id, type: 'extend' };
      paintModal();
      return;
    }
    const err = document.getElementById('parkErr');
    if (action === 'checkin') {
      if (!form.isVisitor && !form.room.trim()) { err.textContent = 'Room Number required'; return; }
      if (form.colour === 'Other' && !form.colourOther.trim()) { err.textContent = 'Type the colour of the car'; return; }
      if (!form.date || !form.time) { err.textContent = 'Date and Time required'; return; }
    }
    if (action === 'extend' && (!form.date || !form.time)) { err.textContent = 'Date and Time required'; return; }
    if (action === 'out-of-service') {
      if (!form.oosFrom || !form.oosTo) { err.textContent = 'From and To dates required'; return; }
      if (form.oosFrom > form.oosTo) { err.textContent = 'The To date must be on or after the From date'; return; }
    }
    const url = '/api/parking/spots/' + encodeURIComponent(spot.id) + '/' + action;
    let body = null;
    if (action === 'checkin') {
      body = {
        room: form.room, isVisitor: form.isVisitor, date: form.date, time: form.time,
        guestName: form.guestName, plate: form.plate, carModel: form.carModel,
        carColour: form.colour === 'Other' ? form.colourOther.trim() : form.colour
      };
    } else if (action === 'extend') {
      body = { date: form.date, time: form.time };
    } else if (action === 'out-of-service') {
      body = { dateFrom: form.oosFrom, dateTo: form.oosTo };
    }
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

  function userOptions(names){
    const list = filters.user && names.indexOf(filters.user) < 0 ? names.concat(filters.user) : names;
    return '<option value="">All users</option>' + list.map(name => `<option value="${escapeHtml(name)}"${name === filters.user ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
  }

  async function loadUserFilter(){
    const names = await window.apiFetch('/api/parking/users');
    const select = document.getElementById('parkFilterUser');
    if (select && Array.isArray(names)) select.innerHTML = userOptions(names);
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
    logItems = items;
    const rows = items.length ? items.map(log => `
      <tr class="parking-log-row" data-log="${escapeHtml(log.id)}" tabindex="0" title="Show details">
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
    const openRow = e => {
      const row = e.target.closest('[data-log]');
      if (row) showLog(row.dataset.log);
    };
    el.onclick = openRow;
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(e); } };
  }

  function showLog(id){
    const host = document.getElementById('parkingModal');
    const log = logItems.find(item => item.id === id);
    if (!host || !log) return;
    const d = log.details || {};
    const rows = [
      ['Date & Time', log.date + ' ' + log.time],
      ['User', log.actor],
      ['Parking Spot', log.spotId],
      ['Room Number', d.isVisitor ? 'VISITOR' : d.room],
      ['Guest Name', d.guestName],
      ['Registration No.', d.plate],
      ['Car Model', d.carModel],
      ['Colour', d.carColour],
      ['Expected Check-out', [d.dateOut, d.timeOut].filter(Boolean).join(' ')],
      ['Out of Service', d.oosFrom ? d.oosFrom + ' to ' + d.oosTo : '']
    ].filter(row => row[1]);
    host.innerHTML = `
      <div class="parking-modal-bg" data-log-close>
        <div class="dmr-dialog parking-dialog" role="dialog" aria-modal="true" aria-labelledby="parkLogTitle">
          <h3 id="parkLogTitle">${escapeHtml(log.action)}</h3>
          <div class="parking-details">${rows.map(row => `<div class="parking-detail"><span>${row[0]}</span><b>${escapeHtml(row[1])}</b></div>`).join('')}</div>
          <div class="dmr-dialog-actions"><button type="button" class="dmr-btn dmr-btn-primary" data-log-close id="parkLogClose">Close</button></div>
        </div>
      </div>`;
    const close = () => { host.innerHTML = ''; };
    host.onclick = e => { if (e.target.hasAttribute && e.target.hasAttribute('data-log-close')) close(); };
    host.onkeydown = e => { if (e.key === 'Escape') close(); };
    document.getElementById('parkLogClose').focus();
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
