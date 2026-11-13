// Phone host: stands in for the desktop shell so the same page (host.js and everything before it) runs in a phone
// browser or an Android WebView. Loaded BEFORE host.js.
// - host.js talks to the shell through window.__TAURI__.core.invoke; here that is a small stand-in whose
//   sidecar_send goes over a WebSocket to the phone bridge (sidecar/bridge.mjs) instead of the shell's pipe.
// - The bridge's { type: 'ui', msg } messages are handed to __roamieHost(msg), as the shell does.
// - The shell feeds the cursor to __roamiePtr every frame; here the last touch (or mouse) position is fed instead.
// - Voice in: the browser's speech recognition, shown through the same { kind: 'voice' } messages the desktop voice
//   helper sends, then sent to the brain as { type: 'voice', text }.
// Pairing: the token is typed once (or arrives as #pair=<token>) and kept in this browser's storage.
(() => {
  if (window.__TAURI__) return; // inside the desktop app: the real shell is there
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode: paired for this visit only */ } },
  };
  const qs = new URLSearchParams(location.search);
  // Where the bridge is: ?bridge=wss://host/ws, a saved address, else the server this page came from.
  const bridgeUrl = () => qs.get('bridge') || store.get('roamies.bridge') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  // Inside the Android app the page comes from the app itself, not from the computer, so the computer's address
  // has to be given once (its Tailscale name). In a browser the page is served by the bridge it then talks to.
  const embedded = location.hostname === 'tauri.localhost' || !/^https?:$/.test(location.protocol) || qs.has('embedded'); // ?embedded: to try it in a browser
  // "pc.tailnet.ts.net", "https://pc.tailnet.ts.net/" or a full ws(s):// address → the bridge's socket address.
  const socketAddress = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return null;
    if (/^wss?:\/\//i.test(t)) return t;
    const m = /^(https?):\/\/([^/]+)/i.exec(t), host = m ? m[2] : t.replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
    return `${m && m[1].toLowerCase() === 'http' ? 'ws' : 'wss'}://${host}/ws`;
  };
  let token = store.get('roamies.pair');
  const fromHash = /(?:^|[#&])pair=([^&]+)/.exec(location.hash);
  if (fromHash) {
    token = decodeURIComponent(fromHash[1]); store.set('roamies.pair', token);
    history.replaceState(null, '', location.pathname + location.search); // keep the token out of the address bar
  }

  // ---------- the link ----------
  const listeners = new Set();
  const state = { link: 'off', lagMs: null, brain: '' }; // link: off | connecting | paired | refused | lost
  const tell = () => { for (const f of listeners) { try { f(state); } catch { /* a listener's own problem */ } } };
  const setLink = (link) => { if (state.link !== link) { state.link = link; tell(); } };
  let ws = null, retry = 0, retryTimer = null, pingTimer = null, wantReady = false, page = '';
  const outbox = []; // what the page sent while the link was down: the latest few go once it's back
  const raw = (m) => { if (ws?.readyState === 1 && state.link === 'paired') { ws.send(JSON.stringify(m)); return true; } return false; };
  const sendBrain = (m) => { if (!raw(m)) { outbox.push(m); if (outbox.length > 8) outbox.shift(); } };

  function connect() {
    clearTimeout(retryTimer);
    if (!token || (embedded && !qs.get('bridge') && !store.get('roamies.bridge'))) { setLink('off'); return; }
    if (ws && ws.readyState <= 1) return;
    setLink('connecting');
    let sock;
    try { sock = new WebSocket(bridgeUrl()); } catch { setLink('lost'); return again(); }
    ws = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', token }));
    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello' && m.ok) {
        // The computer now serves a newer page than the one open here (Roamies was updated): load it, or this old
        // copy would talk to the new brain with yesterday's rules.
        if (page && m.page && m.page !== page) { location.reload(); return; }
        page = m.page || page;
        retry = 0; state.brain = String(m.version ?? ''); setLink('paired');
        if (wantReady) raw({ type: 'ui_ready' });
        for (const o of outbox.splice(0)) raw(o);
        clearInterval(pingTimer);
        pingTimer = setInterval(() => raw({ type: 'ping', t: Math.round(performance.now()) }), 15000);
      } else if (m.type === 'pong') { if (typeof m.t === 'number') { state.lagMs = Math.max(0, Math.round(performance.now() - m.t)); tell(); } }
      else if (m.type === 'ui' && m.msg) window.__roamieHost?.(m.msg);
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      clearInterval(pingTimer); ws = null;
      // 4401: the bridge didn't accept the token. Asking again would only count as more wrong tries.
      if (e.code === 4401) { token = null; store.set('roamies.pair', null); setLink('refused'); return; }
      setLink('lost');
      again();
    };
    sock.onerror = () => { /* onclose follows */ };
  }
  const again = () => { retryTimer = setTimeout(connect, Math.min(15000, 500 * 2 ** retry++)); };
  addEventListener('online', () => { retry = 0; connect(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.link !== 'paired') { retry = 0; connect(); } });

  // ---------- the shell's stand-in ----------
  const DRAWING = new Set(['draw_started', 'draw_done', 'draw_wait_done', 'ink_closed', 'ink_action', 'ink_cleared', 'quiz_done', 'list_toggle']);
  const toBrain = (msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ui_ready') { wantReady = true; raw(msg); return; }
    if (msg.type === 'menu') { if (msg.id === 'stop') sendBrain({ type: 'stop' }); return; } // the page's Esc: stop the reply
    if (msg.type === 'answer' || msg.type === 'reply_said') sendBrain(msg);
    // This page's own drawing reporting back (a card shown, closed, a button or quiz answered) and its list ticked.
    else if (DRAWING.has(msg.type)) sendBrain(msg);
    // Everything else the page says is for the desktop shell or its helpers: nothing to do on a phone.
  };
  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        if (cmd === 'sidecar_send') toBrain(args?.msg);
        return Promise.resolve(cmd === 'buddy' ? false : null);
      },
    },
  };

  // The pointer: the shell reports the cursor in page points with its own clock (ms).
  const ptr = (e) => window.__roamiePtr?.(e.clientX, e.clientY, performance.now());
  addEventListener('pointerdown', ptr, { passive: true });
  addEventListener('pointermove', ptr, { passive: true });

  // ---------- voice in ----------
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voice = (m) => window.__roamieHost?.({ kind: 'voice', ...m });
  let rec = null, heard = '', sent = false;
  const listening = () => !!rec;
  function listen() {
    if (!Rec || rec) return false;
    heard = ''; sent = false;
    const r = new Rec();
    r.lang = navigator.language || 'en-US';
    r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    r.onstart = () => { voice({ type: 'state', state: 'listening', mode: 'handsfree' }); tell(); };
    r.onresult = (e) => {
      let text = '';
      for (const res of e.results) text += res[0].transcript;
      heard = text.trim();
      if (heard) voice({ type: 'partial', text: heard });
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') window.__roamieHost?.({ kind: 'say', text: 'I need the microphone to hear you. Allow it for this page in the browser, then tap the mic again.', mood: 'concerned' }); };
    r.onend = () => {
      rec = null;
      if (heard && !sent) { sent = true; voice({ type: 'final', text: heard }); sendBrain({ type: 'voice', text: heard }); }
      voice({ type: 'state', state: 'idle', cancelled: !heard });
      tell();
    };
    rec = r;
    try { r.start(); } catch { rec = null; return false; }
    return true;
  }
  const stopListening = (cancel = false) => { if (!rec) return; if (cancel) { heard = ''; rec.abort(); } else rec.stop(); };

  window.RoamiePhone = {
    state,
    onChange: (f) => { listeners.add(f); f(state); return () => listeners.delete(f); },
    paired: () => state.link === 'paired',
    needsAddress: embedded,
    address: () => store.get('roamies.bridge') || '',
    // addr: the computer's address, needed in the app. False when it isn't one (nothing is changed then).
    pair(t, addr) {
      if (addr != null && String(addr).trim()) { const a = socketAddress(addr); if (!a) return false; store.set('roamies.bridge', a); }
      token = String(t ?? '').trim() || null; store.set('roamies.pair', token); retry = 0; if (ws) { const old = ws; ws = null; old.close(); } connect();
      return true;
    },
    unpair() { this.pair(null); setLink('off'); },
    ask: (text) => { const t = String(text ?? '').trim(); if (t) sendBrain({ type: 'ask', text: t }); },
    stop: () => { sendBrain({ type: 'stop' }); window.Roamie?.voiceOut?.stop(); },
    canListen: !!Rec,
    listening, listen, stopListening,
  };
  connect();
})();
