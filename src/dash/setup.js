// pocket setup page. Talks to /setup/api/* (same code as the CLI commands). No framework.
(function () {
  var S = null;
  var $ = function (s) { return document.querySelector(s); };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function api(method, route, body) {
    return fetch('/setup/api/' + route, {
      method: method,
      headers: { 'content-type': 'application/json', 'x-pocket-setup': '1' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return { ok: false, message: 'HTTP ' + r.status }; }); });
  }
  function msg(node, ok, text) { node.className = 'msg ' + (ok ? 'ok' : 'bad'); node.textContent = text || ''; }
  function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = on ? label + '…' : label; }

  // ------------------------------------------------------------ keys
  function providerCard(p) {
    var out = el('div', { class: 'msg' });
    var body = [];
    var head = el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('span', { class: 'title', text: p.label + ' ' }),
        p.has_key ? el('span', { class: 'pill ok', text: p.verified_on ? 'key stored, verified' : 'key stored' }) : null,
        p.has_key && p.in_order ? el('span', { class: 'pill', text: 'in fallback order', style: 'margin-left:6px' }) : null,
        el('div', { class: 'muted', text: p.note }),
      ]),
      p.signup ? el('a', { href: p.signup, target: '_blank', rel: 'noopener', text: 'Get a key ↗' }) : null,
    ]);
    body.push(head);
    if (p.notice) body.push(el('div', { class: 'notice', text: p.notice }));
    if (!p.has_key) {
      var input = el('input', { type: 'password', placeholder: 'paste your ' + p.label + ' key', autocomplete: 'off', spellcheck: 'false' });
      var accept = p.notice && !p.in_order ? el('input', { type: 'checkbox' }) : null;
      var add = el('button', { text: 'Add', on: { click: function () {
        if (!input.value.trim()) return msg(out, false, 'Paste a key first.');
        busy(add, true, 'Checking');
        api('POST', 'keys', { provider: p.id, key: input.value }).then(function (r) {
          input.value = '';
          if (!r.ok) { busy(add, false, 'Add'); return msg(out, false, r.message); }
          var next = accept && accept.checked ? api('POST', 'order', { provider: p.id, on: true }) : Promise.resolve();
          return next.then(function () { msg(out, true, r.message + (r.warnings && r.warnings.length ? '\n' + r.warnings.join('\n') : '')); load(); });
        });
      } } });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') add.click(); });
      body.push(el('div', { class: 'row', style: 'margin-top:10px' }, [el('div', { class: 'grow' }, [input]), add]));
      if (accept) body.push(el('label', { class: 'check' }, [accept, el('span', { text: 'Use it as a fallback (I accept the note above)' })]));
    } else {
      var actions = [];
      if (p.notice) actions.push(el('button', { class: 'ghost', text: p.in_order ? 'Stop using it' : 'Use it as a fallback', on: { click: function () {
        api('POST', 'order', { provider: p.id, on: !p.in_order }).then(function (r) { if (!r.ok) msg(out, false, r.message); load(); });
      } } }));
      actions.push(el('button', { class: 'quiet', text: 'Remove key', on: { click: function () {
        api('DELETE', 'keys/' + p.id).then(function (r) { msg(out, !!r.ok, r.message); load(); });
      } } }));
      body.push(el('div', { class: 'row', style: 'margin-top:10px' }, actions));
    }
    body.push(out);
    return el('div', { class: 'card' }, body);
  }

  // ------------------------------------------------------------ apps
  function appCard(title, sub, attached, target, extra) {
    var out = el('div', { class: 'msg' });
    var opts = (extra && extra.opts) || {};
    var btn = el('button', { class: attached ? 'quiet' : '', text: attached ? 'Disconnect' : 'Connect', on: { click: function () {
      if (!attached && extra && extra.confirm && !window.confirm(extra.confirm)) return;
      busy(btn, true, attached ? 'Disconnecting' : 'Connecting');
      var body = { target: target };
      Object.keys(opts).forEach(function (k) { body[k] = opts[k].checked; });
      api('POST', attached ? 'detach' : 'attach', body).then(function (r) { msg(out, !!r.ok, r.ok ? (attached ? 'Disconnected. ' + (r.message.split('\n').filter(function (l) { return /Restart|restored|leave/i.test(l); }).join(' ')) : 'Connected.') : r.message); load(true); });
    } } });
    if (extra && extra.disabled) btn.disabled = true;
    var kids = [el('div', { class: 'row' }, [el('div', { class: 'grow' }, [
      el('span', { class: 'title', text: title + ' ' }),
      attached ? el('span', { class: 'pill ok', text: 'connected' }) : null,
      el('div', { class: 'muted', text: sub }),
    ]), btn])];
    (extra && extra.below || []).forEach(function (k) { kids.push(k); });
    kids.push(out);
    return el('div', { class: 'card' }, kids);
  }

  function copyable(label, value) {
    var b = el('button', { class: 'quiet', text: 'Copy', on: { click: function () { navigator.clipboard && navigator.clipboard.writeText(value); b.textContent = 'Copied'; } } });
    return el('div', { class: 'row', style: 'margin-top:6px' }, [el('span', { class: 'muted', style: 'min-width:110px', text: label }), el('code', { class: 'grow', style: 'word-break:break-all', text: value }), b]);
  }

  function renderApps(a) {
    var box = $('#apps');
    box.innerHTML = '';
    var c = a.claude, x = a.codex;
    var vs = el('input', { type: 'checkbox' });
    box.appendChild(appCard('Claude Code', c.installed ? 'In a terminal, and in VS Code if you tick the box.' : 'Not found on this computer. Install it first: code.claude.com/docs/en/setup', c.attached, 'claude', {
      disabled: !c.installed && !c.attached,
      opts: c.attached ? {} : { vscode: vs },
      below: [
        c.attached ? el('div', {}, [el('div', { class: 'run' }, ['Run ', el('code', { text: c.run })]), el('div', { class: 'muted', text: 'Plain claude stays on your Claude plan; claude-pocket goes through pocket.' })]) : el('label', { class: 'check' }, [vs, el('span', { text: 'Also use it in the VS Code extension' })]),
      ],
    }));
    box.appendChild(appCard('Codex CLI', x.installed ? 'Adds a pocket profile; plain codex is unchanged.' : 'Not found on this computer. Install it first: npm i -g @openai/codex', x.attached, 'codex', {
      disabled: !x.installed && !x.attached,
      below: x.attached ? [el('div', { class: 'run' }, ['Run ', el('code', { text: x.run })])] : [],
    }));
    var ca = a['codex-app'];
    box.appendChild(appCard('Codex app (desktop)', 'Points the whole Codex app at pocket. Plain codex in a terminal also goes through pocket while this is on. Restart the app after.', ca.attached, 'codex-app', {
      confirm: 'This sets the provider for all of Codex (the app and the terminal) to pocket until you disconnect it. pocket must be running for Codex to work. Continue?',
    }));
    var cd = a['claude-desktop'];
    var cdBelow = [];
    if (cd.attached) {
      var steps = el('ol', { class: 'steps' }, [
        el('li', { text: 'Sign out of Claude Desktop (or open it to the sign-in screen).' }),
        el('li', { text: 'Help → Troubleshooting → Enable Developer Mode.' }),
        el('li', { text: 'Developer → Configure Third-Party Inference…' }),
        el('li', {}, ['Import configuration and pick the file below, ', el('a', { href: '#', on: { click: function (e) { e.preventDefault(); download('claude-desktop-pocket.json', JSON.stringify(cd.config, null, 2)); } }, text: 'downloaded here' }), '. Or set Inference provider to Gateway and paste the values.']),
        el('li', { text: 'Apply Changes → Save & Restart, then pick the third-party option on the sign-in screen.' }),
      ]);
      cdBelow.push(steps, copyable('Gateway URL', cd.base_url), copyable('API key', S.token), el('div', { class: 'muted', style: 'margin-top:8px', text: 'This is Claude Desktop’s separate third-party mode: it does not use your Claude account, and its chats stay on this computer. To go back, choose the Anthropic sign-in on the sign-in screen.' }));
    }
    box.appendChild(appCard('Claude Desktop', 'Runs Desktop’s chats, Cowork and Code on your keys, in its third-party mode.', cd.attached, 'claude-desktop', { below: cdBelow }));
    box.appendChild(el('details', {}, [el('summary', { text: 'Cursor (chat with your own key only)' }), el('div', { class: 'card' }, [
      el('div', { class: 'muted', text: 'Cursor → Settings → Models → OpenAI API Key. Agent and Composer may not go through pocket.' }),
      copyable('Base URL', a.cursor.base_url), copyable('API key', S.token),
    ])]));
  }

  function download(name, text) {
    var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ------------------------------------------------------------ page
  function render() {
    $('#keychain').textContent = S.keychain;
    $('#npx').hidden = !S.npx;
    var free = $('#free'), more = $('#more'), paid = $('#paid');
    free.innerHTML = ''; more.innerHTML = ''; paid.innerHTML = '';
    var keys = 0;
    S.providers.forEach(function (p) {
      if (p.has_key) keys++;
      if (!p.signup) return;
      (p.paid ? paid : p.notice && !p.in_order ? more : free).appendChild(providerCard(p));
    });
    $('#moreWrap').hidden = !more.children.length;
    var st = $('#status');
    var connected = Object.keys(S.apps).filter(function (k) { return S.apps[k].attached; }).length;
    st.textContent = !keys ? 'add a key to start' : !connected ? keys + ' key' + (keys > 1 ? 's' : '') + ', connect an app' : 'ready';
    st.className = 'pill ' + (!keys ? 'warn' : !connected ? 'warn' : 'ok');
    renderApps(S.apps);
  }

  function load(keepMsgs) {
    return api('GET', 'state').then(function (s) {
      if (s && s.ok === false) { $('#status').textContent = s.message; $('#status').className = 'pill bad'; return; }
      S = s;
      if (keepMsgs) {
        var msgs = Array.prototype.map.call(document.querySelectorAll('#apps .msg'), function (m) { return [m.className, m.textContent]; });
        render();
        Array.prototype.forEach.call(document.querySelectorAll('#apps .msg'), function (m, i) { if (msgs[i]) { m.className = msgs[i][0]; m.textContent = msgs[i][1]; } });
      } else render();
    }).catch(function () { $('#status').textContent = 'pocket is not running'; $('#status').className = 'pill bad'; });
  }

  $('#test').addEventListener('click', function () {
    var b = $('#test'), out = $('#testMsg');
    busy(b, true, 'Sending');
    api('POST', 'test').then(function (r) {
      busy(b, false, 'Send test');
      if (!r.ok) return msg(out, false, r.message);
      msg(out, true, 'Answered by ' + r.provider + ' / ' + r.model + ' in ' + r.ms + ' ms: "' + r.text + '"');
    });
  });
  $('#install').addEventListener('click', function () {
    var b = $('#install'), out = $('#installMsg');
    busy(b, true, 'Installing');
    api('POST', 'install').then(function (r) { busy(b, false, 'Install pocket'); msg(out, !!r.ok, r.ok ? r.message + '. Connect your apps now, or reconnect them if you already did.' : r.message); });
  });
  load();
})();
