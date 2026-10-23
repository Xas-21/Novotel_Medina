(function(){
  const TIERS = ['Classic','Silver','Gold','Platinum','Daimond','Limitless','Care Of','Complementary','Booking','Repeated','Hony Moon','Others'];
  const VIPS = ['V1','V2','V3'];
  const SCORES = [
    ['rps','RPS'],['trustYou','TrustYou'],['booking','Booking'],['google','Google'],
    ['tripadvisor','TripAdvisor'],['expedia','Expedia']
  ];
  const SCORE_NAMES = SCORES.map(row => row[1]);
  const CONTACT = ['Call','WhatsApp','Email'];
  const SATISFACTION = ['Satisfied','Non Satisfied','Have Comment'];
  const SERVICE = ['Yes','No','RFS','DND','Only Amenities'];
  const REVIEW = ['Sent','Not sent'];
  const PRIORITY = ['Normal','Mid','Urgent'];
  const CALL_STATUS = ['Answered','No Answer','Pending'];
  const MARKS = ['1','2','3','4','5','6','7','8','9','10'];

  let draft = null;
  let loadToken = 0;
  let saveTimer = null;

  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function canEdit(){
    const user = window.state && window.state.user;
    return !!(user && window.canWrite(user.role, 'guest'));
  }
  function locked(){
    const user = window.state && window.state.user;
    return !!(draft && draft.status === 'submitted' && (!user || user.role !== 'admin'));
  }
  function options(list, value){
    return '<option value=""></option>' + list.map(item => `<option${item===value?' selected':''}>${escapeHtml(item)}</option>`).join('');
  }
  function halfUp(value){
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const sign = n < 0 ? -1 : 1;
    return sign * Math.floor(Math.abs(n) + 0.5);
  }
  function vipOcc(arrivals, rooms){
    const raw = String(arrivals == null ? '' : arrivals).replace(/,/g, '').trim();
    const count = Number(rooms);
    if (!count || raw === '') return '';
    const occupied = Number(raw);
    if (!Number.isFinite(occupied)) return '';
    const rounded = halfUp(occupied / count * 100);
    return rounded == null ? '' : String(rounded);
  }
  function prioritySelect(value, dis){
    const current = PRIORITY.indexOf(value) >= 0 ? value : 'Normal';
    return `<select data-k="priority" class="guest-priority" data-priority="${escapeHtml(current)}" ${dis}>${PRIORITY.map(item => `<option${item===current?' selected':''}>${item}</option>`).join('')}</select>`;
  }
  function priorityColor(value){
    if (value === 'Urgent') return [185, 28, 28];
    if (value === 'Mid') return [180, 83, 9];
    if (value === 'Normal') return [30, 34, 170];
    return [35, 48, 61];
  }
  function callStatusColor(value){
    if (value === 'Answered') return [46, 125, 76];
    if (value === 'No Answer') return [177, 75, 63];
    if (value === 'Pending') return [204, 153, 0];
    return [35, 48, 61];
  }
  function callStatusSelect(value, dis){
    const current = CALL_STATUS.indexOf(value) >= 0 ? value : '';
    const colors = {Answered:'#2e7d4c', 'No Answer':'#B14B3F', Pending:'#cc9900'};
    const opts = '<option value=""></option>' + CALL_STATUS.map(item => `<option${item===current?' selected':''} style="color:${colors[item]};font-weight:700">${escapeHtml(item)}</option>`).join('');
    return `<select data-k="callStatus" class="guest-call" data-call="${escapeHtml(current)}" ${dis}>${opts}</select>`;
  }
  function applyData(data){
    draft = {
      date: data.date,
      status: data.status || null,
      submittedBy: data.submittedBy || '',
      shiftStart: data.shiftStart || data.time || '',
      shiftEnd: data.shiftEnd || '',
      arrivals: data.arrivals || '',
      departures: data.departures || '',
      occupancy: data.occupancy || '',
      roomsAvailable: data.roomsAvailable || 0,
      scores: Array.isArray(data.scores) ? data.scores : [],
      membership: Array.isArray(data.membership) ? data.membership : [],
      preArrival: data.preArrival || [],
      inHouse: data.inHouse || [],
      departure: data.departure || [],
      generalComments: data.generalComments || []
    };
  }

  function renderGuestSection(){
    const state = window.state;
    if (!state || state.section !== 'guest') return '';
    if (state.view === 'archive') {
      queueMicrotask(loadArchive);
      return `<div class="dmr-headline"><h1>Guest Relation Archive</h1></div><div class="dmr-sub">Guest relation reports by month</div><input type="date" id="archiveSearch" class="dmr-btn dmr-btn-ghost" style="padding:7px 12px;margin-bottom:12px;"><div id="guestArchive"><div class="dmr-empty">Loading archive…</div></div>`;
    }
    if (state.view === 'analysis') {
      queueMicrotask(loadAnalysis);
      return `<div class="dmr-headline"><h1>Guest Relation Analysis</h1></div><div class="dmr-sub">Pick a day, a week, a month, the year to date, or any from and to dates</div>${window.periodBar ? window.periodBar() : ''}<div id="guestAnalysis"><div class="dmr-empty">Loading analysis…</div></div>`;
    }
    const date = state.selectedDate;
    const token = ++loadToken;
    queueMicrotask(() => loadGuest(date, token));
    return `<div class="dmr-headline"><h1>Guest Relation Report</h1><input type="date" id="dateInput" class="dmr-btn-ghost dmr-btn" style="padding:7px 12px;" value="${escapeHtml(date)}"></div><div id="guestBody"><div class="dmr-empty"><h3>Loading guest relation report…</h3></div></div>`;
  }

  async function loadGuest(date, token){
    const data = await window.apiFetch('/api/guest?date=' + encodeURIComponent(date));
    if (token !== loadToken || !data) return;
    applyData(data);
    paint();
    bind();
  }

  function field(label, html, wide){ return `<div class="dmr-field${wide ? ' guest-wide' : ''}"><label>${label}</label>${html}</div>`; }
  function textRow(list, index, cells){
    return `<div class="night-record" data-list="${list}" data-i="${index}">${cells}<button type="button" class="dmr-dyn-del" data-guest-del="1">✕</button></div>`;
  }

  function guestNumber(i){ return `<div class="guest-wide guest-num">Guest ${i + 1}</div>`; }
  function sectionAcc(key, title, body){
    const open = window.state && window.state.openAcc && window.state.openAcc.has(key) ? 'open' : '';
    return `<details class="dmr-acc" data-acc="${key}" ${open}><summary><span>${title}</span><span class="arrow">▾</span></summary><div class="dmr-acc-body" style="padding-top:14px;">${body}</div></details>`;
  }

  function paint(){
    const body = document.getElementById('guestBody');
    if (!body || !draft) return;
    const dis = locked() || !canEdit() ? 'disabled' : '';
    const badge = draft.status === 'submitted' ? 'Submitted' : (draft.status === 'draft' ? 'Draft' : '');
    const occ = vipOcc(draft.arrivals, draft.roomsAvailable) || draft.occupancy || '';
    const scores = draft.scores.map((row, i) => textRow('scores', i, [
      field('Score type', `<select data-k="type" ${dis}>${options(SCORE_NAMES, row.type)}</select>`),
      field('YTD', `<input data-k="ytd" value="${escapeHtml(row.ytd)}" ${dis}>`)
    ].join(''))).join('');
    const members = draft.membership.map((row, i) => textRow('membership', i, [
      field('Membership type', `<select data-k="tier" ${dis}>${options(TIERS, row.tier)}</select>`),
      field('V', `<select data-k="vip" ${dis}>${options(VIPS, row.vip)}</select>`),
      field('Arrival', `<input data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('In-house', `<input data-k="inHouse" value="${escapeHtml(row.inHouse)}" ${dis}>`),
      field('Departure', `<input data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`)
    ].join(''))).join('');
    const pre = draft.preArrival.map((row, i) => textRow('preArrival', i, [
      guestNumber(i),
      field('Priority', prioritySelect(row.priority, dis)),
      field('Reservation #', `<input data-k="reservation" value="${escapeHtml(row.reservation)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(TIERS, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Arrival time', `<input type="time" data-k="arrivalTime" value="${escapeHtml(row.arrivalTime)}" ${dis}>`),
      field('Preferences', `<textarea data-k="preferences" rows="3" ${dis}>${escapeHtml(row.preferences)}</textarea>`, true),
      field('Action taken', `<textarea data-k="action" rows="3" ${dis}>${escapeHtml(row.action)}</textarea>`, true),
      field('Note', `<textarea data-k="note" rows="3" ${dis}>${escapeHtml(row.note)}</textarea>`, true),
      field('Call status', callStatusSelect(row.callStatus, dis)),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const house = draft.inHouse.map((row, i) => textRow('inHouse', i, [
      guestNumber(i),
      field('Priority', prioritySelect(row.priority, dis)),
      field('Room #', `<input data-k="room" value="${escapeHtml(row.room)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(TIERS, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Satisfaction', `<select data-k="satisfaction" ${dis}>${options(SATISFACTION, row.satisfaction)}</select>`),
      field('Special request', `<textarea data-k="request" rows="3" ${dis}>${escapeHtml(row.request)}</textarea>`, true),
      field('Service done?', `<select data-k="service" ${dis}>${options(SERVICE, row.service)}</select>`),
      field('Welcome drink', `<select data-k="drink" ${dis}>${options(REVIEW, row.drink)}</select>`),
      field('F&B amenities', `<input data-k="fb" value="${escapeHtml(row.fb)}" ${dis}>`),
      field('Guest feedback', `<textarea data-k="feedback" rows="3" ${dis}>${escapeHtml(row.feedback)}</textarea>`, true),
      field('Action taken', `<textarea data-k="action" rows="3" ${dis}>${escapeHtml(row.action)}</textarea>`, true),
      field('Note', `<textarea data-k="note" rows="3" ${dis}>${escapeHtml(row.note)}</textarea>`, true),
      field('Call status', callStatusSelect(row.callStatus, dis)),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const leave = draft.departure.map((row, i) => textRow('departure', i, [
      guestNumber(i),
      field('Priority', prioritySelect(row.priority, dis)),
      field('Room #', `<input data-k="room" value="${escapeHtml(row.room)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(TIERS, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Satisfaction 1–10', `<select data-k="score" ${dis}>${options(MARKS, row.score)}</select>`),
      field('Employee call rating', `<select data-k="employeeRating" ${dis}>${options(MARKS, row.employeeRating)}</select>`),
      field('Guest feedback', `<textarea data-k="feedback" rows="3" ${dis}>${escapeHtml(row.feedback)}</textarea>`, true),
      field('Review reminder', `<select data-k="review" ${dis}>${options(REVIEW, row.review)}</select>`),
      field('Action taken', `<textarea data-k="action" rows="3" ${dis}>${escapeHtml(row.action)}</textarea>`, true),
      field('Note', `<textarea data-k="note" rows="3" ${dis}>${escapeHtml(row.note)}</textarea>`, true),
      field('Call status', callStatusSelect(row.callStatus, dis)),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const comments = draft.generalComments.map((row, i) => textRow('generalComments', i, [
      field('Time', `<input type="time" data-k="time" value="${escapeHtml(row.time)}" ${dis}>`),
      field('Comment', `<textarea data-k="comment" rows="3" ${dis}>${escapeHtml(row.comment)}</textarea>`, true)
    ].join(''))).join('');
    body.innerHTML = `
      <div id="guestForm">
        <div class="dmr-card dmr-section-card">
          <div class="night-card-head"><h3>Next day summary</h3>${badge ? `<span class="dmr-badge ${draft.status==='submitted'?'dmr-badge-submitted':'dmr-badge-draft'}">${badge}</span>` : ''}</div>
          <div class="dmr-row">
            ${field('Shift start', `<input type="time" data-top="shiftStart" value="${escapeHtml(draft.shiftStart)}" ${dis}>`)}
            ${field('Shift end', `<input type="time" data-top="shiftEnd" value="${escapeHtml(draft.shiftEnd)}" ${dis}>`)}
            ${field('Total VIP arrival', `<input data-top="arrivals" inputmode="decimal" value="${escapeHtml(draft.arrivals)}" ${dis}>`)}
            ${field('Total VIP departure', `<input data-top="departures" inputmode="decimal" value="${escapeHtml(draft.departures)}" ${dis}>`)}
            <div class="dmr-field"><label>VIP occ %</label><span class="night-calc" id="guestOcc" style="color:${window.occupancyCss ? window.occupancyCss(occ) : ''}">${escapeHtml(window.withPercent ? window.withPercent(occ) : occ)}</span></div>
          </div>
          ${draft.submittedBy ? `<p class="dmr-prepared-by">Prepared by: ${escapeHtml(draft.submittedBy)}</p>` : ''}
        </div>
        ${sectionAcc('guest-scores', 'Scores', `${scores || '<p class="dmr-sub">No scores yet.</p>'}${dis ? '' : '<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="scores">+ Add score</button>'}`)}
        ${sectionAcc('guest-membership', 'Membership', `${members || '<p class="dmr-sub">No membership rows yet.</p>'}${dis ? '' : '<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="membership">+ Add membership</button>'}`)}
        ${sectionAcc('guest-preArrival', 'Pre-arrival communication', `${pre || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="preArrival" ${dis}>+ Add guest</button>`)}
        ${sectionAcc('guest-inHouse', 'In-house welcome call', `${house || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="inHouse" ${dis}>+ Add guest</button>`)}
        ${sectionAcc('guest-departure', 'Departure courtesy call', `${leave || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="departure" ${dis}>+ Add guest</button>`)}
        ${sectionAcc('guest-comments', 'General Comments', `${comments || '<p class="dmr-sub">No general comments yet.</p>'}${dis ? '' : '<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="generalComments">+ Add comment</button>'}`)}
        ${dis ? '' : `
        <div class="dmr-card" style="padding:18px;margin-top:10px;text-align:center;">
          <button type="button" class="dmr-btn dmr-btn-primary" id="guestSubmit" style="width:100%;justify-content:center;padding:13px;font-size:14.5px;">✓ Submit &amp; Close Daily Report</button>
          <div class="dmr-sub" style="margin:8px 0 0;">Submitting finalizes the shift round, logs your signature, and archives the report.</div>
        </div>`}
        <div id="guestNote" class="night-note"></div>
      </div>`;
  }

  function bind(){
    const body = document.getElementById('guestBody');
    if (!body || body._guestBound) return;
    body._guestBound = true;
    body.addEventListener('input', onInput);
    body.addEventListener('change', onInput);
    body.addEventListener('click', onClick);
  }
  function onInput(e){
    const target = e.target;
    if (target && target.dataset && target.dataset.top === 'arrivals') {
      const span = document.getElementById('guestOcc');
      if (span && draft) {
        const shown = window.withPercent ? window.withPercent(vipOcc(target.value, draft.roomsAvailable)) : vipOcc(target.value, draft.roomsAvailable);
        span.textContent = shown;
        span.style.color = window.occupancyCss ? window.occupancyCss(shown) : '';
      }
    }
    if (target && target.classList && target.classList.contains('guest-priority')) target.dataset.priority = target.value;
    if (target && target.classList && target.classList.contains('guest-call')) target.dataset.call = target.value;
    queue();
  }
  function queue(){
    if (locked() || !canEdit()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }
  function read(){
    const form = document.getElementById('guestForm');
    if (!form || !draft) return;
    form.querySelectorAll('[data-top]').forEach(el => { draft[el.dataset.top] = el.value; });
    draft.occupancy = vipOcc(draft.arrivals, draft.roomsAvailable);
    ['scores','membership','preArrival','inHouse','departure','generalComments'].forEach(list => {
      draft[list] = Array.from(form.querySelectorAll(`[data-list="${list}"]`)).map(row => {
        const item = {};
        row.querySelectorAll('[data-k]').forEach(el => { item[el.dataset.k] = el.value; });
        return item;
      });
    });
  }
  function payload(){
    read();
    return {
      date: draft.date,
      shiftStart: draft.shiftStart, shiftEnd: draft.shiftEnd,
      arrivals: draft.arrivals, departures: draft.departures, occupancy: draft.occupancy,
      scores: draft.scores, membership: draft.membership,
      preArrival: draft.preArrival, inHouse: draft.inHouse, departure: draft.departure,
      generalComments: draft.generalComments
    };
  }
  async function save(){
    if (!draft || locked() || !canEdit()) return;
    const res = await window.apiFetch('/api/guest', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload())});
    const note = document.getElementById('guestNote');
    if (!res || !res.date) { if (note) note.textContent = 'Could not save'; return; }
    draft.status = res.status;
    draft.occupancy = res.occupancy || draft.occupancy;
    draft.roomsAvailable = res.roomsAvailable || draft.roomsAvailable;
    if (note) note.textContent = '';
  }
  function emptyRow(list){
    if (list === 'scores') return {type:'', ytd:''};
    if (list === 'membership') return {tier:'', vip:'', arrival:'', inHouse:'', departure:''};
    if (list === 'generalComments') return {comment:'', time:''};
    return {reservation:'', name:'', membership:'', arrival:'', departure:'', arrivalTime:'', preferences:'', action:'', note:'', callStatus:'', contacted:'', room:'', satisfaction:'', request:'', service:'', drink:'', fb:'', score:'', feedback:'', review:'', employeeRating:'', priority:'Normal'};
  }
  const GUEST_ACC = {scores:'guest-scores', membership:'guest-membership', preArrival:'guest-preArrival', inHouse:'guest-inHouse', departure:'guest-departure', generalComments:'guest-comments'};
  async function onClick(e){
    const summary = e.target.closest && e.target.closest('#guestForm summary');
    if (summary && window.state && window.state.openAcc) {
      const acc = summary.parentElement;
      setTimeout(() => {
        if (!acc) return;
        if (acc.open) window.state.openAcc.add(acc.dataset.acc);
        else window.state.openAcc.delete(acc.dataset.acc);
      }, 0);
    }
    const add = e.target.closest && e.target.closest('[data-guest-add]');
    const del = e.target.closest && e.target.closest('[data-guest-del]');
    if (add && canEdit() && !locked()) {
      read();
      if (window.state && window.state.openAcc) window.state.openAcc.add(GUEST_ACC[add.dataset.guestAdd]);
      draft[add.dataset.guestAdd].push(emptyRow(add.dataset.guestAdd));
      paint();
      queue();
    }
    if (del && canEdit() && !locked()) {
      read();
      const row = del.closest('[data-list]');
      draft[row.dataset.list].splice(Number(row.dataset.i), 1);
      paint();
      queue();
    }
    if (e.target.id === 'guestSubmit') {
      e.preventDefault();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      await save();
      const res = await window.apiFetch('/api/guest/submit?date=' + encodeURIComponent(draft.date), {method:'POST'});
      if (res && res.status === 'submitted') {
        window.goTo('guest', 'archive');
        window.state.selectedDate = res.date || draft.date;
        window.renderApp();
      }
    }
  }

  function fmtDate(d){
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  }

  function monthVip(rows, key, end){
    const byDate = new Map(rows.map(row => [row.date, row]));
    const count = value => {
      const n = Number(String(value == null ? '' : value).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : 0;
    };
    const pack = { labels: [], vipArrivals: [], vipDepartures: [], vipOcc: [] };
    const last = Number(end.slice(8, 10));
    for (let day = 1; day <= last; day++) {
      const label = String(day).padStart(2, '0');
      const row = byDate.get(key + '-' + label);
      pack.labels.push(label);
      pack.vipArrivals.push(row ? count(row.arrivals) : 0);
      pack.vipDepartures.push(row ? count(row.departures) : 0);
      pack.vipOcc.push(row && row.occupancy !== '' && row.occupancy != null ? Number(row.occupancy) : null);
    }
    return pack;
  }

  async function loadArchive(){
    const el = document.getElementById('guestArchive');
    const rows = await window.apiFetch('/api/guest/index') || [];
    if (!el) return;
    const search = document.getElementById('archiveSearch');
    const filtered = search && search.value ? rows.filter(row => row.date === search.value) : rows;
    if (search && !search._guest) { search._guest = true; search.onchange = loadArchive; }
    if (!filtered.length) { el.innerHTML = '<div class="dmr-empty"><h3>No archived reports yet</h3></div>'; return; }
    const groups = window.groupByMonth ? window.groupByMonth(filtered) : [{key:'', label:'Reports', entries: filtered}];
    const isAdmin = window.state.user && window.state.user.role === 'admin';
    const canEditGuest = canEdit();
    const openKey = (search && search.value ? search.value : (window.state.selectedDate || '')).slice(0, 7);
    el.innerHTML = groups.map(group => `
      <details class="archive-month dmr-card" ${group.key === openKey ? 'open' : ''}>
        <summary>${escapeHtml(group.label)} (${group.entries.length})</summary>
        ${group.key ? `<div class="chart-box"><canvas id="guest-vip-${group.key}"></canvas></div>` : ''}
        ${group.entries.map(entry => `
          <div class="dmr-archive-row">
            <div>
              <div class="dmr-archive-date">${escapeHtml(fmtDate(entry.date))}</div>
              <span class="dmr-badge ${entry.status === 'submitted' ? 'dmr-badge-submitted' : 'dmr-badge-draft'}">${entry.status === 'submitted' ? 'Submitted' : 'Draft'}</span>
              ${entry.occupancy ? `<span style="font-size:12px;margin-left:8px;font-weight:700;color:${window.occupancyCss ? window.occupancyCss(entry.occupancy) : ''}">Occ: ${escapeHtml(window.withPercent ? window.withPercent(entry.occupancy) : String(entry.occupancy).replace(/%/g,'').trim() + '%')}</span>` : ''}
              ${entry.status === 'submitted' && entry.submittedBy ? `<div class="dmr-prepared-by">Prepared by: ${escapeHtml(entry.submittedBy)}</div>` : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-open="${escapeHtml(entry.date)}">Open</button>
              ${(canEditGuest && (isAdmin || entry.status !== 'submitted')) ? `<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-edit="${escapeHtml(entry.date)}">Edit</button>` : ''}
              <button type="button" class="dmr-btn dmr-btn-primary dmr-btn-sm" data-guest-pdf="${escapeHtml(entry.date)}">Export PDF</button>
              ${(canEditGuest && isAdmin) ? `<button type="button" class="dmr-btn dmr-btn-sm" data-guest-delete="${escapeHtml(entry.date)}" style="background:var(--danger);color:#fff;">Delete</button>` : ''}
            </div>
          </div>`).join('')}
      </details>`).join('');
    const drawMonth = key => {
      if (!key || !window.todayStr || !window.monthLastDay) return;
      const thisMonth = window.todayStr().slice(0, 7);
      const end = key === thisMonth ? window.todayStr() : window.monthLastDay(key + '-01');
      mountNamed('guest-vip-' + key, canvas => vipChart(canvas, monthVip(rows, key, end), false));
    };
    groups.forEach(group => drawMonth(group.key));
    el.querySelectorAll('details.archive-month').forEach(details => {
      details.ontoggle = () => {
        const canvas = details.open && details.querySelector('canvas');
        if (canvas) drawMonth(canvas.id.replace('guest-vip-', ''));
      };
    });
    el.querySelectorAll('[data-guest-open]').forEach(btn => { btn.onclick = () => openGuestDate(btn.dataset.guestOpen, false); });
    el.querySelectorAll('[data-guest-edit]').forEach(btn => { btn.onclick = () => openGuestDate(btn.dataset.guestEdit, true); });
    el.querySelectorAll('[data-guest-pdf]').forEach(btn => { btn.onclick = () => exportPdf(btn.dataset.guestPdf); });
    el.querySelectorAll('[data-guest-delete]').forEach(btn => { btn.onclick = async () => { await window.apiFetch('/api/guest?date=' + encodeURIComponent(btn.dataset.guestDelete), {method:'DELETE'}); loadArchive(); }; });
  }

  async function openGuestDate(date, edit){
    if (edit) {
      const current = await window.apiFetch('/api/guest?date=' + encodeURIComponent(date));
      if (current && current.status === 'submitted') {
        await window.apiFetch('/api/guest/reopen?date=' + encodeURIComponent(date), {method:'POST'});
      }
    }
    window.goTo('guest', 'today');
    window.state.selectedDate = date;
    window.renderApp();
  }

  const SCORE_COLORS = ['#1e22aa','#14b8a6','#7c6bf2','#A8814F','#B14B3F','#4F7A5B'];

  function scoreSets(charts, canvas, data){
    const box = canvas.parentElement;
    const height = (box && box.clientHeight) || canvas.height || 220;
    return SCORES.map((row, i) => {
      const color = SCORE_COLORS[i];
      const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16)).join(',');
      const series = charts.areaSeries(canvas, row[1], (data.scores && data.scores[row[0]]) || [], color, rgb);
      const fade = canvas.getContext('2d').createLinearGradient(0, 0, 0, height);
      fade.addColorStop(0, 'rgba(' + rgb + ',0.16)');
      fade.addColorStop(0.7, 'rgba(' + rgb + ',0.04)');
      fade.addColorStop(1, 'rgba(' + rgb + ',0)');
      series.backgroundColor = fade;
      series.spanGaps = true;
      return series;
    });
  }

  function scoreScale(options){
    options.scales.y.beginAtZero = false;
    options.scales.y.grace = '8%';
    return options;
  }

  function chartOptions(forPdf){
    const options = window.NovotelCharts.chartFrame();
    options.plugins.legend = {display:true, position:'top', labels:{boxWidth:10, color:'#5B6673', font:{family:'Aptos, Calibri, sans-serif', size:11}}};
    options.plugins.tooltip.displayColors = true;
    if (forPdf) { options.animation = false; options.responsive = false; }
    return options;
  }
  function vipChart(canvas, data, forPdf){
    const charts = window.NovotelCharts;
    const options = chartOptions(forPdf);
    options.scales.y.title = {display:true, text:'VIP guests', color:'#5B6673', font:{family:'Aptos, Calibri, sans-serif', size:11}};
    options.scales.y1 = {
      position:'right', beginAtZero:true, suggestedMax:100, border:{display:false}, grid:{display:false},
      ticks:{color:'#1e22aa', font:{family:'Aptos, Calibri, sans-serif', size:11}},
      title:{display:true, text:'VIP occ %', color:'#1e22aa', font:{family:'Aptos, Calibri, sans-serif', size:11}}
    };
    const occ = charts.areaSeries(canvas, 'VIP occ %', data.vipOcc || [], '#1e22aa', '30,34,170');
    occ.type = 'line'; occ.yAxisID = 'y1'; occ.spanGaps = true; occ.fill = false; occ.order = 1;
    return new Chart(canvas, {type:'bar', data:{labels:data.labels || [], datasets:[
      {type:'bar', label:'VIP arrival', data:data.vipArrivals || [], backgroundColor:'#1e22aa', borderRadius:6, maxBarThickness:16, yAxisID:'y', order:2},
      {type:'bar', label:'VIP departure', data:data.vipDepartures || [], backgroundColor:'#14b8a6', borderRadius:6, maxBarThickness:16, yAxisID:'y', order:2},
      occ
    ]}, options});
  }
  function priorityChart(canvas, data, forPdf){
    const options = chartOptions(forPdf);
    options.scales.x.display = false;
    options.scales.y.display = false;
    options.plugins.legend.position = 'bottom';
    const priority = data.priority || {};
    return new Chart(canvas, {type:'doughnut', data:{labels:['Normal','Mid','Urgent'], datasets:[{data:[priority.Normal||0, priority.Mid||0, priority.Urgent||0], backgroundColor:['#1e22aa','#b8860b','#B14B3F'], borderWidth:2, borderColor:'#fff'}]}, options});
  }
  function sectionPriorityChart(canvas, data, forPdf){
    const options = chartOptions(forPdf);
    options.scales.x.stacked = true;
    options.scales.y.stacked = true;
    const sections = data.priorityBySection || {};
    const pick = (level) => ['preArrival','inHouse','departure'].map(key => (sections[key] && sections[key][level]) || 0);
    return new Chart(canvas, {type:'bar', data:{labels:['Pre-arrival','In-house','Departure'], datasets:[
      {label:'Normal', data:pick('Normal'), backgroundColor:'#1e22aa', stack:'priority'},
      {label:'Mid', data:pick('Mid'), backgroundColor:'#b8860b', stack:'priority'},
      {label:'Urgent', data:pick('Urgent'), backgroundColor:'#B14B3F', stack:'priority'}
    ]}, options});
  }
  function satisfactionChart(canvas, data, forPdf){
    const options = chartOptions(forPdf);
    options.plugins.legend.display = false;
    const mood = data.satisfaction || {};
    return new Chart(canvas, {type:'bar', data:{labels:['Satisfied','Non Satisfied','Have Comment'], datasets:[{data:[mood.Satisfied||0, mood['Non Satisfied']||0, mood['Have Comment']||0], backgroundColor:['#4F7A5B','#B14B3F','#b8860b'], borderRadius:8, maxBarThickness:48}]}, options});
  }
  function membershipChart(canvas, data, forPdf){
    const options = chartOptions(forPdf);
    const rows = (data.membershipTiers && data.membershipTiers.length) ? data.membershipTiers : [{tier:'No membership', arrival:0, inHouse:0, departure:0}];
    return new Chart(canvas, {type:'bar', data:{labels:rows.map(row => row.tier), datasets:[
      {label:'Arrival', data:rows.map(row => row.arrival || 0), backgroundColor:'#1e22aa', borderRadius:6, maxBarThickness:22},
      {label:'In-house', data:rows.map(row => row.inHouse || 0), backgroundColor:'#14b8a6', borderRadius:6, maxBarThickness:22},
      {label:'Departure', data:rows.map(row => row.departure || 0), backgroundColor:'#7c6bf2', borderRadius:6, maxBarThickness:22}
    ]}, options});
  }
  function ratingChart(canvas, data, forPdf){
    const charts = window.NovotelCharts;
    const options = chartOptions(forPdf);
    options.scales.y.suggestedMax = 10;
    const guest = charts.areaSeries(canvas, 'Departure score', data.departureScores || [], '#1e22aa', '30,34,170');
    const employee = charts.areaSeries(canvas, 'Employee call rating', data.employeeRatings || [], '#14b8a6', '20,184,166');
    guest.spanGaps = true; guest.fill = false;
    employee.spanGaps = true; employee.fill = false;
    return new Chart(canvas, {type:'line', data:{labels:data.labels || [], datasets:[guest, employee]}, options});
  }
  function mountNamed(id, draw){
    const canvas = document.getElementById(id);
    if (!canvas || !window.Chart || !window.NovotelCharts) return;
    if (canvas._chart) canvas._chart.destroy();
    canvas._chart = draw(canvas, false);
  }

  function guestTiers(data){
    const tones = window.kpiTones;
    const n = window.kpiNumber;
    const mood = data.satisfaction || {};
    const scoreCard = (label, value, note, empty) => ({ label: label, value: value == null ? '—' : n(value, 1), tone: 'teal', note: value == null ? empty : note });
    return [
      { title: 'VIP Occupancy & Guest Scores', kind: 'hero', cards: [
        window.occupancyCard('Avg VIP occ', data.avgVipOcc, 'VIP arrivals ÷ hotel rooms', Number(data.avgVipOcc) > 0 ? { badge: 'Active', badgeColor: tones.indigo } : {}),
        scoreCard('Avg departure score', data.avgDeparture, 'Departure courtesy call score', 'No departure surveys recorded'),
        scoreCard('Avg employee call rating', data.avgEmployee, 'Rating given to the calling employee', 'No call ratings recorded')
      ] },
      { title: 'Report Submission & Guest Satisfaction', kind: 'pair', cards: [
        { title: 'Guest Relation Logs', done: data.submitted || 0, open: data.missing || 0, doneLabel: 'Reports submitted', openLabel: 'Days not submitted' },
        { title: 'In-house Satisfaction', done: mood.Satisfied || 0, open: data.notSatisfied || 0, doneWord: 'Satisfied', doneLabel: 'Satisfied guests', openLabel: 'Not satisfied guests', unit: 'guests', openWord: 'not satisfied' }
      ] },
      { title: 'Guest Calls & Escalations', kind: 'compact', cards: [
        { label: 'Welcome calls', value: n(data.welcomeCalls || 0), tone: 'indigo', note: 'In-house welcome calls made' },
        { label: 'Departure calls', value: n(data.departureCalls || 0), tone: 'indigo', note: 'Departure courtesy calls made' },
        { label: 'Guests with comments', value: n(mood['Have Comment'] || 0), tone: 'amber', note: 'In-house guests who left a comment' },
        { label: 'Urgent guest actions', value: n(data.urgent || 0), tone: 'crimson', note: data.urgent ? 'Guest rows marked urgent' : 'No urgent escalations' }
      ] }
    ];
  }

  async function loadAnalysis(){
    const el = document.getElementById('guestAnalysis');
    const data = await window.apiFetch('/api/guest/analysis?' + window.periodQuery());
    if (!el || !data) return;
    window.guestAnalysis = data;
    el.innerHTML = `
      <p class="dmr-sub">${escapeHtml(data.startDate)} to ${escapeHtml(data.endDate)}</p>
      ${window.kpiBoard(guestTiers(data))}
      <div class="dmr-card dmr-chart-card"><h3>How guests were contacted</h3><div class="chart-box"><canvas id="guestChannels"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Scores (YTD)</h3><div class="chart-box"><canvas id="guestScores"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Priority by section</h3><div class="chart-box"><canvas id="guestSectionPriority"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>In-house satisfaction</h3><div class="chart-box"><canvas id="guestSatisfaction"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Membership by tier</h3><div class="chart-box"><canvas id="guestMembership"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Departure score and employee call rating</h3><div class="chart-box"><canvas id="guestRatings"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>VIP arrival, departure, and occ</h3><div class="chart-box"><canvas id="guestVipTrend"></canvas></div></div>
      <button type="button" class="dmr-btn dmr-btn-primary" id="guestAnalysisPdf">Export analysis PDF</button>`;
    const charts = window.NovotelCharts;
    const channels = data.channels || {};
    if (charts && window.Chart) {
      const channelOptions = charts.chartFrame();
      charts.mountChart(document.getElementById('guestChannels'), {type:'bar', data:{labels:['Call','WhatsApp','Email'], datasets:[{data:[channels.Call||0, channels.WhatsApp||0, channels.Email||0], backgroundColor:['#1e22aa','#14b8a6','#7c6bf2'], borderRadius:8, maxBarThickness:48}]}, options: channelOptions});
      const scoreOptions = charts.chartFrame();
      scoreOptions.plugins.legend = {display:true, position:'top', labels:{boxWidth:10, color:'#5B6673', font:{family:'Aptos, Calibri, sans-serif', size:11}}};
      const scoreCanvas = document.getElementById('guestScores');
      charts.mountChart(scoreCanvas, {type:'line', data:{labels:data.labels, datasets: scoreSets(charts, scoreCanvas, data)}, options: scoreScale(scoreOptions)});
    }
    mountNamed('guestSectionPriority', canvas => sectionPriorityChart(canvas, data, false));
    mountNamed('guestSatisfaction', canvas => satisfactionChart(canvas, data, false));
    mountNamed('guestMembership', canvas => membershipChart(canvas, data, false));
    mountNamed('guestRatings', canvas => ratingChart(canvas, data, false));
    mountNamed('guestVipTrend', canvas => vipChart(canvas, data, false));
    const btn = document.getElementById('guestAnalysisPdf');
    if (btn) btn.onclick = exportAnalysisPdf;
  }

  const GR = {
    brand: [30, 34, 170], ink: [15, 23, 42], slate: [51, 65, 85], gray: [100, 116, 139],
    line: [226, 232, 240], tint: [248, 250, 252], track: [241, 245, 249], white: [255, 255, 255],
    midTint: [255, 251, 235], green: [6, 95, 70], red: [185, 28, 28], amber: [180, 83, 9], rose: [159, 18, 57]
  };
  const SUB_COLORS = {
    'PREFERENCES': [[6, 95, 70], [4, 120, 87]],
    'ACTION TAKEN': [[30, 64, 175], [29, 78, 216]],
    'SPECIAL REQUEST': [[107, 33, 168], [126, 34, 206]],
    'GUEST FEEDBACK': [[185, 28, 28], [220, 38, 38]],
    'NOTE': [[146, 64, 14], [180, 83, 9]]
  };
  const LEGEND = [
    ['PREFERENCES (Green)', [4, 120, 87]], ['ACTION TAKEN (Blue)', [29, 78, 216]],
    ['SPECIAL REQUEST (Purple)', [126, 34, 206]], ['GUEST FEEDBACK (Red)', [220, 38, 38]], ['NOTE (Amber)', [180, 83, 9]]
  ];
  const txt = value => String(value == null ? '' : value).trim();
  const dash = value => txt(value) || '-';
  const part = (t, c, b, s) => ({t, c, b, s});
  function pdfNumber(value){
    const raw = txt(value).replace(/,/g, '');
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  function satisfactionColor(value){
    if (value === 'Satisfied') return GR.green;
    if (value === 'Non Satisfied') return GR.red;
    if (value === 'Have Comment') return GR.amber;
    return GR.slate;
  }
  function markColor(value){
    const n = pdfNumber(value);
    if (n == null) return GR.slate;
    return n >= 8 ? GR.green : (n >= 5 ? GR.amber : GR.red);
  }

  function guestPdfWriter(doc){
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const M = 28, TW = W - 2 * M, TOP = 48, BOTTOM = H - 44, PAD = 4, LABEL_W = 96;
    const g = { y: 0 };
    const font = (bold, size, color) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color); };
    const border = (x, y, w, h) => { doc.setDrawColor(...GR.brand); doc.setLineWidth(1.5); doc.rect(x, y, w, h, 'S'); doc.setLineWidth(0.75); };

    function measure(parts, width){
      const out = [];
      let h = 0;
      parts.forEach(p => {
        const t = txt(p.t);
        if (!t) return;
        const s = p.s || 7.5;
        doc.setFont('helvetica', p.b ? 'bold' : 'normal'); doc.setFontSize(s);
        const lines = doc.splitTextToSize(t, width - 2 * PAD);
        out.push({p, s, lines});
        h += lines.length * s * 1.28;
      });
      return {out, h};
    }
    function paint(cell, x, y){
      let cy = y;
      cell.out.forEach(({p, s, lines}) => {
        font(p.b, s, p.c || GR.ink);
        lines.forEach(line => { doc.text(line, x + PAD, cy + s * 0.95); cy += s * 1.28; });
      });
    }

    function strip(items){
      const h = 34, cw = TW / items.length;
      doc.setFillColor(...GR.tint); doc.setDrawColor(...GR.line); doc.setLineWidth(0.75);
      doc.rect(M, g.y, TW, h, 'FD');
      items.forEach((item, i) => {
        const x = M + i * cw;
        if (i) doc.line(x, g.y, x, g.y + h);
        font(true, 6.5, GR.gray); doc.text(item.label, x + 10, g.y + 12);
        font(true, 11, item.color || GR.ink); doc.text(item.value, x + 10, g.y + 26);
      });
      g.y += h + 18;
    }

    function summary(data, occText){
      const scores = (data.scores || []).filter(r => txt(r.type) || txt(r.ytd));
      const members = (data.membership || []).filter(r => txt(r.tier) || txt(r.vip) || txt(r.arrival) || txt(r.inHouse) || txt(r.departure));
      const house = data.inHouse || [];
      const LW = Math.round(TW * 0.4), RX = M + LW + 12, RW = TW - LW - 12;
      font(true, 10, GR.ink);
      doc.text('Scores & Shift Analytics', M, g.y + 9);
      doc.text('Membership', RX, g.y + 9);
      font(false, 6.5, GR.gray);
      doc.text('YTD & Call Outcomes', M + LW, g.y + 9, {align: 'right'});
      doc.text('Tier Breakdown & Share Chart', M + TW, g.y + 9, {align: 'right'});
      const y0 = g.y + 15;

      let ly = y0;
      const c1 = 58, c3 = 46, c2 = LW - c1 - c3;
      doc.setFillColor(...GR.brand); doc.rect(M, ly, LW, 16, 'F');
      font(true, 6.5, GR.white);
      doc.text('SCORE', M + 6, ly + 10.5);
      doc.text('VISUAL BENCHMARK', M + c1 + 4, ly + 10.5);
      doc.text('YTD', M + LW - 6, ly + 10.5, {align: 'right'});
      ly += 16;
      if (!scores.length) { font(false, 7.5, GR.gray); doc.text('No scores recorded', M + 6, ly + 10.5); ly += 16; }
      scores.forEach((s, i) => {
        if (i % 2) { doc.setFillColor(...GR.tint); doc.rect(M, ly, LW, 16, 'F'); }
        font(true, 7.5, GR.ink); doc.text(doc.splitTextToSize(dash(s.type), c1 - 8)[0], M + 6, ly + 10.5);
        const v = pdfNumber(s.ytd);
        const scale = v == null ? 100 : (v <= 5 ? 5 : (v <= 10 ? 10 : 100));
        const bw = c2 - 8;
        doc.setFillColor(...GR.track); doc.roundedRect(M + c1 + 4, ly + 5, bw, 6, 2, 2, 'F');
        if (v != null && v > 0) { doc.setFillColor(...GR.brand); doc.roundedRect(M + c1 + 4, ly + 5, Math.max(3, bw * Math.min(v / scale, 1)), 6, 2, 2, 'F'); }
        font(true, 7.5, GR.brand); doc.text(dash(s.ytd), M + LW - 6, ly + 10.5, {align: 'right'});
        ly += 16;
      });
      const total = house.length;
      const noAnswer = house.filter(r => r.callStatus === 'No Answer').length;
      const satisfied = house.filter(r => r.callStatus !== 'No Answer' && r.satisfaction === 'Satisfied').length;
      const followUp = total - noAnswer - satisfied;
      doc.setFillColor(...GR.tint); doc.rect(M, ly, LW, 50, 'F');
      doc.setDrawColor(...GR.line); doc.line(M, ly, M + LW, ly);
      font(true, 6.5, GR.slate); doc.text('WELCOME CALL OUTCOMES (' + total + ')', M + 6, ly + 11);
      font(false, 6.5, GR.gray); doc.text(satisfied + ' Sat | ' + followUp + ' Follow-up | ' + noAnswer + ' No Ans', M + LW - 6, ly + 11, {align: 'right'});
      const bx = M + 6, bw = LW - 12, by = ly + 17;
      doc.setFillColor(...GR.track); doc.rect(bx, by, bw, 7, 'F');
      if (total) {
        let cx = bx;
        [[satisfied, [4, 120, 87]], [followUp, GR.brand], [noAnswer, [245, 158, 11]]].forEach(([n, c]) => {
          if (!n) return;
          doc.setFillColor(...c); doc.rect(cx, by, bw * n / total, 7, 'F');
          cx += bw * n / total;
        });
      }
      font(false, 6.5, GR.gray); doc.text('VIP Movement Ratio', M + 6, ly + 40);
      font(true, 6.5, GR.ink); doc.text('Arr: ' + dash(data.arrivals) + ' / Dep: ' + dash(data.departures) + ' (Occ ' + (occText || '-') + ')', M + LW - 6, ly + 40, {align: 'right'});
      ly += 50;
      border(M, y0, LW, ly - y0);

      let ry = y0;
      const mc = [['TIER', 70], ['V', 28], ['ARRIVAL', 46, true], ['IN-HOUSE', 48, true], ['DEPARTURE', 54, true], ['IN-HOUSE CHART', RW - 246]];
      doc.setFillColor(...GR.brand); doc.rect(RX, ry, RW, 16, 'F');
      let hx = RX;
      mc.forEach(([label, w, right]) => {
        font(true, 6.5, GR.white);
        doc.text(label, right ? hx + w - 5 : hx + 5, ry + 10.5, right ? {align: 'right'} : undefined);
        hx += w;
      });
      ry += 16;
      const count = v => pdfNumber(v) || 0;
      const sums = {a: 0, i: 0, d: 0};
      members.forEach(r => { sums.a += count(r.arrival); sums.i += count(r.inHouse); sums.d += count(r.departure); });
      const memberRow = (cells, share, fill, bold) => {
        if (fill) { doc.setFillColor(...fill); doc.rect(RX, ry, RW, 15, 'F'); }
        let cx = RX;
        cells.forEach((value, i) => {
          const [, w, right] = mc[i];
          font(bold || i === 3, 7.5, i === 0 ? GR.ink : GR.slate);
          doc.text(doc.splitTextToSize(value, w - 8)[0] || '', right ? cx + w - 5 : cx + 5, ry + 10, right ? {align: 'right'} : undefined);
          cx += w;
        });
        const cw = mc[5][1], tw = cw - 36;
        doc.setFillColor(...GR.track); doc.roundedRect(cx + 5, ry + 5, tw, 5, 2, 2, 'F');
        if (share > 0) { doc.setFillColor(...GR.brand); doc.roundedRect(cx + 5, ry + 5, Math.max(2, tw * share), 5, 2, 2, 'F'); }
        font(true, 7, GR.ink); doc.text(sums.i ? Math.round(share * 100) + '%' : '-', cx + cw - 5, ry + 10, {align: 'right'});
        ry += 15;
      };
      if (!members.length) { font(false, 7.5, GR.gray); doc.text('No membership rows', RX + 5, ry + 10); ry += 15; }
      members.forEach((r, i) => memberRow([dash(r.tier), dash(r.vip), dash(r.arrival), dash(r.inHouse), dash(r.departure)], sums.i ? count(r.inHouse) / sums.i : 0, i % 2 ? GR.tint : null));
      if (members.length) memberRow(['Total', '-', String(sums.a), String(sums.i), String(sums.d)], sums.i ? 1 : 0, GR.track, true);
      border(RX, y0, RW, ry - y0);
      g.y = Math.max(ly, ry) + 20;
    }

    function legend(){
      const h = 18;
      doc.setFillColor(...GR.tint); doc.setDrawColor(...GR.line); doc.setLineWidth(0.75);
      doc.rect(M, g.y, TW, h, 'FD');
      const title = 'SUB-ROW TEXT COLOR KEY:';
      font(true, 6.5, GR.slate); doc.text(title, M + 8, g.y + 11.5);
      let x = M + 8 + doc.getTextWidth(title) + 12;
      const widths = LEGEND.map(([t]) => doc.getTextWidth(t) + 9);
      const gap = Math.max(6, (M + TW - 8 - x - widths.reduce((a, b) => a + b, 0)) / (LEGEND.length - 1));
      LEGEND.forEach(([t, c], i) => {
        doc.setFillColor(...c); doc.circle(x + 2.5, g.y + 9.3, 2.3, 'F');
        font(true, 6.5, c); doc.text(t, x + 8, g.y + 11.5);
        x += widths[i] + gap;
      });
      g.y += h + 16;
    }

    function headerHeight(cols){
      font(true, 6.5, GR.white);
      return Math.max(...cols.map(c => doc.splitTextToSize(c.label, c.w - 2 * PAD).length)) * 8 + 8;
    }
    function table(title, cols, records){
      if (!records.length) return;
      cols = cols.map(c => Object.assign({}, c, {w: c.f * TW}));
      const hh = headerHeight(cols);
      const groups = records.map(r => {
        const cells = r.cells.map((parts, i) => measure(parts, cols[i].w));
        const mainH = Math.max(14, ...cells.map(c => c.h)) + 8;
        font(false, 7.5, GR.ink);
        const subs = (r.subs || []).filter(s => txt(s[1])).map(s => {
          const lines = doc.splitTextToSize(txt(s[1]), TW - LABEL_W - PAD - 4);
          return {label: s[0], lines, h: lines.length * 9.6 + 7};
        });
        return {r, cells, mainH, subs, h: mainH + subs.reduce((a, s) => a + s.h, 0)};
      });
      const note = records.length + (records.length === 1 ? ' record' : ' records');
      let top = 0;
      const open = cont => {
        font(true, 11, GR.ink); doc.text(cont ? title + ' (Continued)' : title, M, g.y + 10);
        if (!cont) { font(false, 7, GR.gray); doc.text(note, M + TW, g.y + 10, {align: 'right'}); }
        g.y += 16;
        top = g.y;
        doc.setFillColor(...GR.brand); doc.rect(M, g.y, TW, hh, 'F');
        let x = M;
        cols.forEach(c => {
          font(true, 6.5, GR.white);
          doc.splitTextToSize(c.label, c.w - 2 * PAD).forEach((line, i) => doc.text(line, x + PAD, g.y + 10 + i * 8));
          x += c.w;
        });
        g.y += hh;
      };
      const breakPage = () => { border(M, top, TW, g.y - top); doc.addPage(); g.y = TOP; open(true); };
      if (g.y + 16 + hh + groups[0].mainH > BOTTOM) { doc.addPage(); g.y = TOP; }
      open(false);
      groups.forEach((group, gi) => {
        if (g.y + group.h > BOTTOM && g.y > top + hh + 1) breakPage();
        doc.setFillColor(...(group.r.tint || (gi % 2 ? GR.tint : GR.white)));
        doc.rect(M, g.y, TW, group.mainH, 'F');
        let x = M;
        group.cells.forEach((cell, i) => { paint(cell, x, g.y + 4); x += cols[i].w; });
        g.y += group.mainH;
        group.subs.forEach(sub => {
          if (g.y + sub.h > BOTTOM) breakPage();
          const colors = SUB_COLORS[sub.label] || [GR.brand, GR.ink];
          doc.setDrawColor(...GR.line); doc.setLineWidth(0.75); doc.line(M, g.y, M + TW, g.y);
          font(true, 7, colors[0]); doc.text(sub.label + ':', M + PAD + 2, g.y + 10);
          font(false, 7.5, colors[1]);
          sub.lines.forEach((line, i) => doc.text(line, M + LABEL_W, g.y + 10 + i * 9.6));
          g.y += sub.h;
        });
        if (gi < groups.length - 1) { doc.setDrawColor(...GR.brand); doc.setLineWidth(1.5); doc.line(M, g.y, M + TW, g.y); doc.setLineWidth(0.75); }
      });
      border(M, top, TW, g.y - top);
      g.y += 20;
    }

    function finish(dateText, preparedBy){
      const total = doc.internal.getNumberOfPages();
      for (let i = 1; i <= total; i++) {
        doc.setPage(i);
        if (i > 1) {
          doc.setFillColor(...GR.tint); doc.rect(M, 14, TW, 20, 'F');
          doc.setFillColor(...GR.brand); doc.rect(M, 34, TW, 1.2, 'F');
          font(true, 7, GR.brand); doc.text('NOVOTEL', M + 8, 27);
          const nw = doc.getTextWidth('NOVOTEL  ');
          font(true, 7, GR.slate); doc.text('·  GUEST RELATION REPORT (' + dateText + ')', M + 8 + nw, 27);
          if (preparedBy) { font(true, 7, GR.brand); doc.text('Prepared by: ' + preparedBy, M + TW - 8, 27, {align: 'right'}); }
        }
        doc.setDrawColor(...GR.line); doc.setLineWidth(0.75); doc.line(M, H - 30, M + TW, H - 30);
        font(false, 7.5, GR.gray);
        doc.text('Novotel — Guest Relation Report', M, H - 18);
        doc.text('Page ' + i + ' of ' + total, M + TW, H - 18, {align: 'right'});
      }
    }

    return { g, M, strip, summary, legend, table, finish };
  }

  function prettyDate(value){
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!match) return String(value || '').trim();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = months[Number(match[2]) - 1];
    return month ? month + ' ' + Number(match[3]) + ', ' + match[1] : String(value).trim();
  }
  function prettyTime(value){
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return String(value || '').trim();
    let hour = Number(match[1]);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    hour = hour % 12 || 12;
    return (hour < 10 ? '0' : '') + hour + ':' + match[2] + ' ' + suffix;
  }
  async function exportPdf(date){
    if (!window.jspdf || !window.NovotelPdf) return;
    const data = await window.apiFetch('/api/guest?date=' + encodeURIComponent(date));
    if (!data || !data.status) return;
    const {jsPDF} = window.jspdf;
    const pdf = window.NovotelPdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth();
    const out = guestPdfWriter(doc);
    const dateText = fmtDate(data.date);
    const occText = window.withPercent ? window.withPercent(data.occupancy) : (txt(data.occupancy) ? txt(data.occupancy) + '%' : '');
    out.g.y = pdf.pdfMasthead(doc, W, await pdf.getLogoDataUrl(), { title: 'Guest Relation Report', date: dateText, preparedBy: data.submittedBy, margin: out.M });
    out.strip([
      {label: 'SHIFT', value: (data.shiftStart || '—') + ' to ' + (data.shiftEnd || '—')},
      {label: 'VIP OCC', value: occText || '—', color: GR.rose},
      {label: 'TOTAL VIP ARRIVAL', value: dash(data.arrivals)},
      {label: 'TOTAL VIP DEPARTURE', value: dash(data.departures)}
    ]);
    out.summary(data, occText);
    const priorityCell = (row, i) => [part('GUEST ' + (i + 1), GR.gray, true, 6), part(row.priority || 'Normal', priorityColor(row.priority || 'Normal'), true)];
    const tint = row => row.priority === 'Mid' ? GR.midTint : null;
    const slate = value => [part(dash(value), GR.slate)];
    const strong = value => [part(dash(value), GR.ink, true)];
    const call = row => row.callStatus ? part(row.callStatus, callStatusColor(row.callStatus), true) : null;
    const pre = data.preArrival || [], house = data.inHouse || [], leave = data.departure || [];
    if (pre.length || house.length || leave.length) out.legend();
    out.table('Pre-arrival', [
      {label: 'PRIORITY', f: 0.08}, {label: 'GUEST', f: 0.20}, {label: 'RESERVATION #', f: 0.15}, {label: 'TIER', f: 0.09},
      {label: 'ARRIVAL', f: 0.10}, {label: 'DEPARTURE', f: 0.10}, {label: 'ARRIVAL TIME', f: 0.10}, {label: 'CONTACT & CALL STATUS', f: 0.18}
    ], pre.map((row, i) => ({
      tint: tint(row),
      cells: [
        priorityCell(row, i), strong(row.name), strong(row.reservation), slate(row.membership),
        slate(prettyDate(row.arrival)), slate(prettyDate(row.departure)), slate(prettyTime(row.arrivalTime)),
        [part(dash(row.contacted), GR.slate), call(row)].filter(Boolean)
      ],
      subs: [['PREFERENCES', row.preferences], ['ACTION TAKEN', row.action], ['NOTE', row.note]]
    })));
    out.table('In-house welcome call', [
      {label: 'PRIORITY', f: 0.08}, {label: 'ROOM', f: 0.11}, {label: 'GUEST', f: 0.15}, {label: 'MEMBERSHIP', f: 0.10},
      {label: 'ARRIVAL', f: 0.10}, {label: 'DEPARTURE', f: 0.10}, {label: 'SERVICE / DRINK / F&B', f: 0.14},
      {label: 'CONTACT', f: 0.09}, {label: 'SATISFACTION', f: 0.13}
    ], house.map((row, i) => {
      const service = [['Svc', row.service], ['Drk', row.drink], ['F&B', row.fb]].filter(item => txt(item[1])).map(item => part(item[0] + ': ' + txt(item[1]), GR.slate));
      return {
        tint: tint(row),
        cells: [
          priorityCell(row, i), strong(row.room), strong(row.name), slate(row.membership),
          slate(prettyDate(row.arrival)), slate(prettyDate(row.departure)),
          service.length ? service : slate(''), slate(row.contacted),
          [part(dash(row.satisfaction), satisfactionColor(row.satisfaction), true), call(row)].filter(Boolean)
        ],
        subs: [['SPECIAL REQUEST', row.request], ['GUEST FEEDBACK', row.feedback], ['ACTION TAKEN', row.action], ['NOTE', row.note]]
      };
    }));
    out.table('Departure courtesy call', [
      {label: 'PRIORITY', f: 0.08}, {label: 'ROOM #', f: 0.10}, {label: 'GUEST NAME', f: 0.14}, {label: 'TIER', f: 0.08},
      {label: 'ARRIVAL', f: 0.095}, {label: 'DEPARTURE', f: 0.095}, {label: 'SATISF. 1–10', f: 0.07},
      {label: 'EMP. RATING', f: 0.08}, {label: 'REVIEW REMINDER', f: 0.10}, {label: 'STATUS & BY', f: 0.16}
    ], leave.map((row, i) => ({
      tint: tint(row),
      cells: [
        priorityCell(row, i), strong(row.room), strong(row.name), slate(row.membership),
        slate(prettyDate(row.arrival)), slate(prettyDate(row.departure)),
        txt(row.score) ? [part(txt(row.score) + ' / 10', markColor(row.score), true)] : slate(''),
        txt(row.employeeRating) ? [part(txt(row.employeeRating) + ' / 10', GR.brand, true)] : slate(''),
        slate(row.review),
        [call(row), part(dash(row.contacted), GR.slate)].filter(Boolean)
      ],
      subs: [['GUEST FEEDBACK', row.feedback], ['ACTION TAKEN', row.action], ['NOTE', row.note]]
    })));
    out.table('General Comments', [
      {label: 'TIME', f: 0.14}, {label: 'COMMENT', f: 0.86}
    ], (data.generalComments || []).map(row => ({
      cells: [[part(dash(prettyTime(row.time)), GR.slate, true)], [part(dash(row.comment), GR.ink)]]
    })));
    out.finish(dateText, data.submittedBy);
    doc.save('novotel-guest-relation-' + date + '.pdf');
  }

  async function exportAnalysisPdf(){
    const data = window.guestAnalysis;
    if (!data || !window.jspdf || !window.NovotelPdf || !window.NovotelCharts) return;
    const {jsPDF} = window.jspdf;
    const pdf = window.NovotelPdf;
    const charts = window.NovotelCharts;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const W = doc.internal.pageSize.getWidth();
    let y = pdf.pdfHeader(doc, W, await pdf.getLogoDataUrl(), 'GUEST RELATION ANALYSIS');
    doc.setFontSize(10); doc.text(data.startDate + ' to ' + data.endDate, 40, y); y += 12;
    y = pdf.pdfKpiBoard(doc, W, y, guestTiers(data));
    const img = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      const channels = data.channels || {};
      return new Chart(canvas, {type:'bar', data:{labels:['Call','WhatsApp','Email'], datasets:[{data:[channels.Call||0, channels.WhatsApp||0, channels.Email||0], backgroundColor:['#1e22aa','#14b8a6','#7c6bf2'], borderRadius:8}]}, options});
    });
    const chartH = charts.pdfChartHeight(W - 80);
    if (y + chartH + 20 > 790) { doc.addPage(); y = 48; }
    doc.text('How guests were contacted', 40, y); y += 8;
    doc.addImage(img, 'PNG', 40, y, W - 80, chartH, undefined, 'FAST'); y += chartH + 16;
    const scoreImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      options.plugins.legend.display = true;
      return new Chart(canvas, {type:'line', data:{labels:data.labels, datasets: scoreSets(charts, canvas, data)}, options: scoreScale(options)});
    });
    if (y + chartH + 20 > 790) { doc.addPage(); y = 48; }
    doc.text('Scores (YTD)', 40, y); y += 8;
    doc.addImage(scoreImg, 'PNG', 40, y, W - 80, chartH, undefined, 'FAST'); y += chartH + 16;
    const extra = [
      ['Priority by section', canvas => sectionPriorityChart(canvas, data, true)],
      ['In-house satisfaction', canvas => satisfactionChart(canvas, data, true)],
      ['Membership by tier', canvas => membershipChart(canvas, data, true)],
      ['Departure score and employee call rating', canvas => ratingChart(canvas, data, true)],
      ['VIP arrival, departure, and occ', canvas => vipChart(canvas, data, true)]
    ];
    extra.forEach(item => {
      const image = charts.chartImage(item[1]);
      if (y + chartH + 20 > 790) { doc.addPage(); y = 48; }
      doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(28,43,57);
      doc.text(item[0], 40, y); y += 8;
      doc.addImage(image, 'PNG', 40, y, W - 80, chartH, undefined, 'FAST'); y += chartH + 16;
    });
    pdf.addPdfFooter(doc, W, 'Novotel — Guest Relation Analysis');
    doc.save('novotel-guest-analysis-' + data.startDate + '-to-' + data.endDate + '.pdf');
  }

  window.renderGuestSection = renderGuestSection;
  window.guestPriorityChart = priorityChart;
  window.guestVipChart = vipChart;
})();
