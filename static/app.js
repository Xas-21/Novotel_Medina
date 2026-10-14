(function(){
  const DEPTS = ["Front Office","Housekeeping","Food & Beverage","Maintenance","Security","Other"];
  const PRIORITIES = [
    {v:"normal",label:"Normal",cls:"dmr-tag-normal"},
    {v:"follow",label:"Needs follow-up",cls:"dmr-tag-follow"},
    {v:"urgent",label:"Urgent",cls:"dmr-tag-urgent"}
  ];
  const STATUSES = [
    {v:"open",label:"Open",cls:"dmr-status-open"},
    {v:"progress",label:"In progress",cls:"dmr-status-progress"},
    {v:"closed",label:"Closed",cls:"dmr-status-closed"}
  ];

  const AREA_SECTIONS = [
    {key:'publicAreas', title:'Public Areas – GF', items:[
      'Main Entrance (Outside & Inside)','Saudi Coffee Table','Lobby Sound / Smell','Reception / Public Desks on Duty?',
      'Security and Safety on Duty?','Somou Taxi on Duty?','Rose on Table / Indoor & Outdoor Plants','GF – Guest Bathroom',
      'Lights / Clock Timing','Lobby Coffee Shop (Studio)','Guest Elevators','Service Elevators','Lift Landing (Service Area)',
      'GF – Reception / Offices','Electricity Room','Staff Appearance / Uniform','Prayer Area','Luggage Room','TV','Currency Exchange Board'
    ]},
    {key:'surrounding', title:'Hotel Surrounding', items:[
      'Hotel Lighting','Security Room','Hotel Signage','Parking Entrance / Security on Duty','Emergency Exits / Basement – 12 Floors'
    ]},
    {key:'parking', title:'Parking & Basement', items:[
      {label:'Basement 1', desc:'Receiving area, garbage room, lift landing, cleanliness, lights, generator room, kitchen area'},
      {label:'Basement 2', desc:'Guest entrance lift landing, cleanliness, stores, lights'},
      {label:'Basement 3', desc:'Guest entrance, lift landing, cleanliness, stores, lights, CCTV room'},
      {label:'Basement 4', desc:'Locker room / bathroom & changing room, staff prayer room, server room, pump rooms, stores'}
    ]},
    {key:'restaurant', title:'Restaurant / M-Floor', items:[
      'Trio Restaurant','Food Square Restaurant','Kitchen Area','Staff Appearance and Uniform','Lift Landing Area / Service – Guest','Public Toilets'
    ]},
    {key:'firstFloor', title:'1st Floor', items:[
      'Admin Offices Locked and Lights Off','Public Toilets','Meeting Rooms – Almuhajren / Alansar','Albustan Lounge & Prayer Area','Lift Landing Area / Service – Guest'
    ]},
    {key:'guestFloors', title:'Guest Floors', items: Array.from({length:12},(_,i)=>'Floor '+(i+1))}
  ];

  const CAFETERIA_ITEMS = [
    'Back of House store is clean and well arranged','All food product items are within their expiry dates',
    'All colleagues are groomed to standard','All food containers are clean and free of cracks or stains',
    'All food is labeled properly, and dishes spelt properly','All condiments are clean and filled','Paper napkins are present',
    'All food is in good appearance','Food variety is to standard','Food quality is to standard','Food temperature is to standard',
    'All counters and surfaces are cleaned','Beverage station is filled to standard','Beverage station is clean to standard',
    'Clearance area is cleaned','Food and beverage supply sufficient for staff on shift','Tables in the outlet are clean and in good condition'
  ];

  let state = {
    view: "today",
    section: "duty",
    selectedDate: todayStr(),
    report: null,
    user: null,
    token: localStorage.getItem('novotel_token') || "",
    loading: true,
    openAcc: new Set(['publicAreas']),
    analysisRange: "week",
    analysisData: null,
    modalImg: null,
    confirmDeleteId: null,
    confirmDeleteReport: null,
    photoTarget: null,
    toast: null,
    wsConnected: false
  };

  let ws = null;
  let saveDebounceTimer = null;

  function todayStr(){
    return new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Riyadh'});
  }

  function canWrite(role, section){
    if (role === 'admin') return section === 'duty' || section === 'night';
    if (role === 'staff') return section === 'duty';
    if (role === 'night') return section === 'night';
    return false;
  }
  function fmtDate(d){ const dt=new Date(d+"T00:00:00"); return dt.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}); }
  function priorityMeta(v){ return PRIORITIES.find(p=>p.v===v) || PRIORITIES[0]; }
  function statusMeta(v){ return STATUSES.find(s=>s.v===v) || STATUSES[0]; }
  function fullName(u){ return ((u && (u.first_name || '')) + ' ' + (u && (u.last_name || ''))).trim() || (u && u.username) || '—'; }
  function showToast(msg){ state.toast = msg; renderOverlays(); setTimeout(()=>{ state.toast=null; renderOverlays(); }, 2600); }
  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- Novotel PDF helpers ----------
  const NOVOTEL = {
    navy: [28,43,57], navy2: [40,57,74], brass: [168,129,79], brassDark: [140,107,63],
    blue: [0,94,184], paper: [247,244,236], rowAlt: [250,249,244],
    ink: [35,48,61], inkSoft: [110,120,132], ok: [46,125,76], okBg: [234,242,236],
    danger: [177,75,63], dangerBg: [251,234,231], yellow: [204,153,0], line: [228,223,210], white: [255,255,255], brandBlue: [30,34,170]
  };

  function occupancyColor(val) {
    const n = parseFloat(String(val || '').replace('%', '').trim());
    if (isNaN(n) || n <= 0) return NOVOTEL.inkSoft;
    if (n >= 50) return NOVOTEL.ok;      // 50–100% → green
    if (n >= 11) return NOVOTEL.yellow;  // 11–49% → yellow
    return NOVOTEL.danger;               // 1–10% → red
  }

  function preparerName(r) {
    if (r.submittedBy) return r.submittedBy;
    if (state.user) {
      const nm = fullName(state.user);
      return state.user.title ? `${nm} — ${state.user.title}` : nm;
    }
    return '';
  }

  async function getLogoDataUrl() {
    try {
      const img = new Image();
      img.src = '/assets/novotel-logo-blue.png';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  }

  function loadImg(url) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });
  }

  function pdfHeader(doc, W, logoUrl, title) {
    // White header with the Novotel logo (blue on white)
    if (logoUrl) {
      const logoW = 180;
      const logoH = 42;
      const x = (W - logoW) / 2;
      try { doc.addImage(logoUrl, 'PNG', x, 24, logoW, logoH); } catch(e) {}
    }
    doc.setFillColor(...NOVOTEL.navy);
    doc.rect(0, 88, W, 2, 'F');
    doc.setFillColor(...NOVOTEL.brass);
    doc.rect(0, 90, W, 2, 'F');
    doc.setTextColor(...NOVOTEL.inkSoft);
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.text(title || 'DUTY MANAGER DAILY REPORT', 40, 106);
    return 122;
  }

  function pdfSectionHeading(doc, W, y, text) {
    if (y + 34 > 780) { doc.addPage(); y = 45; }
    doc.setFillColor(...NOVOTEL.brandBlue);
    doc.rect(40, y, W - 80, 20, 'F');
    doc.setFillColor(...NOVOTEL.brass);
    doc.rect(40, y, 3, 20, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text(text.toUpperCase(), 51, y + 13.5);
    return y + 20;
  }

  function pdfTable(doc, W, y, cols, rows) {
    const x = 40, width = W - 80, rowH = 16, headerH = 16;
    function drawHeader(cy) {
      doc.setFillColor(...NOVOTEL.brandBlue);
      doc.rect(x, cy, width, headerH, 'F');
      doc.setTextColor(255,255,255);
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
      let cx = x;
      cols.forEach(col => {
        if (col.align === 'center') doc.text(col.label, cx + col.w / 2, cy + 10.5, {align:'center'});
        else doc.text(col.label, cx + 4, cy + 10.5);
        cx += col.w;
      });
    }
    if (y + headerH > 780) { doc.addPage(); y = 45; }
    drawHeader(y);
    y += headerH;
    rows.forEach((row, ri) => {
      // ponytail: compute wrapped lines just for row height, render with maxWidth
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      const lineCounts = cols.map(col => {
        const txt = row[col.key] != null ? String(row[col.key]) : '';
        return txt ? Math.max(doc.splitTextToSize(txt, col.w - 8).length, 1) : 1;
      });
      const dynRowH = Math.max(...lineCounts) === 1 ? rowH : (11 + Math.max(...lineCounts) * 5);
      if (y + dynRowH > 780) { doc.addPage(); y = 45; drawHeader(y); y += headerH; }
      const fill = row._fill || (ri % 2 === 0 ? NOVOTEL.white : NOVOTEL.rowAlt);
      doc.setFillColor(...fill);
      doc.rect(x, y, width, dynRowH, 'F');
      let cx = x;
      cols.forEach(col => {
        const key = col.key;
        const txt = row[key] != null ? String(row[key]) : '';
        const color = row[key + '_color'] || NOVOTEL.ink;
        doc.setTextColor(...color);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        const opts = col.align === 'center' ? {align:'center', maxWidth: col.w - 4} : {maxWidth: col.w - 8};
        if (col.align === 'center') doc.text(txt, cx + col.w / 2, y + 10.5, opts);
        else doc.text(txt, cx + 4, y + 10.5, opts);
        cx += col.w;
      });
      y += dynRowH;
    });
    return y;
  }

  function addPdfFooter(doc, W, label, fromPage) {
    const total = doc.internal.getNumberOfPages();
    for (let i = fromPage || 1; i <= total; i++) {
      doc.setPage(i);
      const H = doc.internal.pageSize.getHeight();
      doc.setDrawColor(...NOVOTEL.line);
      doc.line(40, H - 30, W - 40, H - 30);
      doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
      doc.setTextColor(...NOVOTEL.inkSoft);
      doc.text(label || 'Novotel — Duty Manager Report', 40, H - 18);
      doc.text(`Page ${i} of ${total}`, W - 40, H - 18, {align:'right'});
    }
  }

  function drawStatBox(doc, x, y, w, h, value, label, color) {
    doc.setFillColor(...color);
    doc.rect(x, y, w, h, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(15);
    doc.text(value, x + w / 2, y + 24, {align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(6.8);
    doc.setTextColor(235,240,245);
    doc.text(label.toUpperCase(), x + w / 2, y + h - 7, {align:'center'});
  }

  // ---------- API Layer ----------
  async function apiFetch(url, options = {}) {
    options.headers = options.headers || {};
    if (state.token) {
      options.headers['Authorization'] = `Bearer ${state.token}`;
    }
    try {
      const res = await fetch(url, options);
      if (res.status === 401) {
        state.token = "";
        localStorage.removeItem('novotel_token');
        state.user = null;
      }
      return await res.json();
    } catch (err) {
      console.error("API error:", err);
      return null;
    }
  }

  async function loadReport(date) {
    return await apiFetch(`/api/reports?date=${date}`);
  }

  async function persistReport() {
    if (!state.report) return;
    if (!state.user || !canWrite(state.user.role, 'duty')) return;
    const body = {
      date: state.report.date,
      status: state.report.status,
      shiftStart: state.report.shiftStart || "",
      shiftEnd: state.report.shiftEnd || "",
      occupancy: state.report.occupancy || "",
      arrivals: state.report.arrivals || "",
      departures: state.report.departures || "",
      inHouse: state.report.inHouse || "",
      allMembers: state.report.allMembers || "",
      cafeteriaMealTime: state.report.cafeteriaMealTime || "",
      checklists: state.report.checklists,
      cafeteriaItems: state.report.cafeteriaItems,
      roomsInspection: state.report.roomsInspection,
      courtesyCalls: state.report.courtesyCalls,
      trustYou: state.report.trustYou,
      complaints: state.report.complaints,
      incidents: state.report.incidents
    };
    await apiFetch(`/api/reports`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
  }

  function queueSave() {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => { persistReport(); }, 400);
  }

  // ---------- WebSocket Real-Time Sync ----------
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => { state.wsConnected = true; updateSyncIndicator(); };
      ws.onclose = () => { state.wsConnected = false; updateSyncIndicator(); setTimeout(initWebSocket, 3000); };
      ws.onerror = () => { state.wsConnected = false; updateSyncIndicator(); };
      ws.onmessage = async (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.date === state.selectedDate && state.section === 'duty' && state.view === 'today') {
            // Report saves bounce back on the socket. Re-rendering destroys the input being typed in.
            if (msg.event === 'REPORT_UPDATED' || msg.event === 'NIGHT_REPORT_UPDATED') return;
            const fresh = await loadReport(state.selectedDate);
            if (fresh) {
              state.report = fresh;
              render();
              if (msg.event === 'NOTE_ADDED') showToast(`New note by ${msg.note?.manager || 'manager'}`);
              else if (msg.event === 'REPORT_SUBMITTED') showToast(`Report submitted by ${msg.submittedBy}`);
            }
          }
        } catch (err) {}
      };
    } catch (e) {
      setTimeout(initWebSocket, 4000);
    }
  }

  function updateSyncIndicator() {
    const dot = document.getElementById('syncDot');
    const txt = document.getElementById('syncText');
    if (!dot || !txt) return;
    if (state.wsConnected) { dot.className = 'sync-dot'; txt.textContent = 'Live Sync'; }
    else { dot.className = 'sync-dot offline'; txt.textContent = 'Reconnecting…'; }
  }

  // ---------- Image Upload ----------
  async function uploadPhotoFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: state.token ? {'Authorization': `Bearer ${state.token}`} : {},
        body: formData
      });
      const data = await res.json();
      if (data.success) return data.url;
    } catch (e) {
      console.error('Upload failed', e);
    }
    return null;
  }

  // ---------- Auth / Login ----------
  function pageLabel() {
    if (state.view === 'users') return 'Users';
    if (state.section === 'full') return 'Full Report';
    const section = state.section === 'night' ? 'Night' : 'Duty';
    const view = { today: "Today's Report", archive: 'Archive', analysis: 'Analysis' }[state.view] || '';
    return view ? section + ' · ' + view : section;
  }

  function setNavOpen(open) {
    const root = document.getElementById('dmrRoot');
    const nav = document.getElementById('dmrNav');
    const btn = document.getElementById('menuBtn');
    const backdrop = document.getElementById('navBackdrop');
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    if (!narrow) open = false;
    if (root) root.classList.toggle('nav-open', open);
    document.body.classList.toggle('nav-open', open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (backdrop) backdrop.hidden = !open;
    if (nav) nav.inert = narrow && !open;
    if (open) {
      const closeBtn = document.getElementById('navClose');
      if (closeBtn) closeBtn.focus();
    } else if (btn && nav && nav.contains(document.activeElement)) {
      btn.focus();
    }
  }

  function bindNavDrawer() {
    const menuBtn = document.getElementById('menuBtn');
    const navClose = document.getElementById('navClose');
    const backdrop = document.getElementById('navBackdrop');
    if (menuBtn) menuBtn.onclick = () => {
      const root = document.getElementById('dmrRoot');
      setNavOpen(!(root && root.classList.contains('nav-open')));
    };
    if (navClose) navClose.onclick = () => setNavOpen(false);
    if (backdrop) backdrop.onclick = () => setNavOpen(false);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setNavOpen(false);
    });
    window.addEventListener('resize', () => {
      if (!window.matchMedia('(max-width: 900px)').matches) setNavOpen(false);
    });
    setNavOpen(false);
  }

  async function init() {
    bindNavDrawer();
    if (state.token) {
      const me = await apiFetch('/api/auth/me');
      if (me && me.id) {
        state.user = me;
        enterApp();
        return;
      }
      localStorage.removeItem('novotel_token');
      state.token = "";
    }
    showLogin();
  }

  function showLogin() {
    document.getElementById('dmrRoot').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('login-password').value = '';
    document.getElementById('loginError').textContent = '';

    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn && !loginBtn._bound) {
      loginBtn._bound = true;
      loginBtn.onclick = handleLogin;
      const pw = document.getElementById('login-password');
      const un = document.getElementById('login-username');
      if (pw) pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
      if (un) un.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
    }
  }

  function setLoginError(msg) {
    document.getElementById('loginError').textContent = msg || '';
  }

  async function handleLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) { setLoginError('Please enter your username and password.'); return; }
    setLoginError('');
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ username, password })
    });
    if (res && res.token) {
      state.token = res.token;
      state.user = res.user;
      localStorage.setItem('novotel_token', res.token);
      enterApp();
    } else {
      setLoginError((res && res.detail) || 'Login failed. Please try again.');
    }
  }

  function logout() {
    state.token = "";
    state.user = null;
    localStorage.removeItem('novotel_token');
    if (ws) { try { ws.close(); } catch(e){} }
    state.wsConnected = false;
    showLogin();
  }

  async function enterApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dmrRoot').style.display = 'flex';
    state.section = (state.user && state.user.role === 'night') ? 'night' : 'duty';
    state.view = 'today';
    initWebSocket();
    state.loading = true;
    render();
    state.report = await loadReport(state.selectedDate);
    state.loading = false;
    if (state.section === 'duty') render();
  }

  async function switchDate(d) {
    state.selectedDate = d;
    state.loading = true;
    render();
    state.report = await loadReport(d);
    state.loading = false;
    // Night paints from /api/night. A second render would wipe that form.
    if (state.section === 'duty') render();
  }

  // ---------- Render Main View ----------
  function render() {
    const navName = document.getElementById('navName');
    const navTitle = document.getElementById('navTitle');
    if (navName) navName.textContent = fullName(state.user);
    if (navTitle) navTitle.textContent = state.user ? (state.user.title || '') : '';
    const crumb = document.getElementById('mobileCrumb');
    if (crumb) crumb.textContent = pageLabel();

    const usersBtn = document.getElementById('usersNavBtn');
    if (usersBtn) usersBtn.style.display = (state.user && state.user.role === 'admin') ? 'flex' : 'none';

    document.querySelectorAll('.dmr-navbtn').forEach(b => {
      const sectionOk = !b.dataset.section || b.dataset.section === state.section;
      b.classList.toggle('active', sectionOk && b.dataset.view === state.view);
    });
    updateSyncIndicator();

    const main = document.getElementById('dmrMain');
    if (!main) return;

    if (state.view === 'users') {
      main.innerHTML = renderUsers();
      loadUsers();
    } else if (state.section === 'night' || state.section === 'full') {
      main.innerHTML = window.renderNightSection();
    } else if (state.loading) {
      main.innerHTML = '<div class="dmr-empty"><h3>Loading report data…</h3></div>';
    } else if (state.view === 'today') {
      main.innerHTML = renderToday();
    } else if (state.view === 'archive') {
      main.innerHTML = renderArchive();
      loadArchiveList();
    } else if (state.view === 'analysis') {
      main.innerHTML = renderAnalysis();
      loadAnalysis();
    }

    attachHandlers();
    renderOverlays();
  }

  function renderOverlays() {
    document.querySelectorAll('.dmr-modal-bg, .dmr-toast').forEach(el => el.remove());

    if (state.modalImg) {
      const bg = document.createElement('div');
      bg.className = 'dmr-modal-bg';
      bg.innerHTML = `<img src="${state.modalImg}">`;
      bg.addEventListener('click', () => { state.modalImg = null; renderOverlays(); });
      document.getElementById('dmrRoot').appendChild(bg);
    }

    if (state.confirmDeleteId) {
      const bg = document.createElement('div');
      bg.className = 'dmr-modal-bg';
      bg.innerHTML = `
        <div class="dmr-dialog">
          <h3>Delete this note?</h3>
          <p>This action cannot be undone.</p>
          <div class="dmr-dialog-actions">
            <button class="dmr-btn dmr-btn-ghost dmr-btn-sm" id="delCancel">Cancel</button>
            <button class="dmr-btn dmr-btn-primary dmr-btn-sm" id="delConfirm" style="background:var(--danger);">Delete</button>
          </div>
        </div>`;
      document.getElementById('dmrRoot').appendChild(bg);
      document.getElementById('delCancel').onclick = () => { state.confirmDeleteId = null; renderOverlays(); };
      document.getElementById('delConfirm').onclick = async () => {
        const id = state.confirmDeleteId;
        state.confirmDeleteId = null;
        await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
        state.report.notes = state.report.notes.filter(n => n.id !== id);
        render();
        showToast('Note deleted');
      };
    }

    if (state.confirmDeleteReport) {
      const date = state.confirmDeleteReport;
      const bg = document.createElement('div');
      bg.className = 'dmr-modal-bg';
      bg.innerHTML = `
        <div class="dmr-dialog">
          <h3>Delete this report?</h3>
          <p>Report for <b>${fmtDate(date)}</b> will be permanently deleted along with its notes and photos. This cannot be undone.</p>
          <div class="dmr-dialog-actions">
            <button class="dmr-btn dmr-btn-ghost dmr-btn-sm" id="delRepCancel">Cancel</button>
            <button class="dmr-btn dmr-btn-primary dmr-btn-sm" id="delRepConfirm" style="background:var(--danger);">Delete</button>
          </div>
        </div>`;
      document.getElementById('dmrRoot').appendChild(bg);
      document.getElementById('delRepCancel').onclick = () => { state.confirmDeleteReport = null; renderOverlays(); };
      document.getElementById('delRepConfirm').onclick = async () => {
        state.confirmDeleteReport = null;
        await deleteReport(date);
      };
    }

    if (state.toast) {
      const t = document.createElement('div');
      t.className = 'dmr-toast';
      t.textContent = state.toast;
      document.getElementById('dmrRoot').appendChild(t);
    }
  }

  function renderToday() {
    const r = state.report;
    const dutyWritable = canWrite(state.user && state.user.role, 'duty');
    return `
    <div class="dmr-headline">
      <h1>Duty Manager Round</h1>
      <input type="date" id="dateInput" class="dmr-btn-ghost dmr-btn" style="padding:7px 12px;" value="${state.selectedDate}">
    </div>
    <div class="dmr-sub">
      ${fmtDate(state.selectedDate)} ·
      <span class="dmr-badge ${r.status==='submitted'?'dmr-badge-submitted':'dmr-badge-draft'}">
        ${r.status==='submitted'?'Submitted & Closed':'Draft Round'}
      </span>
    </div>

    ${r.status==='submitted' ? `
    <div class="dmr-card" style="padding:14px 18px;margin-bottom:18px;background:var(--ok-bg);border-color:var(--ok);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
      <div style="font-size:13.5px;color:var(--ok);font-weight:600;">
        ✓ Report submitted ${r.submittedAt ? 'on ' + new Date(r.submittedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''} ${r.submittedBy ? 'by ' + escapeHtml(r.submittedBy) : ''}
      </div>
      <div style="display:flex;gap:8px;">
        ${dutyWritable && state.user && state.user.role === 'admin' ? `<button class="dmr-btn dmr-btn-ghost dmr-btn-sm" id="reopenBtn">Reopen to Edit</button>` : ''}
        <button class="dmr-btn dmr-btn-primary dmr-btn-sm" id="exportTodayPdf">Export Official PDF</button>
      </div>
    </div>` : ''}

    <div id="reportBody" class="${r.status==='submitted' || !dutyWritable ? 'dmr-locked' : ''}">
      <div class="dmr-card dmr-section-card">
        <h3>Shift & Operations Overview</h3>
        <div class="dmr-row">
          <div class="dmr-field"><label>Shift Start</label><input type="time" data-gf="shiftStart" value="${r.shiftStart}"></div>
          <div class="dmr-field"><label>Shift End</label><input type="time" data-gf="shiftEnd" value="${r.shiftEnd}"></div>
          <div class="dmr-field"><label>Occupancy %</label><input type="text" inputmode="decimal" data-gf="occupancy" value="${escapeHtml(r.occupancy)}" placeholder="e.g. 88%"></div>
        </div>
        <div class="dmr-row">
          <div class="dmr-field"><label>Arrivals</label><input type="text" inputmode="numeric" data-gf="arrivals" value="${escapeHtml(r.arrivals)}"></div>
          <div class="dmr-field"><label>Departures</label><input type="text" inputmode="numeric" data-gf="departures" value="${escapeHtml(r.departures)}"></div>
          <div class="dmr-field"><label>In-House Guests</label><input type="text" inputmode="numeric" data-gf="inHouse" value="${escapeHtml(r.inHouse)}"></div>
          <div class="dmr-field"><label>ALL Loyalty Members</label><input type="text" inputmode="numeric" data-gf="allMembers" value="${escapeHtml(r.allMembers)}"></div>
        </div>
      </div>

      ${AREA_SECTIONS.map(sec => renderChecklistAcc(sec, r.checklists[sec.key] || [])).join('')}

      ${renderDynAcc('roomsInspection', 'Rooms Inspection', r.roomsInspection, [
          {key:'room', ph:'Room #', type:'text', w:1},
          {key:'status', type:'toggle'},
          {key:'comment', ph:'Inspection comment / findings', type:'text', w:2}
        ])}

      <details class="dmr-acc" data-acc="guestExp" ${state.openAcc.has('guestExp')?'open':''}>
        <summary><span>Guest Experience & TrustYou</span><span class="arrow">▾</span></summary>
        <div class="dmr-acc-body">
          <h3 style="font-size:13.5px;margin:14px 0 8px;color:var(--navy);">Courtesy Calls</h3>
          ${dynListHtml('courtesyCalls', r.courtesyCalls, [
            {key:'room', ph:'Room #', type:'text', w:1},
            {key:'impression', type:'toggle'},
            {key:'comment', ph:'Guest feedback & remarks', type:'text', w:2}
          ])}
          <button class="dmr-btn dmr-btn-ghost dmr-btn-sm dmr-add-row-btn" data-add-row="courtesyCalls">+ Add Room Call</button>

          <h3 style="font-size:13.5px;margin:20px 0 8px;color:var(--navy);">TrustYou Daily Reviews</h3>
          <div class="dmr-row">
            <div class="dmr-field"><label>Total Reviews</label><input type="text" data-ty="totalReviews" value="${escapeHtml(r.trustYou?.totalReviews || '')}"></div>
            <div class="dmr-field"><label>GSS Score</label><input type="text" data-ty="gss" value="${escapeHtml(r.trustYou?.gss || '')}"></div>
          </div>
          <div class="dmr-field"><label>Key Positive Comment</label><input type="text" data-ty="keyPositive" value="${escapeHtml(r.trustYou?.keyPositive || '')}"></div>
          <div class="dmr-field"><label>Key Negative / Actionable Comment</label><input type="text" data-ty="keyNegative" value="${escapeHtml(r.trustYou?.keyNegative || '')}"></div>
          <div class="dmr-field"><label>Overall TrustYou Remarks</label><input type="text" data-ty="comment" value="${escapeHtml(r.trustYou?.comment || '')}"></div>
        </div>
      </details>

      <details class="dmr-acc" data-acc="cafeteria" ${state.openAcc.has('cafeteria')?'open':''}>
        <summary><span>Staff Cafeteria Audit</span><span class="arrow">▾</span></summary>
        <div class="dmr-acc-body">
          <div class="dmr-field" style="margin-top:14px;">
            <label>Meal / Inspection Time</label>
            <input type="text" data-gf="cafeteriaMealTime" value="${escapeHtml(r.cafeteriaMealTime)}" placeholder="e.g. Lunch Round (1:30 PM)">
          </div>
          ${CAFETERIA_ITEMS.map((label, idx) => checklistRowHtml('cafeteriaItems', idx, label, null, r.cafeteriaItems[idx] || {status:null, comment:''})).join('')}
        </div>
      </details>

      ${renderDynAcc('complaints', 'Guest Complaints', r.complaints, [
          {key:'complaint', ph:'Nature of complaint', type:'textarea', w:2},
          {key:'room', ph:'Room #', type:'text', w:1},
          {key:'action', ph:'Action taken by Duty Manager', type:'textarea', w:2}
        ])}

      ${renderDynAcc('incidents', 'Incidents / General Comments', r.incidents, [
          {key:'description', ph:'Incident description / notable observation', type:'textarea', w:3},
          {key:'time', ph:'Time', type:'time', w:1}
        ])}

      <details class="dmr-acc" data-acc="notes" ${state.openAcc.has('notes')?'open':''}>
        <summary><span>Additional Notes & Photo Documentation</span><span class="arrow">▾</span></summary>
        <div class="dmr-acc-body">
          <div style="padding-top:14px;">
            <div class="dmr-row">
              <div class="dmr-field"><label>Department</label><select id="f-dept">${DEPTS.map(d=>`<option>${d}</option>`).join('')}</select></div>
              <div class="dmr-field"><label>Priority</label><select id="f-priority">${PRIORITIES.map(p=>`<option value="${p.v}">${p.label}</option>`).join('')}</select></div>
            </div>
            <div class="dmr-field"><label>Detailed Note</label><textarea id="f-text" placeholder="Record maintenance issue, VIP requests, cleanliness observation..."></textarea></div>
            <div class="dmr-row" style="align-items:flex-end;">
              <div class="dmr-field" style="margin-bottom:0;">
                <label>Attach Photo (Camera / Gallery)</label>
                <div class="dmr-photo-input">
                  <input type="file" id="f-photo" accept="image/*" capture="environment">
                  <img id="f-photo-preview" class="dmr-photo-preview" style="display:none;">
                </div>
              </div>
              <button class="dmr-btn dmr-btn-primary" id="addNoteBtn" style="height:40px;">+ Add Note</button>
            </div>
          </div>
          ${r.notes.length === 0 ? '<div class="dmr-empty" style="padding:24px;">No additional notes logged for this shift.</div>' :
            `<div class="dmr-timeline" style="margin-top:14px;">${r.notes.map(n => entryHtml(n)).join('')}</div>`}
        </div>
      </details>
    </div>

    ${(r.status==='submitted' || !dutyWritable) ? '' : `
    <div class="dmr-card" style="padding:18px;margin-top:10px;text-align:center;">
      <button class="dmr-btn dmr-btn-primary" id="submitReportBtn" style="width:100%;justify-content:center;padding:13px;font-size:14.5px;">✓ Submit & Close Daily Report</button>
      <div class="dmr-sub" style="margin:8px 0 0;">Submitting finalizes the shift round, logs your signature, and archives the report.</div>
    </div>`}
    `;
  }

  function checklistRowHtml(sectionKey, idx, label, desc, data) {
    const photos = (data && data.photos) || [];
    const showDetail = data.status === false || (data.comment && data.comment.length > 0) || photos.length > 0;
    return `
    <div class="dmr-check-row" data-chk-section="${sectionKey}" data-chk-idx="${idx}">
      <div class="dmr-check-label">
        ${escapeHtml(label)}
        ${desc ? `<div class="dmr-check-desc">${escapeHtml(desc)}</div>` : ''}
      </div>
      <div class="dmr-check-toggle">
        <button class="dmr-chk-btn ok ${data.status===true?'active':''}" data-chk="ok" type="button">✓</button>
        <button class="dmr-chk-btn bad ${data.status===false?'active':''}" data-chk="bad" type="button">✗</button>
      </div>
      ${showDetail ? `
        <div class="dmr-check-detail">
          <input type="text" class="dmr-check-comment" placeholder="Remark / reason for failure" value="${escapeHtml(data.comment||'')}" data-chk-comment="1">
          <div class="dmr-check-photos">
            ${photos.map((p, i) => `
              <div class="dmr-check-photo">
                <img src="${p}" class="dmr-check-photo-img" data-chk-photo="${p}">
                <button class="dmr-photo-del" data-chk-photo-del="${sectionKey}|${idx}|${i}" title="Remove photo">✕</button>
              </div>`).join('')}
            ${photos.length < 2 ? `<button class="dmr-btn dmr-btn-ghost dmr-btn-sm dmr-photo-add-btn" data-chk-photo-add="${sectionKey}|${idx}" type="button">+ Add Photo (${photos.length}/2)</button>` : ''}
          </div>
        </div>` : ''}
    </div>`;
  }

  function renderChecklistAcc(sec, arr) {
    const okCount = arr.filter(a => a && a.status === true).length;
    const badCount = arr.filter(a => a && a.status === false).length;
    return `
    <details class="dmr-acc" data-acc="${sec.key}" ${state.openAcc.has(sec.key)?'open':''}>
      <summary>
        <span>${sec.title}</span>
        <span class="dmr-acc-stat">${okCount}/${arr.length} ✓${badCount ? ` · <b>${badCount} ✗</b>` : ''}</span>
      </summary>
      <div class="dmr-acc-body">
        ${sec.items.map((it, idx) => {
          const label = typeof it === 'string' ? it : it.label;
          const desc = typeof it === 'object' ? it.desc : null;
          return checklistRowHtml(sec.key, idx, label, desc, arr[idx] || {status:null, comment:''});
        }).join('')}
      </div>
    </details>`;
  }

  function dynListHtml(listKey, rows, fields) {
    if (!rows || rows.length === 0) return '<div class="dmr-sub" style="margin:8px 0;">No entries recorded yet.</div>';
    return rows.map((row, idx) => `
      <div class="dmr-dyn-row" data-dyn-list="${listKey}" data-dyn-idx="${idx}">
        ${fields.map(f => {
          if (f.type === 'toggle') {
            const v = row[f.key];
            return `
            <div class="dmr-dyn-toggle">
              <button class="dmr-chk-btn ok ${v===true?'active':''}" data-dyn-toggle="${f.key}" type="button">✓</button>
              <button class="dmr-chk-btn bad ${v===false?'active':''}" data-dyn-toggle="${f.key}" type="button">✗</button>
            </div>`;
          }
          const style = f.w ? `flex-grow:${f.w};` : '';
          const tag = f.type === 'textarea' ? 'textarea' : 'input';
          const typeAttr = f.type === 'time' ? 'time' : 'text';
          if (tag === 'textarea') {
            return `<textarea style="${style}" placeholder="${f.ph||''}" data-dyn-field="${f.key}" rows="2">${escapeHtml(row[f.key]||'')}</textarea>`;
          }
          return `<input style="${style}" type="${typeAttr}" placeholder="${f.ph||''}" value="${escapeHtml(row[f.key]||'')}" data-dyn-field="${f.key}">`;
        }).join('')}
        <button class="dmr-dyn-del" data-dyn-del="1">✕</button>
      </div>`).join('');
  }

  function renderDynAcc(listKey, title, rows, fields) {
    const count = rows ? rows.length : 0;
    return `
    <details class="dmr-acc" data-acc="${listKey}" ${state.openAcc.has(listKey)?'open':''}>
      <summary><span>${title}</span><span class="dmr-acc-stat">${count} entr${count===1?'y':'ies'}</span></summary>
      <div class="dmr-acc-body" style="padding-top:14px;">
        ${dynListHtml(listKey, rows, fields)}
        <button class="dmr-btn dmr-btn-ghost dmr-btn-sm dmr-add-row-btn" data-add-row="${listKey}">+ Add</button>
      </div>
    </details>`;
  }

  function entryHtml(n) {
    const pr = priorityMeta(n.priority), st = statusMeta(n.status);
    return `
    <div class="dmr-entry" data-id="${n.id}">
      <div class="dmr-card dmr-entry-card">
        <div class="dmr-entry-top">
          <div><span class="dmr-tag dmr-tag-dept">${escapeHtml(n.department)}</span><span class="dmr-tag ${pr.cls}">${pr.label}</span></div>
          <div class="dmr-entry-time">${escapeHtml(n.time)}</div>
        </div>
        <div class="dmr-entry-text">${escapeHtml(n.text)}</div>
        <div class="dmr-entry-bottom">
          <div style="display:flex;align-items:center;gap:12px;">
            <span class="dmr-manager">Logged by: <b>${escapeHtml(n.manager)}</b></span>
            ${n.photo_url ? `<img src="${n.photo_url}" class="dmr-thumb" data-photo="${n.photo_url}">` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <select class="dmr-status-select ${st.cls}" data-status-id="${n.id}">
              ${STATUSES.map(s => `<option value="${s.v}" ${s.v===n.status?'selected':''}>${s.label}</option>`).join('')}
            </select>
            <button class="dmr-del" data-del="${n.id}">✕</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---------- Archive View ----------
  function groupByMonth(entries){
    const groups = new Map();
    entries.forEach(entry => {
      const [year, month] = entry.date.split('-');
      const key = year + '-' + month;
      if (!groups.has(key)) {
        const label = new Date(entry.date + 'T00:00:00').toLocaleDateString('en-US', {month:'long', year:'numeric', timeZone:'Asia/Riyadh'});
        groups.set(key, {key, label, entries: []});
      }
      groups.get(key).entries.push(entry);
    });
    return Array.from(groups.values());
  }

  function parseOccupancy(text){
    if (text == null) return null;
    const cleaned = String(text).replace('%', '').trim();
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function occupancySeries(rows, startIso, endIso){
    const byDate = new Map(rows.map(r => [r.date, parseOccupancy(r.occupancy)]));
    const labels = [];
    const values = [];
    let cursor = new Date(startIso + 'T00:00:00');
    const end = new Date(endIso + 'T00:00:00');
    while (cursor <= end) {
      const iso = cursor.toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
      const spans = startIso.slice(0, 7) !== endIso.slice(0, 7);
      const label = spans
        ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : iso.slice(8);
      labels.push(label);
      const parsed = byDate.has(iso) ? byDate.get(iso) : null;
      values.push(parsed == null ? 0 : parsed);
      cursor.setDate(cursor.getDate() + 1);
    }
    return {labels, values};
  }

  function monthLastDay(iso){
    const [year, month] = iso.split('-').map(Number);
    const last = new Date(year, month, 0).getDate();
    return iso.slice(0, 8) + String(last).padStart(2, '0');
  }

  function shiftIso(iso, days){
    const cursor = new Date(iso + 'T00:00:00');
    cursor.setDate(cursor.getDate() + days);
    return cursor.toLocaleDateString('en-CA', {timeZone:'Asia/Riyadh'});
  }

  function applyPeriod(mode){
    const today = todayStr();
    let to = state.periodTo || state.selectedDate || today;
    if (to > today) to = today;
    state.periodMode = mode;
    if (mode === 'day') {
      state.periodFrom = to;
      state.periodTo = to;
    } else if (mode === 'week') {
      state.periodTo = to;
      state.periodFrom = shiftIso(to, -6);
    } else if (mode === 'month') {
      const monthKey = to.slice(0, 7);
      state.periodFrom = monthKey + '-01';
      state.periodTo = monthKey < today.slice(0, 7) ? monthLastDay(state.periodFrom) : today;
    } else if (mode === 'ytd') {
      const year = to.slice(0, 4);
      state.periodFrom = year + '-01-01';
      state.periodTo = year === today.slice(0, 4) ? today : year + '-12-31';
    }
  }

  function ensurePeriod(){
    const today = todayStr();
    if (!state.periodTo) state.periodTo = state.selectedDate || today;
    if (!state.periodMode || !state.periodFrom) applyPeriod(state.periodMode || 'week');
  }

  function periodBar(){
    ensurePeriod();
    const mode = state.periodMode;
    const button = (id, label) => `<button type="button" class="dmr-btn ${mode === id ? 'dmr-btn-primary' : 'dmr-btn-ghost'}" data-period="${id}">${label}</button>`;
    return `
      <div class="dmr-toolbar">
        ${button('day', 'Day')}
        ${button('week', 'Week')}
        ${button('month', 'Month')}
        ${button('ytd', 'YTD')}
      </div>
      <div class="dmr-row" style="margin:12px 0;">
        <div class="dmr-field"><label>From</label><input type="date" id="periodFrom" value="${state.periodFrom}"></div>
        <div class="dmr-field"><label>To</label><input type="date" id="periodTo" value="${state.periodTo}"></div>
      </div>`;
  }

  function periodQuery(){
    ensurePeriod();
    const range = state.periodMode === 'month' ? 'month' : 'week';
    return 'date=' + encodeURIComponent(state.periodTo) + '&range=' + range + '&start=' + encodeURIComponent(state.periodFrom);
  }

  function chartFill(canvas, rgb){
    const box = canvas.parentElement;
    const h = (box && box.clientHeight) || canvas.height || 220;
    const fade = canvas.getContext('2d').createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(' + rgb + ',0.38)');
    fade.addColorStop(0.72, 'rgba(' + rgb + ',0.08)');
    fade.addColorStop(1, 'rgba(' + rgb + ',0)');
    return fade;
  }

  function chartFrame(){
    const tick = { color: '#5B6673', font: { family: 'Inter', size: 11 } };
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1C2B39',
          titleFont: { family: 'Inter', size: 12 },
          bodyFont: { family: 'Inter', size: 12 },
          padding: 10,
          cornerRadius: 8,
          displayColors: false
        }
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: Object.assign({ maxTicksLimit: 14, autoSkip: true }, tick) },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: { color: '#E6E1D6', drawTicks: false, borderDash: [4, 6] },
          ticks: tick
        }
      }
    };
  }

  function areaSeries(canvas, label, data, hex, rgb){
    return {
      label: label,
      data: data,
      borderColor: hex,
      backgroundColor: chartFill(canvas, rgb),
      fill: true,
      spanGaps: false,
      tension: 0.45,
      borderWidth: 2.5,
      pointRadius: 3.5,
      pointHoverRadius: 6,
      pointBackgroundColor: hex,
      pointBorderColor: '#ffffff',
      pointBorderWidth: 2
    };
  }

  function mountChart(canvas, config){
    if (canvas._chart) canvas._chart.destroy();
    canvas._chart = new Chart(canvas, config);
    return canvas._chart;
  }

  function drawOccupancyChart(canvasId, series){
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return;
    const options = chartFrame();
    options.scales.y.suggestedMax = 100;
    mountChart(canvas, {
      type: 'line',
      data: { labels: series.labels, datasets: [areaSeries(canvas, 'Occupancy %', series.values, '#1e22aa', '30,34,170')] },
      options: options
    });
  }

  function renderArchive() {
    return `
    <div class="dmr-headline"><h1>Archive</h1></div>
    <div class="dmr-sub">Complete historical archive of Duty Manager daily reports</div>
    <input type="date" id="archiveSearch" class="dmr-btn dmr-btn-ghost" style="padding:7px 12px;margin-bottom:12px;">
    <div id="archiveList"><div class="dmr-card"><div class="dmr-empty">Loading archive…</div></div></div>`;
  }

  let dutyArchive = [];

  async function loadArchiveList() {
    const entries = await apiFetch('/api/reports/index');
    dutyArchive = entries || [];
    const search = document.getElementById('archiveSearch');
    if (search && !search._bound) {
      search._bound = true;
      search.onchange = () => paintDutyArchive();
    }
    paintDutyArchive();
  }

  function paintDutyArchive() {
    const el = document.getElementById('archiveList');
    if (!el) return;
    const search = document.getElementById('archiveSearch');
    const query = search && search.value;
    let rows = dutyArchive;
    if (query) rows = dutyArchive.filter(entry => entry.date === query);
    if (rows.length === 0) {
      el.innerHTML = '<div class="dmr-empty"><h3>No archived reports yet</h3></div>';
      return;
    }
    const isAdmin = state.user && state.user.role === 'admin';
    const canEditDuty = canWrite(state.user && state.user.role, 'duty');
    const openKey = query ? query.slice(0, 7) : (state.selectedDate || todayStr()).slice(0, 7);
    const todayKey = todayStr().slice(0, 7);
    el.innerHTML = groupByMonth(rows).map(group => {
      const open = group.key === openKey;
      return `
      <details class="archive-month dmr-card" ${open ? 'open' : ''}>
        <summary>${escapeHtml(group.label)} (${group.entries.length})</summary>
        <div class="chart-box"><canvas id="occ-${group.key}"></canvas></div>
        ${group.entries.map(e => `
          <div class="dmr-archive-row">
            <div>
              <div class="dmr-archive-date">${fmtDate(e.date)}</div>
              <span class="dmr-badge ${e.status==='submitted'?'dmr-badge-submitted':'dmr-badge-draft'}">
                ${e.status==='submitted'?'Submitted':'Draft'}
              </span>
              ${e.occupancy ? `<span style="font-size:12px;color:var(--ink-soft);margin-left:8px;">Occ: ${escapeHtml(String(e.occupancy).replace('%','').trim())}%</span>` : ''}
              ${e.notesCount ? `<span style="font-size:12px;color:var(--ink-soft);margin-left:8px;">${e.notesCount} note${e.notesCount===1?'':'s'}</span>` : ''}
              ${e.status==='submitted' && e.submittedBy ? `<div class="dmr-prepared-by">Prepared by: ${escapeHtml(e.submittedBy)}</div>` : ''}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-view-date="${e.date}">Open</button>
              ${(canEditDuty && (isAdmin || e.status !== 'submitted')) ? `<button class="dmr-btn dmr-btn-ghost dmr-btn-sm" data-edit-date="${e.date}">Edit</button>` : ''}
              <button class="dmr-btn dmr-btn-primary dmr-btn-sm" data-export="${e.date}">Export PDF</button>
              ${(canEditDuty && isAdmin) ? `<button class="dmr-btn dmr-btn-sm" data-delete-date="${e.date}" style="background:var(--danger);color:#fff;">Delete</button>` : ''}
            </div>
          </div>`).join('')}
      </details>`;
    }).join('');

    groupByMonth(rows).forEach(group => {
      const end = group.key === todayKey ? todayStr() : monthLastDay(group.key + '-01');
      drawOccupancyChart('occ-' + group.key, occupancySeries(dutyArchive, group.key + '-01', end));
    });
    el.querySelectorAll('details.archive-month').forEach(details => {
      details.ontoggle = () => {
        if (!details.open) return;
        const canvas = details.querySelector('canvas');
        if (!canvas) return;
        const key = canvas.id.replace('occ-', '');
        const end = key === todayKey ? todayStr() : monthLastDay(key + '-01');
        drawOccupancyChart(canvas.id, occupancySeries(dutyArchive, key + '-01', end));
      };
    });

    el.querySelectorAll('[data-view-date]').forEach(btn => {
      btn.onclick = () => { state.view = 'today'; switchDate(btn.dataset.viewDate); };
    });
    el.querySelectorAll('[data-export]').forEach(btn => {
      btn.onclick = () => exportPdf(btn.dataset.export);
    });
    el.querySelectorAll('[data-edit-date]').forEach(btn => {
      btn.onclick = () => editReportFromArchive(btn.dataset.editDate);
    });
    el.querySelectorAll('[data-delete-date]').forEach(btn => {
      btn.onclick = () => { state.confirmDeleteReport = btn.dataset.deleteDate; renderOverlays(); };
    });
  }

  // ---------- Analysis View ----------
  function renderAnalysis() {
    return `
    <div class="dmr-headline"><h1>Operations & Trend Analysis</h1></div>
    <div class="dmr-sub">Pick a day, a week, a month, the year to date, or any from and to dates</div>
    ${periodBar()}
    <div id="analysisBody"><div class="dmr-empty">Computing analysis…</div></div>`;
  }

  async function loadAnalysis() {
    const data = await apiFetch('/api/reports/analysis?' + periodQuery());
    const index = await apiFetch('/api/reports/index');
    state.analysisData = data;
    state.dutyIndex = index || [];
    const body = document.getElementById('analysisBody');
    if (!body || !data) return;

    body.innerHTML = `
      <div class="dmr-stat-grid">
        <div class="dmr-card dmr-stat"><div class="num">${data.days}</div><div class="lbl">Days Analyzed</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.totalFail}</div><div class="lbl">Checklist Failures (✗)</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.complaintsList.length}</div><div class="lbl">Guest Complaints</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.totalIncidents}</div><div class="lbl">Incidents Logged</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.totalNotesOpen}</div><div class="lbl">Action Items Open</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.courtesyNeg}</div><div class="lbl">Negative Courtesy Calls</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.avgGss}</div><div class="lbl">Avg. TrustYou GSS</div></div>
        <div class="dmr-card dmr-stat"><div class="num">${data.reviewsSum || '—'}</div><div class="lbl">Total Reviews Analyzed</div></div>
      </div>

      <div class="dmr-card dmr-chart-card">
        <h3>Occupancy %</h3>
        <div class="chart-box"><canvas id="occupancyChart"></canvas></div>
      </div>

      <div class="dmr-card dmr-chart-card">
        <h3>Inspection Failures by Area</h3>
        <div class="chart-box"><canvas id="sectionChart"></canvas></div>
      </div>

      <div class="dmr-card dmr-chart-card">
        <h3>Most Recurring Deficiencies</h3>
        ${data.topItems.length === 0 ? '<div class="dmr-sub" style="margin:0;">No recurring issues recorded in this period 👍</div>' :
          data.topItems.map(([label, count]) => `
            <div class="dmr-recur-item">
              <span>${escapeHtml(label)}</span>
              <span class="dmr-recur-count">${count}×</span>
            </div>`).join('')}
      </div>

      <div class="dmr-card dmr-chart-card">
        <h3>Guest Complaints Log (${data.complaintsList.length})</h3>
        ${data.complaintsList.length === 0 ? '<div class="dmr-sub" style="margin:0;">No complaints logged in this period.</div>' :
          data.complaintsList.map(c => `
            <div class="dmr-recur-item">
              <span>${fmtDate(c.date).split(',')[0]} — <b>${escapeHtml(c.complaint)}</b> ${c.room ? '(Room ' + escapeHtml(c.room) + ')' : ''}</span>
              <span class="dmr-recur-count" style="font-weight:400;color:var(--ink-soft);">${escapeHtml(c.action || '—')}</span>
            </div>`).join('')}
      </div>

      <div class="dmr-card dmr-chart-card">
        <h3>Incidents & Operational Remarks (${data.incidentsList.length})</h3>
        ${data.incidentsList.length === 0 ? '<div class="dmr-sub" style="margin:0;">No incidents logged.</div>' :
          data.incidentsList.map(i => `
            <div class="dmr-recur-item">
              <span>${fmtDate(i.date).split(',')[0]} — ${escapeHtml(i.description)} ${i.time ? '('+escapeHtml(i.time)+')' : ''}</span>
            </div>`).join('')}
      </div>

      ${data.courtesyNegList.length ? `
      <div class="dmr-card dmr-chart-card">
        <h3>Negative Courtesy Calls Feedback</h3>
        ${data.courtesyNegList.map(c => `
          <div class="dmr-recur-item">
            <span>${fmtDate(c.date).split(',')[0]} — Room ${escapeHtml(c.room || '—')}: ${escapeHtml(c.comment || '')}</span>
          </div>`).join('')}
      </div>` : ''}

      ${data.negComments.length ? `
      <div class="dmr-card dmr-chart-card">
        <h3>TrustYou — Actionable Guest Feedback Themes</h3>
        ${data.negComments.map(c => `
          <div class="dmr-recur-item">
            <span>${fmtDate(c.date).split(',')[0]} — ${escapeHtml(c.text)}</span>
          </div>`).join('')}
      </div>` : ''}

      <button class="dmr-btn dmr-btn-primary" id="exportAnalysisPdf" style="width:100%;justify-content:center;padding:13px;margin-top:8px;font-size:14px;">
        Export Summary Report for Executive / GM Meeting
      </button>
      `;

    drawChart();
    drawOccupancyChart('occupancyChart', occupancySeries(state.dutyIndex || [], state.periodFrom, state.periodTo));
    const expBtn = document.getElementById('exportAnalysisPdf');
    if (expBtn) expBtn.onclick = exportAnalysisPdf;
  }

  function drawChart() {
    const canvas = document.getElementById('sectionChart');
    if (!canvas || !window.Chart || !state.analysisData) return;
    if (canvas._chart) canvas._chart.destroy();
    const entries = state.analysisData.topSections.length ? state.analysisData.topSections : [['No failures', 0]];
    const options = chartFrame();
    options.scales.y.ticks.precision = 0;
    options.scales.x.ticks.maxRotation = 0;
    mountChart(canvas, {
      type: 'bar',
      data: {
        labels: entries.map(e => e[0]),
        datasets: [{
          data: entries.map(e => e[1]),
          backgroundColor: '#7c6bf2',
          borderRadius: 8,
          borderSkipped: false,
          maxBarThickness: 36
        }]
      },
      options: options
    });
  }

  // ---------- Users Management (admin only) ----------
  function renderUsers() {
    return `
    <div class="dmr-headline"><h1>User Management</h1></div>
    <div class="dmr-sub">Create and manage duty manager accounts</div>

    <div class="dmr-card user-form-card">
      <h3>Create New User</h3>
      <div class="dmr-row">
        <div class="dmr-field"><label>First Name</label><input id="u-first" placeholder="e.g. Houssin"></div>
        <div class="dmr-field"><label>Last Name</label><input id="u-last" placeholder="e.g. Al-Otaibi"></div>
      </div>
      <div class="dmr-row">
        <div class="dmr-field"><label>Username</label><input id="u-username" placeholder="Login username" autocapitalize="off"></div>
        <div class="dmr-field"><label>Password</label><input id="u-password" type="password" placeholder="Minimum 4 characters"></div>
      </div>
      <div class="dmr-row">
        <div class="dmr-field"><label>Title / Position</label><input id="u-title" placeholder="e.g. Duty Manager"></div>
        <div class="dmr-field"><label>Role</label><select id="u-role">
          <option value="staff">Staff</option>
          <option value="night">Night Manager</option>
          <option value="admin">Admin</option>
        </select></div>
      </div>
      <button class="dmr-btn dmr-btn-primary" id="createUserBtn">Create User</button>
    </div>

    <div class="dmr-card user-list-card">
      <h3>Existing Users</h3>
      <div id="userList"><div class="dmr-empty">Loading…</div></div>
    </div>`;
  }

  async function loadUsers() {
    const users = await apiFetch('/api/auth/users');
    const el = document.getElementById('userList');
    if (!el) return;
    if (!users || users.length === 0) {
      el.innerHTML = '<div class="dmr-empty"><h3>No users yet</h3></div>';
      return;
    }
    el.innerHTML = users.map(u => `
      <div class="user-row">
        <div class="user-avatar">${escapeHtml((u.first_name || '?').charAt(0).toUpperCase())}</div>
        <div class="user-info">
          <div class="user-name">${escapeHtml(fullName(u))}</div>
          <div class="user-meta">@${escapeHtml(u.username)}${u.title ? ' · ' + escapeHtml(u.title) : ''}</div>
        </div>
        <span class="user-role-badge ${u.role==='admin'?'user-role-admin':'user-role-staff'}">${u.role==='admin'?'Admin':'Staff'}</span>
        ${state.user && u.id !== state.user.id ? `<button class="dmr-del" data-user-del="${u.id}" title="Delete user">✕</button>` : ''}
      </div>`).join('');

    el.querySelectorAll('[data-user-del]').forEach(btn => {
      btn.onclick = () => deleteUser(btn.dataset.userDel);
    });
  }

  async function createUser() {
    const payload = {
      first_name: document.getElementById('u-first').value.trim(),
      last_name: document.getElementById('u-last').value.trim(),
      username: document.getElementById('u-username').value.trim(),
      password: document.getElementById('u-password').value,
      title: document.getElementById('u-title').value.trim(),
      role: document.getElementById('u-role').value
    };
    if (!payload.first_name || !payload.username || !payload.password) {
      showToast('First name, username and password are required');
      return;
    }
    const res = await apiFetch('/api/auth/users', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    if (res && res.id) {
      showToast('User created ✓');
      loadUsers();
      ['u-first','u-last','u-username','u-password','u-title'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    } else if (res && res.detail) {
      showToast(res.detail);
    }
  }

  async function deleteUser(id) {
    const res = await apiFetch('/api/auth/users/' + id, { method: 'DELETE' });
    if (res && res.success) { showToast('User deleted'); loadUsers(); }
    else if (res && res.detail) showToast(res.detail);
  }

  async function deleteReport(date) {
    const res = await apiFetch(`/api/reports/${date}`, { method: 'DELETE' });
    if (res && res.success) {
      showToast('Report deleted ✓');
      if (state.view === 'archive') loadArchiveList();
      else render();
    } else if (res && res.detail) {
      showToast(res.detail);
    }
  }

  async function editReportFromArchive(date) {
    const report = await loadReport(date);
    if (report && report.status === 'submitted') {
      await apiFetch(`/api/reports/${date}/reopen`, { method: 'POST' });
    }
    state.view = 'today';
    await switchDate(date);
    showToast('Report ready to edit');
  }

  // ---------- PDF Generation ----------
  function chartImage(draw){
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 280;
    const previous = Chart.defaults.devicePixelRatio;
    Chart.defaults.devicePixelRatio = 1;
    let chart = null;
    try {
      chart = draw(canvas);
      return canvas.toDataURL('image/jpeg', 0.82);
    } finally {
      if (chart) chart.destroy();
      Chart.defaults.devicePixelRatio = previous;
    }
  }

  async function occupancyChartImage(startIso, endIso){
    if (!window.Chart) return null;
    const index = await apiFetch('/api/reports/index');
    if (!index) return null;
    const series = occupancySeries(index, startIso, endIso);
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 280;
    const options = chartFrame();
    options.animation = false;
    options.responsive = false;
    options.scales.y.suggestedMax = 100;
    const previous = Chart.defaults.devicePixelRatio;
    Chart.defaults.devicePixelRatio = 1;
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: series.labels,
        datasets: [areaSeries(canvas, 'Occupancy %', series.values, '#1e22aa', '30,34,170')]
      },
      options: options
    });
    const url = canvas.toDataURL('image/jpeg', 0.82);
    chart.destroy();
    Chart.defaults.devicePixelRatio = previous;
    return url;
  }

  async function exportPdf(date, sharedDoc) {
    if (!window.jspdf) { showToast('PDF generator loading, please try in a moment'); return; }
    const r = await loadReport(date);
    const { jsPDF } = window.jspdf;
    const doc = sharedDoc || new jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const logoUrl = await getLogoDataUrl();
    let y = pdfHeader(doc, W, logoUrl);

    // Meta summary
    doc.setFont('helvetica','bold'); doc.setFontSize(11);
    doc.setTextColor(...NOVOTEL.navy);
    doc.text(fmtDate(date), 40, y);
    const prep = preparerName(r);
    if (prep) {
      doc.setFont('helvetica','bold'); doc.setFontSize(9);
      doc.setTextColor(...NOVOTEL.brandBlue);
      doc.text(`Prepared by: ${prep}`, W - 40, y, {align:'right'});
    }
    y += 16;
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    doc.setTextColor(...NOVOTEL.inkSoft);
    doc.text(`Shift: ${r.shiftStart || '—'}  to  ${r.shiftEnd || '—'}`, 40, y);
    const occNum = parseFloat(String(r.occupancy || '').replace('%','').trim());
    doc.setFont('helvetica','bold');
    doc.setTextColor(...occupancyColor(r.occupancy));
    doc.text(`Occupancy: ${isNaN(occNum) ? '—' : occNum + '%'}`, 210, y);
    doc.setFont('helvetica','normal');
    doc.setTextColor(...NOVOTEL.inkSoft);
    doc.text(`Arrivals: ${r.arrivals||0}`, 330, y);
    doc.text(`Departures: ${r.departures||0}`, 420, y);
    doc.text(`In-House: ${r.inHouse||0}`, 490, y);
    y += 14;
    doc.text(`ALL Loyalty Members: ${r.allMembers||0}`, 40, y);
    y += 16;
    try {
      const chartUrl = await occupancyChartImage(date.slice(0, 8) + '01', date);
      if (chartUrl) {
        if (y + 160 > 780) { doc.addPage(); y = 45; }
        doc.addImage(chartUrl, 'PNG', 40, y, W - 80, 140);
        y += 156;
      }
    } catch (e) {}

    // Area checklist tables
    const chkCols = [
      {key:'STATUS', label:'STATUS', w:38, align:'center'},
      {key:'ITEM', label:'ITEM', w:290},
      {key:'REMARKS', label:'REMARKS', w:187}
    ];
    AREA_SECTIONS.forEach(sec => {
      y = pdfSectionHeading(doc, W, y, sec.title);
      const rows = sec.items.map((it, idx) => {
        const label = typeof it === 'string' ? it : it.label;
        const e = (r.checklists[sec.key] && r.checklists[sec.key][idx]) || {};
        const isFail = e.status === false, isOk = e.status === true;
        return {
          STATUS: isOk ? 'OK' : (isFail ? 'FAIL' : '—'),
          ITEM: label,
          REMARKS: e.comment || '',
          _fill: isFail ? NOVOTEL.dangerBg : (idx % 2 === 0 ? NOVOTEL.white : NOVOTEL.rowAlt),
          STATUS_color: isOk ? NOVOTEL.ok : (isFail ? NOVOTEL.danger : NOVOTEL.inkSoft)
        };
      });
      y = pdfTable(doc, W, y, chkCols, rows);
      y += 8;
    });

    // Inspection photo evidence (failed items)
    const evidence = [];
    AREA_SECTIONS.forEach(sec => {
      sec.items.forEach((it, idx) => {
        const e = (r.checklists[sec.key] && r.checklists[sec.key][idx]) || {};
        if (e.status === false && e.photos && e.photos.length) {
          evidence.push({ section: sec.title, label: (typeof it === 'string' ? it : it.label), photos: e.photos });
        }
      });
    });
    CAFETERIA_ITEMS.forEach((label, idx) => {
      const e = r.cafeteriaItems && r.cafeteriaItems[idx] ? r.cafeteriaItems[idx] : {};
      if (e.status === false && e.photos && e.photos.length) {
        evidence.push({ section: 'Staff Cafeteria', label: label, photos: e.photos });
      }
    });
    if (evidence.length) {
      y = pdfSectionHeading(doc, W, y, 'Inspection Photo Evidence');
      y += 12; // gap between heading bar and first photo label
      for (const ev of evidence) {
        const photoHeight = ev.photos.length ? 98 : 3; // label + photo(s) or label only
        if (y + 11 + photoHeight > 780) { doc.addPage(); y = 45; }
        doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
        doc.setTextColor(...NOVOTEL.brassDark);
        doc.text(`${ev.section} — ${ev.label}`, 40, y); y += 11;
        let px = 40, loaded = 0;
        for (const p of ev.photos) {
          const img = await loadImg(p);
          if (!img) continue;
          if (px + 90 > W - 40) { y += 96; px = 40; }
          if (y + 90 > 770) { doc.addPage(); y = 45; }
          try { doc.addImage(img, 'JPEG', px, y, 88, 88); px += 94; loaded++; } catch(e) {}
        }
        y += (loaded ? 98 : 3);
      }
      y += 6;
    }

    // Rooms inspection
    if (r.roomsInspection && r.roomsInspection.length) {
      y = pdfSectionHeading(doc, W, y, 'Rooms Inspection');
      const cols = [
        {key:'ROOM', label:'ROOM', w:60},
        {key:'STATUS', label:'STATUS', w:70, align:'center'},
        {key:'COMMENT', label:'COMMENT', w:385}
      ];
      const rows = r.roomsInspection.map(row => ({
        ROOM: row.room || '—',
        STATUS: row.status===true?'OK':(row.status===false?'FAIL':'—'),
        COMMENT: row.comment || '',
        STATUS_color: row.status===true?NOVOTEL.ok:(row.status===false?NOVOTEL.danger:NOVOTEL.inkSoft)
      }));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Courtesy calls
    if (r.courtesyCalls && r.courtesyCalls.length) {
      y = pdfSectionHeading(doc, W, y, 'Courtesy Calls');
      const cols = [
        {key:'ROOM', label:'ROOM', w:60},
        {key:'IMPRESSION', label:'IMPRESSION', w:90, align:'center'},
        {key:'FEEDBACK', label:'FEEDBACK', w:365}
      ];
      const rows = r.courtesyCalls.map(row => ({
        ROOM: row.room || '—',
        IMPRESSION: row.impression===true?'Positive':(row.impression===false?'Negative':'—'),
        FEEDBACK: row.comment || '',
        IMPRESSION_color: row.impression===true?NOVOTEL.ok:(row.impression===false?NOVOTEL.danger:NOVOTEL.inkSoft)
      }));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // TrustYou
    if (r.trustYou) {
      y = pdfSectionHeading(doc, W, y, 'TrustYou — Daily Review Metrics');
      const cols = [
        {key:'METRIC', label:'METRIC', w:170},
        {key:'VALUE', label:'VALUE', w:345}
      ];
      const rows = [
        {METRIC:'Total Reviews', VALUE: r.trustYou.totalReviews || '0'},
        {METRIC:'GSS Score', VALUE: r.trustYou.gss || '0'},
        {METRIC:'Key Positive Theme', VALUE: r.trustYou.keyPositive || '—'},
        {METRIC:'Key Negative Theme', VALUE: r.trustYou.keyNegative || '—'},
        {METRIC:'Remarks', VALUE: r.trustYou.comment || '—'}
      ];
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Cafeteria
    if (r.cafeteriaItems && r.cafeteriaItems.length) {
      y = pdfSectionHeading(doc, W, y, 'Staff Cafeteria Inspection' + (r.cafeteriaMealTime ? ' — ' + r.cafeteriaMealTime : ''));
      const cols = [
        {key:'STATUS', label:'STATUS', w:38, align:'center'},
        {key:'ITEM', label:'CHECK ITEM', w:290},
        {key:'REMARKS', label:'REMARKS', w:187}
      ];
      const rows = CAFETERIA_ITEMS.map((label, idx) => {
        const e = r.cafeteriaItems[idx] || {};
        const isFail = e.status === false, isOk = e.status === true;
        return {
          STATUS: isOk ? 'OK' : (isFail ? 'FAIL' : '—'),
          ITEM: label,
          REMARKS: e.comment || '',
          _fill: isFail ? NOVOTEL.dangerBg : (idx % 2 === 0 ? NOVOTEL.white : NOVOTEL.rowAlt),
          STATUS_color: isOk ? NOVOTEL.ok : (isFail ? NOVOTEL.danger : NOVOTEL.inkSoft)
        };
      });
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Complaints
    if (r.complaints && r.complaints.length) {
      y = pdfSectionHeading(doc, W, y, 'Guest Complaints');
      const cols = [
        {key:'ROOM', label:'ROOM', w:55},
        {key:'COMPLAINT', label:'COMPLAINT', w:230},
        {key:'ACTION', label:'ACTION TAKEN', w:230}
      ];
      const rows = r.complaints.map(c => ({ROOM: c.room || '—', COMPLAINT: c.complaint || '', ACTION: c.action || '—', COMPLAINT_color: NOVOTEL.danger, ACTION_color: NOVOTEL.ok}));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Incidents
    if (r.incidents && r.incidents.length) {
      y = pdfSectionHeading(doc, W, y, 'Incidents / General Comments');
      const cols = [
        {key:'TIME', label:'TIME', w:60},
        {key:'DESCRIPTION', label:'DESCRIPTION', w:455}
      ];
      const rows = r.incidents.map(inc => ({TIME: inc.time || '—', DESCRIPTION: inc.description || '', DESCRIPTION_color: NOVOTEL.danger}));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Notes
    if (r.notes && r.notes.length) {
      y = pdfSectionHeading(doc, W, y, 'Detailed Notes & Observations');
      for (const n of r.notes) {
        if (y + 26 > 780) { doc.addPage(); y = 45; }
        doc.setFont('helvetica','bold'); doc.setFontSize(9);
        doc.setTextColor(...NOVOTEL.navy);
        doc.text(`${n.time}  |  ${n.department}  |  ${(n.priority||'').toUpperCase()}  |  ${(n.status||'').toUpperCase()}`, 40, y); y += 13;
        doc.setFont('helvetica','normal'); doc.setFontSize(9);
        doc.setTextColor(...NOVOTEL.ink);
        const lines = doc.splitTextToSize(`${n.manager || 'Duty Manager'}: ${n.text}`, W - 80);
        doc.text(lines, 40, y); y += lines.length * 12 + 4;
        if (n.photo_url) {
          const img = await loadImg(n.photo_url);
          if (img) {
            if (y + 100 > 780) { doc.addPage(); y = 45; }
            try { doc.addImage(img, 'JPEG', 40, y, 86, 64); y += 70; } catch(e) {}
          }
        }
      }
    }

    addPdfFooter(doc, W);
    if (!sharedDoc) doc.save(`novotel-duty-report-${date}.pdf`);
    return doc;
  }

  async function exportAnalysisPdf() {
    if (!window.jspdf) return;
    const d = state.analysisData;
    if (!d) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const logoUrl = await getLogoDataUrl();
    let y = pdfHeader(doc, W, logoUrl);

    doc.setFont('helvetica','bold'); doc.setFontSize(12);
    doc.setTextColor(...NOVOTEL.navy);
    doc.text(`${d.range === 'week' ? 'Weekly' : 'Monthly'} Operations Summary`, 40, y); y += 18;
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    doc.setTextColor(...NOVOTEL.inkSoft);
    doc.text(`Period: ${d.startDate} to ${d.endDate}    ·    Days Analyzed: ${d.days}`, 40, y); y += 14;

    // Stat cards (4 x 2 grid)
    const cards = [
      {v: String(d.days), l: 'Days Analyzed', c: NOVOTEL.navy},
      {v: String(d.totalFail), l: 'Checklist Failures', c: NOVOTEL.danger},
      {v: String(d.complaintsList.length), l: 'Guest Complaints', c: NOVOTEL.danger},
      {v: String(d.totalIncidents), l: 'Incidents', c: NOVOTEL.brass},
      {v: String(d.totalNotesOpen), l: 'Action Items Open', c: NOVOTEL.navy2},
      {v: String(d.courtesyNeg), l: 'Neg. Courtesy Calls', c: NOVOTEL.danger},
      {v: String(d.avgGss), l: 'Avg TrustYou GSS', c: NOVOTEL.ok},
      {v: String(d.reviewsSum || '0'), l: 'Total Reviews', c: NOVOTEL.navy}
    ];
    const cw = 121, ch = 50, cgap = 10;
    let gx = 40, gy = y;
    cards.forEach((c, i) => {
      if (i > 0 && i % 4 === 0) { gx = 40; gy += ch + cgap; }
      drawStatBox(doc, gx, gy, cw, ch, c.v, c.l, c.c);
      gx += cw + cgap;
    });
    y = gy + ch + 16;

    // Charts
    try {
      const occImg = await occupancyChartImage(d.startDate, d.endDate);
      if (occImg) {
        if (y + 180 > 780) { doc.addPage(); y = 45; }
        y = pdfSectionHeading(doc, W, y, 'Occupancy %');
        doc.addImage(occImg, 'JPEG', 40, y, W - 80, 150);
        y += 158;
      }
    } catch (e) {}
    const canvas = document.getElementById('sectionChart');
    if (d.topSections) {
      try {
        const failImg = chartImage(canvasEl => {
          const options = chartFrame();
          options.animation = false;
          options.responsive = false;
          const entries = d.topSections.length ? d.topSections : [['No failures', 0]];
          return new Chart(canvasEl, {
            type: 'bar',
            data: {
              labels: entries.map(e => e[0]),
              datasets: [{ data: entries.map(e => e[1]), backgroundColor: '#7c6bf2', borderRadius: 8, maxBarThickness: 36 }]
            },
            options: options
          });
        });
        if (y + 170 > 780) { doc.addPage(); y = 45; }
        y = pdfSectionHeading(doc, W, y, 'Inspection Failures by Area');
        doc.addImage(failImg, 'JPEG', 40, y, W - 80, 150);
        y += 158;
      } catch (e) {}
    } else if (canvas) {
      try {
        const img = canvas.toDataURL('image/png');
        if (y + 170 > 780) { doc.addPage(); y = 45; }
        y = pdfSectionHeading(doc, W, y, 'Inspection Failures by Area');
        doc.addImage(img, 'PNG', 40, y, W - 80, 150);
        y += 158;
      } catch (e) {}
    }

    // Top recurring issues
    if (d.topItems.length) {
      y = pdfSectionHeading(doc, W, y, 'Top Recurring Deficiencies');
      const cols = [
        {key:'ISSUE', label:'ISSUE', w:400},
        {key:'COUNT', label:'COUNT', w:115, align:'center'}
      ];
      const rows = d.topItems.map(([label, count]) => ({ISSUE: label, COUNT: count + '×', COUNT_color: NOVOTEL.brassDark}));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Complaints
    if (d.complaintsList.length) {
      y = pdfSectionHeading(doc, W, y, 'Guest Complaints');
      const cols = [
        {key:'DATE', label:'DATE', w:70},
        {key:'COMPLAINT', label:'COMPLAINT', w:240},
        {key:'ACTION', label:'ACTION', w:205}
      ];
      const rows = d.complaintsList.map(c => ({
        DATE: c.date,
        COMPLAINT: c.complaint + (c.room ? ' (Room ' + c.room + ')' : ''),
        ACTION: c.action || '—',
        COMPLAINT_color: NOVOTEL.danger, ACTION_color: NOVOTEL.ok
      }));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Incidents
    if (d.incidentsList.length) {
      y = pdfSectionHeading(doc, W, y, 'Incidents / General Comments');
      const cols = [
        {key:'DATE', label:'DATE', w:70},
        {key:'DESCRIPTION', label:'DESCRIPTION', w:445}
      ];
      const rows = d.incidentsList.map(i => ({DATE: i.date, DESCRIPTION: i.description + (i.time ? ' (' + i.time + ')' : ''), DESCRIPTION_color: NOVOTEL.danger}));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Negative courtesy calls
    if (d.courtesyNegList.length) {
      y = pdfSectionHeading(doc, W, y, 'Negative Courtesy Calls');
      const cols = [
        {key:'DATE', label:'DATE', w:70},
        {key:'ROOM', label:'ROOM', w:70},
        {key:'FEEDBACK', label:'FEEDBACK', w:375}
      ];
      const rows = d.courtesyNegList.map(c => ({DATE: c.date, ROOM: c.room || '—', FEEDBACK: c.comment || '—'}));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    // Negative themes
    if (d.negComments.length) {
      y = pdfSectionHeading(doc, W, y, 'TrustYou — Negative Feedback Themes');
      const cols = [
        {key:'DATE', label:'DATE', w:70},
        {key:'THEME', label:'THEME', w:445}
      ];
      const rows = d.negComments.map(c => ({DATE: c.date, THEME: c.text}));
      y = pdfTable(doc, W, y, cols, rows);
      y += 8;
    }

    addPdfFooter(doc, W);
    doc.save(`novotel-summary-${d.range}-${state.selectedDate}.pdf`);
  }

  // ---------- Event Handlers ----------
  function attachHandlers() {
    // Checklist photo file input (attached once)
    const checklistPhotoInput = document.getElementById('checklistPhotoInput');
    if (checklistPhotoInput && !checklistPhotoInput._bound) {
      checklistPhotoInput._bound = true;
      checklistPhotoInput.onchange = async () => {
        const file = checklistPhotoInput.files[0];
        checklistPhotoInput.value = '';
        if (!file || !state.photoTarget) return;
        const [secKey, idxStr] = state.photoTarget;
        state.photoTarget = null;
        const arr = secKey === 'cafeteriaItems' ? state.report.cafeteriaItems : state.report.checklists[secKey];
        const item = arr[parseInt(idxStr)];
        if (!item.photos) item.photos = [];
        if (item.photos.length >= 2) { showToast('Maximum 2 photos per item'); return; }
        showToast('Uploading photo…');
        const url = await uploadPhotoFile(file);
        if (url) { item.photos.push(url); queueSave(); render(); showToast('Photo added ✓'); }
      };
    }

    document.querySelectorAll('[data-view]').forEach(b => {
      b.onclick = () => {
        if (b.dataset.section) state.section = b.dataset.section;
        state.view = b.dataset.view;
        setNavOpen(false);
        render();
      };
    });

    document.querySelectorAll('.dmr-acc').forEach(acc => {
      const summary = acc.querySelector('summary');
      if (summary) {
        summary.onclick = (e) => {
          e.preventDefault();
          const key = acc.dataset.acc;
          if (state.openAcc.has(key)) state.openAcc.delete(key);
          else state.openAcc.add(key);
          render();
        };
      }
    });

    const dateInput = document.getElementById('dateInput');
    if (dateInput) dateInput.onchange = (e) => switchDate(e.target.value);

    document.querySelectorAll('[data-gf]').forEach(inp => {
      inp.oninput = () => { state.report[inp.dataset.gf] = inp.value; queueSave(); };
    });

    document.querySelectorAll('[data-ty]').forEach(inp => {
      inp.oninput = () => { if (!state.report.trustYou) state.report.trustYou = {}; state.report.trustYou[inp.dataset.ty] = inp.value; queueSave(); };
    });

    document.querySelectorAll('[data-chk-section]').forEach(row => {
      const secKey = row.dataset.chkSection, idx = parseInt(row.dataset.chkIdx, 10);
      const arr = secKey === 'cafeteriaItems' ? state.report.cafeteriaItems : state.report.checklists[secKey];
      row.querySelectorAll('[data-chk]').forEach(btn => {
        btn.onclick = async () => {
          const want = btn.dataset.chk === 'ok' ? true : false;
          arr[idx].status = arr[idx].status === want ? null : want;
          render(); queueSave();
        };
      });
      const commentInput = row.querySelector('[data-chk-comment]');
      if (commentInput) commentInput.oninput = () => { arr[idx].comment = commentInput.value; queueSave(); };
    });

    // Checklist photo add / remove / view
    document.querySelectorAll('[data-chk-photo-add]').forEach(btn => {
      btn.onclick = () => {
        state.photoTarget = btn.dataset.chkPhotoAdd.split('|');
        document.getElementById('checklistPhotoInput').click();
      };
    });
    document.querySelectorAll('[data-chk-photo-del]').forEach(btn => {
      btn.onclick = () => {
        const [secKey, idx, photoIdx] = btn.dataset.chkPhotoDel.split('|');
        const arr = secKey === 'cafeteriaItems' ? state.report.cafeteriaItems : state.report.checklists[secKey];
        const item = arr[parseInt(idx)];
        if (item.photos) item.photos.splice(parseInt(photoIdx), 1);
        queueSave(); render();
      };
    });
    document.querySelectorAll('[data-chk-photo]').forEach(img => {
      img.onclick = () => { state.modalImg = img.src; renderOverlays(); };
    });

    document.querySelectorAll('[data-add-row]').forEach(btn => {
      btn.onclick = async () => {
        const key = btn.dataset.addRow;
        const templates = {
          roomsInspection: { room: '', status: null, comment: '' },
          courtesyCalls: { room: '', impression: null, comment: '' },
          complaints: { complaint: '', room: '', action: '' },
          incidents: { description: '', time: '' }
        };
        state.report[key].push(Object.assign({}, templates[key]));
        render(); queueSave();
      };
    });

    document.querySelectorAll('[data-dyn-list]').forEach(row => {
      const listKey = row.dataset.dynList, idx = parseInt(row.dataset.dynIdx, 10);
      const dataRow = state.report[listKey][idx];
      row.querySelectorAll('[data-dyn-field]').forEach(inp => {
        inp.oninput = () => { dataRow[inp.dataset.dynField] = inp.value; queueSave(); };
      });
      row.querySelectorAll('[data-dyn-toggle]').forEach(btn => {
        btn.onclick = () => {
          const field = btn.dataset.dynToggle;
          const want = btn.classList.contains('ok');
          dataRow[field] = dataRow[field] === want ? null : want;
          render(); queueSave();
        };
      });
      const delBtn = row.querySelector('[data-dyn-del]');
      if (delBtn) delBtn.onclick = () => { state.report[listKey].splice(idx, 1); render(); queueSave(); };
    });

    const photoInput = document.getElementById('f-photo');
    if (photoInput) {
      photoInput.onchange = async () => {
        const file = photoInput.files[0];
        if (!file) return;
        showToast('Uploading photo…');
        const photoUrl = await uploadPhotoFile(file);
        const prev = document.getElementById('f-photo-preview');
        if (photoUrl && prev) {
          prev.src = photoUrl;
          prev.style.display = 'block';
          photoInput.dataset.url = photoUrl;
          showToast('Photo uploaded ✓');
        }
      };
    }

    const addBtn = document.getElementById('addNoteBtn');
    if (addBtn) {
      addBtn.onclick = async () => {
        const text = document.getElementById('f-text').value.trim();
        if (!text) { showToast('Please type your note observation first'); return; }
        const draft = {
          department: document.getElementById('f-dept').value,
          priority: document.getElementById('f-priority').value,
          text,
          photo_url: photoInput?.dataset.url || null
        };
        await submitNote(draft);
      };
    }

    document.querySelectorAll('[data-status-id]').forEach(sel => {
      sel.onchange = async () => {
        const noteId = sel.dataset.statusId;
        const note = state.report.notes.find(n => n.id === noteId);
        if (note) {
          note.status = sel.value;
          await apiFetch(`/api/notes/${noteId}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ status: sel.value })
          });
          render();
        }
      };
    });

    document.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = () => { state.confirmDeleteId = btn.dataset.del; renderOverlays(); };
    });

    document.querySelectorAll('[data-photo]').forEach(img => {
      img.onclick = () => { state.modalImg = img.src; renderOverlays(); };
    });

    document.querySelectorAll('[data-period]').forEach(btn => {
      btn.onclick = () => { applyPeriod(btn.dataset.period); render(); };
    });
    const periodFrom = document.getElementById('periodFrom');
    const periodTo = document.getElementById('periodTo');
    if (periodFrom) periodFrom.onchange = () => {
      state.periodMode = 'custom';
      state.periodFrom = periodFrom.value;
      if (state.periodTo && state.periodFrom > state.periodTo) state.periodTo = state.periodFrom;
      render();
    };
    if (periodTo) periodTo.onchange = () => {
      state.periodMode = 'custom';
      state.periodTo = periodTo.value;
      if (state.periodFrom && state.periodFrom > state.periodTo) state.periodFrom = state.periodTo;
      render();
    };

    const createUserBtn = document.getElementById('createUserBtn');
    if (createUserBtn) createUserBtn.onclick = createUser;

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.onclick = logout;

    const submitBtn = document.getElementById('submitReportBtn');
    if (submitBtn) {
      submitBtn.onclick = async () => {
        await persistReport();
        const res = await apiFetch(`/api/reports/${state.selectedDate}/submit`, { method: 'POST' });
        if (res && res.success) {
          state.report.status = 'submitted';
          state.report.submittedAt = res.submittedAt;
          state.report.submittedBy = res.submittedBy;
          render();
          showToast('Daily Report finalized & submitted');
          await exportPdf(state.report.date);
        }
      };
    }

    const reopenBtn = document.getElementById('reopenBtn');
    if (reopenBtn) {
      reopenBtn.onclick = async () => {
        const res = await apiFetch(`/api/reports/${state.selectedDate}/reopen`, { method: 'POST' });
        if (res && res.success) {
          state.report.status = 'draft';
          state.report.submittedAt = null;
          state.report.submittedBy = null;
          render();
          showToast('Report reopened for editing');
        }
      };
    }

    const exportTodayBtn = document.getElementById('exportTodayPdf');
    if (exportTodayBtn) exportTodayBtn.onclick = () => exportPdf(state.report.date);
  }

  async function submitNote(draft) {
    const res = await apiFetch(`/api/notes/${state.selectedDate}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        department: draft.department,
        priority: draft.priority,
        text: draft.text,
        photo_url: draft.photo_url
      })
    });
    if (res && res.id) {
      state.report.notes.push(res);
      render();
      showToast('Note logged ✓');
    }
  }

  window.canWrite = canWrite;
  window.apiFetch = apiFetch;
  window.state = state;
  window.renderApp = render;
  window.groupByMonth = groupByMonth;
  window.exportDutyPdf = exportPdf;
  window.NovotelPdf = { pdfHeader, pdfTable, addPdfFooter, getLogoDataUrl };
  window.occupancySeries = occupancySeries;
  window.periodBar = periodBar;
  window.periodQuery = periodQuery;
  window.NovotelCharts = { chartFrame, areaSeries, chartFill, mountChart, chartImage };

  init();
})();
