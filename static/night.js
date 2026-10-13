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
    if (!state || state.section !== 'night' || state.view !== 'today') {
      return '<h1>Night Manager</h1>';
    }
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

  window.renderNightSection = renderNightSection;
})();
