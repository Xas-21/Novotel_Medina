(function(){
  const FC = ['totalOcc', 'arrRooms', 'depRooms', 'occPct', 'compRooms', 'averageRate'];
  const FC_LABELS = ['Total occ', 'Arr rooms', 'Dep rooms', 'Occ %', 'Comp rooms', 'Average rate'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  let draft = null;
  let loadToken = 0;
  let saveTimer = null;
  let flight = null;
  let pending = false;

  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function halfUp(value){
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const sign = n < 0 ? -1 : 1;
    return sign * Math.floor(Math.abs(n) + 0.5);
  }

  function formatMoney(value){
    if (value == null || value === '') return '';
    const rounded = halfUp(value);
    if (rounded == null) return '';
    return rounded.toLocaleString('en-US');
  }

  function formatPercent(ratio){
    if (ratio == null || ratio === '') return '';
    const rounded = halfUp(Number(ratio) * 100);
    if (rounded == null) return '';
    return rounded.toLocaleString('en-US') + '%';
  }

  function formatCount(value){
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-US', {maximumFractionDigits: 2});
  }

  function num(value){
    const n = parseFloat(String(value == null ? '' : value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  function asText(value){
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : '';
  }

  function dayNumber(iso){
    const n = parseInt(String(iso || '').split('-')[2], 10);
    return Number.isFinite(n) ? String(n) : '';
  }

  function shortDay(iso){
    const dt = new Date(iso + 'T00:00:00');
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.getDate() + ' ' + MONTHS[dt.getMonth()];
  }

  function weekday(iso){
    const dt = new Date(iso + 'T00:00:00');
    if (Number.isNaN(dt.getTime())) return '';
    return WEEKDAYS[dt.getDay()];
  }

  function fmtDate(iso){
    const dt = new Date(iso + 'T00:00:00');
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  }

  function missingLine(dates){
    if (!dates || !dates.length) return '';
    return 'Missing night reports: ' + dates.map(shortDay).join(', ');
  }

  function nightWritable(){
    const user = window.state && window.state.user;
    return !!(user && window.canWrite(user.role, 'night'));
  }

  function editingLocked(){
    if (!nightWritable()) return true;
    const user = window.state && window.state.user;
    if (draft && draft.status === 'submitted' && (!user || user.role !== 'admin')) return true;
    return false;
  }

  function toDraft(data){
    const blank = !data.status;
    const textNum = (v) => blank ? '' : asText(v);
    const comments = data.comments || [];
    return {
      date: data.date,
      status: data.status || null,
      submittedBy: data.submittedBy || '',
      roomsOccupied: textNum(data.roomsOccupied),
      roomsAvailable: Number(data.roomsAvailable) || 0,
      roomsRevenue: textNum(data.roomsRevenue),
      fbRevenue: textNum(data.fbRevenue),
      meRevenue: textNum(data.meRevenue),
      oodRevenue: textNum(data.oodRevenue),
      otherRevenue: textNum(data.otherRevenue),
      segments: (data.segments || []).map(s => ({code: s.code, rooms: textNum(s.rooms), adr: textNum(s.adr)})),
      forecast: (data.forecast || []).map(day => {
        const row = {date: day.date};
        FC.forEach(key => { row[key] = day[key] == null ? '' : String(day[key]); });
        return row;
      }),
      groups: (data.groups || []).map(g => ({
        day: g.day || '', name: g.name || '',
        rooms: g.rooms == null || g.rooms === '' ? '' : asText(g.rooms),
        arrival: g.arrival || '', departure: g.departure || ''
      })),
      vip: (data.vip || []).map(v => ({
        date: v.date || '',
        gold: v.gold == null || v.gold === '' ? '' : asText(v.gold),
        platinum: v.platinum == null || v.platinum === '' ? '' : asText(v.platinum),
        diamond: v.diamond == null || v.diamond === '' ? '' : asText(v.diamond),
        stay: v.stay === 'arrival' ? 'arrival' : 'in house'
      })),
      checklist: (data.checklist || []).map(item => ({area: item.area, remark: item.remark || ''})),
      comments: [0, 1, 2, 3].map(i => comments[i] || ''),
      inspection: window.normalizeNightInspection ? window.normalizeNightInspection(data.inspection) : (data.inspection || {}),
      shiftStart: data.shiftStart || '',
      shiftEnd: data.shiftEnd || '',
      arrivals: data.arrivals || '',
      departures: data.departures || '',
      inHouse: data.inHouse || '',
      allMembers: data.allMembers || '',
      overviewOccupancy: data.overviewOccupancy || '',
      calculated: data.calculated || {},
      segmentGap: data.segmentGap || {segmentRooms: 0, unassigned: 0},
      mtd: data.mtd || {},
      missingDates: data.missingDates || []
    };
  }

  function renderNightSection(){
    const state = window.state;
    if (!state) return '<h1>Night Manager</h1>';
    if (state.section === 'full') {
      queueMicrotask(loadFullReport);
      return `
        <div class="dmr-headline"><h1>Dashboard</h1></div>
        ${window.periodBar ? window.periodBar() : ''}
        <div id="fullBody"><div class="dmr-empty"><h3>Loading full report…</h3></div></div>`;
    }
    if (state.section !== 'night') return '<h1>Night Manager</h1>';
    if (state.view === 'archive') {
      queueMicrotask(loadNightArchive);
      return `
        <div class="dmr-headline"><h1>Night Archive</h1></div>
        <div class="dmr-sub">Night manager reports by month</div>
        <input type="date" id="archiveSearch" class="dmr-btn dmr-btn-ghost" style="padding:7px 12px;margin-bottom:12px;">
        <div id="archiveList"><div class="dmr-card"><div class="dmr-empty">Loading archive…</div></div></div>`;
    }
    if (state.view === 'analysis') {
      queueMicrotask(loadNightAnalysis);
      return `
        <div class="dmr-headline"><h1>Night Analysis</h1></div>
        <div class="dmr-sub">Pick a day, a week, a month, the year to date, or any from and to dates</div>
        ${window.periodBar ? window.periodBar() : ''}
        <div id="nightAnalysisBody"><div class="dmr-empty"><h3>Loading night analysis…</h3></div></div>`;
    }
    if (state.view !== 'today') return '<h1>Night Manager</h1>';
    const date = state.selectedDate;
    const token = ++loadToken;
    queueMicrotask(() => {
      hookDate();
      loadNight(date, token);
    });
    return `
      <div class="dmr-headline">
        <h1>Night Manager Report</h1>
        <input type="date" id="dateInput" class="dmr-btn-ghost dmr-btn" style="padding:7px 12px;" value="${escapeHtml(date)}">
      </div>
      <div class="dmr-sub">${escapeHtml(fmtDate(date))}</div>
      <div id="nightBody"><div class="dmr-empty"><h3>Loading night report…</h3></div></div>`;
  }

  function hookDate(){
    const input = document.getElementById('dateInput');
    if (!input || input._nightHook) return;
    input._nightHook = true;
    const prev = input.onchange;
    input.onchange = async (e) => {
      if (saveTimer || pending || flight) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        pending = true;
        await saveNow();
      }
      if (typeof prev === 'function') prev.call(input, e);
    };
  }

  async function loadNight(date, token){
    const data = await window.apiFetch('/api/night?date=' + encodeURIComponent(date));
    if (token !== loadToken) return;
    const state = window.state;
    if (!state || state.section !== 'night' || state.view !== 'today' || state.selectedDate !== date) return;
    const body = document.getElementById('nightBody');
    if (!body) return;
    if (!data || !data.date) {
      body.innerHTML = '<div class="dmr-empty"><h3>Could not load the night report.</h3></div>';
      return;
    }
    draft = toDraft(data);
    paint();
    bindNight();
  }

  function forecastOcc(totalOcc){
    const rooms = Number(draft && draft.roomsAvailable);
    const raw = String(totalOcc == null ? '' : totalOcc).replace(/,/g, '').trim();
    if (!rooms || raw === '') return '';
    const occupied = Number(raw);
    if (!Number.isFinite(occupied)) return '';
    const rounded = halfUp(occupied / rooms * 100);
    return rounded == null ? '' : String(rounded);
  }

  function paint(){
    const body = document.getElementById('nightBody');
    if (!body || !draft) return;
    if (!nightWritable() && !draft.status) {
      body.innerHTML = '<div class="dmr-empty"><h3>No night report for this date</h3></div>';
      return;
    }
    body.innerHTML = formHtml(draft);
  }

  function formHtml(d){
    const dis = editingLocked() ? 'disabled' : '';
    const c = d.calculated || {};
    const m = d.mtd || {};
    const gap = d.segmentGap || {};
    const missing = missingLine(d.missingDates);
    const badge = d.status === 'submitted'
      ? '<span id="nightStatus" class="dmr-badge dmr-badge-submitted">Submitted</span>'
      : (d.status === 'draft'
        ? '<span id="nightStatus" class="dmr-badge dmr-badge-draft">Draft</span>'
        : '<span id="nightStatus" class="dmr-badge dmr-badge-draft" hidden>Draft</span>');
    const rows = [
      ['Day', calc('day', dayNumber(d.date)), ''],
      ['Rooms occupied', field('roomsOccupied', d.roomsOccupied, dis), calc('mtd-roomsOccupied', formatCount(m.roomsOccupied))],
      ['Occupancy', calc('occupancy', formatPercent(c.occupancy)), calc('mtd-occupancy', formatPercent(m.occupancy))],
      ['Rooms revenue', field('roomsRevenue', d.roomsRevenue, dis), calc('mtd-roomsRevenue', formatMoney(m.roomsRevenue))],
      ['ADR', calc('adr', formatMoney(c.adr)), calc('mtd-adr', formatMoney(m.adr))],
      ['RevPAR', calc('revpar', formatMoney(c.revpar)), calc('mtd-revpar', formatMoney(m.revpar))],
      ['F&amp;B', field('fbRevenue', d.fbRevenue, dis), calc('mtd-fbRevenue', formatMoney(m.fbRevenue))],
      ['M&amp;E', field('meRevenue', d.meRevenue, dis), calc('mtd-meRevenue', formatMoney(m.meRevenue))],
      ['OOD', field('oodRevenue', d.oodRevenue, dis), calc('mtd-oodRevenue', formatMoney(m.oodRevenue))],
      ['Other', field('otherRevenue', d.otherRevenue, dis), calc('mtd-otherRevenue', formatMoney(m.otherRevenue))],
      ['Grand total', calc('grand', formatMoney(c.grandTotal)), calc('mtd-grand', formatMoney(m.grandTotal))]
    ];
    return `
      <div id="nightForm" data-date="${escapeHtml(d.date)}">
        <div class="dmr-card dmr-section-card">
          <h3>Shift &amp; Operations Overview</h3>
          <div class="dmr-row">
            <div class="dmr-field"><label>Shift Start</label><input type="time" data-field="shiftStart" value="${escapeHtml(d.shiftStart)}" ${dis}></div>
            <div class="dmr-field"><label>Shift End</label><input type="time" data-field="shiftEnd" value="${escapeHtml(d.shiftEnd)}" ${dis}></div>
            <div class="dmr-field"><label>Arrivals</label><input type="text" inputmode="numeric" data-field="arrivals" value="${escapeHtml(d.arrivals)}" ${dis}></div>
            <div class="dmr-field"><label>Departures</label><input type="text" inputmode="numeric" data-field="departures" value="${escapeHtml(d.departures)}" ${dis}></div>
            <div class="dmr-field"><label>ALL Loyalty Members</label><input type="text" inputmode="numeric" data-field="allMembers" value="${escapeHtml(d.allMembers)}" ${dis}></div>
          </div>
        </div>
        <div class="dmr-card dmr-section-card">
          <div class="night-card-head"><h3>General information</h3>${badge}</div>
          <table class="night-figures">
            <thead>
              <tr>
                <th></th>
                <th>Last night</th>
                <th>
                  <div id="nightMissing" class="night-missing"${missing ? '' : ' hidden'}>${escapeHtml(missing)}</div>
                  MTD
                </th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(row => `<tr><th>${row[0]}</th><td>${row[1]}</td><td class="num">${row[2]}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>Segments</h3>
          <table class="night-figures night-segments">
              <thead><tr><th>Code</th><th>Rooms</th></tr></thead>
              <tbody>
                ${d.segments.map((seg, i) => `
                  <tr>
                    <th>${escapeHtml(seg.code)}</th>
                    <td><input data-seg-rooms="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(seg.rooms)}" ${dis}></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          <p class="night-unassigned">Unassigned rooms <strong class="night-calc" data-calc="unassigned">${escapeHtml(formatCount(gap.unassigned))}</strong></p>
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>Groups</h3>
          ${d.groups.map((g, i) => `
            <div class="night-record" data-group="${i}">
              ${labeled('Day', `<input type="date" data-g="day" value="${escapeHtml(g.day)}" ${dis}>`)}
              ${labeled('Name', `<input data-g="name" value="${escapeHtml(g.name)}" ${dis}>`)}
              ${labeled('Rooms', `<input data-g="rooms" inputmode="decimal" value="${escapeHtml(g.rooms)}" ${dis}>`)}
              ${labeled('Arrival', `<input type="date" data-g="arrival" value="${escapeHtml(g.arrival)}" ${dis}>`)}
              ${labeled('Departure', `<input type="date" data-g="departure" value="${escapeHtml(g.departure)}" ${dis}>`)}
              <button type="button" class="dmr-dyn-del" data-night-del="group" ${dis}>✕</button>
            </div>`).join('')}
          <button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-night-add="group" ${dis}>+ Add group</button>
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>VIP</h3>
          ${d.vip.map((v, i) => `
            <div class="night-vip" data-vip="${i}">
              ${labeled('Date', `<input type="date" data-v="date" value="${escapeHtml(v.date)}" ${dis}>`)}
              ${labeled('Gold', `<input data-v="gold" inputmode="decimal" value="${escapeHtml(v.gold)}" ${dis}>`)}
              ${labeled('Platinum', `<input data-v="platinum" inputmode="decimal" value="${escapeHtml(v.platinum)}" ${dis}>`)}
              ${labeled('Diamond', `<input data-v="diamond" inputmode="decimal" value="${escapeHtml(v.diamond)}" ${dis}>`)}
              ${labeled('Stay', `<select data-v="stay" ${dis}>
                <option value="in house"${v.stay === 'in house' ? ' selected' : ''}>in house</option>
                <option value="arrival"${v.stay === 'arrival' ? ' selected' : ''}>arrival</option>
              </select>`)}
              <button type="button" class="dmr-dyn-del" data-night-del="vip" ${dis}>✕</button>
            </div>`).join('')}
          <button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-night-add="vip" ${dis}>+ Add VIP</button>
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>Forecast</h3>
          <div class="night-scroll">
            <table class="night-forecast">
              <thead>
                <tr>
                  <th>Date</th>
                  ${FC_LABELS.map(label => `<th>${label}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${d.forecast.map((day, i) => `
                  <tr>
                    <td class="night-date">${escapeHtml(weekday(day.date))} ${escapeHtml(day.date)}</td>
                    ${FC.map(key => key === 'occPct'
                      ? `<td><span class="night-calc" data-fc="occPct" data-i="${i}">${escapeHtml(forecastOcc(day.totalOcc))}</span></td>`
                      : `<td><input data-fc="${key}" data-i="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(day[key])}" ${dis}></td>`).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        ${window.renderNightInspection ? window.renderNightInspection(d.inspection, !!editingLocked()) : ''}

        <div class="dmr-card dmr-section-card">
          <p id="nightPrepared" class="dmr-prepared-by"${d.submittedBy ? '' : ' hidden'}>Prepared by: ${escapeHtml(d.submittedBy || '')}</p>
          ${editingLocked() ? '' : `
            <div class="night-actions">
              <button type="button" class="dmr-btn dmr-btn-ghost" id="nightSaveBtn">Save</button>
              <button type="button" class="dmr-btn dmr-btn-primary" id="nightSubmitBtn">Submit</button>
            </div>`}
          <div id="nightNote" class="night-note"></div>
        </div>
      </div>`;
  }

  function field(name, value, dis){
    return `<input data-field="${name}" inputmode="decimal" autocomplete="off" value="${escapeHtml(value)}" ${dis}>`;
  }

  function calc(name, text){
    return `<span class="night-calc" data-calc="${name}">${escapeHtml(text)}</span>`;
  }

  function labeled(label, control){
    return `<div class="dmr-field"><label>${label}</label>${control}</div>`;
  }

  function bindNight(){
    const body = document.getElementById('nightBody');
    if (!body || body._nightBound) return;
    body._nightBound = true;
    body.addEventListener('input', onEdit);
    body.addEventListener('change', onEdit);
    body.addEventListener('click', onClick);
  }

  function onEdit(e){
    const t = e.target;
    if (!t || !t.closest || !t.closest('#nightForm')) return;
    if (t.id === 'nightNotePhoto') {
      uploadNightNotePhoto(t);
      return;
    }
    if (t.matches('input, textarea, select')) {
      if (t.dataset.fc === 'totalOcc') {
        const span = t.closest('tr') && t.closest('tr').querySelector('[data-fc="occPct"]');
        if (span) span.textContent = forecastOcc(t.value);
      }
      queueNightSave();
    }
  }

  function onClick(e){
    const t = e.target;
    if (!t || !t.closest) return;
    const form = t.closest('#nightForm');
    const view = t.closest('[data-chk-photo], img[data-photo]');
    if (view && form) {
      window.state.modalImg = view.getAttribute('src');
      if (window.renderOverlays) window.renderOverlays();
      return;
    }
    const summary = t.closest('#nightInspection summary');
    if (summary) {
      const acc = summary.parentElement;
      setTimeout(() => {
        if (!window.state || !acc) return;
        if (acc.open) window.state.openAcc.add(acc.dataset.acc);
        else window.state.openAcc.delete(acc.dataset.acc);
      }, 0);
      return;
    }
    if (!form || editingLocked()) return;
    const chk = t.closest('[data-chk]');
    if (chk) { e.preventDefault(); toggleNightCheck(chk); return; }
    const addPhoto = t.closest('[data-chk-photo-add]');
    if (addPhoto) {
      e.preventDefault();
      window.state.photoTarget = addPhoto.dataset.chkPhotoAdd.split('|');
      const input = document.getElementById('checklistPhotoInput');
      if (input) input.click();
      return;
    }
    const delPhoto = t.closest('[data-chk-photo-del]');
    if (delPhoto) { e.preventDefault(); deleteNightCheckPhoto(delPhoto); return; }
    const dynToggle = t.closest('[data-dyn-toggle]');
    if (dynToggle) { e.preventDefault(); toggleNightDyn(dynToggle); return; }
    const dynDel = t.closest('[data-dyn-del]');
    if (dynDel && dynDel.closest('#nightInspection')) { e.preventDefault(); deleteNightDyn(dynDel); return; }
    const addList = t.closest('[data-add-row]');
    if (addList) { e.preventDefault(); addNightListRow(addList.dataset.addRow); return; }
    if (t.id === 'nightAddNoteBtn' || t.closest('#nightAddNoteBtn')) { e.preventDefault(); addNightNote(); return; }
    const noteDel = t.closest('[data-night-note-del]');
    if (noteDel) { e.preventDefault(); deleteNightNote(noteDel.dataset.nightNoteDel); return; }
    const add = t.closest('[data-night-add]');
    const del = t.closest('[data-night-del]');
    if (add) { e.preventDefault(); addRow(add.dataset.nightAdd); return; }
    if (del) { e.preventDefault(); deleteRow(del); return; }
    if (e.target.id === 'nightSaveBtn') { e.preventDefault(); saveNow(); }
    if (e.target.id === 'nightSubmitBtn') { e.preventDefault(); submitNight(); }
  }

  function inspectionList(secKey) {
    const pack = draft && draft.inspection;
    if (!pack) return null;
    if (secKey === 'cafeteriaItems') return pack.cafeteriaItems;
    return pack.checklists && pack.checklists[secKey];
  }

  function toggleNightCheck(btn) {
    if (editingLocked() || !draft) return;
    syncDraftFromDom();
    const row = btn.closest('[data-chk-section]');
    const arr = inspectionList(row.dataset.chkSection);
    const idx = parseInt(row.dataset.chkIdx, 10);
    if (!arr || !arr[idx]) return;
    const want = btn.dataset.chk === 'ok';
    arr[idx].status = arr[idx].status === want ? null : want;
    paint();
    queueNightSave();
  }

  function deleteNightCheckPhoto(btn) {
    if (editingLocked() || !draft) return;
    syncDraftFromDom();
    const parts = btn.dataset.chkPhotoDel.split('|');
    const arr = inspectionList(parts[0]);
    const item = arr && arr[parseInt(parts[1], 10)];
    if (!item || !item.photos) return;
    item.photos.splice(parseInt(parts[2], 10), 1);
    paint();
    queueNightSave();
  }

  function toggleNightDyn(btn) {
    if (editingLocked() || !draft || !draft.inspection) return;
    syncDraftFromDom();
    const row = btn.closest('[data-dyn-list]');
    const list = draft.inspection[row.dataset.dynList];
    const dataRow = list && list[parseInt(row.dataset.dynIdx, 10)];
    if (!dataRow) return;
    const field = btn.dataset.dynToggle;
    const want = btn.classList.contains('ok');
    dataRow[field] = dataRow[field] === want ? null : want;
    paint();
    queueNightSave();
  }

  function deleteNightDyn(btn) {
    if (editingLocked() || !draft || !draft.inspection) return;
    syncDraftFromDom();
    const row = btn.closest('[data-dyn-list]');
    const list = draft.inspection[row.dataset.dynList];
    if (!list) return;
    list.splice(parseInt(row.dataset.dynIdx, 10), 1);
    paint();
    queueNightSave();
  }

  function addNightListRow(key) {
    if (editingLocked() || !draft || !draft.inspection) return;
    syncDraftFromDom();
    const templates = {
      roomsInspection: { room: '', status: null, comment: '' },
      complaints: { complaint: '', room: '', action: '' },
      incidents: { description: '', time: '' },
      generalComments: { comment: '', time: '' }
    };
    if (!templates[key] || !Array.isArray(draft.inspection[key])) return;
    draft.inspection[key].push(templates[key]);
    if (window.state) window.state.openAcc.add(key);
    paint();
    queueNightSave();
  }

  function addNightNote() {
    if (editingLocked() || !draft || !draft.inspection) return;
    syncDraftFromDom();
    const textEl = document.getElementById('nightNoteText');
    const text = textEl ? textEl.value.trim() : '';
    if (!text) { showNote('Please type your note observation first'); return; }
    const photo = document.getElementById('nightNotePhoto');
    const user = window.state && window.state.user;
    const name = user ? (((user.first_name || '') + ' ' + (user.last_name || '')).trim() || user.username || '') : '';
    draft.inspection.notes.push({
      id: 'nn_' + Date.now(),
      department: (document.getElementById('nightNoteDept') || {}).value || 'Other',
      priority: (document.getElementById('nightNotePriority') || {}).value || 'normal',
      text: text,
      photo_url: photo && photo.dataset.url ? photo.dataset.url : null,
      manager: user && user.title ? (name + ' — ' + user.title) : name,
      time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Riyadh' }),
      status: 'open'
    });
    if (window.state) window.state.openAcc.add('notes');
    paint();
    queueNightSave();
    showNote('Note logged');
  }

  function deleteNightNote(id) {
    if (editingLocked() || !draft || !draft.inspection) return;
    syncDraftFromDom();
    draft.inspection.notes = (draft.inspection.notes || []).filter(n => n.id !== id);
    paint();
    queueNightSave();
  }

  async function uploadNightNotePhoto(input) {
    const file = input.files && input.files[0];
    if (!file || !window.uploadDutyPhoto || editingLocked()) return;
    showNote('Uploading photo…');
    const url = await window.uploadDutyPhoto(file);
    const prev = document.getElementById('nightNotePreview');
    if (url && prev) {
      prev.src = url;
      prev.style.display = 'block';
      input.dataset.url = url;
      showNote('Photo uploaded');
    } else {
      showNote('Photo upload failed');
    }
  }

  async function applyNightChecklistPhoto(file, target) {
    if (editingLocked() || !draft || !draft.inspection || !target || !window.uploadDutyPhoto) return;
    syncDraftFromDom();
    const arr = inspectionList(target[0]);
    const item = arr && arr[parseInt(target[1], 10)];
    if (!item) return;
    if (!item.photos) item.photos = [];
    if (item.photos.length >= 2) { showNote('Maximum 2 photos per item'); return; }
    showNote('Uploading photo…');
    const url = await window.uploadDutyPhoto(file);
    if (!url) { showNote('Photo upload failed'); return; }
    item.photos.push(url);
    paint();
    queueNightSave();
    showNote('Photo added');
  }

  function addRow(kind){
    if (editingLocked() || !draft) return;
    syncDraftFromDom();
    if (kind === 'group') draft.groups.push({day:'', name:'', rooms:'', arrival:'', departure:''});
    if (kind === 'vip') draft.vip.push({date:'', gold:'', platinum:'', diamond:'', stay:'in house'});
    paint();
    queueNightSave();
  }

  function deleteRow(btn){
    if (editingLocked() || !draft) return;
    syncDraftFromDom();
    const group = btn.closest('[data-group]');
    const vip = btn.closest('[data-vip]');
    if (group) draft.groups.splice(parseInt(group.dataset.group, 10), 1);
    if (vip) draft.vip.splice(parseInt(vip.dataset.vip, 10), 1);
    paint();
    queueNightSave();
  }

  function syncDraftFromDom(){
    const form = document.getElementById('nightForm');
    if (!form || !draft) return;
    ['roomsOccupied','roomsRevenue','fbRevenue','meRevenue','oodRevenue','otherRevenue','shiftStart','shiftEnd','arrivals','departures','inHouse','allMembers','overviewOccupancy'].forEach(key => {
      const el = form.querySelector(`[data-field="${key}"]`);
      if (el) draft[key] = el.value;
    });
    draft.segments.forEach((seg, i) => {
      const rooms = form.querySelector(`[data-seg-rooms="${i}"]`);
      const adr = form.querySelector(`[data-seg-adr="${i}"]`);
      if (rooms) seg.rooms = rooms.value;
      if (adr) seg.adr = adr.value;
    });
    draft.forecast.forEach((day, i) => {
      FC.forEach(key => {
        const el = form.querySelector(`[data-fc="${key}"][data-i="${i}"]`);
        if (el && el.tagName === 'INPUT') day[key] = el.value;
      });
      day.occPct = forecastOcc(day.totalOcc);
    });
    draft.groups = Array.from(form.querySelectorAll('[data-group]')).map(row => ({
      day: row.querySelector('[data-g="day"]').value,
      name: row.querySelector('[data-g="name"]').value,
      rooms: row.querySelector('[data-g="rooms"]').value,
      arrival: row.querySelector('[data-g="arrival"]').value,
      departure: row.querySelector('[data-g="departure"]').value
    }));
    draft.vip = Array.from(form.querySelectorAll('[data-vip]')).map(row => ({
      date: row.querySelector('[data-v="date"]').value,
      gold: row.querySelector('[data-v="gold"]').value,
      platinum: row.querySelector('[data-v="platinum"]').value,
      diamond: row.querySelector('[data-v="diamond"]').value,
      stay: row.querySelector('[data-v="stay"]').value
    }));
    draft.checklist.forEach((item, i) => {
      const el = form.querySelector(`[data-remark="${i}"]`);
      if (el) item.remark = el.value;
    });
    draft.comments = [0, 1, 2, 3].map(i => {
      const el = form.querySelector(`[data-comment="${i}"]`);
      return el ? el.value : (draft.comments[i] || '');
    });
    syncInspectionFromDom(form);
  }

  function syncInspectionFromDom(form) {
    const pack = draft.inspection;
    if (!pack) return;
    form.querySelectorAll('#nightInspection [data-chk-section]').forEach(row => {
      const sec = row.dataset.chkSection;
      const idx = parseInt(row.dataset.chkIdx, 10);
      const arr = sec === 'cafeteriaItems' ? pack.cafeteriaItems : (pack.checklists && pack.checklists[sec]);
      if (!arr || !arr[idx]) return;
      const comment = row.querySelector('[data-chk-comment]');
      if (comment) arr[idx].comment = comment.value;
    });
    const meal = form.querySelector('[data-night-meal]');
    if (meal) pack.cafeteriaMealTime = meal.value;
    const mealTime = form.querySelector('[data-night-time]');
    if (mealTime) pack.cafeteriaTime = mealTime.value;
    form.querySelectorAll('#nightInspection [data-dyn-list]').forEach(row => {
      const list = pack[row.dataset.dynList];
      const dataRow = list && list[parseInt(row.dataset.dynIdx, 10)];
      if (!dataRow) return;
      row.querySelectorAll('[data-dyn-field]').forEach(inp => {
        dataRow[inp.dataset.dynField] = inp.value;
      });
    });
    form.querySelectorAll('[data-night-note-status]').forEach(sel => {
      const note = (pack.notes || []).find(n => n.id === sel.dataset.nightNoteStatus);
      if (note) note.status = sel.value;
    });
  }

  function putBody(date){
    syncDraftFromDom();
    const comments = draft.comments.slice(0, 4);
    while (comments.length < 4) comments.push('');
    return {
      date: date,
      roomsOccupied: num(draft.roomsOccupied),
      roomsRevenue: num(draft.roomsRevenue),
      fbRevenue: num(draft.fbRevenue),
      meRevenue: num(draft.meRevenue),
      oodRevenue: num(draft.oodRevenue),
      otherRevenue: num(draft.otherRevenue),
      segments: draft.segments.map(s => ({code: s.code, rooms: num(s.rooms), adr: num(s.adr)})),
      forecast: draft.forecast.map(day => {
        const row = {date: day.date};
        FC.forEach(key => { row[key] = day[key]; });
        return row;
      }),
      groups: draft.groups.map(g => ({
        day: g.day, name: g.name, rooms: num(g.rooms), arrival: g.arrival, departure: g.departure
      })),
      vip: draft.vip.map(v => ({
        date: v.date, gold: num(v.gold), platinum: num(v.platinum), diamond: num(v.diamond), stay: v.stay
      })),
      checklist: draft.checklist.map(item => ({area: item.area, remark: item.remark})),
      comments: comments,
      inspection: draft.inspection,
      shiftStart: draft.shiftStart || '',
      shiftEnd: draft.shiftEnd || '',
      arrivals: draft.arrivals || '',
      departures: draft.departures || '',
      inHouse: draft.inHouse || '',
      allMembers: draft.allMembers || '',
      overviewOccupancy: draft.overviewOccupancy || ''
    };
  }

  function queueNightSave(){
    if (editingLocked()) return;
    syncDraftFromDom();
    pending = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; kick(); }, 500);
  }

  function kick(){
    if (flight || !pending) return flight;
    if (editingLocked()) { pending = false; return null; }
    const form = document.getElementById('nightForm');
    if (!form || form.dataset.date !== window.state.selectedDate) { pending = false; return null; }
    pending = false;
    const date = form.dataset.date;
    const body = putBody(date);
    flight = window.apiFetch('/api/night', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    }).then(res => {
      if (window.state.selectedDate !== date) return null;
      if (!res || !res.calculated) {
        showNote(errorText(res));
        return null;
      }
      showNote('');
      applyCalculated(res);
      return res;
    }).finally(() => {
      flight = null;
      if (pending) kick();
    });
    return flight;
  }

  async function saveNow(){
    if (editingLocked()) return null;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    pending = true;
    let result = null;
    while (pending || flight) {
      if (flight) result = await flight;
      else result = await kick();
    }
    return result;
  }

  async function submitNight(){
    if (editingLocked()) return;
    const saved = await saveNow();
    if (!saved) return;
    const date = window.state.selectedDate;
    const res = await window.apiFetch('/api/night/submit?date=' + encodeURIComponent(date), {method: 'POST'});
    if (!res || !res.submittedBy) {
      showNote(errorText(res) || 'Could not submit');
      return;
    }
    draft.submittedBy = res.submittedBy;
    draft.status = 'submitted';
    const prepared = document.getElementById('nightPrepared');
    if (prepared) {
      prepared.hidden = false;
      prepared.textContent = 'Prepared by: ' + res.submittedBy;
    }
    const badge = document.getElementById('nightStatus');
    if (badge) {
      badge.hidden = false;
      badge.textContent = 'Submitted';
      badge.className = 'dmr-badge dmr-badge-submitted';
    }
    if (editingLocked()) {
      syncDraftFromDom();
      paint();
    }
  }

  function applyCalculated(res){
    if (!draft) return;
    draft.status = res.status || draft.status;
    draft.calculated = res.calculated || {};
    draft.segmentGap = res.segmentGap || draft.segmentGap;
    draft.mtd = res.mtd || {};
    draft.missingDates = res.missingDates || [];
    if (res.submittedBy) draft.submittedBy = res.submittedBy;
    const c = draft.calculated;
    const m = draft.mtd;
    setCalc('day', dayNumber(res.date || draft.date));
    setCalc('occupancy', formatPercent(c.occupancy));
    setCalc('adr', formatMoney(c.adr));
    setCalc('revpar', formatMoney(c.revpar));
    setCalc('grand', formatMoney(c.grandTotal));
    setCalc('unassigned', formatCount(draft.segmentGap.unassigned));
    setCalc('mtd-roomsOccupied', formatCount(m.roomsOccupied));
    setCalc('mtd-occupancy', formatPercent(m.occupancy));
    setCalc('mtd-roomsRevenue', formatMoney(m.roomsRevenue));
    setCalc('mtd-adr', formatMoney(m.adr));
    setCalc('mtd-revpar', formatMoney(m.revpar));
    setCalc('mtd-fbRevenue', formatMoney(m.fbRevenue));
    setCalc('mtd-meRevenue', formatMoney(m.meRevenue));
    setCalc('mtd-oodRevenue', formatMoney(m.oodRevenue));
    setCalc('mtd-otherRevenue', formatMoney(m.otherRevenue));
    setCalc('mtd-grand', formatMoney(m.grandTotal));
    const missing = document.getElementById('nightMissing');
    if (missing) {
      const line = missingLine(draft.missingDates);
      missing.textContent = line;
      missing.hidden = !line;
    }
    const badge = document.getElementById('nightStatus');
    if (badge && draft.status) {
      badge.hidden = false;
      badge.textContent = draft.status === 'submitted' ? 'Submitted' : 'Draft';
      badge.className = 'dmr-badge ' + (draft.status === 'submitted' ? 'dmr-badge-submitted' : 'dmr-badge-draft');
    }
  }

  function setCalc(name, text){
    const el = document.querySelector(`[data-calc="${name}"]`);
    if (el) el.textContent = text;
  }

  function showNote(text){
    const el = document.getElementById('nightNote');
    if (el) el.textContent = text || '';
  }

  function errorText(res){
    if (!res) return 'Could not save';
    if (typeof res.detail === 'string') return res.detail;
    return 'Could not save';
  }

  function openNightDate(date){
    const state = window.state;
    state.section = 'night';
    state.view = 'today';
    state.selectedDate = date;
    window.renderApp();
  }

  let nightArchive = [];

  async function loadNightArchive(){
    const entries = await window.apiFetch('/api/night/index');
    nightArchive = entries || [];
    const search = document.getElementById('archiveSearch');
    if (search && !search._bound) {
      search._bound = true;
      search.onchange = paintNightArchive;
    }
    paintNightArchive();
  }

  function paintNightArchive(){
    const el = document.getElementById('archiveList');
    if (!el || !window.groupByMonth) return;
    const search = document.getElementById('archiveSearch');
    const query = search && search.value;
    const state = window.state;
    let rows = nightArchive;
    if (query) rows = nightArchive.filter(entry => entry.date === query);
    if (!rows.length) {
      el.innerHTML = '<div class="dmr-empty"><h3>No archived reports yet</h3></div>';
      return;
    }
    const writable = nightWritable();
    const isAdmin = state.user && state.user.role === 'admin';
    const openKey = query ? query.slice(0, 7) : (state.selectedDate || '').slice(0, 7);
    el.innerHTML = window.groupByMonth(rows).map(group => `
      <details class="archive-month dmr-card" ${group.key === openKey ? 'open' : ''}>
        <summary>${escapeHtml(group.label)} (${group.entries.length})</summary>
        ${group.entries.map(entry => `
          <div class="dmr-archive-row">
            <div>
              <div class="dmr-archive-date">${escapeHtml(fmtDate(entry.date))}</div>
              <span class="dmr-badge ${entry.status === 'submitted' ? 'dmr-badge-submitted' : 'dmr-badge-draft'}">${entry.status === 'submitted' ? 'Submitted' : 'Draft'}</span>
              ${entry.occupancy != null ? `<span style="font-size:12px;color:var(--ink-soft);margin-left:8px;">Occ: ${escapeHtml(entry.occupancy)}%</span>` : ''}
              ${entry.submittedBy ? `<div class="dmr-prepared-by">Prepared by: ${escapeHtml(entry.submittedBy)}</div>` : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-night-open="${escapeHtml(entry.date)}">Open</button>
              ${(writable && (isAdmin || entry.status !== 'submitted')) ? `<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-night-edit="${escapeHtml(entry.date)}">Edit</button>` : ''}
              <button type="button" class="dmr-btn dmr-btn-primary dmr-btn-sm" data-night-pdf="${escapeHtml(entry.date)}">Export PDF</button>
              ${(writable && isAdmin) ? `<button type="button" class="dmr-btn dmr-btn-sm" data-night-delete="${escapeHtml(entry.date)}" style="background:var(--danger);color:#fff;">Delete</button>` : ''}
            </div>
          </div>`).join('')}
      </details>`).join('');
    el.querySelectorAll('[data-night-open], [data-night-edit]').forEach(btn => {
      btn.onclick = () => openNightDate(btn.dataset.nightOpen || btn.dataset.nightEdit);
    });
    el.querySelectorAll('[data-night-pdf]').forEach(btn => {
      btn.onclick = () => exportNightPdf(btn.dataset.nightPdf);
    });
    el.querySelectorAll('[data-night-delete]').forEach(btn => {
      btn.onclick = async () => {
        const res = await window.apiFetch('/api/night?date=' + encodeURIComponent(btn.dataset.nightDelete), { method: 'DELETE' });
        if (res && res.success !== false && !res.detail) loadNightArchive();
      };
    });
  }

  function drawRatesChart(canvasId, labels, adr, revpar){
    const canvas = document.getElementById(canvasId);
    const charts = window.NovotelCharts;
    if (!canvas || !charts) return;
    const options = charts.chartFrame();
    options.plugins.legend = {
      display: true,
      position: 'top',
      align: 'end',
      labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, color: '#5B6673', font: { family: 'Aptos, Calibri, sans-serif', size: 11 } }
    };
    options.plugins.tooltip.displayColors = true;
    const adrSeries = charts.areaSeries(canvas, 'ADR', adr, '#14b8a6', '20,184,166');
    const revparSeries = charts.areaSeries(canvas, 'RevPAR', revpar, '#1e22aa', '30,34,170');
    adrSeries.spanGaps = true;
    revparSeries.spanGaps = true;
    charts.mountChart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: [adrSeries, revparSeries] },
      options: options
    });
  }

  function drawNightLine(id, values, labels, hex, rgb, name){
    const canvas = document.getElementById(id);
    const charts = window.NovotelCharts;
    if (!canvas || !window.Chart || !charts) return;
    const options = charts.chartFrame();
    if (name === 'Occupancy %') options.scales.y.suggestedMax = 100;
    charts.mountChart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: [charts.areaSeries(canvas, name, values, hex, rgb)] },
      options: options
    });
  }

  function relabel(data){
    const state = window.state;
    if (!data || !data.labels || !state.periodFrom || !state.periodTo) return;
    if (state.periodFrom.slice(0, 7) === state.periodTo.slice(0, 7)) return;
    data.labels = data.labels.map((_, index) => {
      const cursor = new Date(state.periodFrom + 'T00:00:00');
      cursor.setDate(cursor.getDate() + index);
      return cursor.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    });
  }

  async function loadNightAnalysis(){
    const state = window.state;
    const data = await window.apiFetch('/api/night/analysis?' + window.periodQuery());
    const body = document.getElementById('nightAnalysisBody');
    if (!body || !data) return;
    relabel(data);
    const revenue = data.revenue || {};
    const charts = window.NovotelCharts;
    body.innerHTML = `
      <div class="dmr-card dmr-chart-card"><h3>Occupancy %</h3><div class="chart-box"><canvas id="nightOcc"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>ADR and RevPAR</h3><div class="chart-box"><canvas id="nightRates"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Revenue by Departments</h3><div class="chart-box"><canvas id="nightRevenue"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Segments</h3><div class="chart-box"><canvas id="nightSegments"></canvas></div></div>
      <button type="button" class="dmr-btn dmr-btn-primary" id="nightPdfBtn">Export analysis PDF</button>`;
    const occ = (data.occupancy || []).map(value => value == null ? 0 : value);
    nightPack = data;
    if (window.drawOccupancyChart) {
      window.drawOccupancyChart('nightOcc', { labels: data.labels || [], values: occ, loyalty: data.loyalty || [] });
    } else {
      drawNightLine('nightOcc', occ, data.labels || [], '#1e22aa', '30,34,170', 'Occupancy %');
    }
    const rates = document.getElementById('nightRates');
    if (rates && charts) {
      const options = charts.chartFrame();
      options.plugins.legend = {
        display: true,
        position: 'top',
        align: 'end',
        labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, color: '#5B6673', font: { family: 'Aptos, Calibri, sans-serif', size: 11 } }
      };
      options.plugins.tooltip.displayColors = true;
      charts.mountChart(rates, {
        type: 'line',
        data: {
          labels: data.labels || [],
          datasets: [
            charts.areaSeries(rates, 'ADR', data.adr || [], '#14b8a6', '20,184,166'),
            charts.areaSeries(rates, 'RevPAR', data.revpar || [], '#1e22aa', '30,34,170')
          ]
        },
        options: options
      });
    }
    const revenueCanvas = document.getElementById('nightRevenue');
    if (revenueCanvas && charts) {
      const options = charts.chartFrame();
      charts.mountChart(revenueCanvas, {
        type: 'bar',
        data: {
          labels: ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'],
          datasets: [{
            data: [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0],
            backgroundColor: ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2'],
            borderRadius: 8,
            borderSkipped: false,
            maxBarThickness: 48
          }]
        },
        options: options
      });
    }
    const segmentCanvas = document.getElementById('nightSegments');
    if (segmentCanvas && charts) {
      const options = charts.chartFrame();
      options.indexAxis = 'y';
      options.scales.x.beginAtZero = true;
      charts.mountChart(segmentCanvas, {
        type: 'bar',
        data: {
          labels: (data.segments || []).map(seg => seg.code),
          datasets: [{
            data: (data.segments || []).map(seg => seg.rooms || 0),
            backgroundColor: '#7c6bf2',
            borderRadius: 8,
            borderSkipped: false,
            maxBarThickness: 18
          }]
        },
        options: options
      });
    }
    const pdfBtn = document.getElementById('nightPdfBtn');
    if (pdfBtn) pdfBtn.onclick = () => exportNightAnalysisPdf();
  }

  let nightPack = null;

  function pdfLines(doc, text, x, y, width){
    const lines = doc.splitTextToSize(String(text || ''), width);
    doc.setFontSize(9);
    lines.forEach(line => {
      if (y > 760) { doc.addPage(); y = 48; }
      doc.text(line, x, y);
      y += 12;
    });
    return y + 4;
  }

  function pdfChart(doc, W, y, title, image){
    if (y + 180 > 760) { doc.addPage(); y = 48; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(28, 43, 57);
    doc.text(title, 40, y);
    y += 8;
    doc.addImage(image, 'JPEG', 40, y, W - 80, 140);
    return y + 152;
  }

  async function appendNightAnalysisCharts(doc, W, y, data){
    const charts = window.NovotelCharts;
    if (!data || !charts || !window.Chart) return y;
    const occ = (data.occupancy || []).map(value => value == null ? 0 : value);
    const occImg = charts.chartImage(canvas => {
      const options = charts.comboOptions();
      options.animation = false;
      options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: charts.comboOccupancy(canvas, data.labels, occ, data.loyalty || []), options });
    });
    y = pdfChart(doc, W, y, 'Occupancy %', occImg);
    const rateImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      options.plugins.legend.display = true;
      return new Chart(canvas, {
        type: 'line',
        data: { labels: data.labels, datasets: [
          charts.areaSeries(canvas, 'ADR', data.adr || [], '#14b8a6', '20,184,166'),
          charts.areaSeries(canvas, 'RevPAR', data.revpar || [], '#1e22aa', '30,34,170')
        ] },
        options
      });
    });
    y = pdfChart(doc, W, y, 'ADR and RevPAR', rateImg);
    const revenue = data.revenue || {};
    const revImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      return new Chart(canvas, {
        type: 'bar',
        data: {
          labels: ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'],
          datasets: [{ data: [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], backgroundColor: ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2'], borderRadius: 8, maxBarThickness: 48 }]
        },
        options
      });
    });
    y = pdfChart(doc, W, y, 'Revenue by Departments', revImg);
    const segImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      options.indexAxis = 'y';
      return new Chart(canvas, {
        type: 'bar',
        data: {
          labels: (data.segments || []).map(seg => seg.code),
          datasets: [{ data: (data.segments || []).map(seg => seg.rooms || 0), backgroundColor: '#7c6bf2', borderRadius: 8, maxBarThickness: 18 }]
        },
        options
      });
    });
    return pdfChart(doc, W, y, 'Segments', segImg);
  }

  async function exportNightAnalysisPdf(){
    const data = nightPack;
    const pdf = window.NovotelPdf;
    if (!data || !window.jspdf || !window.NovotelCharts || !pdf) return;
    const state = window.state || {};
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const logo = await pdf.getLogoDataUrl();
    let y = pdf.pdfHeader(doc, W, logo, 'NIGHT ANALYSIS');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text((state.periodFrom || '') + '  to  ' + (state.periodTo || data.date || ''), 40, y);
    y += 16;
    y = await appendNightAnalysisCharts(doc, W, y, data);
    pdf.addPdfFooter(doc, W, 'Novotel — Night Analysis');
    doc.save('novotel-night-analysis-' + (data.date || 'report') + '.pdf');
  }

  async function writeNightPdf(doc, date){
    const pdf = window.NovotelPdf;
    const startPage = doc.internal.getNumberOfPages();
    const data = await window.apiFetch('/api/night?date=' + encodeURIComponent(date));
    const W = doc.internal.pageSize.getWidth();
    if (!data || !data.status) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.text('Night report was not filed for this date', 40, 80);
      return;
    }
    const logo = await pdf.getLogoDataUrl();
    let y = pdf.pdfHeader(doc, W, logo, 'NIGHT MANAGER REPORT');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Shift: ' + (data.shiftStart || '—') + '  to  ' + (data.shiftEnd || '—'), 40, y);
    doc.text('Arrivals: ' + (data.arrivals || '—'), 240, y);
    doc.text('Departures: ' + (data.departures || '—'), 360, y);
    doc.text('ALL Loyalty Members: ' + (data.allMembers || '—'), 470, y);
    y += 16;
    const c = data.calculated || {};
    const m = data.mtd || {};
    const asEntered = value => value == null || value === '' ? '' : String(value);
    const rows = [
      ['Day', dayNumber(data.date), ''],
      ['Rooms occupied', asEntered(data.roomsOccupied), formatCount(m.roomsOccupied)],
      ['Occupancy', formatPercent(c.occupancy), formatPercent(m.occupancy)],
      ['Rooms revenue', asEntered(data.roomsRevenue), formatMoney(m.roomsRevenue)],
      ['ADR', formatMoney(c.adr), formatMoney(m.adr)],
      ['RevPAR', formatMoney(c.revpar), formatMoney(m.revpar)],
      ['F&B', asEntered(data.fbRevenue), formatMoney(m.fbRevenue)],
      ['M&E', asEntered(data.meRevenue), formatMoney(m.meRevenue)],
      ['OOD', asEntered(data.oodRevenue), formatMoney(m.oodRevenue)],
      ['Other', asEntered(data.otherRevenue), formatMoney(m.otherRevenue)],
      ['Grand total', formatMoney(c.grandTotal), formatMoney(m.grandTotal)]
    ];
    y = pdf.pdfTable(doc, W, y, [
      {key:'ITEM', label:'', w:180},
      {key:'LAST', label:'LAST NIGHT', w:160},
      {key:'MTD', label:'MTD', w:160}
    ], rows.map(row => {
      const item = {ITEM: row[0], LAST: row[1], MTD: row[2]};
      if (row[0] === 'Occupancy' && window.occupancyColor) {
        item.LAST_color = window.occupancyColor(row[1]);
        item.MTD_color = window.occupancyColor(row[2]);
      }
      return item;
    }));
    y += 12;
    const analysis = await window.apiFetch('/api/night/analysis?date=' + encodeURIComponent(date) + '&range=month');
    y = await appendNightAnalysisCharts(doc, W, y, analysis);
    const gap = data.segmentGap || {};
    const segmentRows = (data.segments || []).map(seg => ({CODE: seg.code, ROOMS: String(seg.rooms ?? '')}));
    segmentRows.push({CODE: 'Unassigned', ROOMS: String(gap.unassigned ?? '')});
    y = pdf.pdfTable(doc, W, y, [
      {key:'CODE', label:'SEGMENT', w:260},
      {key:'ROOMS', label:'ROOMS', w:200}
    ], segmentRows);
    y += 8;
    y = pdf.pdfTable(doc, W, y, [
      {key:'DATE', label:'DATE', w:78},
      {key:'OCC', label:'OCC', w:48},
      {key:'ARR', label:'ARR', w:48},
      {key:'DEP', label:'DEP', w:48},
      {key:'PCT', label:'OCC %', w:52},
      {key:'COMP', label:'COMP ROOMS', w:78},
      {key:'RATE', label:'AVG RATE', w:78}
    ], (data.forecast || []).map(day => ({
      DATE: day.date,
      OCC: String(day.totalOcc ?? ''),
      ARR: String(day.arrRooms ?? ''),
      DEP: String(day.depRooms ?? ''),
      PCT: String(day.occPct ?? ''),
      COMP: String(day.compRooms ?? ''),
      RATE: String(day.averageRate ?? '')
    })));
    y += 8;
    if ((data.groups || []).length) {
      y = pdf.pdfTable(doc, W, y, [
        {key:'NAME', label:'GROUP', w:180},
        {key:'ROOMS', label:'ROOMS', w:80},
        {key:'ARR', label:'ARRIVAL', w:120},
        {key:'DEP', label:'DEPARTURE', w:120}
      ], data.groups.map(g => ({NAME: g.name || '', ROOMS: String(g.rooms ?? ''), ARR: g.arrival || '', DEP: g.departure || ''})));
      y += 8;
    }
    if ((data.vip || []).length) {
      y = pdf.pdfTable(doc, W, y, [
        {key:'DATE', label:'VIP', w:120},
        {key:'GOLD', label:'GOLD', w:80},
        {key:'PLAT', label:'PLATINUM', w:90},
        {key:'DIA', label:'DIAMOND', w:90},
        {key:'STAY', label:'STAY', w:100}
      ], data.vip.map(v => ({DATE: v.date || '', GOLD: String(v.gold ?? ''), PLAT: String(v.platinum ?? ''), DIA: String(v.diamond ?? ''), STAY: v.stay || ''})));
      y += 8;
    }
    if (window.appendNightInspectionPdf) {
      y = await window.appendNightInspectionPdf(doc, y, data.inspection || {});
    }
    if (data.submittedBy) {
      doc.setFontSize(9);
      doc.text('Prepared by: ' + data.submittedBy, 40, y + 8);
    }
    pdf.addPdfFooter(doc, W, 'Novotel — Night Manager Report', startPage);
  }

  async function exportNightPdf(date){
    if (!window.jspdf || !window.NovotelPdf) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    await writeNightPdf(doc, date);
    doc.save('novotel-night-report-' + date + '.pdf');
  }

  function fullWindow(){
    const state = window.state;
    const to = state.fullTo || state.selectedDate;
    if (state.fullMode === 'month') return { from: to.slice(0, 8) + '01', to: to };
    if (state.fullMode === 'custom' && state.fullFrom && state.fullFrom <= to) return { from: state.fullFrom, to: to };
    const cursor = new Date(to + 'T00:00:00');
    cursor.setDate(cursor.getDate() - 6);
    const from = cursor.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    return { from: from, to: to };
  }

  function shiftIso(iso, days){
    const cursor = new Date(iso + 'T00:00:00');
    cursor.setDate(cursor.getDate() + days);
    return cursor.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  }

  function spanDays(from, to){
    let count = 0;
    let cursor = from;
    while (cursor && cursor <= to && count < 400) {
      count += 1;
      cursor = shiftIso(cursor, 1);
    }
    return count;
  }

  function drawPie(id, labels, values, colors){
    const canvas = document.getElementById(id);
    const charts = window.NovotelCharts;
    if (!canvas || !window.Chart || !charts) return;
    const options = charts.chartFrame();
    options.scales.x.display = false;
    options.scales.y.display = false;
    options.plugins.legend = { display: true, position: 'bottom', labels: { boxWidth: 10, color: '#5B6673', font: { family: 'Aptos, Calibri, sans-serif', size: 11 } } };
    charts.mountChart(canvas, {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
      options: options
    });
  }

  let fullPack = null;

  function dashboardStats(duty, night, index, from, to, guest) {
    const dutyRows = (index || []).filter(row => row.date >= from && row.date <= to);
    const dutySubmitted = dutyRows.filter(row => row.status === 'submitted').length;
    const dutyMissing = Math.max(0, spanDays(from, to) - dutySubmitted);
    const nightRaw = (night && night.occupancy) || [];
    const nightFiled = nightRaw.filter(value => value != null).length;
    const nightMissing = Math.max(0, nightRaw.length - nightFiled);
    const revenue = (night && night.revenue) || {};
    const adrValues = ((night && night.adr) || []).filter(value => value != null);
    const avgAdr = adrValues.length ? Math.round(adrValues.reduce((sum, value) => sum + Number(value), 0) / adrValues.length) : null;
    return {
      dutySubmitted: dutySubmitted,
      dutyMissing: dutyMissing,
      failures: duty ? duty.totalFail : 0,
      complaints: duty && duty.complaintsList ? duty.complaintsList.length : 0,
      gss: duty && duty.avgGss != null && duty.avgGss !== '' ? duty.avgGss : '—',
      avgAdr: avgAdr == null ? '—' : formatMoney(avgAdr),
      nightFiled: nightFiled,
      nightMissing: nightMissing,
      rooms: formatMoney(revenue.rooms || 0),
      revenue: revenue,
      guestSubmitted: guest ? guest.submitted : 0,
      guestMissing: guest ? guest.missing : 0,
      guestNotSatisfied: guest ? guest.notSatisfied : 0,
      guestDeparture: guest && guest.avgDeparture != null ? guest.avgDeparture : '—'
    };
  }

  const STAT_TONES = {
    ok: { bg: [234, 242, 236], fg: [79, 122, 91] },
    danger: { bg: [251, 234, 231], fg: [177, 75, 63] },
    warn: { bg: [251, 240, 226], fg: [196, 129, 60] },
    navy: { bg: [238, 240, 251], fg: [30, 34, 170] },
    teal: { bg: [231, 247, 244], fg: [15, 118, 110] }
  };

  function dashboardCards(stats) {
    return [
      { tone: 'ok', value: stats.dutySubmitted, label: 'Duty reports submitted' },
      { tone: 'danger', value: stats.dutyMissing, label: 'Duty days not submitted' },
      { tone: 'warn', value: stats.failures, label: 'Checklist failures' },
      { tone: 'navy', value: stats.complaints, label: 'Guest complaints' },
      { tone: 'teal', value: stats.gss, label: 'Avg TrustYou GSS' },
      { tone: 'teal', value: stats.avgAdr, label: 'Avg ADR' },
      { tone: 'ok', value: stats.nightFiled, label: 'Night reports submitted' },
      { tone: 'danger', value: stats.nightMissing, label: 'Nights not submitted' },
      { tone: 'navy', value: stats.rooms, label: 'Night rooms revenue' },
      { tone: 'ok', value: stats.guestSubmitted || 0, label: 'Guest Relation submitted' },
      { tone: 'danger', value: stats.guestMissing || 0, label: 'Guest Relation days not submitted' },
      { tone: 'warn', value: stats.guestNotSatisfied || 0, label: 'Not satisfied guests' },
      { tone: 'teal', value: stats.guestDeparture == null ? '—' : stats.guestDeparture, label: 'Avg departure score' }
    ];
  }

  function pdfStatCards(doc, W, y, cards) {
    const gap = 6;
    const cols = 3;
    const cardW = (W - 80 - gap * (cols - 1)) / cols;
    const cardH = 52;
    const rows = Math.ceil(cards.length / cols);
    if (y + rows * (cardH + gap) > 780) { doc.addPage(); y = 48; }
    cards.forEach((card, index) => {
      const tone = STAT_TONES[card.tone];
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = 40 + col * (cardW + gap);
      const top = y + row * (cardH + gap);
      doc.setFillColor(tone.bg[0], tone.bg[1], tone.bg[2]);
      doc.roundedRect(x, top, cardW, cardH, 3, 3, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(tone.fg[0], tone.fg[1], tone.fg[2]);
      doc.text(String(card.value), x + 8, top + 20);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(91, 102, 115);
      doc.text(doc.splitTextToSize(card.label, cardW - 16).slice(0, 2), x + 8, top + 34);
    });
    return y + rows * (cardH + gap) + 6;
  }

  function pieImage(charts, labels, values, colors) {
    return charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      options.scales.x.display = false;
      options.scales.y.display = false;
      options.plugins.legend = {
        display: true,
        position: 'bottom',
        labels: { boxWidth: 10, color: '#5B6673', font: { family: 'Aptos, Calibri, sans-serif', size: 13 } }
      };
      return new Chart(canvas, {
        type: 'doughnut',
        data: { labels: labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#ffffff' }] },
        options: options
      });
    }, 420, 360);
  }

  function pdfPieRow(doc, W, y, pies) {
    const gap = 8;
    const boxW = (W - 80 - gap * (pies.length - 1)) / pies.length;
    const imgH = boxW * 0.86;
    if (y + 16 + imgH > 780) { doc.addPage(); y = 48; }
    pies.forEach((pie, index) => {
      const x = 40 + index * (boxW + gap);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(28, 43, 57);
      doc.text(pie.title, x, y);
      doc.addImage(pie.image, 'JPEG', x, y + 6, boxW, imgH);
    });
    return y + 14 + imgH;
  }

  async function loadFullReport(){
    const state = window.state;
    const body = document.getElementById('fullBody');
    if (!body) return;
    const range = { from: state.periodFrom, to: state.periodTo };
    const [duty, night, guest] = await Promise.all([
      window.apiFetch('/api/reports/analysis?' + window.periodQuery()),
      window.apiFetch('/api/night/analysis?' + window.periodQuery()),
      window.apiFetch('/api/guest/analysis?' + window.periodQuery())
    ]);
    const index = await window.apiFetch('/api/reports/index');
    relabel(night);
    if (!document.getElementById('fullBody')) return;
    const stats = dashboardStats(duty, night, index || [], range.from, range.to, guest);
    const revenue = stats.revenue;
    fullPack = { duty: duty, night: night, guest: guest, index: index || [], from: range.from, to: range.to, stats: stats };
    window.currentDutyAnalysis = duty;
    const charts = window.NovotelCharts;
    body.innerHTML = `
      <p class="dmr-sub">${escapeHtml(range.from)} to ${escapeHtml(range.to)}</p>
      <div class="dmr-stat-grid">
        ${dashboardCards(stats).map(card => `<div class="dmr-card dmr-stat tone-${card.tone}"><div class="num">${escapeHtml(String(card.value))}</div><div class="lbl">${escapeHtml(card.label)}</div></div>`).join('')}
      </div>
      <div class="dash-pies">
        <div class="dmr-card dmr-chart-card"><h3>Duty reports</h3><div class="chart-box chart-box-pie"><canvas id="pieDuty"></canvas></div></div>
        <div class="dmr-card dmr-chart-card"><h3>Night reports</h3><div class="chart-box chart-box-pie"><canvas id="pieNight"></canvas></div></div>
        <div class="dmr-card dmr-chart-card"><h3>Revenue Mix</h3><div class="chart-box chart-box-pie"><canvas id="pieRevenue"></canvas></div></div>
        <div class="dmr-card dmr-chart-card"><h3>Guest Relation</h3><div class="chart-box chart-box-pie"><canvas id="pieGuest"></canvas></div></div>
      </div>
      ${window.actionItemsHtml ? window.actionItemsHtml((duty && duty.actionItems) || []) : ''}
      <div class="dmr-card dmr-chart-card"><h3>Duty occupancy and ALL Loyalty Members</h3><div class="chart-box"><canvas id="fullOcc"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>TrustYou GSS</h3><div class="chart-box"><canvas id="fullGss"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Inspection failures</h3><div class="chart-box"><canvas id="fullFail"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Night occupancy and ALL Loyalty Members</h3><div class="chart-box"><canvas id="fullNightOcc"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>ADR and RevPAR</h3><div class="chart-box"><canvas id="fullRates"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Room revenue</h3><div class="chart-box"><canvas id="fullRooms"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Revenue by Departments</h3><div class="chart-box"><canvas id="fullRevenue"></canvas></div></div>
      <div class="dmr-card dmr-section-card"><h3>Complaints in this period</h3>
        ${duty && duty.complaintsList.length ? duty.complaintsList.slice(0, 8).map(item => `<div class="dmr-recur-item"><span>${escapeHtml(item.date)} — ${escapeHtml(item.complaint || '')}</span></div>`).join('') : '<p>No complaints in this period.</p>'}
      </div>
      <button type="button" class="dmr-btn dmr-btn-primary" id="fullPdfBtn">Export dashboard PDF</button>`;
    if (!charts || !window.occupancySeries) {
      const btn = document.getElementById('fullPdfBtn');
      if (btn) btn.onclick = () => exportFullPdf();
      return;
    }
    const dutySeries = window.occupancySeries(index || [], range.from, range.to);
    if (window.drawOccupancyChart) window.drawOccupancyChart('fullOcc', dutySeries);
    const fails = (duty && duty.topSections && duty.topSections.length) ? duty.topSections : [['No failures', 0]];
    const failOptions = charts.chartFrame();
    charts.mountChart(document.getElementById('fullFail'), {
      type: 'bar',
      data: { labels: fails.map(item => item[0]), datasets: [{ data: fails.map(item => item[1]), backgroundColor: '#7c6bf2', borderRadius: 8, maxBarThickness: 36 }] },
      options: failOptions
    });
    const nightOcc = ((night && night.occupancy) || []).map(value => value == null ? 0 : value);
    if (window.drawOccupancyChart) {
      window.drawOccupancyChart('fullNightOcc', { labels: (night && night.labels) || [], values: nightOcc, loyalty: (night && night.loyalty) || [] });
    }
    if (window.drawTrend) {
      window.drawTrend('fullGss', dutySeries.labels, (duty && duty.gss) || [], 'TrustYou GSS', '#14b8a6', '20,184,166', true);
      window.drawTrend('fullRooms', (night && night.labels) || [], (night && night.roomsSeries) || [], 'Room revenue', '#1e22aa', '30,34,170', false);
    }
    drawRatesChart('fullRates', (night && night.labels) || [], (night && night.adr) || [], (night && night.revpar) || []);
    drawPie('pieDuty', ['Submitted', 'Not submitted'], [stats.dutySubmitted, stats.dutyMissing], ['#4F7A5B', '#E7D3D0']);
    drawPie('pieNight', ['Submitted', 'Not submitted'], [stats.nightFiled, stats.nightMissing], ['#0f766e', '#E7D3D0']);
    drawPie('pieRevenue', ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'], [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2']);
    drawPie('pieGuest', ['Submitted', 'Not submitted'], [stats.guestSubmitted || 0, stats.guestMissing || 0], ['#1e22aa', '#E7D3D0']);
    const revOptions = charts.chartFrame();
    charts.mountChart(document.getElementById('fullRevenue'), {
      type: 'bar',
      data: {
        labels: ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'],
        datasets: [{ data: [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], backgroundColor: ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2'], borderRadius: 8, maxBarThickness: 48 }]
      },
      options: revOptions
    });
    const btn = document.getElementById('fullPdfBtn');
    if (btn) btn.onclick = () => exportFullPdf();
  }

  async function exportFullPdf(){
    const pack = fullPack;
    const charts = window.NovotelCharts;
    const pdf = window.NovotelPdf;
    if (!pack || !window.jspdf || !charts || !pdf || !window.occupancySeries) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const logo = await pdf.getLogoDataUrl();
    let y = pdf.pdfHeader(doc, W, logo, 'FULL REPORT');
    doc.setFontSize(11);
    doc.setTextColor(35, 48, 61);
    doc.text(pack.from + '  to  ' + pack.to, 40, y);
    y += 16;
    const duty = pack.duty || {};
    const night = pack.night || {};
    const stats = pack.stats || dashboardStats(duty, night, pack.index, pack.from, pack.to, pack.guest);
    y = pdfStatCards(doc, W, y, dashboardCards(stats));
    const revenueMix = stats.revenue || {};
    y = pdfPieRow(doc, W, y, [
      { title: 'Duty reports', image: pieImage(charts, ['Submitted', 'Not submitted'], [stats.dutySubmitted, stats.dutyMissing], ['#4F7A5B', '#E7D3D0']) },
      { title: 'Night reports', image: pieImage(charts, ['Submitted', 'Not submitted'], [stats.nightFiled, stats.nightMissing], ['#0f766e', '#E7D3D0']) },
      { title: 'Revenue Mix', image: pieImage(charts, ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'], [revenueMix.rooms || 0, revenueMix.fb || 0, revenueMix.me || 0, revenueMix.ood || 0, revenueMix.other || 0], ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2']) },
      { title: 'Guest Relation', image: pieImage(charts, ['Submitted', 'Not submitted'], [stats.guestSubmitted || 0, stats.guestMissing || 0], ['#1e22aa', '#E7D3D0']) }
    ]);
    y += 8;
    const series = window.occupancySeries(pack.index, pack.from, pack.to);
    const occImg = charts.chartImage(canvas => {
      const options = charts.comboOptions();
      options.animation = false;
      options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: charts.comboOccupancy(canvas, series.labels, series.values, series.loyalty), options });
    });
    y = pdfChart(doc, W, y, 'Duty occupancy %', occImg);
    const gssImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      const series = charts.areaSeries(canvas, 'TrustYou GSS', duty.gss || [], '#14b8a6', '20,184,166');
      series.spanGaps = true;
      return new Chart(canvas, { type: 'line', data: { labels: window.occupancySeries([], pack.from, pack.to).labels, datasets: [series] }, options });
    });
    y = pdfChart(doc, W, y, 'TrustYou GSS', gssImg);
    const fails = (duty.topSections && duty.topSections.length) ? duty.topSections : [['No failures', 0]];
    const failImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: { labels: fails.map(item => item[0]), datasets: [{ data: fails.map(item => item[1]), backgroundColor: '#7c6bf2', borderRadius: 8 }] }, options });
    });
    y = pdfChart(doc, W, y, 'Inspection failures', failImg);
    const nightOcc = (night.occupancy || []).map(value => value == null ? 0 : value);
    const nightImg = charts.chartImage(canvas => {
      const options = charts.comboOptions();
      options.animation = false;
      options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: charts.comboOccupancy(canvas, night.labels || [], nightOcc, night.loyalty || []), options });
    });
    y = pdfChart(doc, W, y, 'Night occupancy %', nightImg);
    const rateImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      options.plugins.legend.display = true;
      const adr = charts.areaSeries(canvas, 'ADR', night.adr || [], '#14b8a6', '20,184,166');
      const revpar = charts.areaSeries(canvas, 'RevPAR', night.revpar || [], '#1e22aa', '30,34,170');
      adr.spanGaps = true;
      revpar.spanGaps = true;
      return new Chart(canvas, { type: 'line', data: { labels: night.labels || [], datasets: [adr, revpar] }, options });
    });
    y = pdfChart(doc, W, y, 'ADR and RevPAR', rateImg);
    const roomsImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      return new Chart(canvas, { type: 'line', data: { labels: night.labels || [], datasets: [charts.areaSeries(canvas, 'Room revenue', night.roomsSeries || [], '#1e22aa', '30,34,170')] }, options });
    });
    y = pdfChart(doc, W, y, 'Room revenue', roomsImg);
    const revenue = night.revenue || {};
    const revImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: { labels: ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'], datasets: [{ data: [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], backgroundColor: ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2'], borderRadius: 8 }] }, options });
    });
    y = pdfChart(doc, W, y, 'Revenue by Departments', revImg);
    if ((duty.complaintsList || []).length) {
      if (y > 700) { doc.addPage(); y = 48; }
      doc.setFontSize(11);
      doc.text('Guest complaints', 40, y);
      y += 14;
      duty.complaintsList.slice(0, 12).forEach(item => {
        const action = item.action ? '  Action: ' + item.action : '';
        y = pdfLines(doc, (item.date || '') + '  ' + (item.complaint || '') + action, 40, y, W - 80);
      });
    }
    pdf.addPdfFooter(doc, W, 'Novotel — Dashboard');
    doc.save('novotel-full-report-' + pack.from + '-to-' + pack.to + '.pdf');
  }

  window.renderNightSection = renderNightSection;
  window.reloadFullReport = loadFullReport;
  window.exportDashboardPdf = exportFullPdf;
  window.syncNightDraft = syncDraftFromDom;
  window.applyNightChecklistPhoto = applyNightChecklistPhoto;
})();
