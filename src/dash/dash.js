// pocket dashboard: renders /dash/events (SSE) snapshots. No framework.
(function () {
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function time(iso) { return iso ? new Date(iso).toLocaleTimeString() : ''; }
  function n(x) { return Number(x || 0).toLocaleString(); }
  function bar(used, limit) {
    if (!limit) return '<span class="num">' + n(used) + '</span> <span class="muted">/ ?</span>';
    var pct = Math.min(100, Math.round((used / limit) * 100));
    var cls = pct >= 100 ? 'full' : pct >= 80 ? 'hot' : '';
    return '<div class="bar" title="' + n(used) + ' / ' + n(limit) + '"><i class="' + cls + '" style="width:' + pct + '%"></i></div><span class="num muted">' + n(used) + ' / ' + n(limit) + '</span>';
  }

  function render(s) {
    var uv = document.getElementById('unverified');
    $('#now').textContent = 'updated ' + time(s.now);
    var st = $('#status');
    st.textContent = s.degraded ? 'degraded: running on a fallback' : 'normal';
    st.className = 'pill ' + (s.degraded ? 'warn' : 'ok');

    var rows = '', anyUnverified = false;
    Object.keys(s.providers).forEach(function (id) {
      if (!s.providers[id].limits_verified_on && !s.providers[id].paid) anyUnverified = true;
      var p = s.providers[id], l = p.limits || {}, u = p.used;
      var state = p.cooldown_until ? '<span class="pill bad">429 cooldown until ' + time(p.cooldown_until) + '</span>'
        : p.blocked ? '<span class="pill warn">' + esc(p.blocked) + '</span>'
        : p.has_key ? '<span class="pill ok">ready</span>' : '<span class="muted">no key</span>';
      var spend = p.paid ? '<span class="num">$' + (p.spend_usd || 0).toFixed(2) + (p.cap_usd != null ? ' / $' + p.cap_usd : '') + '</span>' : '<span class="muted">free</span>';
      var tok = l.tpd ? bar(u.tpd, l.tpd) : l.tpmonth ? bar(u.tpmonth, l.tpmonth) + ' <span class="muted">(month)</span>' : '<span class="num">' + n(u.tpd) + '</span>';
      rows += '<tr><td><b>' + esc(id) + '</b>' + (p.limits_verified_on || p.paid ? '' : ' <span class="muted" title="limits not verified against provider docs">*</span>') + (p.notice ? ' <span class="pill warn" title="' + esc(p.notice) + '">data use</span>' : '') + '</td>' +
        '<td>' + (p.has_key ? 'yes' : '-') + '</td><td>' + bar(u.rpd, l.rpd) + '</td><td>' + bar(u.rpm, l.rpm) + '</td><td>' + tok + '</td><td>' + spend + '</td>' +
        '<td class="num muted">' + time(p.resets_at) + '</td><td>' + state + '</td></tr>';
    });
    $('#providers tbody').innerHTML = rows || '<tr><td colspan="8" class="muted">no providers in the policy</td></tr>';
    if (uv) uv.hidden = !anyUnverified;

    var ar = '';
    Object.keys(s.agents).forEach(function (a) {
      var x = s.agents[a];
      ar += '<tr><td>' + esc(a) + '</td><td><code>' + esc(x.provider) + '/' + esc(x.model) + '</code></td><td class="num muted">' + time(x.at) + '</td><td>' +
        (x.degraded ? '<span class="pill warn">degraded: ' + esc(x.reason) + '</span>' : '<span class="pill ok">primary</span>') + '</td></tr>';
    });
    $('#agents tbody').innerHTML = ar || '<tr><td colspan="4" class="muted">no requests yet</td></tr>';

    var lr = '';
    (s.failovers || []).forEach(function (e) {
      lr += '<tr><td class="num">' + time(e.ts) + '</td><td>' + esc(e.agent) + '</td><td>' + esc(e.from) + '</td><td>' + (e.to ? esc(e.to) : '<span class="pill bad">nothing</span>') + '</td><td>' + esc(e.reason) + '</td><td class="num">' + (e.latency_ms == null ? '' : e.latency_ms + ' ms') + '</td></tr>';
    });
    $('#log tbody').innerHTML = lr || '<tr><td colspan="6" class="muted">no failovers</td></tr>';
  }

  function connect() {
    var es = new EventSource('/dash/events');
    es.addEventListener('state', function (ev) { render(JSON.parse(ev.data)); });
    es.onerror = function () {
      var st = $('#status');
      st.textContent = 'daemon unreachable';
      st.className = 'pill bad';
    };
  }
  connect();
})();
