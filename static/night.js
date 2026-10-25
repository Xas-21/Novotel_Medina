(function(){
  const FC = ['totalOcc', 'arrRooms', 'depRooms', 'occPct', 'compRooms', 'averageRate'];
  const FC_LABELS = ['RM OCC', 'Arr rooms', 'Dep rooms', 'Occ %', 'Comp rooms', 'Average rate'];
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

  function moneyNumber(value){
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(/,/g, '').replace(/sar/ig, '').trim());
    return Number.isFinite(n) ? n : null;
  }

  function moneyPlain(value){
    const n = moneyNumber(value);
    if (n == null) return '';
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function formatEnteredMoney(value){
    const plain = moneyPlain(value);
    return plain === '' ? '' : plain + ' SAR';
  }

  function formatMoney(value){
    if (value == null || value === '') return '';
    const rounded = halfUp(value);
    if (rounded == null) return '';
    return rounded.toLocaleString('en-US') + ' SAR';
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
    if (!state) return '';
    if (state.section === 'full') {
      queueMicrotask(loadFullReport);
      return `
        ${window.periodBar ? window.periodBar() : ''}
        <div id="fullBody"><div class="dmr-empty"><h3>Loading full report…</h3></div></div>`;
    }
    if (state.section !== 'night') return '';
    if (state.view === 'archive') {
      queueMicrotask(loadNightArchive);
      return `
        <div class="dmr-sub">Night manager reports by month</div>
        <input type="date" id="archiveSearch" class="dmr-btn dmr-btn-ghost" style="padding:7px 12px;margin-bottom:12px;">
        <div id="archiveList"><div class="dmr-card"><div class="dmr-empty">Loading archive…</div></div></div>`;
    }
    if (state.view === 'analysis') {
      queueMicrotask(loadNightAnalysis);
      return `
        <div class="dmr-sub">Pick a day, a week, a month, the year to date, or any from and to dates</div>
        ${window.periodBar ? window.periodBar() : ''}
        <div id="nightAnalysisBody"><div class="dmr-empty"><h3>Loading night analysis…</h3></div></div>`;
    }
    if (state.view !== 'today') return '';
    const date = state.selectedDate;
    const token = ++loadToken;
    queueMicrotask(() => {
      hookDate();
      loadNight(date, token);
    });
    return `
      <div class="dmr-headline">
        <input type="date" id="dateInput" class="dmr-btn-ghost dmr-btn" style="padding:7px 12px;margin-left:auto;" value="${escapeHtml(date)}">
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

  function nightAcc(key, title, inner, extra){
    const open = window.state && window.state.openAcc && window.state.openAcc.has(key) ? 'open' : '';
    const side = extra
      ? `<span style="display:flex;align-items:center;gap:10px;">${extra}<span class="arrow">▾</span></span>`
      : '<span class="arrow">▾</span>';
    return `<details class="dmr-acc" data-acc="${key}" ${open}><summary><span>${title}</span>${side}</summary><div class="dmr-acc-body" style="padding-top:14px;">${inner}</div></details>`;
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
      ['Rooms revenue', moneyField('roomsRevenue', d.roomsRevenue, dis), calc('mtd-roomsRevenue', formatMoney(m.roomsRevenue))],
      ['ADR', calc('adr', formatMoney(c.adr)), calc('mtd-adr', formatMoney(m.adr))],
      ['RevPAR', calc('revpar', formatMoney(c.revpar)), calc('mtd-revpar', formatMoney(m.revpar))],
      ['F&amp;B', moneyField('fbRevenue', d.fbRevenue, dis), calc('mtd-fbRevenue', formatMoney(m.fbRevenue))],
      ['M&amp;E', moneyField('meRevenue', d.meRevenue, dis), calc('mtd-meRevenue', formatMoney(m.meRevenue))],
      ['OOD', moneyField('oodRevenue', d.oodRevenue, dis), calc('mtd-oodRevenue', formatMoney(m.oodRevenue))],
      ['Other', moneyField('otherRevenue', d.otherRevenue, dis), calc('mtd-otherRevenue', formatMoney(m.otherRevenue))],
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
        ${nightAcc('night-general', 'General information', `<table class="night-figures">
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
          </table>`, badge)}

        ${nightAcc('night-segments', 'Segments', `<table class="night-figures night-segments">
              <thead><tr><th>Code</th><th>Rooms</th></tr></thead>
              <tbody>
                ${d.segments.map((seg, i) => `
                  <tr>
                    <th>${escapeHtml(seg.code)}</th>
                    <td><input data-seg-rooms="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(seg.rooms)}" ${dis}></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          <p class="night-unassigned">Unassigned rooms <strong class="night-calc" data-calc="unassigned">${escapeHtml(formatCount(gap.unassigned))}</strong></p>`)}

        ${nightAcc('night-groups', 'Groups', `${d.groups.map((g, i) => `
            <div class="night-record" data-group="${i}">
              ${labeled('Day', `<input type="date" data-g="day" value="${escapeHtml(g.day)}" ${dis}>`)}
              ${labeled('Name', `<input data-g="name" value="${escapeHtml(g.name)}" ${dis}>`)}
              ${labeled('Rooms', `<input data-g="rooms" inputmode="decimal" value="${escapeHtml(g.rooms)}" ${dis}>`)}
              ${labeled('Arrival', `<input type="date" data-g="arrival" value="${escapeHtml(g.arrival)}" ${dis}>`)}
              ${labeled('Departure', `<input type="date" data-g="departure" value="${escapeHtml(g.departure)}" ${dis}>`)}
              <button type="button" class="dmr-dyn-del" data-night-del="group" ${dis}>✕</button>
            </div>`).join('')}
          <button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-night-add="group" ${dis}>+ Add group</button>`)}

        ${nightAcc('night-vip', 'VIP', `${d.vip.map((v, i) => `
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
          <button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-night-add="vip" ${dis}>+ Add VIP</button>`)}

        ${nightAcc('night-forecast', 'Forecast', `<div class="night-scroll">
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
                      ? `<td><span class="night-calc" data-fc="occPct" data-i="${i}" style="color:${window.occupancyCss ? window.occupancyCss(forecastOcc(day.totalOcc)) : ''}">${escapeHtml(window.withPercent ? window.withPercent(forecastOcc(day.totalOcc)) : forecastOcc(day.totalOcc))}</span></td>`
                      : `<td>${key === 'averageRate'
                        ? moneyField(null, day[key], dis, `data-fc="averageRate" data-i="${i}"`)
                        : `<input data-fc="${key}" data-i="${i}" inputmode="decimal" autocomplete="off" value="${escapeHtml(day[key])}" ${dis}>`}</td>`).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`)}

        ${window.renderNightInspection ? window.renderNightInspection(d.inspection, !!editingLocked()) : ''}

        <div class="dmr-card dmr-section-card">
          <p id="nightPrepared" class="dmr-prepared-by"${d.submittedBy ? '' : ' hidden'}>Prepared by: ${escapeHtml(d.submittedBy || '')}</p>
          <div id="nightNote" class="night-note"></div>
        </div>
        ${editingLocked() ? '' : `
        <div class="dmr-card" style="padding:18px;margin-top:10px;text-align:center;">
          <button type="button" class="dmr-btn dmr-btn-primary" id="nightSubmitBtn" style="width:100%;justify-content:center;padding:13px;font-size:14.5px;">✓ Submit &amp; Close Daily Report</button>
          <div class="dmr-sub" style="margin:8px 0 0;">Submitting finalizes the shift round, logs your signature, and archives the report.</div>
        </div>`}
      </div>`;
  }

  function field(name, value, dis){
    return `<input data-field="${name}" inputmode="decimal" autocomplete="off" value="${escapeHtml(value)}" ${dis}>`;
  }

  function moneyField(name, value, dis, extra){
    const attrs = extra || `data-field="${name}" data-money="1"`;
    return `<span class="money-entry"><input ${attrs} inputmode="decimal" autocomplete="off" value="${escapeHtml(moneyPlain(value))}" ${dis}><span class="money-tag">SAR</span></span>`;
  }

  function calc(name, text){
    const colored = name === 'occupancy' || name === 'mtd-occupancy';
    const style = colored && window.occupancyCss ? ` style="color:${window.occupancyCss(text)}"` : '';
    return `<span class="night-calc" data-calc="${name}"${style}>${escapeHtml(text)}</span>`;
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
      if (e.type === 'change' && (t.dataset.money || t.dataset.fc === 'averageRate')) {
        const plain = moneyPlain(t.value);
        if (String(t.value).trim() !== '' && plain !== '') t.value = plain;
      }
      if (t.dataset.fc === 'totalOcc') {
        const span = t.closest('tr') && t.closest('tr').querySelector('[data-fc="occPct"]');
        if (span) {
          const pct = forecastOcc(t.value);
          span.textContent = window.withPercent ? window.withPercent(pct) : pct;
          span.style.color = window.occupancyCss ? window.occupancyCss(pct) : '';
        }
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
    const summary = t.closest('#nightForm summary');
    if (summary) {
      const acc = summary.parentElement;
      setTimeout(() => {
        if (!window.state || !window.state.openAcc || !acc) return;
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
    const itemNoteAdd = t.closest('[data-chk-note-add], [data-dyn-note-add]');
    if (itemNoteAdd) { e.preventDefault(); editNightNotes(itemNoteAdd, null); return; }
    const itemNoteDel = t.closest('[data-chk-note-del], [data-dyn-note-del]');
    if (itemNoteDel) { e.preventDefault(); editNightNotes(itemNoteDel, parseInt(itemNoteDel.dataset.chkNoteDel || itemNoteDel.dataset.dynNoteDel, 10)); return; }
    const dynPhotoAdd = t.closest('[data-dyn-photo-add]');
    if (dynPhotoAdd) {
      e.preventDefault();
      const dynRow = dynPhotoAdd.closest('[data-dyn-list]');
      window.state.photoTarget = ['dyn', dynRow.dataset.dynList, dynRow.dataset.dynIdx];
      const input = document.getElementById('checklistPhotoInput');
      if (input) input.click();
      return;
    }
    const dynPhotoDel = t.closest('[data-dyn-photo-del]');
    if (dynPhotoDel) {
      e.preventDefault();
      syncDraftFromDom();
      const item = nightNoteTarget(dynPhotoDel);
      if (item && item.photos) item.photos.splice(parseInt(dynPhotoDel.dataset.dynPhotoDel, 10), 1);
      paint();
      queueNightSave();
      return;
    }
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

  function nightNoteTarget(el) {
    const chkRow = el.closest('[data-chk-section]');
    if (chkRow) {
      const arr = inspectionList(chkRow.dataset.chkSection);
      return arr && arr[parseInt(chkRow.dataset.chkIdx, 10)];
    }
    const dynRow = el.closest('[data-dyn-list]');
    const list = dynRow && draft.inspection && draft.inspection[dynRow.dataset.dynList];
    return list && list[parseInt(dynRow.dataset.dynIdx, 10)];
  }

  function editNightNotes(btn, removeIndex) {
    if (editingLocked() || !draft || !draft.inspection) return;
    syncDraftFromDom();
    const item = nightNoteTarget(btn);
    if (!item) return;
    const lines = String(item.comment || '').split('\n');
    if (removeIndex == null) lines.push('');
    else lines.splice(removeIndex, 1);
    item.comment = lines.join('\n');
    paint();
    queueNightSave();
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
    let item;
    if (target[0] === 'dyn') {
      item = (draft.inspection[target[1]] || [])[parseInt(target[2], 10)];
    } else {
      const arr = inspectionList(target[0]);
      item = arr && arr[parseInt(target[1], 10)];
    }
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
    if (window.state && window.state.openAcc) window.state.openAcc.add(kind === 'group' ? 'night-groups' : 'night-vip');
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
      const notes = row.querySelectorAll('[data-chk-note]');
      if (notes.length) arr[idx].comment = Array.from(notes).map(el => el.value).join('\n');
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
      const notes = row.querySelectorAll('[data-dyn-note]');
      if (notes.length) dataRow.comment = Array.from(notes).map(el => el.value).join('\n');
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
        FC.forEach(key => {
          if (key === 'averageRate') {
            const n = moneyNumber(day[key]);
            row[key] = n == null ? '' : String(n);
          } else row[key] = day[key];
        });
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
      allMembers: draft.allMembers || ''
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
    syncDraftFromDom();
    const gaps = window.missingNightSections ? window.missingNightSections(draft.inspection) : [];
    if (gaps.length && window.showSubmitGaps) { window.showSubmitGaps(gaps); return; }
    const saved = await saveNow();
    if (!saved) return;
    const date = window.state.selectedDate;
    const res = await window.apiFetch('/api/night/submit?date=' + encodeURIComponent(date), {method: 'POST'});
    if (res && Array.isArray(res.detail) && res.detail.length && window.showSubmitGaps) {
      window.showSubmitGaps(res.detail);
      return;
    }
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
    if (!el) return;
    el.textContent = text;
    if (name === 'occupancy' || name === 'mtd-occupancy') {
      el.style.color = window.occupancyCss ? window.occupancyCss(text) : '';
    }
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
    window.goTo('night', 'today');
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
        <div class="chart-box"><canvas id="night-occ-${group.key}"></canvas></div>
        ${group.entries.map(entry => `
          <div class="dmr-archive-row">
            <div>
              <div class="dmr-archive-date">${escapeHtml(fmtDate(entry.date))}</div>
              <span class="dmr-badge ${entry.status === 'submitted' ? 'dmr-badge-submitted' : 'dmr-badge-draft'}">${entry.status === 'submitted' ? 'Submitted' : 'Draft'}</span>
              ${entry.occupancy != null ? `<span style="font-size:12px;margin-left:8px;font-weight:700;color:${window.occupancyCss ? window.occupancyCss(entry.occupancy) : ''}">Occ: ${escapeHtml(window.withPercent ? window.withPercent(entry.occupancy) : entry.occupancy + '%')}</span>` : ''}
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
    const drawMonth = key => {
      if (!window.drawOccupancyChart || !window.occupancySeries) return;
      const thisMonth = window.todayStr().slice(0, 7);
      const end = key === thisMonth ? window.todayStr() : window.monthLastDay(key + '-01');
      window.drawOccupancyChart('night-occ-' + key, window.occupancySeries(nightArchive, key + '-01', end));
    };
    window.groupByMonth(rows).forEach(group => drawMonth(group.key));
    el.querySelectorAll('details.archive-month').forEach(details => {
      details.ontoggle = () => {
        const canvas = details.open && details.querySelector('canvas');
        if (canvas) drawMonth(canvas.id.replace('night-occ-', ''));
      };
    });
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
      ${window.kpiBoard ? window.kpiBoard(nightTiers(data)) : ''}
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
    const h = window.NovotelCharts.pdfChartHeight(W - 80);
    if (y + h + 24 > 770) { doc.addPage(); y = 48; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(28, 43, 57);
    doc.text(title, 40, y);
    y += 8;
    doc.addImage(image, 'PNG', 40, y, W - 80, h, undefined, 'FAST');
    return y + h + 14;
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
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth();
    const logo = await pdf.getLogoDataUrl();
    let y = pdf.pdfHeader(doc, W, logo, 'NIGHT ANALYSIS');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text((state.periodFrom || '') + '  to  ' + (state.periodTo || data.date || ''), 40, y);
    y += 12;
    y = pdf.pdfKpiBoard(doc, W, y, nightTiers(data));
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
    let y = pdf.pdfMasthead(doc, W, logo, { title: 'Night Manager Report', date: fmtDate(data.date || date), preparedBy: data.submittedBy });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(35, 48, 61);
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
      ['Rooms revenue', formatEnteredMoney(data.roomsRevenue), formatMoney(m.roomsRevenue)],
      ['ADR', formatMoney(c.adr), formatMoney(m.adr)],
      ['RevPAR', formatMoney(c.revpar), formatMoney(m.revpar)],
      ['F&B', formatEnteredMoney(data.fbRevenue), formatMoney(m.fbRevenue)],
      ['M&E', formatEnteredMoney(data.meRevenue), formatMoney(m.meRevenue)],
      ['OOD', formatEnteredMoney(data.oodRevenue), formatMoney(m.oodRevenue)],
      ['Other', formatEnteredMoney(data.otherRevenue), formatMoney(m.otherRevenue)],
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
    if (analysis && window.NovotelPdf) y = pdf.pdfKpiBoard(doc, W, y, nightTiers(analysis));
    y = await appendNightAnalysisCharts(doc, W, y, analysis);
    const gap = data.segmentGap || {};
    const segmentRows = (data.segments || []).map(seg => ({CODE: seg.code, ROOMS: String(seg.rooms ?? '')}));
    segmentRows.push({CODE: 'Unassigned', ROOMS: String(gap.unassigned ?? '')});
    y = pdf.pdfTable(doc, W, y, [
      {key:'CODE', label:'SEGMENT', w:260},
      {key:'ROOMS', label:'ROOMS', w:200}
    ], segmentRows);
    y += 8;
    if (y + 36 > 780) { doc.addPage(); y = 45; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(28, 43, 57);
    doc.text('Forecast', 40, y + 12);
    y += 20;
    y = pdf.pdfTable(doc, W, y, [
      {key:'DATE', label:'DATE', w:70},
      {key:'OCC', label:'RM OCC', w:56},
      {key:'ARR', label:'ARR', w:48},
      {key:'DEP', label:'DEP', w:48},
      {key:'PCT', label:'OCC %', w:52},
      {key:'COMP', label:'COMP ROOMS', w:70},
      {key:'RATE', label:'AVG RATE', w:86}
    ], (data.forecast || []).map(day => ({
      DATE: day.date,
      OCC: String(day.totalOcc ?? ''),
      ARR: String(day.arrRooms ?? ''),
      DEP: String(day.depRooms ?? ''),
      PCT: window.withPercent ? window.withPercent(day.occPct) : (day.occPct == null || day.occPct === '' ? '' : day.occPct + '%'),
      PCT_color: window.occupancyColor ? window.occupancyColor(day.occPct) : undefined,
      COMP: String(day.compRooms ?? ''),
      RATE: formatEnteredMoney(day.averageRate)
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
    pdf.addPdfFooter(doc, W, 'Novotel — Night Manager Report', startPage);
  }

  async function exportNightPdf(date){
    if (!window.jspdf || !window.NovotelPdf) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
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
    const revparValues = ((night && night.revpar) || []).filter(value => value != null);
    const avgRevpar = revparValues.length ? Math.round(revparValues.reduce((sum, value) => sum + Number(value), 0) / revparValues.length) : null;
    const avgAdr = night && night.avgAdr != null ? night.avgAdr : null;
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
      guestDeparture: guest && guest.avgDeparture != null ? guest.avgDeparture : '—',
      guestUrgent: guest ? guest.urgent || 0 : 0,
      guestVipOcc: guest && guest.avgVipOcc != null ? guest.avgVipOcc + '%' : '—',
      guestVipOccValue: guest ? guest.avgVipOcc : null,
      roomsValue: revenue.rooms || 0,
      avgAdrValue: avgAdr,
      avgRevparValue: avgRevpar,
      roomsSold: night ? night.roomsSold : null,
      avgOccupancy: night ? night.avgOccupancy : null,
      weekdayOccupancy: night ? night.weekdayOccupancy : null,
      weekendOccupancy: night ? night.weekendOccupancy : null,
      weekdayAdr: night ? night.weekdayAdr : null,
      weekendAdr: night ? night.weekendAdr : null,
      loyaltyMembers: night && Array.isArray(night.loyalty) ? night.loyalty.reduce((sum, value) => sum + (Number(value) || 0), 0) : null
    };
  }

  function dashboardTiers(stats){
    const tones = window.kpiTones;
    const n = window.kpiNumber;
    const has = value => value != null && value !== '' && value !== '—';
    return [
      { title: 'Revenue, Occupancy, Volume & Guest Satisfaction', kind: 'hero', cards: [
        { label: 'Night rooms revenue', value: n(stats.roomsValue), unit: 'SAR', tone: 'indigo', badge: 'Primary KPI', note: 'Room revenue in this period' },
        { label: 'Rooms sold', value: has(stats.roomsSold) ? n(stats.roomsSold) : '—', tone: 'teal', note: 'Occupied room nights in this period' },
        { label: 'Avg RevPAR', value: has(stats.avgRevparValue) ? n(stats.avgRevparValue) : '—', unit: 'SAR', tone: 'indigo', note: 'Average revenue per available room' },
        window.nightOccupancyCard(stats.avgOccupancy, stats.weekdayOccupancy, stats.weekendOccupancy),
        window.nightAdrCard(stats.avgAdrValue, stats.weekdayAdr, stats.weekendAdr),
        Object.assign({ label: 'Avg TrustYou GSS', value: stats.gss, tone: 'teal', note: 'Out of 100 guest score index' }, window.gssStatus(stats.gss)),
        window.occupancyCard('Avg VIP occ', stats.guestVipOccValue, 'VIP arrivals ÷ hotel rooms', Number(stats.guestVipOccValue) > 0 ? { badge: 'Active', badgeColor: tones.indigo } : {}),
        { label: 'ALL Loyalty Members', value: stats.loyaltyMembers == null ? '—' : n(stats.loyaltyMembers), color: '#7c6bf2', note: 'Total entered on night reports in this period' }
      ] },
      { title: 'Operational Report Submission Compliance', kind: 'pair', cards: [
        { title: 'Duty Reports Submission', done: stats.dutySubmitted, open: stats.dutyMissing, doneLabel: 'Duty reports submitted', openLabel: 'Duty days not submitted' },
        { title: 'Night Audit Reports', done: stats.nightFiled, open: stats.nightMissing, doneLabel: 'Night reports submitted', openLabel: 'Nights not submitted' },
        { title: 'Guest Relation Logs', done: stats.guestSubmitted || 0, open: stats.guestMissing || 0, doneLabel: 'Guest Relation submitted', openLabel: 'Guest Relation days not submitted' }
      ] },
      { title: 'Quality Control, Guest Complaints & Survey Status', kind: 'compact', cards: [
        { label: 'Checklist failures', value: n(stats.failures), tone: 'amber', note: stats.failures ? 'Flagged across daily inspections' : 'No inspection failures' },
        { label: 'Guest complaints', value: n(stats.complaints), tone: 'indigo', note: 'Logged during this period' },
        { label: 'Not satisfied guests', value: n(stats.guestNotSatisfied || 0), tone: 'amber', note: stats.guestNotSatisfied ? 'Marked not satisfied by Guest Relation' : 'No dissatisfied guest reports' },
        { label: 'Urgent guest actions', value: n(stats.guestUrgent || 0), tone: 'crimson', note: stats.guestUrgent ? 'Guest rows marked urgent' : 'No urgent escalations' },
        { label: 'Avg departure score', value: has(stats.guestDeparture) ? stats.guestDeparture : '—', tone: 'teal', note: has(stats.guestDeparture) ? 'Departure courtesy call score' : 'No departure surveys recorded' }
      ] },
      { title: 'Parking Status Right Now', kind: 'compact', cards: stats.parking ? [
        { label: 'Available', value: n(stats.parking.available), color: '#FFFFFF', fill: '#4F7A5B', note: 'Free spots ready for a car' },
        { label: 'Occupied', value: n(stats.parking.occupied), color: '#FFFFFF', fill: '#B14B3F', note: 'Cars in, not due out today' },
        { label: 'Due out', value: n(stats.parking['due-today']), color: '#FFFFFF', fill: '#C4813C', note: 'Cars expected to leave today' },
        { label: 'Overdue', value: n(stats.parking.overdue), color: '#FFFFFF', fill: '#5E1F1A', note: 'Past the expected checkout time' },
        { label: 'Out of service', value: n(stats.parking['out-of-service']), color: '#FFFFFF', fill: '#8A9099', note: 'Spots closed by an admin' }
      ] : [] }
    ];
  }

  function nightTiers(data){
    const tones = window.kpiTones;
    const n = window.kpiNumber;
    const revenue = data.revenue || {};
    const mean = list => {
      const values = (list || []).filter(v => v != null).map(Number).filter(Number.isFinite);
      return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    };
    const occ = data.occupancy || [];
    let peak = null;
    occ.forEach((value, i) => { if (value != null && (peak == null || value > peak.value)) peak = { value: value, label: (data.labels || [])[i] }; });
    const filed = data.filedNights != null ? data.filedNights : occ.filter(v => v != null).length;
    const money = (label, value, note) => ({ label: label, value: n(value || 0), unit: 'SAR', tone: 'indigo', note: note });
    return [
      { title: 'Revenue, Occupancy & Rate Benchmarks', kind: 'hero', cards: [
        { label: 'Night rooms revenue', value: n(revenue.rooms || 0), unit: 'SAR', tone: 'indigo', badge: 'Primary KPI', note: 'Room revenue in this period' },
        { label: 'Rooms sold', value: data.roomsSold != null ? n(data.roomsSold) : '—', tone: 'teal', note: 'Occupied room nights in this period' },
        { label: 'Avg RevPAR', value: mean(data.revpar) == null ? '—' : n(mean(data.revpar)), unit: 'SAR', tone: 'indigo', note: 'Average revenue per available room' },
        window.nightOccupancyCard(data.avgOccupancy, data.weekdayOccupancy, data.weekendOccupancy),
        window.nightAdrCard(data.avgAdr, data.weekdayAdr, data.weekendAdr),
        { label: 'Grand total revenue', value: n(data.grandTotal || 0), unit: 'SAR', tone: 'indigo', badge: 'All outlets', badgeColor: tones.indigo, note: 'Rooms + F&B + M&E + OOD + Other' }
      ] },
      { title: 'Night Audit Submission Compliance', kind: 'pair', cards: [
        { title: 'Night Audit Reports', done: filed, open: Math.max(0, occ.length - filed), doneLabel: 'Night reports submitted', openLabel: 'Nights not submitted' }
      ] },
      { title: 'Revenue Mix & Peak Night', kind: 'compact', cards: [
        money('F&B revenue', revenue.fb, 'Food and beverage'),
        money('M&E revenue', revenue.me, 'Meetings and events'),
        money('OOD revenue', revenue.ood, 'Other operated departments'),
        money('Other revenue', revenue.other, 'Remaining income'),
        window.occupancyCard('Peak occupancy', peak ? peak.value : null, peak ? 'Highest night: ' + (/^\d+$/.test(String(peak.label)) ? 'day ' : '') + peak.label : 'No nights filed')
      ] }
    ];
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
      doc.addImage(pie.image, 'PNG', x, y + 6, boxW, imgH, undefined, 'FAST');
    });
    return y + 14 + imgH;
  }

  async function loadFullReport(){
    const state = window.state;
    const body = document.getElementById('fullBody');
    if (!body) return;
    const range = { from: state.periodFrom, to: state.periodTo };
    const compare = comparisonWindow(state.periodMode, range.from, range.to);
    const [duty, night, guest, spots, prevNight] = await Promise.all([
      window.apiFetch('/api/reports/analysis?' + window.periodQuery()),
      window.apiFetch('/api/night/analysis?' + window.periodQuery()),
      window.apiFetch('/api/guest/analysis?' + window.periodQuery()),
      window.apiFetch('/api/parking/spots'),
      window.apiFetch('/api/night/analysis?date=' + encodeURIComponent(compare.to) + '&range=week&start=' + encodeURIComponent(compare.from))
    ]);
    const index = await window.apiFetch('/api/reports/index');
    relabel(night);
    if (!document.getElementById('fullBody')) return;
    const stats = dashboardStats(duty, night, index || [], range.from, range.to, guest);
    stats.parking = Array.isArray(spots) && window.parkingCounts ? window.parkingCounts(spots) : null;
    const revenue = stats.revenue;
    fullPack = { duty: duty, night: night, guest: guest, index: index || [], from: range.from, to: range.to, stats: stats };
    window.currentDutyAnalysis = duty;
    const charts = window.NovotelCharts;
    body.innerHTML = dashboardHtml(stats, duty, night, guest, prevNight, compare);
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
    drawPie('pieRevenue', ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'], [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2']);
    if (window.guestPriorityChart) window.guestPriorityChart(document.getElementById('guestPriority'), guest || {}, false);
    if (window.guestVipChart) window.guestVipChart(document.getElementById('guestVip'), guest || {}, false);
    const revOptions = charts.chartFrame();
    revOptions.indexAxis = 'y';
    revOptions.scales.y.grid = { display: false };
    charts.mountChart(document.getElementById('fullRevenue'), {
      type: 'bar',
      data: {
        labels: ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'],
        datasets: [{ label: 'Revenue (SAR)', data: [revenue.rooms || 0, revenue.fb || 0, revenue.me || 0, revenue.ood || 0, revenue.other || 0], backgroundColor: ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2'], borderRadius: 6, maxBarThickness: 16 }]
      },
      options: revOptions
    });
    const segments = (night && night.segments) || [];
    const segOptions = charts.chartFrame();
    segOptions.indexAxis = 'y';
    segOptions.scales.y.grid = { display: false };
    segOptions.scales.x.beginAtZero = true;
    charts.mountChart(document.getElementById('fullSegments'), {
      type: 'bar',
      data: {
        labels: segments.map(seg => seg.code),
        datasets: [{ label: 'Rooms', data: segments.map(seg => seg.rooms || 0), backgroundColor: '#5b60ff', borderRadius: 6, borderSkipped: false, maxBarThickness: 16 }]
      },
      options: segOptions
    });
    const btn = document.getElementById('fullPdfBtn');
    if (btn) btn.onclick = () => exportFullPdf();
  }

  const DASH_TABS = { main: 'perf', side: 'parking', list: 'actions', pie: 'mix' };
  const DASH_ICONS = {
    money: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.2 1.7 3 2 3 .9 3 2.1-1.3 1.9-3 1.9c-1.4 0-2.6-.6-3-1.6M12 6v2M12 16v2"/></svg>',
    bed: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V8l9-5 9 5v13M9 21v-7h6v7"/></svg>',
    trend: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>',
    users: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/></svg>',
    pdf: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>'
  };

  function dashTabFor(group){
    const tabs = window.state && window.state.dashTabs;
    return (tabs && tabs[group]) || DASH_TABS[group];
  }

  function dashTabs(group, items, extra){
    return `<div class="dash-tabs" role="tablist">${items.map(([id, label]) => {
      const on = dashTabFor(group) === id;
      return `<button type="button" role="tab" class="dash-tab${on ? ' on' : ''}" data-dash-group="${group}" data-dash-tab="${id}" aria-selected="${on}">${label}</button>`;
    }).join('')}${extra ? `<div class="dash-tabs-end">${extra}</div>` : ''}</div>`;
  }

  function dashPane(group, id, html){
    return `<div class="dash-pane${dashTabFor(group) === id ? ' on' : ''}" data-dash-pane="${group}:${id}" role="tabpanel">${html}</div>`;
  }

  function dashCanvas(id){
    return `<div class="dash-canvas"><canvas id="${id}"></canvas></div>`;
  }

  function dashRing(outerPct, innerPct, outerColor, innerColor){
    const arc = (r, width, pct, color) => {
      const length = 2 * Math.PI * r;
      const share = Math.max(0, Math.min(100, Number(pct) || 0));
      const track = `<circle cx="75" cy="75" r="${r}" class="dash-ring-track" stroke-width="${width}"/>`;
      if (!share) return track;
      return track + `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length * (1 - share / 100)).toFixed(1)}"/>`;
    };
    return `<svg viewBox="0 0 150 150" aria-hidden="true">${arc(68, 9, outerPct, outerColor)}${arc(55, 9, innerPct, innerColor)}<circle cx="75" cy="75" r="44" class="dash-ring-core"/></svg>`;
  }

  function comparisonWindow(mode, from, to){
    const parts = iso => iso.split('-').map(Number);
    const iso = date => date.toISOString().slice(0, 10);
    const monthEnd = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const addDays = (value, count) => {
      const [y, m, d] = parts(value);
      return iso(new Date(Date.UTC(y, m - 1, d + count)));
    };
    const backMonths = (value, count) => {
      const [y, m, d] = parts(value);
      const target = new Date(Date.UTC(y, m - 1 - count, 1));
      const last = monthEnd(target.getUTCFullYear(), target.getUTCMonth());
      const day = d === monthEnd(y, m - 1) ? last : Math.min(d, last);
      return iso(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)));
    };
    if (mode === 'today') return { from: addDays(from, -1), to: addDays(to, -1), label: 'vs yesterday' };
    if (mode === 'month') return { from: backMonths(from, 1), to: backMonths(to, 1), label: 'vs last month' };
    if (mode === 'ytd') return { from: backMonths(from, 12), to: backMonths(to, 12), label: 'vs last year' };
    const [fy, fm, fd] = parts(from);
    const [ty, tm, td] = parts(to);
    const span = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
    return { from: addDays(from, -span), to: addDays(to, -span), label: mode === 'week' ? 'vs last week' : 'vs previous period' };
  }

  function nightHeadline(night){
    if (!night) return {};
    const revenue = night.revenue || {};
    const revpar = (night.revpar || []).filter(value => value != null).map(Number);
    const loyalty = (night.loyalty || []).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const filed = (night.occupancy || []).some(value => value != null);
    return {
      grand: night.grandTotal != null ? night.grandTotal : (revenue.rooms || 0) + (revenue.fb || 0) + (revenue.me || 0) + (revenue.ood || 0) + (revenue.other || 0),
      revpar: revpar.length ? Math.round(revpar.reduce((a, b) => a + b, 0) / revpar.length) : null,
      adr: night.avgAdr != null ? night.avgAdr : null,
      loyalty: filed ? loyalty : null
    };
  }

  function dashboardHtml(stats, duty, night, guest, prevNight, compare){
    const n = window.kpiNumber;
    const has = value => value != null && value !== '' && value !== '—' && Number.isFinite(Number(value));
    const pct = value => has(value) ? n(value, 1) + '%' : '—';
    const sar = value => has(value) ? 'SAR ' + n(value) : '—';
    const count = value => has(value) ? n(value) : '—';
    const revenue = stats.revenue || {};
    const grand = night && night.grandTotal != null ? night.grandTotal : (revenue.rooms || 0) + (revenue.fb || 0) + (revenue.me || 0) + (revenue.ood || 0) + (revenue.other || 0);
    const parking = stats.parking;
    const sections = [
      ['Duty Manager', stats.dutySubmitted, stats.dutyMissing],
      ['Night Manager', stats.nightFiled, stats.nightMissing],
      ['Guest Relation', stats.guestSubmitted || 0, stats.guestMissing || 0]
    ];
    const reportsIn = sections.reduce((sum, row) => sum + (row[1] || 0), 0);
    const reportsAll = sections.reduce((sum, row) => sum + (row[1] || 0) + (row[2] || 0), 0);
    const departure = guest && guest.avgDeparture != null ? guest.avgDeparture : null;
    const callRating = guest && guest.avgEmployee != null ? guest.avgEmployee : null;
    const reviews = duty && duty.reviewsSum ? duty.reviewsSum : null;
    const complaints = (duty && duty.complaintsList) || [];
    const revparSplit = { weekday: [], weekend: [] };
    const fromIso = window.state && window.state.periodFrom;
    ((night && night.revpar) || []).forEach((value, i) => {
      if (value == null || !fromIso) return;
      const day = new Date(fromIso + 'T00:00:00');
      day.setDate(day.getDate() + i);
      const weekend = day.getDay() === 4 || day.getDay() === 5;
      revparSplit[weekend ? 'weekend' : 'weekday'].push(Number(value));
    });
    const mean = list => list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null;
    const split = (weekday, weekend) => `<span class="dash-wd">Weekday ${weekday}</span> · <span class="dash-we">Weekend ${weekend}</span>`;

    const prev = nightHeadline(prevNight);
    const vs = (current, before) => {
      const range = compare ? `${compare.from} to ${compare.to}` : '';
      const label = compare ? compare.label : '';
      if (!has(current) || !has(before) || Number(before) === 0) {
        return `<span class="dash-vs none" title="No figures for ${escapeHtml(range)}">— ${escapeHtml(label)}</span>`;
      }
      const change = (Number(current) - Number(before)) / Math.abs(Number(before)) * 100;
      const tone = change > 0 ? 'up' : (change < 0 ? 'down' : 'flat');
      const arrow = change > 0 ? '▲' : (change < 0 ? '▼' : '■');
      return `<span class="dash-vs ${tone}" title="${escapeHtml(range)}: ${escapeHtml(n(before))}">${arrow} ${n(Math.abs(change), 1)}% <em>${escapeHtml(label)}</em></span>`;
    };
    const hero = (label, value, note, icon, tone, lead, extra, delta) => `
      <div class="dash-card dash-kpi${lead ? ' lead' : ''}${extra ? ' ' + extra : ''}">
        <div><span class="dash-label">${label}</span><div class="dash-kpi-value"><strong>${value}</strong>${delta || ''}</div><small>${note}</small></div>
        <span class="dash-badge ${tone}">${DASH_ICONS[icon]}</span>
      </div>`;
    const tile = (label, value, color, note, action) => action
      ? `<button type="button" class="dash-tile is-link" style="background:${color}" title="${escapeHtml(note)}" ${action}><span>${label}</span><strong>${value}</strong></button>`
      : `<div class="dash-tile" style="background:${color}" title="${escapeHtml(note)}"><span>${label}</span><strong>${value}</strong></div>`;
    const fact = (tone, label, hint, value) => `<div class="dash-fact ${tone}"><span class="dash-fact-label">${label}</span><span class="dash-fact-hint">${hint}</span><strong>${value}</strong></div>`;
    const parkRows = [
      ['Available', 'available', '#4F7A5B', 'Free spots ready for a car'],
      ['Occupied', 'occupied', '#B14B3F', 'Cars in, not due out today'],
      ['Due out', 'due-today', '#C4813C', 'Cars expected to leave today'],
      ['Overdue', 'overdue', '#7a2a23', 'Past the expected checkout time'],
      ['Out of service', 'out-of-service', '#8A9099', 'Spots closed by an admin']
    ];
    const parkTotal = parking ? parkRows.reduce((sum, row) => sum + (parking[row[1]] || 0), 0) : 0;

    return `
    <div class="dash">
      <section class="dash-hero">
        ${hero('Total revenue', sar(grand), 'Rooms + F&amp;B + M&amp;E + OOD + Other', 'money', 'brass', true, '', vs(grand, prev.grand))}
        ${hero('Avg RevPAR', sar(stats.avgRevparValue), split(sar(mean(revparSplit.weekday)), sar(mean(revparSplit.weekend))), 'bed', 'blue', false, '', vs(stats.avgRevparValue, prev.revpar))}
        ${hero('Avg ADR', sar(stats.avgAdrValue), split(sar(stats.weekdayAdr), sar(stats.weekendAdr)), 'trend', 'teal', false, '', vs(stats.avgAdrValue, prev.adr))}
        ${hero('ALL Loyalty Members', count(stats.loyaltyMembers), 'Total entered on night reports in this period', 'users', 'violet', false, 'loyalty', vs(stats.loyaltyMembers, prev.loyalty))}
      </section>

      <section class="dash-strip">
        ${tile('Rooms sold', count(stats.roomsSold), '#1e22aa', 'Occupied room nights in this period')}
        ${tile('Reports in', `${n(reportsIn)} / ${n(reportsAll)}`, '#3f7f5a', 'Duty, Night and Guest Relation reports submitted')}
        ${tile('Check fails', count(stats.failures), '#C4813C', 'Show the failed checks', 'data-dash-open="fails"')}
        ${tile('Complaints', count(stats.complaints), '#3a3f86', 'Show the guest complaints', 'data-dash-open="complaints"')}
        ${tile('Urgent', count(stats.guestUrgent || 0), '#B14B3F', 'Show the urgent guest actions', 'data-dash-open="urgent"')}
        ${tile('Mid', count(guest && guest.priority ? guest.priority.Mid || 0 : 0), '#b8860b', 'Show the mid priority guest actions', 'data-dash-open="mid"')}
        ${tile('Normal', count(guest && guest.priority ? guest.priority.Normal || 0 : 0), '#2b31b8', 'Show the normal priority guest actions', 'data-dash-open="normal"')}
        ${tile('Not satisfied', count(stats.guestNotSatisfied || 0), '#8c6b3f', 'Show the guests marked not satisfied', 'data-dash-open="unhappy"')}
      </section>

      <section class="dash-row">
        <div class="dash-card dash-panel">
          ${dashTabs('main', [['perf', 'Performance'], ['rooms', 'Room revenue'], ['nightOcc', 'Night occ'], ['dutyOcc', 'Duty occ'], ['rates', 'ADR &amp; RevPAR'], ['gss', 'GSS'], ['vip', 'VIP guests'], ['fails', 'Inspections']],
            `<button type="button" class="dash-export" id="fullPdfBtn" title="Export dashboard PDF">${DASH_ICONS.pdf}<span>Export PDF</span></button>`)}
          <div class="dash-body">
            ${dashPane('main', 'perf', `
              <div class="dash-perf">
                <div class="dash-block">
                  <h4>Occupancy</h4>
                  <div class="dash-ring">${dashRing(stats.weekendOccupancy, stats.weekdayOccupancy, '#14b8a6', '#5b60ff')}<div class="dash-ring-mid"><strong>${has(stats.avgOccupancy) ? Math.round(stats.avgOccupancy) + '%' : '—'}</strong><small>Avg occupancy</small></div></div>
                  <div class="dash-facts">
                    ${fact('a', 'Weekend', 'Thu – Fri', pct(stats.weekendOccupancy))}
                    ${fact('b', 'Weekday', 'Sat – Wed', pct(stats.weekdayOccupancy))}
                    ${fact('c', 'VIP Avg Occupancy %', 'VIP arrivals ÷ rooms', pct(stats.guestVipOccValue))}
                  </div>
                </div>
                <div class="dash-sep"></div>
                <div class="dash-block">
                  <h4>Guest satisfaction</h4>
                  <div class="dash-ring">${dashRing(stats.gss, departure != null ? departure * 10 : null, '#14b8a6', '#A8814F')}<div class="dash-ring-mid"><strong>${has(stats.gss) ? n(stats.gss, 1) : '—'}</strong><small>TrustYou GSS</small></div></div>
                  <div class="dash-facts">
                    ${fact('a', 'Departure score', 'out of 10', departure != null ? n(departure, 1) : '—')}
                    ${fact('d', 'Call rating', 'out of 10', callRating != null ? n(callRating, 1) : '—')}
                    ${fact('c', 'Reviews', 'TrustYou', reviews != null ? n(reviews) : '—')}
                  </div>
                </div>
              </div>`)}
            ${dashPane('main', 'rooms', dashCanvas('fullRooms'))}
            ${dashPane('main', 'nightOcc', dashCanvas('fullNightOcc'))}
            ${dashPane('main', 'dutyOcc', dashCanvas('fullOcc'))}
            ${dashPane('main', 'rates', dashCanvas('fullRates'))}
            ${dashPane('main', 'gss', dashCanvas('fullGss'))}
            ${dashPane('main', 'vip', dashCanvas('guestVip'))}
            ${dashPane('main', 'fails', dashCanvas('fullFail'))}
          </div>
        </div>

        <div class="dash-card dash-panel">
          ${dashTabs('side', [['parking', 'Parking now'], ['depts', 'Revenue by departments'], ['compliance', 'Report compliance'], ['segments', 'Segments']])}
          <div class="dash-body">
            ${dashPane('side', 'depts', dashCanvas('fullRevenue'))}
            ${dashPane('side', 'compliance', `
              <div class="dash-gauges">
                ${sections.map(([label, done, open], i) => {
                  const total = (done || 0) + (open || 0);
                  const share = total ? (done || 0) / total : 0;
                  const length = 2 * Math.PI * 30;
                  const color = ['#14b8a6', '#5b60ff', '#A8814F'][i];
                  return `<div class="dash-gauge">
                    <div class="dash-gauge-ring"><svg viewBox="0 0 74 74" aria-hidden="true"><circle cx="37" cy="37" r="30" class="dash-ring-track" stroke-width="7"/>${share ? `<circle cx="37" cy="37" r="30" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length * (1 - share)).toFixed(1)}"/>` : ''}</svg><strong>${n(done || 0)}/${n(total)}</strong></div>
                    <span>${label.split(' ')[0]}</span>
                    <small>${n(open || 0)} missing</small>
                  </div>`;
                }).join('')}
              </div>`)}
            ${dashPane('side', 'segments', `<p class="dash-caption">Rooms by segment on ${escapeHtml((window.state && window.state.periodTo) || '')}</p><div class="dash-canvas dash-canvas-captioned"><canvas id="fullSegments"></canvas></div>`)}
            ${dashPane('side', 'parking', parking ? `
              <div class="dash-park">
                ${parkRows.map(([label, key, color, note]) => `<button type="button" class="dash-park-card" style="background:${color}" title="${escapeHtml(note)} · Open Manage Parkings" data-dash-go="parking"><span>${label}</span><strong>${n(parking[key] || 0)}</strong></button>`).join('')}
                <button type="button" class="dash-park-card total" title="All parking spots · Open Manage Parkings" data-dash-go="parking"><span>Total spots</span><strong>${n(parkTotal)}</strong></button>
              </div>` : '<p class="dash-empty">Parking status is not available for this account.</p>')}
          </div>
        </div>
      </section>

      <section class="dash-row">
        <div class="dash-card dash-panel">
          ${dashTabs('list', [['actions', `Action items${duty && duty.totalNotesOpen ? ' · ' + n(duty.totalNotesOpen) + ' open' : ''}`], ['complaints', `Complaints · ${n(complaints.length)}`], ['reports', 'Report submission']])}
          <div class="dash-body">
            ${dashPane('list', 'actions', `<div class="dash-scroll">${window.dashActionRows ? window.dashActionRows((duty && duty.actionItems) || []) : ''}</div>`)}
            ${dashPane('list', 'complaints', `<div class="dash-scroll">${complaints.length ? `
              <table class="dash-table"><thead><tr><th>Complaint</th><th>Room</th><th>Date</th><th class="r">Action</th></tr></thead><tbody>
                ${complaints.map(item => `<tr><td>${escapeHtml(item.complaint || '')}</td><td>${escapeHtml(item.room || '—')}</td><td>${escapeHtml(item.date || '')}</td><td class="r">${escapeHtml(item.action || '—')}</td></tr>`).join('')}
              </tbody></table>` : '<p class="dash-empty">No complaints in this period.</p>'}</div>`)}
            ${dashPane('list', 'reports', `<div class="dash-scroll">
              <table class="dash-table"><thead><tr><th>Section</th><th>Submitted</th><th>Not submitted</th><th class="r">Rate</th></tr></thead><tbody>
                ${sections.map(([label, done, open]) => {
                  const total = (done || 0) + (open || 0);
                  const rate = total ? Math.round((done || 0) / total * 100) : 0;
                  const tone = rate >= 100 ? 'dmr-status-closed' : (rate >= 50 ? 'dmr-status-progress' : 'dmr-status-open');
                  return `<tr><td>${label}</td><td>${n(done || 0)}</td><td>${n(open || 0)}</td><td class="r"><span class="dash-pill ${tone}">${rate}%</span></td></tr>`;
                }).join('')}
              </tbody></table></div>`)}
          </div>
        </div>

        <div class="dash-card dash-panel">
          ${dashTabs('pie', [['mix', 'Revenue mix'], ['priority', 'Guest priority']])}
          <div class="dash-body">
            ${dashPane('pie', 'mix', dashCanvas('pieRevenue'))}
            ${dashPane('pie', 'priority', dashCanvas('guestPriority'))}
          </div>
        </div>
      </section>
    </div>`;
  }

  function dashDetail(label, value){
    const text = value == null ? '' : String(value).trim();
    return text ? `<div class="dash-pop-field"><span>${label}</span>${escapeHtml(text)}</div>` : '';
  }

  function dashPopupContent(kind){
    const duty = (fullPack && fullPack.duty) || {};
    const guest = (fullPack && fullPack.guest) || {};
    const guestButton = date => `<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-open-guest="${escapeHtml(date)}">Open Guest Relation report</button>`;
    const dutyButton = date => `<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-review-date="${escapeHtml(date)}">Open Duty report</button>`;
    const row = (heading, meta, fields, button) => `
      <div class="dash-pop-row">
        <div class="dash-pop-main">
          <div class="dash-pop-title">${heading}</div>
          <div class="dash-pop-meta">${meta}</div>
          ${fields ? `<div class="dash-pop-fields">${fields}</div>` : ''}
        </div>
        ${button}
      </div>`;
    const guestName = item => escapeHtml(item.name || 'Guest') + (item.room ? ' · Room ' + escapeHtml(item.room) : '') + (item.reservation ? ' · Res. ' + escapeHtml(item.reservation) : '');
    const priority = { urgent: ['urgentList', 'Urgent guest actions', 'urgent'], mid: ['midList', 'Mid priority guest actions', 'mid priority'], normal: ['normalList', 'Normal priority guest actions', 'normal priority'] }[kind];
    if (priority) {
      const items = guest[priority[0]] || [];
      return {
        title: priority[1],
        empty: `No guest rows were marked ${priority[2]} in this period.`,
        items: items,
        html: items.map(item => row(
          guestName(item),
          [item.date, item.section, item.membership].filter(Boolean).map(escapeHtml).join(' · '),
          dashDetail('Preferences', item.preferences) + dashDetail('Special request', item.request) + dashDetail('Guest feedback', item.feedback)
            + dashDetail('Action taken', item.action) + dashDetail('Note', item.note) + dashDetail('Call status', item.callStatus) + dashDetail('Contacted by', item.contacted),
          guestButton(item.date)
        )).join('')
      };
    }
    if (kind === 'unhappy') {
      const items = guest.notSatisfiedList || [];
      return {
        title: 'Guests not satisfied',
        empty: 'No in-house guests were marked not satisfied in this period.',
        items: items,
        html: items.map(item => row(
          guestName(item),
          [item.date, 'In-house', item.membership, item.priority ? item.priority + ' priority' : ''].filter(Boolean).map(escapeHtml).join(' · '),
          dashDetail('Guest feedback', item.feedback) + dashDetail('Special request', item.request) + dashDetail('Action taken', item.action)
            + dashDetail('Note', item.note) + dashDetail('Contacted by', item.contacted),
          guestButton(item.date)
        )).join('')
      };
    }
    if (kind === 'complaints') {
      const items = duty.complaintsList || [];
      return {
        title: 'Guest complaints',
        empty: 'No guest complaints were logged in this period.',
        items: items,
        html: items.map(item => row(
          escapeHtml(item.complaint || 'Complaint'),
          [item.date, item.room ? 'Room ' + item.room : ''].filter(Boolean).map(escapeHtml).join(' · '),
          dashDetail('Action taken', item.action),
          dutyButton(item.date)
        )).join('')
      };
    }
    const items = duty.failList || [];
    return {
      title: 'Failed checks',
      empty: 'No checklist items failed in this period.',
      items: items,
      html: items.map(item => row(
        escapeHtml(item.item || 'Checklist item'),
        [item.date, item.section].filter(Boolean).map(escapeHtml).join(' · '),
        dashDetail('Comment', item.comment),
        dutyButton(item.date)
      )).join('')
    };
  }

  function closeDashPopup(){
    const open = document.getElementById('dashPopup');
    if (open) open.remove();
  }

  function openDashPopup(kind){
    closeDashPopup();
    const content = dashPopupContent(kind);
    const bg = document.createElement('div');
    bg.className = 'dash-modal-bg';
    bg.id = 'dashPopup';
    bg.innerHTML = `
      <div class="dash-modal" role="dialog" aria-modal="true" aria-labelledby="dashPopupTitle">
        <div class="dash-modal-head">
          <h3 id="dashPopupTitle">${content.title}</h3>
          <span class="dash-modal-count">${content.items.length}</span>
          <button type="button" class="dash-modal-close" data-dash-close aria-label="Close">
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="dash-modal-body">${content.items.length ? content.html : `<p class="dash-empty">${content.empty}</p>`}</div>
      </div>`;
    bg.addEventListener('click', e => { if (e.target === bg) closeDashPopup(); });
    document.body.appendChild(bg);
    bg.querySelector('[data-dash-close]').focus();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDashPopup();
  });

  document.addEventListener('click', (e) => {
    const target = e.target.closest ? e.target : null;
    if (!target) return;
    const opener = target.closest('[data-dash-open]');
    if (opener) { openDashPopup(opener.dataset.dashOpen); return; }
    if (target.closest('[data-dash-close]')) { closeDashPopup(); return; }
    if (target.closest('[data-dash-go]')) {
      window.goTo('parking', 'manage');
      window.renderApp();
      return;
    }
    const guestReport = target.closest('[data-open-guest]');
    if (guestReport) {
      closeDashPopup();
      window.goTo('guest', 'today');
      window.state.selectedDate = guestReport.dataset.openGuest;
      window.renderApp();
      return;
    }
    if (target.closest('#dashPopup [data-review-date]')) closeDashPopup();
  });

  document.addEventListener('click', (e) => {
    const tab = e.target.closest && e.target.closest('[data-dash-tab]');
    if (!tab) return;
    const group = tab.dataset.dashGroup;
    const id = tab.dataset.dashTab;
    const state = window.state;
    state.dashTabs = Object.assign({}, state.dashTabs, { [group]: id });
    document.querySelectorAll(`[data-dash-group="${group}"]`).forEach(btn => {
      const on = btn.dataset.dashTab === id;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll(`[data-dash-pane^="${group}:"]`).forEach(pane => pane.classList.toggle('on', pane.dataset.dashPane === group + ':' + id));
  });

  async function exportFullPdf(){
    const pack = fullPack;
    const charts = window.NovotelCharts;
    const pdf = window.NovotelPdf;
    if (!pack || !window.jspdf || !charts || !pdf || !window.occupancySeries) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
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
    y = pdf.pdfKpiBoard(doc, W, y, dashboardTiers(stats), { split: true });
    const revenueMix = stats.revenue || {};
    const guestPack = pack.guest || {};
    const pies = [
      { title: 'Revenue Mix', image: pieImage(charts, ['Rooms', 'F&B', 'M&E', 'OOD', 'Other'], [revenueMix.rooms || 0, revenueMix.fb || 0, revenueMix.me || 0, revenueMix.ood || 0, revenueMix.other || 0], ['#1e22aa', '#14b8a6', '#7c6bf2', '#A8814F', '#8aa0b2']) }
    ];
    if (window.guestPriorityChart) {
      pies.push({ title: 'Guest priority', image: charts.chartImage(canvas => window.guestPriorityChart(canvas, guestPack, true), 420, 360) });
    }
    y = pdfPieRow(doc, W, y, pies);
    y += 8;
    if (window.guestVipChart) {
      y = pdfChart(doc, W, y, 'Guest Relation VIP', charts.chartImage(canvas => window.guestVipChart(canvas, guestPack, true)));
    }
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
