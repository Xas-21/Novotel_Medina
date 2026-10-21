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
    if (value === 'Urgent') return [177, 75, 63];
    if (value === 'Mid') return [184, 134, 11];
    if (value === 'Normal') return [30, 34, 170];
    return [35, 48, 61];
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
      field('Priority', prioritySelect(row.priority, dis)),
      field('Reservation #', `<input data-k="reservation" value="${escapeHtml(row.reservation)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(TIERS, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Arrival time', `<input type="time" data-k="arrivalTime" value="${escapeHtml(row.arrivalTime)}" ${dis}>`),
      field('Preferences', `<textarea data-k="preferences" rows="3" ${dis}>${escapeHtml(row.preferences)}</textarea>`, true),
      field('Action taken', `<textarea data-k="action" rows="3" ${dis}>${escapeHtml(row.action)}</textarea>`, true),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const house = draft.inHouse.map((row, i) => textRow('inHouse', i, [
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
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const leave = draft.departure.map((row, i) => textRow('departure', i, [
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
            <div class="dmr-field"><label>VIP occ %</label><span class="night-calc" id="guestOcc">${escapeHtml(occ)}</span></div>
          </div>
          ${draft.submittedBy ? `<p class="dmr-prepared-by">Prepared by: ${escapeHtml(draft.submittedBy)}</p>` : ''}
        </div>
        <div class="dmr-card dmr-section-card">
          <h3>Scores</h3>
          ${scores || '<p class="dmr-sub">No scores yet.</p>'}
          ${dis ? '' : '<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="scores">+ Add score</button>'}
        </div>
        <div class="dmr-card dmr-section-card">
          <h3>Membership</h3>
          ${members || '<p class="dmr-sub">No membership rows yet.</p>'}
          ${dis ? '' : '<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="membership">+ Add membership</button>'}
        </div>
        <div class="dmr-card dmr-section-card"><h3>Pre-arrival communication</h3>${pre || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="preArrival" ${dis}>+ Add guest</button></div>
        <div class="dmr-card dmr-section-card"><h3>In-house welcome call</h3>${house || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="inHouse" ${dis}>+ Add guest</button></div>
        <div class="dmr-card dmr-section-card"><h3>Departure courtesy call</h3>${leave || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="departure" ${dis}>+ Add guest</button></div>
        <div class="dmr-card dmr-section-card">
          <h3>General Comments</h3>
          ${comments || '<p class="dmr-sub">No general comments yet.</p>'}
          ${dis ? '' : '<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="generalComments">+ Add comment</button>'}
        </div>
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
      if (span && draft) span.textContent = vipOcc(target.value, draft.roomsAvailable);
    }
    if (target && target.classList && target.classList.contains('guest-priority')) target.dataset.priority = target.value;
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
    return {reservation:'', name:'', membership:'', arrival:'', departure:'', arrivalTime:'', preferences:'', action:'', contacted:'', room:'', satisfaction:'', request:'', service:'', drink:'', fb:'', score:'', feedback:'', review:'', employeeRating:'', priority:'Normal'};
  }
  async function onClick(e){
    const add = e.target.closest && e.target.closest('[data-guest-add]');
    const del = e.target.closest && e.target.closest('[data-guest-del]');
    if (add && canEdit() && !locked()) {
      read();
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
        ${group.entries.map(entry => `
          <div class="dmr-archive-row">
            <div>
              <div class="dmr-archive-date">${escapeHtml(fmtDate(entry.date))}</div>
              <span class="dmr-badge ${entry.status === 'submitted' ? 'dmr-badge-submitted' : 'dmr-badge-draft'}">${entry.status === 'submitted' ? 'Submitted' : 'Draft'}</span>
              ${entry.occupancy ? `<span style="font-size:12px;color:var(--ink-soft);margin-left:8px;">Occ: ${escapeHtml(String(entry.occupancy).replace('%','').trim())}%</span>` : ''}
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

  async function loadAnalysis(){
    const el = document.getElementById('guestAnalysis');
    const data = await window.apiFetch('/api/guest/analysis?' + window.periodQuery());
    if (!el || !data) return;
    window.guestAnalysis = data;
    el.innerHTML = `
      <p class="dmr-sub">${escapeHtml(data.startDate)} to ${escapeHtml(data.endDate)}</p>
      <div class="dmr-stat-grid">
        <div class="dmr-card dmr-stat tone-ok"><div class="num">${data.submitted}</div><div class="lbl">Reports submitted</div></div>
        <div class="dmr-card dmr-stat tone-danger"><div class="num">${data.missing}</div><div class="lbl">Days not submitted</div></div>
        <div class="dmr-card dmr-stat tone-navy"><div class="num">${data.welcomeCalls}</div><div class="lbl">Welcome calls</div></div>
        <div class="dmr-card dmr-stat tone-navy"><div class="num">${data.departureCalls}</div><div class="lbl">Departure calls</div></div>
        <div class="dmr-card dmr-stat tone-warn"><div class="num">${data.notSatisfied}</div><div class="lbl">Not satisfied</div></div>
        <div class="dmr-card dmr-stat tone-danger"><div class="num">${data.urgent || 0}</div><div class="lbl">Urgent guest actions</div></div>
        <div class="dmr-card dmr-stat tone-teal"><div class="num">${data.avgDeparture == null ? '—' : data.avgDeparture}</div><div class="lbl">Avg departure score</div></div>
        <div class="dmr-card dmr-stat tone-teal"><div class="num">${data.avgEmployee == null ? '—' : data.avgEmployee}</div><div class="lbl">Avg employee call rating</div></div>
        <div class="dmr-card dmr-stat tone-navy"><div class="num">${data.avgVipOcc == null ? '—' : data.avgVipOcc + '%'}</div><div class="lbl">Avg VIP occ</div></div>
      </div>
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
      const colors = ['#1e22aa','#14b8a6','#7c6bf2','#A8814F','#B14B3F','#4F7A5B'];
      charts.mountChart(document.getElementById('guestScores'), {type:'line', data:{labels:data.labels, datasets: SCORES.map((row, i) => { const series = charts.areaSeries(document.getElementById('guestScores'), row[1], (data.scores && data.scores[row[0]]) || [], colors[i], '30,34,170'); series.spanGaps = true; series.fill = false; series.backgroundColor = colors[i]; return series; })}, options: scoreOptions});
    }
    mountNamed('guestSectionPriority', canvas => sectionPriorityChart(canvas, data, false));
    mountNamed('guestSatisfaction', canvas => satisfactionChart(canvas, data, false));
    mountNamed('guestMembership', canvas => membershipChart(canvas, data, false));
    mountNamed('guestRatings', canvas => ratingChart(canvas, data, false));
    mountNamed('guestVipTrend', canvas => vipChart(canvas, data, false));
    const btn = document.getElementById('guestAnalysisPdf');
    if (btn) btn.onclick = exportAnalysisPdf;
  }

  function pdfTable(doc, pdf, W, y, title, cols, rows){
    if (!rows.length) return y;
    if (y > 700) { doc.addPage(); y = 48; }
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(28,43,57);
    doc.text(title, 40, y); y += 8;
    return pdf.pdfTable(doc, W, y, cols, rows) + 10;
  }
  function withPriority(row){
    const item = Object.assign({}, row);
    item.PRI = row.priority || '';
    item.PRI_color = priorityColor(row.priority);
    return item;
  }

  function writeNote(doc, W, y, label, text){
    const body = String(text || '').trim();
    if (!body) return y;
    const x = 40, width = W - 80;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    const wrapped = doc.splitTextToSize(body, width - 12);
    const labelBar = () => {
      if (y + 26 > 770) { doc.addPage(); y = 48; }
      doc.setFillColor(247, 244, 236);
      doc.rect(x, y, width, 14, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(30, 34, 170);
      doc.text(label, x + 6, y + 10);
      y += 14;
    };
    labelBar();
    wrapped.forEach(line => {
      if (y + 14 > 770) { doc.addPage(); y = 48; labelBar(); }
      doc.setFillColor(247, 244, 236);
      doc.rect(x, y, width, 12, 'F');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(35, 48, 61);
      doc.text(line, x + 6, y + 9);
      y += 12;
    });
    return y + 2;
  }

  function paintGuestPeople(doc, W, y, title, cols, people){
    if (!people.length) return y;
    if (y > 700) { doc.addPage(); y = 48; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(28, 43, 57);
    doc.text(title, 40, y);
    y += 8;
    const x = 40, width = W - 80, headerH = 16;
    const header = (cy) => {
      doc.setFillColor(30, 34, 170);
      doc.rect(x, cy, width, headerH, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
      let cx = x;
      cols.forEach(col => { doc.text(col.label, cx + 4, cy + 10.5); cx += col.w; });
      return cy + headerH;
    };
    y = header(y);
    people.forEach((person, ri) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      const lines = cols.map(col => {
        const txt = person[col.key] != null ? String(person[col.key]) : '';
        return txt ? doc.splitTextToSize(txt, col.w - 8) : [''];
      });
      const rowH = Math.max(16, 6 + Math.max(...lines.map(list => list.length)) * 10);
      if (y + rowH > 770) { doc.addPage(); y = 48; y = header(y); }
      doc.setFillColor(...(ri % 2 === 0 ? [255, 255, 255] : [250, 249, 244]));
      doc.rect(x, y, width, rowH, 'F');
      let cx = x;
      cols.forEach((col, i) => {
        doc.setTextColor(...(person[col.key + '_color'] || [35, 48, 61]));
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        lines[i].forEach((line, n) => doc.text(line, cx + 4, y + 11 + n * 10));
        cx += col.w;
      });
      y += rowH;
      (person.notes || []).forEach(note => { y = writeNote(doc, W, y, note.label, note.text); });
      y += 3;
    });
    return y + 8;
  }

  async function exportPdf(date){
    if (!window.jspdf || !window.NovotelPdf) return;
    const data = await window.apiFetch('/api/guest?date=' + encodeURIComponent(date));
    if (!data || !data.status) return;
    const {jsPDF} = window.jspdf;
    const pdf = window.NovotelPdf;
    const doc = new jsPDF({unit:'pt', format:'a4'});
    const W = doc.internal.pageSize.getWidth();
    const logo = await pdf.getLogoDataUrl();
    let y = pdf.pdfHeader(doc, W, logo, 'GUEST RELATION REPORT');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(28, 43, 57);
    doc.text(fmtDate(data.date), 40, y);
    if (data.submittedBy) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(30, 34, 170);
      doc.text('Prepared by: ' + data.submittedBy, W - 40, y, {align:'right'});
    }
    y += 16;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110, 120, 132);
    doc.text('Shift: ' + (data.shiftStart || '—') + '  to  ' + (data.shiftEnd || '—'), 40, y);
    const occText = data.occupancy ? data.occupancy + '%' : '—';
    const occColor = window.occupancyColor ? window.occupancyColor(data.occupancy) : [110, 120, 132];
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(occColor[0], occColor[1], occColor[2]);
    doc.text('VIP occ: ' + occText, 200, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(110, 120, 132);
    doc.text('Total VIP arrival: ' + (data.arrivals || '—'), 300, y);
    doc.text('Total VIP departure: ' + (data.departures || '—'), 430, y);
    y += 16;
    y = pdfTable(doc, pdf, W, y, 'Scores', [
      {key:'TYPE', label:'SCORE', w:260},{key:'YTD', label:'YTD', w:200}
    ], (data.scores || []).map(row => ({TYPE: row.type || '', YTD: row.ytd || ''})));
    y = pdfTable(doc, pdf, W, y, 'Membership', [
      {key:'TIER', label:'TIER', w:140},{key:'VIP', label:'V', w:60},{key:'ARR', label:'ARRIVAL', w:100},{key:'INN', label:'IN-HOUSE', w:100},{key:'DEP', label:'DEPARTURE', w:100}
    ], (data.membership || []).map(row => ({TIER: row.tier || '', VIP: row.vip || '', ARR: row.arrival || '', INN: row.inHouse || '', DEP: row.departure || ''})));
    y = paintGuestPeople(doc, W, y, 'Pre-arrival', [
      {key:'PRI', label:'PRIORITY', w:90},{key:'NAME', label:'GUEST', w:280},{key:'MEM', label:'TIER', w:145}
    ], (data.preArrival || []).map(row => withPriority({
      PRI: row.priority || '', NAME: row.name || '', MEM: row.membership || '', priority: row.priority,
      notes: [{label:'PREFERENCES', text: row.preferences}, {label:'ACTION', text: row.action}]
    })));
    y = paintGuestPeople(doc, W, y, 'In-house welcome call', [
      {key:'PRI', label:'PRIORITY', w:90},{key:'ROOM', label:'ROOM', w:70},{key:'NAME', label:'GUEST', w:220},{key:'SAT', label:'SATISFACTION', w:135}
    ], (data.inHouse || []).map(row => withPriority({
      PRI: row.priority || '', ROOM: row.room || '', NAME: row.name || '', SAT: row.satisfaction || '', priority: row.priority,
      notes: [{label:'SPECIAL REQUEST', text: row.request}, {label:'FEEDBACK', text: row.feedback}, {label:'ACTION', text: row.action}]
    })));
    y = paintGuestPeople(doc, W, y, 'Departure courtesy call', [
      {key:'PRI', label:'PRIORITY', w:80},{key:'ROOM', label:'ROOM', w:60},{key:'NAME', label:'GUEST', w:200},{key:'SCORE', label:'SCORE', w:70},{key:'EMP', label:'EMPLOYEE', w:105}
    ], (data.departure || []).map(row => withPriority({
      PRI: row.priority || '', ROOM: row.room || '', NAME: row.name || '', SCORE: row.score || '', EMP: row.employeeRating || '', priority: row.priority,
      notes: [{label:'FEEDBACK', text: row.feedback}, {label:'ACTION', text: row.action}]
    })));
    y = paintGuestPeople(doc, W, y, 'General Comments', [
      {key:'TIME', label:'TIME', w:120}
    ], (data.generalComments || []).map(row => ({TIME: row.time || '—', notes: [{label:'COMMENT', text: row.comment}]})));
    pdf.addPdfFooter(doc, W, 'Novotel — Guest Relation Report');
    doc.save('novotel-guest-relation-' + date + '.pdf');
  }

  async function exportAnalysisPdf(){
    const data = window.guestAnalysis;
    if (!data || !window.jspdf || !window.NovotelPdf || !window.NovotelCharts) return;
    const {jsPDF} = window.jspdf;
    const pdf = window.NovotelPdf;
    const charts = window.NovotelCharts;
    const doc = new jsPDF({unit:'pt', format:'a4'});
    const W = doc.internal.pageSize.getWidth();
    let y = pdf.pdfHeader(doc, W, await pdf.getLogoDataUrl(), 'GUEST RELATION ANALYSIS');
    doc.setFontSize(10); doc.text(data.startDate + ' to ' + data.endDate, 40, y); y += 16;
    doc.text('Submitted ' + data.submitted + '   Not submitted ' + data.missing + '   Not satisfied ' + data.notSatisfied + '   Urgent ' + (data.urgent || 0), 40, y); y += 14;
    doc.text('Avg departure ' + (data.avgDeparture == null ? '—' : data.avgDeparture) + '   Avg employee rating ' + (data.avgEmployee == null ? '—' : data.avgEmployee) + '   Avg VIP occ ' + (data.avgVipOcc == null ? '—' : data.avgVipOcc + '%'), 40, y); y += 16;
    const img = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      const channels = data.channels || {};
      return new Chart(canvas, {type:'bar', data:{labels:['Call','WhatsApp','Email'], datasets:[{data:[channels.Call||0, channels.WhatsApp||0, channels.Email||0], backgroundColor:['#1e22aa','#14b8a6','#7c6bf2'], borderRadius:8}]}, options});
    });
    if (y > 560) { doc.addPage(); y = 48; }
    doc.text('How guests were contacted', 40, y); y += 8;
    doc.addImage(img, 'JPEG', 40, y, W - 80, 140); y += 156;
    const colors = ['#1e22aa','#14b8a6','#7c6bf2','#A8814F','#B14B3F','#4F7A5B'];
    const scoreImg = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      options.plugins.legend.display = true;
      return new Chart(canvas, {type:'line', data:{labels:data.labels, datasets: SCORES.map((row, i) => {
        const series = charts.areaSeries(canvas, row[1], (data.scores && data.scores[row[0]]) || [], colors[i], '30,34,170');
        series.spanGaps = true; series.fill = false; series.backgroundColor = colors[i];
        return series;
      })}, options});
    });
    if (y > 620) { doc.addPage(); y = 48; }
    doc.text('Scores (YTD)', 40, y); y += 8;
    doc.addImage(scoreImg, 'JPEG', 40, y, W - 80, 140); y += 156;
    const extra = [
      ['Priority by section', canvas => sectionPriorityChart(canvas, data, true)],
      ['In-house satisfaction', canvas => satisfactionChart(canvas, data, true)],
      ['Membership by tier', canvas => membershipChart(canvas, data, true)],
      ['Departure score and employee call rating', canvas => ratingChart(canvas, data, true)],
      ['VIP arrival, departure, and occ', canvas => vipChart(canvas, data, true)]
    ];
    extra.forEach(item => {
      const image = charts.chartImage(item[1]);
      if (y > 620) { doc.addPage(); y = 48; }
      doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(28,43,57);
      doc.text(item[0], 40, y); y += 8;
      doc.addImage(image, 'JPEG', 40, y, W - 80, 140); y += 156;
    });
    pdf.addPdfFooter(doc, W, 'Novotel — Guest Relation Analysis');
    doc.save('novotel-guest-analysis-' + data.startDate + '-to-' + data.endDate + '.pdf');
  }

  window.renderGuestSection = renderGuestSection;
  window.guestPriorityChart = priorityChart;
  window.guestVipChart = vipChart;
})();
