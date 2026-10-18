(function(){
  const TIERS = [
    ['Classic','A1','V3'],['Silver','A2','V3'],['Gold','A3','V3'],['Platinum','A4','V2'],
    ['Daimond','A5','V2'],['Limitless','A6','V2'],['Care Of','','V2'],['Complementary','','V3'],
    ['Booking','','V3'],['Repeated','','V3'],['Hony Moon','','V3'],['Others','','V3']
  ];
  const SCORES = [
    ['rps','RPS'],['trustYou','TrustYou'],['booking','Booking'],['google','Google'],
    ['tripadvisor','TripAdvisor'],['expedia','Expedia']
  ];
  const MEMBERSHIP = TIERS.map(row => row[0]);
  const CONTACT = ['Call','WhatsApp','Email'];
  const SATISFACTION = ['Satisfied','Non Satisfied','Have Comment'];
  const SERVICE = ['Yes','No','RFS','DND','Only Amenities'];
  const REVIEW = ['Sent','Not sent'];

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
  function blankTier(row){
    return {name:row[0], code:row[1], vip:row[2], arrival:'', arrivalRooms:'', inHouse:'', inHouseRooms:'', departure:'', departureRooms:''};
  }
  function blank(){
    const scores = {};
    SCORES.forEach(row => { scores[row[0]] = {mtd:'', ytd:'', target:''}; });
    return {time:'', inCharge:'', arrivals:'', departures:'', occupancy:'', remarks:'', scores:scores, membership:TIERS.map(blankTier), preArrival:[], inHouse:[], departure:[]};
  }
  function applyData(data){
    const base = blank();
    draft = Object.assign(base, {
      date: data.date,
      status: data.status || null,
      submittedBy: data.submittedBy || '',
      time: data.time || '',
      inCharge: data.inCharge || '',
      arrivals: data.arrivals || '',
      departures: data.departures || '',
      occupancy: data.occupancy || '',
      remarks: data.remarks || '',
      scores: base.scores,
      membership: base.membership,
      preArrival: data.preArrival || [],
      inHouse: data.inHouse || [],
      departure: data.departure || []
    });
    SCORES.forEach(row => {
      const cell = (data.scores && data.scores[row[0]]) || {};
      draft.scores[row[0]] = {mtd: cell.mtd || '', ytd: cell.ytd || '', target: cell.target || ''};
    });
    const byName = {};
    (data.membership || []).forEach(item => { if (item && item.name) byName[item.name] = item; });
    draft.membership.forEach(row => {
      const src = byName[row.name] || {};
      ['arrival','arrivalRooms','inHouse','inHouseRooms','departure','departureRooms'].forEach(key => { row[key] = src[key] || ''; });
    });
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

  function field(label, html){ return `<div class="dmr-field"><label>${label}</label>${html}</div>`; }
  function textRow(list, index, cells){
    return `<div class="night-record" data-list="${list}" data-i="${index}">${cells}<button type="button" class="dmr-dyn-del" data-guest-del="1">✕</button></div>`;
  }

  function paint(){
    const body = document.getElementById('guestBody');
    if (!body || !draft) return;
    const dis = locked() || !canEdit() ? 'disabled' : '';
    const badge = draft.status === 'submitted' ? 'Submitted' : (draft.status === 'draft' ? 'Draft' : '');
    const scoreRows = SCORES.map(row => {
      const cell = draft.scores[row[0]];
      return `<tr><th>${row[1]}</th><td><input data-score="${row[0]}" data-part="mtd" value="${escapeHtml(cell.mtd)}" ${dis}></td><td><input data-score="${row[0]}" data-part="ytd" value="${escapeHtml(cell.ytd)}" ${dis}></td><td><input data-score="${row[0]}" data-part="target" value="${escapeHtml(cell.target)}" ${dis}></td></tr>`;
    }).join('');
    const members = draft.membership.map((row, i) => `<tr>
      <th>${escapeHtml(row.name)} <span class="dmr-sub">${escapeHtml([row.code, row.vip].filter(Boolean).join(' · '))}</span></th>
      <td><input data-mem="arrival" data-i="${i}" value="${escapeHtml(row.arrival)}" ${dis}></td>
      <td><input data-mem="arrivalRooms" data-i="${i}" value="${escapeHtml(row.arrivalRooms)}" ${dis}></td>
      <td><input data-mem="inHouse" data-i="${i}" value="${escapeHtml(row.inHouse)}" ${dis}></td>
      <td><input data-mem="inHouseRooms" data-i="${i}" value="${escapeHtml(row.inHouseRooms)}" ${dis}></td>
      <td><input data-mem="departure" data-i="${i}" value="${escapeHtml(row.departure)}" ${dis}></td>
      <td><input data-mem="departureRooms" data-i="${i}" value="${escapeHtml(row.departureRooms)}" ${dis}></td>
    </tr>`).join('');
    const pre = draft.preArrival.map((row, i) => textRow('preArrival', i, [
      field('Reservation #', `<input data-k="reservation" value="${escapeHtml(row.reservation)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(MEMBERSHIP, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Arrival time', `<input type="time" data-k="arrivalTime" value="${escapeHtml(row.arrivalTime)}" ${dis}>`),
      field('Preferences', `<input data-k="preferences" value="${escapeHtml(row.preferences)}" ${dis}>`),
      field('Action taken', `<input data-k="action" value="${escapeHtml(row.action)}" ${dis}>`),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const house = draft.inHouse.map((row, i) => textRow('inHouse', i, [
      field('Room #', `<input data-k="room" value="${escapeHtml(row.room)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(MEMBERSHIP, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Satisfaction', `<select data-k="satisfaction" ${dis}>${options(SATISFACTION, row.satisfaction)}</select>`),
      field('Special request', `<input data-k="request" value="${escapeHtml(row.request)}" ${dis}>`),
      field('Service done?', `<select data-k="service" ${dis}>${options(SERVICE, row.service)}</select>`),
      field('Welcome drink', `<select data-k="drink" ${dis}>${options(REVIEW, row.drink)}</select>`),
      field('F&B amenities', `<input data-k="fb" value="${escapeHtml(row.fb)}" ${dis}>`),
      field('Action taken', `<input data-k="action" value="${escapeHtml(row.action)}" ${dis}>`),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    const leave = draft.departure.map((row, i) => textRow('departure', i, [
      field('Room #', `<input data-k="room" value="${escapeHtml(row.room)}" ${dis}>`),
      field('Guest name', `<input data-k="name" value="${escapeHtml(row.name)}" ${dis}>`),
      field('Membership', `<select data-k="membership" ${dis}>${options(MEMBERSHIP, row.membership)}</select>`),
      field('Arrival', `<input type="date" data-k="arrival" value="${escapeHtml(row.arrival)}" ${dis}>`),
      field('Departure', `<input type="date" data-k="departure" value="${escapeHtml(row.departure)}" ${dis}>`),
      field('Satisfaction 1–10', `<select data-k="score" ${dis}>${options(['1','2','3','4','5','6','7','8','9','10'], row.score)}</select>`),
      field('Guest feedback', `<input data-k="feedback" value="${escapeHtml(row.feedback)}" ${dis}>`),
      field('Review reminder', `<select data-k="review" ${dis}>${options(REVIEW, row.review)}</select>`),
      field('Action taken', `<input data-k="action" value="${escapeHtml(row.action)}" ${dis}>`),
      field('Contacted by', `<select data-k="contacted" ${dis}>${options(CONTACT, row.contacted)}</select>`)
    ].join(''))).join('');
    body.innerHTML = `
      <div id="guestForm">
        <div class="dmr-card dmr-section-card">
          <div class="night-card-head"><h3>Next day summary</h3>${badge ? `<span class="dmr-badge ${draft.status==='submitted'?'dmr-badge-submitted':'dmr-badge-draft'}">${badge}</span>` : ''}</div>
          <div class="dmr-row">
            ${field('Time', `<input type="time" data-top="time" value="${escapeHtml(draft.time)}" ${dis}>`)}
            ${field('Guest Relation in charge', `<input data-top="inCharge" value="${escapeHtml(draft.inCharge)}" ${dis}>`)}
            ${field('Total arrival', `<input data-top="arrivals" value="${escapeHtml(draft.arrivals)}" ${dis}>`)}
            ${field('Total departure', `<input data-top="departures" value="${escapeHtml(draft.departures)}" ${dis}>`)}
            ${field('Occ %', `<input data-top="occupancy" value="${escapeHtml(draft.occupancy)}" ${dis}>`)}
          </div>
          ${field('Special remarks', `<textarea data-top="remarks" rows="3" ${dis}>${escapeHtml(draft.remarks)}</textarea>`)}
          ${draft.submittedBy ? `<p class="dmr-prepared-by">Prepared by: ${escapeHtml(draft.submittedBy)}</p>` : ''}
        </div>
        <div class="dmr-card dmr-section-card">
          <h3>Scores</h3>
          <div class="night-scroll"><table class="night-figures"><thead><tr><th></th><th>MTD</th><th>YTD</th><th>Target</th></tr></thead><tbody>${scoreRows}</tbody></table></div>
        </div>
        <div class="dmr-card dmr-section-card">
          <h3>Membership</h3>
          <div class="night-scroll"><table class="night-figures"><thead><tr><th>Tier</th><th>Arrival</th><th>Rooms</th><th>In house</th><th>Rooms</th><th>Departure</th><th>Rooms</th></tr></thead><tbody>${members}</tbody></table></div>
        </div>
        <div class="dmr-card dmr-section-card"><h3>Pre-arrival communication</h3>${pre || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="preArrival" ${dis}>+ Add guest</button></div>
        <div class="dmr-card dmr-section-card"><h3>In-house welcome call</h3>${house || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="inHouse" ${dis}>+ Add guest</button></div>
        <div class="dmr-card dmr-section-card"><h3>Departure courtesy call</h3>${leave || '<p class="dmr-sub">No guests yet.</p>'}<button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-add="departure" ${dis}>+ Add guest</button></div>
        ${dis ? '' : `<div class="night-actions"><button type="button" class="dmr-btn dmr-btn-ghost" id="guestSave">Save</button><button type="button" class="dmr-btn dmr-btn-primary" id="guestSubmit">Submit</button></div>`}
        <div id="guestNote" class="night-note"></div>
      </div>`;
  }

  function bind(){
    const body = document.getElementById('guestBody');
    if (!body || body._guestBound) return;
    body._guestBound = true;
    body.addEventListener('input', queue);
    body.addEventListener('change', queue);
    body.addEventListener('click', onClick);
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
    form.querySelectorAll('[data-score]').forEach(el => { draft.scores[el.dataset.score][el.dataset.part] = el.value; });
    form.querySelectorAll('[data-mem]').forEach(el => { draft.membership[Number(el.dataset.i)][el.dataset.mem] = el.value; });
    ['preArrival','inHouse','departure'].forEach(list => {
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
      time: draft.time, inCharge: draft.inCharge, arrivals: draft.arrivals, departures: draft.departures,
      occupancy: draft.occupancy, remarks: draft.remarks, scores: draft.scores, membership: draft.membership,
      preArrival: draft.preArrival, inHouse: draft.inHouse, departure: draft.departure
    };
  }
  async function save(){
    if (!draft || locked() || !canEdit()) return;
    const res = await window.apiFetch('/api/guest', {method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload())});
    const note = document.getElementById('guestNote');
    if (!res || !res.date) { if (note) note.textContent = 'Could not save'; return; }
    draft.status = res.status;
    if (note) note.textContent = '';
  }
  async function onClick(e){
    const add = e.target.closest && e.target.closest('[data-guest-add]');
    const del = e.target.closest && e.target.closest('[data-guest-del]');
    if (add && canEdit() && !locked()) {
      read();
      const empty = {reservation:'', name:'', membership:'', arrival:'', departure:'', arrivalTime:'', preferences:'', action:'', contacted:'', room:'', satisfaction:'', request:'', service:'', drink:'', fb:'', score:'', feedback:'', review:''};
      draft[add.dataset.guestAdd].push(empty);
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
    if (e.target.id === 'guestSave') { e.preventDefault(); await save(); }
    if (e.target.id === 'guestSubmit') {
      e.preventDefault();
      await save();
      const res = await window.apiFetch('/api/guest/submit?date=' + encodeURIComponent(draft.date), {method:'POST'});
      if (res && res.status) { applyData(res); paint(); }
    }
  }

  async function loadArchive(){
    const el = document.getElementById('guestArchive');
    const rows = await window.apiFetch('/api/guest/index') || [];
    if (!el) return;
    const search = document.getElementById('archiveSearch');
    const filtered = search && search.value ? rows.filter(row => row.date === search.value) : rows;
    if (search && !search._guest) { search._guest = true; search.onchange = loadArchive; }
    if (!filtered.length) { el.innerHTML = '<div class="dmr-card"><div class="dmr-empty">No guest relation reports yet.</div></div>'; return; }
    const groups = window.groupByMonth ? window.groupByMonth(filtered) : [{label:'Reports', entries: filtered}];
    const isAdmin = window.state.user && window.state.user.role === 'admin';
    el.innerHTML = groups.map(group => `<details class="dmr-acc" open><summary><span>${escapeHtml(group.label)}</span></summary><div class="dmr-acc-body">${group.entries.map(entry => `
      <div class="dmr-archive-row"><div><b>${escapeHtml(entry.date)}</b> <span class="dmr-sub">${escapeHtml(entry.status)}</span></div>
      <div><button type="button" class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-guest-open="${escapeHtml(entry.date)}">Open</button>
      <button type="button" class="dmr-btn dmr-btn-primary dmr-btn-sm" data-guest-pdf="${escapeHtml(entry.date)}">Export PDF</button>
      ${isAdmin ? `<button type="button" class="dmr-btn dmr-btn-sm" data-guest-delete="${escapeHtml(entry.date)}" style="background:var(--danger);color:#fff;">Delete</button>` : ''}</div></div>`).join('')}</div></details>`).join('');
    el.querySelectorAll('[data-guest-open]').forEach(btn => { btn.onclick = () => { window.state.section = 'guest'; window.state.view = 'today'; window.state.selectedDate = btn.dataset.guestOpen; window.renderApp(); }; });
    el.querySelectorAll('[data-guest-pdf]').forEach(btn => { btn.onclick = () => exportPdf(btn.dataset.guestPdf); });
    el.querySelectorAll('[data-guest-delete]').forEach(btn => { btn.onclick = async () => { await window.apiFetch('/api/guest?date=' + encodeURIComponent(btn.dataset.guestDelete), {method:'DELETE'}); loadArchive(); }; });
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
        <div class="dmr-card dmr-stat tone-teal"><div class="num">${data.avgDeparture == null ? '—' : data.avgDeparture}</div><div class="lbl">Avg departure score</div></div>
      </div>
      <div class="dmr-card dmr-chart-card"><h3>How guests were contacted</h3><div class="chart-box"><canvas id="guestChannels"></canvas></div></div>
      <div class="dmr-card dmr-chart-card"><h3>Score lines</h3><div class="chart-box"><canvas id="guestScores"></canvas></div></div>
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
    doc.setFontSize(10); doc.text((data.date || '') + '   ' + (data.time || '') + '   ' + (data.inCharge || ''), 40, y); y += 14;
    doc.text('Arrivals ' + (data.arrivals || '—') + '   Departures ' + (data.departures || '—') + '   Occ ' + (data.occupancy || '—'), 40, y); y += 14;
    if (data.remarks) { const lines = doc.splitTextToSize(data.remarks, W - 80); doc.text(lines, 40, y); y += 12 * lines.length + 8; }
    y = pdfTable(doc, pdf, W, y, 'Scores', [
      {key:'NAME', label:'SCORE', w:140},{key:'MTD', label:'MTD', w:120},{key:'YTD', label:'YTD', w:120},{key:'TARGET', label:'TARGET', w:120}
    ], SCORES.map(row => { const cell = (data.scores && data.scores[row[0]]) || {}; return {NAME: row[1], MTD: cell.mtd || '', YTD: cell.ytd || '', TARGET: cell.target || ''}; }));
    y = pdfTable(doc, pdf, W, y, 'Membership', [
      {key:'NAME', label:'TIER', w:95},{key:'ARR', label:'ARR', w:50},{key:'AR', label:'ROOMS', w:70},{key:'INN', label:'IN', w:50},{key:'IR', label:'ROOMS', w:70},{key:'DEP', label:'DEP', w:50},{key:'DR', label:'ROOMS', w:70}
    ], (data.membership || []).map(row => ({NAME: row.name, ARR: row.arrival || '', AR: row.arrivalRooms || '', INN: row.inHouse || '', IR: row.inHouseRooms || '', DEP: row.departure || '', DR: row.departureRooms || ''})));
    y = pdfTable(doc, pdf, W, y, 'Pre-arrival', [
      {key:'NAME', label:'GUEST', w:120},{key:'MEM', label:'TIER', w:80},{key:'ARR', label:'ARRIVAL', w:80},{key:'PREF', label:'PREFERENCES', w:135},{key:'ACT', label:'ACTION', w:100}
    ], (data.preArrival || []).map(row => ({NAME: row.name || '', MEM: row.membership || '', ARR: row.arrival || '', PREF: row.preferences || '', ACT: row.action || ''})));
    y = pdfTable(doc, pdf, W, y, 'In-house welcome call', [
      {key:'ROOM', label:'ROOM', w:55},{key:'NAME', label:'GUEST', w:120},{key:'SAT', label:'SATISFACTION', w:110},{key:'SVC', label:'SERVICE', w:90},{key:'ACT', label:'ACTION', w:140}
    ], (data.inHouse || []).map(row => ({ROOM: row.room || '', NAME: row.name || '', SAT: row.satisfaction || '', SVC: row.service || '', ACT: row.action || ''})));
    y = pdfTable(doc, pdf, W, y, 'Departure courtesy call', [
      {key:'ROOM', label:'ROOM', w:55},{key:'NAME', label:'GUEST', w:120},{key:'SCORE', label:'SCORE', w:55},{key:'FEED', label:'FEEDBACK', w:185},{key:'ACT', label:'ACTION', w:100}
    ], (data.departure || []).map(row => ({ROOM: row.room || '', NAME: row.name || '', SCORE: row.score || '', FEED: row.feedback || '', ACT: row.action || ''})));
    if (data.submittedBy) doc.text('Prepared by: ' + data.submittedBy, 40, y + 8);
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
    doc.text('Submitted ' + data.submitted + '   Not submitted ' + data.missing + '   Not satisfied ' + data.notSatisfied + '   Avg departure ' + (data.avgDeparture == null ? '—' : data.avgDeparture), 40, y); y += 16;
    const img = charts.chartImage(canvas => {
      const options = charts.chartFrame();
      options.animation = false; options.responsive = false;
      const channels = data.channels || {};
      return new Chart(canvas, {type:'bar', data:{labels:['Call','WhatsApp','Email'], datasets:[{data:[channels.Call||0, channels.WhatsApp||0, channels.Email||0], backgroundColor:['#1e22aa','#14b8a6','#7c6bf2'], borderRadius:8}]}, options});
    });
    if (y > 620) { doc.addPage(); y = 48; }
    doc.text('How guests were contacted', 40, y); y += 8;
    doc.addImage(img, 'JPEG', 40, y, W - 80, 140);
    pdf.addPdfFooter(doc, W, 'Novotel — Guest Relation Analysis');
    doc.save('novotel-guest-analysis-' + data.startDate + '-to-' + data.endDate + '.pdf');
  }

  window.renderGuestSection = renderGuestSection;
})();
