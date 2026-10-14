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
        <div class="dmr-headline"><h1>Full Report</h1></div>
        <div class="dmr-sub">Duty and night together for the dates you choose</div>
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
        <h1>Night Manager</h1>
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
          <div class="night-scroll">
            <table class="night-figures">
              <thead><tr><th>Code</th><th>Rooms</th><th>ADR</th></tr></thead>
              <tbody>
                ${d.segments.map((seg, i) => `
                  <tr>
                    <th>${escapeHtml(seg.code)}</th>
                    <td><input data-seg-rooms="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(seg.rooms)}" ${dis}></td>
                    <td><input data-seg-adr="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(seg.adr)}" ${dis}></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <p class="night-unassigned">Unassigned rooms <strong class="night-calc" data-calc="unassigned">${escapeHtml(formatCount(gap.unassigned))}</strong></p>
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>Groups</h3>
          ${d.groups.map((g, i) => `
            <div class="night-record" data-group="${i}">
              ${labeled('Day', `<input data-g="day" value="${escapeHtml(g.day)}" ${dis}>`)}
              ${labeled('Name', `<input data-g="name" value="${escapeHtml(g.name)}" ${dis}>`)}
              ${labeled('Rooms', `<input data-g="rooms" inputmode="decimal" value="${escapeHtml(g.rooms)}" ${dis}>`)}
              ${labeled('Arrival', `<input data-g="arrival" value="${escapeHtml(g.arrival)}" ${dis}>`)}
              ${labeled('Departure', `<input data-g="departure" value="${escapeHtml(g.departure)}" ${dis}>`)}
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
                    ${FC.map(key => `<td><input data-fc="${key}" data-i="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(day[key])}" ${dis}></td>`).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>Night observation</h3>
          ${d.checklist.map((item, i) => `
            <div class="dmr-field">
              <label>${escapeHtml(item.area)}</label>
              <input data-remark="${i}" value="${escapeHtml(item.remark)}" ${dis}>
            </div>`).join('')}
        </div>

        <div class="dmr-card dmr-section-card">
          <h3>General comments</h3>
          ${d.comments.map((text, i) => `
            <div class="dmr-field">
              <label>General comment ${i + 1}</label>
              <textarea data-comment="${i}" rows="2" ${dis}>${escapeHtml(text)}</textarea>
            </div>`).join('')}
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
    if (t.matches('input, textarea, select')) queueNightSave();
  }

  function onClick(e){
    const t = e.target;
    if (!t || !t.closest) return;
    const add = t.closest('[data-night-add]');
    const del = t.closest('[data-night-del]');
    if (add) { e.preventDefault(); addRow(add.dataset.nightAdd); return; }
    if (del) { e.preventDefault(); deleteRow(del); return; }
    if (e.target.id === 'nightSaveBtn') { e.preventDefault(); saveNow(); }
    if (e.target.id === 'nightSubmitBtn') { e.preventDefault(); submitNight(); }
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
    ['roomsOccupied','roomsRevenue','fbRevenue','meRevenue','oodRevenue','otherRevenue'].forEach(key => {
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
        if (el) day[key] = el.value;
      });
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
      return el ? el.value : '';
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
      comments: comments
    };
  }

  function queueNightSave(){
    if (editingLocked()) return;
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
      <div class="dmr-card dmr-chart-card"><h3>Revenue by department</h3><div class="chart-box"><canvas id="nightRevenue"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Segments</h3><div class="chart-box"><canvas id="nightSegments"></canvas></div></div>
      <button type="button" class="dmr-btn dmr-btn-primary" id="nightPdfBtn">Export analysis PDF</button>`;
    const occ = (data.occupancy || []).map(value => value == null ? 0 : value);
    nightPack = data;
    drawNightLine('nightOcc', occ, data.labels || [], '#1e22aa', '30,34,170', 'Occupancy %');
    const rates = document.getElementById('nightRates');
    if (rates && charts) {
      const options = charts.chartFrame();
      options.plugins.legend = {
        display: true,
        position: 'top',
        align: 'end',
        labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, color: '#5B6673', font: { family: 'Inter', size: 11 } }
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

  async function exportNightAnalysisPdf(){
    const data = nightPack;
    const charts = window.NovotelCharts;
    const pdf = window.NovotelPdf;
    if (!data || !window.jspdf || !charts || !pdf) return;
    const occ = (data.occupancy || []).map(value => value == null ? 0 : value);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const logo = await pdf.getLogoDataUrl();
    let y = pdf.pdfHeader(doc, W, logo, 'NIGHT ANALYSIS');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text((state.periodFrom || '') + '  to  ' + (state.periodTo || data.date || ''), 40, y);
    y += 16;
    const occImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false;
      options.responsive = false;
      options.scales.y.suggestedMax = 100;
      return new Chart(canvas, { type: 'line', data: { labels: data.labels, datasets: [charts.areaSeries(canvas, 'Occupancy %', occ, '#1e22aa', '30,34,170')] }, options });
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
    y = pdfChart(doc, W, y, 'Revenue by department', revImg);
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
    pdfChart(doc, W, y, 'Segments', segImg);
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
    const c = data.calculated || {};
    const m = data.mtd || {};
    const gap = data.segmentGap || {};
    const rows = [
      ['Rooms occupied', String(data.roomsOccupied ?? ''), String(m.roomsOccupied ?? '')],
      ['Occupancy', formatPercent(c.occupancy), formatPercent(m.occupancy)],
      ['ADR', formatMoney(c.adr), formatMoney(m.adr)],
      ['RevPAR', formatMoney(c.revpar), formatMoney(m.revpar)],
      ['Grand total', formatMoney(c.grandTotal), formatMoney(m.grandTotal)]
    ];
    y = pdf.pdfTable(doc, W, y, [
      {key:'ITEM', label:'', w:180},
      {key:'LAST', label:'LAST NIGHT', w:160},
      {key:'MTD', label:'MTD', w:160}
    ], rows.map(row => ({ITEM: row[0], LAST: row[1], MTD: row[2]})));
    y += 8;
    const segmentRows = (data.segments || []).map(seg => ({CODE: seg.code, ROOMS: String(seg.rooms ?? ''), ADR: String(seg.adr ?? '')}));
    segmentRows.push({CODE: 'Unassigned', ROOMS: String(gap.unassigned ?? ''), ADR: ''});
    y = pdf.pdfTable(doc, W, y, [
      {key:'CODE', label:'SEGMENT', w:160},
      {key:'ROOMS', label:'ROOMS', w:120},
      {key:'ADR', label:'ADR', w:120}
    ], segmentRows);
    y += 8;
    y = pdf.pdfTable(doc, W, y, [
      {key:'DATE', label:'FORECAST', w:110},
      {key:'OCC', label:'OCC', w:70},
      {key:'ARR', label:'ARR', w:70},
      {key:'DEP', label:'DEP', w:70},
      {key:'PCT', label:'OCC %', w:70}
    ], (data.forecast || []).map(day => ({
      DATE: day.date, OCC: String(day.totalOcc ?? ''), ARR: String(day.arrRooms ?? ''), DEP: String(day.depRooms ?? ''), PCT: String(day.occPct ?? '')
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
    y = pdf.pdfTable(doc, W, y, [
      {key:'AREA', label:'AREA', w:220},
      {key:'REMARK', label:'REMARK', w:280}
    ], (data.checklist || []).map(item => ({AREA: item.area, REMARK: item.remark || ''})));
    y += 8;
    (data.comments || []).forEach((text, i) => {
      if (y > 760) { doc.addPage(); y = 48; }
      doc.setFontSize(9);
      doc.text('Comment ' + (i + 1) + ': ' + (text || '—'), 40, y, {maxWidth: W - 80});
      y += 16;
    });
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

  let fullPack = null;

  async function loadFullReport(){
    const state = window.state;
    const body = document.getElementById('fullBody');
    if (!body) return;
    const range = { from: state.periodFrom, to: state.periodTo };
    const [duty, night] = await Promise.all([
      window.apiFetch('/api/reports/analysis?' + window.periodQuery()),
      window.apiFetch('/api/night/analysis?' + window.periodQuery())
    ]);
    const index = await window.apiFetch('/api/reports/index');
    relabel(night);
    if (!document.getElementById('fullBody')) return;
    fullPack = { duty: duty, night: night, index: index || [], from: range.from, to: range.to };
    const charts = window.NovotelCharts;
    body.innerHTML = `
      <p class="dmr-sub">${escapeHtml(range.from)} to ${escapeHtml(range.to)}</p>
      <div class="dmr-stat-grid">
        <div class="dmr-card dmr-stat"><div class="num">${duty ? duty.days : 0}</div><div class="lbl">Duty reports</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${duty ? duty.totalFail : 0}</div><div class="lbl">Checklist failures</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${duty ? duty.complaintsList.length : 0}</div><div class="lbl">Complaints</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${duty ? duty.avgGss : '—'}</div><div class="lbl">Avg GSS</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${night && night.revenue ? night.revenue.rooms : 0}</div><div class="lbl">Night rooms revenue</div></div>
      </div>
      <div class="dmr-card dmr-chart-card"><h3>Duty occupancy %</h3><div class="chart-box"><canvas id="fullOcc"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Inspection failures</h3><div class="chart-box"><canvas id="fullFail"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Night occupancy %</h3><div class="chart-box"><canvas id="fullNightOcc"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Night ADR and RevPAR</h3><div class="chart-box"><canvas id="fullRates"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Night revenue</h3><div class="chart-box"><canvas id="fullRevenue"></canvas></div></div>
      <div class="dmr-card dmr-section-card"><h3>Complaints in this period</h3>
        ${duty && duty.complaintsList.length ? duty.complaintsList.slice(0, 8).map(item => `<div class="dmr-recur-item"><span>${escapeHtml(item.date)} — ${escapeHtml(item.complaint || '')}</span></div>`).join('') : '<p>No complaints in this period.</p>'}
      </div>
      <button type="button" class="dmr-btn dmr-btn-primary" id="fullPdfBtn">Export full PDF</button>`;
    if (!charts || !window.occupancySeries) {
      const btn = document.getElementById('fullPdfBtn');
      if (btn) btn.onclick = () => exportFullPdf();
      return;
    }
    const dutySeries = window.occupancySeries(index || [], range.from, range.to);
    const occOptions = charts.chartFrame();
    occOptions.scales.y.suggestedMax = 100;
    charts.mountChart(document.getElementById('fullOcc'), {
      type: 'line',
      data: { labels: dutySeries.labels, datasets: [charts.areaSeries(document.getElementById('fullOcc'), 'Occupancy %', dutySeries.values, '#1e22aa', '30,34,170')] },
      options: occOptions
    });
    const fails = (duty && duty.topSections && duty.topSections.length) ? duty.topSections : [['No failures', 0]];
    const failOptions = charts.chartFrame();
    charts.mountChart(document.getElementById('fullFail'), {
      type: 'bar',
      data: { labels: fails.map(item => item[0]), datasets: [{ data: fails.map(item => item[1]), backgroundColor: '#7c6bf2', borderRadius: 8, maxBarThickness: 36 }] },
      options: failOptions
    });
    const nightOcc = ((night && night.occupancy) || []).map(value => value == null ? 0 : value);
    const nightOccOptions = charts.chartFrame();
    nightOccOptions.scales.y.suggestedMax = 100;
    charts.mountChart(document.getElementById('fullNightOcc'), {
      type: 'line',
      data: { labels: (night && night.labels) || [], datasets: [charts.areaSeries(document.getElementById('fullNightOcc'), 'Occupancy %', nightOcc, '#14b8a6', '20,184,166')] },
      options: nightOccOptions
    });
    const rateOptions = charts.chartFrame();
    rateOptions.plugins.legend = { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, color: '#5B6673', font: { family: 'Inter', size: 11 } } };
    const rates = document.getElementById('fullRates');
    charts.mountChart(rates, {
      type: 'line',
      data: { labels: (night && night.labels) || [], datasets: [
        charts.areaSeries(rates, 'ADR', (night && night.adr) || [], '#14b8a6', '20,184,166'),
        charts.areaSeries(rates, 'RevPAR', (night && night.revpar) || [], '#1e22aa', '30,34,170')
      ] },
      options: rateOptions
    });
    const revenue = (night && night.revenue) || {};
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
    doc.text(pack.from + '  to  ' + pack.to, 40, y);
    y += 18;
    const duty = pack.duty || {};
    doc.setFontSize(10);
    doc.text('Duty reports ' + (duty.days || 0) + '   Failures ' + (duty.totalFail || 0) + '   Complaints ' + ((duty.complaintsList || []).length) + '   GSS ' + (duty.avgGss || '—'), 40, y);
    y += 16;
    const series = window.occupancySeries(pack.index, pack.from, pack.to);
    const occImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false; options.scales.y.suggestedMax = 100;
      return new Chart(canvas, { type: 'line', data: { labels: series.labels, datasets: [charts.areaSeries(canvas, 'Occupancy %', series.values, '#1e22aa', '30,34,170')] }, options });
    });
    y = pdfChart(doc, W, y, 'Duty occupancy %', occImg);
    const fails = (duty.topSections && duty.topSections.length) ? duty.topSections : [['No failures', 0]];
    const failImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: { labels: fails.map(item => item[0]), datasets: [{ data: fails.map(item => item[1]), backgroundColor: '#7c6bf2', borderRadius: 8 }] }, options });
    });
    y = pdfChart(doc, W, y, 'Inspection failures', failImg);
    const night = pack.night || {};
    const nightOcc = (night.occupancy || []).map(value => value == null ? 0 : value);
    const nightImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false; options.scales.y.suggestedMax = 100;
      return new Chart(canvas, { type: 'line', data: { labels: night.labels || [], datasets: [charts.areaSeries(canvas, 'Occupancy %', nightOcc, '#14b8a6', '20,184,166')] }, options });
    });
    y = pdfChart(doc, W, y, 'Night occupancy %', nightImg);
    const rateImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false; options.plugins.legend.display = true;
      return new Chart(canvas, { type: 'line', data: { labels: night.labels || [], datasets: [
        charts.areaSeries(canvas, 'ADR', night.adr || [], '#14b8a6', '20,184,166'),
        charts.areaSeries(canvas, 'RevPAR', night.revpar || [], '#1e22aa', '30,34,170')
      ] }, options });
    });
    y = pdfChart(doc, W, y, 'Night ADR and RevPAR', rateImg);
    const revenue = night.revenue || {};
    const revImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      return new Chart(canvas, { type: 'bar', data: { labels: ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'], datasets: [{ data: [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], backgroundColor: ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2'], borderRadius: 8 }] }, options });
    });
    y = pdfChart(doc, W, y, 'Night revenue', revImg);
    if ((duty.complaintsList || []).length) {
      if (y > 700) { doc.addPage(); y = 48; }
      doc.setFontSize(11);
      doc.text('Guest complaints', 40, y);
      y += 14;
      duty.complaintsList.slice(0, 12).forEach(item => {
        if (y > 760) { doc.addPage(); y = 48; }
        doc.setFontSize(9);
        doc.text((item.date || '') + '  ' + (item.complaint || ''), 40, y, { maxWidth: W - 80 });
        y += 14;
      });
    }
    pdf.addPdfFooter(doc, W, 'Novotel — Full Report');
    doc.save('novotel-full-report-' + pack.from + '-to-' + pack.to + '.pdf');
  }

  window.renderNightSection = renderNightSection;
})();
