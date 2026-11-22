// Writes the guide pages (one search question each) next to index.html, and the sitemap.
// Run after editing: node docs/site/guides.mjs && node docs/site/check.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://zerwone.github.io/pocket/';
const TODAY = '2026-11-22';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const INSTALL = `<pre class="term"><span class="p">$ </span>npm i -g @zerwone/pocket
<span class="p">$ </span>pocket</pre>`;

const guides = [
  {
    slug: 'claude-code-usage-limit',
    title: 'Claude Code usage limit reached? Keep working on your own keys',
    desc: 'What to do when Claude Code says 5-hour limit reached or weekly limit: wait, use an API key, or switch to your next key with pocket. Free, local, open source.',
    h1: 'Claude Code usage limit reached: how to keep working',
    lede: 'When Claude Code stops with a "5-hour limit reached" or "weekly limit" message, you have four options. Here they are, including when pocket is the wrong tool.',
    body: `
<h2>The four options</h2>
<ol>
<li><strong>Wait for the reset.</strong> The message says when. Free, and you keep Claude's best models.</li>
<li><strong>Turn on usage credits or use an Anthropic API key.</strong> Same models, paid per token.</li>
<li><strong>Point Claude Code at one other provider</strong>, for example OpenRouter. Works until that provider's limit too.</li>
<li><strong>Run it through pocket.</strong> pocket tries your keys in order: your paid key first if you have one, then free keys from Groq, NVIDIA and OpenRouter. When one says "limit reached" (HTTP 429), the next one answers, and the session tells you which model is now working.</li>
</ol>
<h2>With a Pro or Max plan</h2>
<p>Keep using plain <code>claude</code> on your plan. When it hits the limit, run <code>claude-pocket</code> in the same project folder. It runs Claude Code on API keys instead of your plan login, so your files carry over but the conversation does not: ask Claude for a short handoff note in <code>CLAUDE.md</code> before you switch.</p>
<h2>Set it up</h2>
${INSTALL}
<p><code>pocket</code> opens a setup page: paste free keys (each has its signup link), click Connect next to Claude Code, then run <code>claude-pocket</code> instead of <code>claude</code>.</p>
<h2>What you give up</h2>
<p>Free models are weaker than Claude's. They handle routine edits and questions; review their work on hard changes. Free keys have limits too: when all of them are spent, the agent stops, as it would without pocket.</p>`,
    faq: [
      ['Why does Claude Code say "5-hour limit reached"?', 'Claude plans give Claude Code a usage allowance per 5-hour session and per week. The message names the reset time. It is a plan limit, not an error in your project.'],
      ['Can Claude Code keep working after the limit?', 'Yes, on API keys: usage credits or an Anthropic API key keep Claude models; pocket can also fall back to free keys from Groq, NVIDIA and OpenRouter, which run weaker open models.'],
      ['Does pocket use my Claude subscription?', 'No. claude-pocket runs Claude Code on API keys you add. Keep using claude on your plan and switch to claude-pocket when the plan is out.'],
    ],
  },
  {
    slug: 'codex-usage-limit',
    title: 'Codex usage limit hit? Switch to your next API key automatically',
    desc: 'When Codex CLI or the Codex app hits its usage limit or a 429, pocket resends the request to your next API key (Groq, NVIDIA, OpenRouter or your own). Free.',
    h1: 'Codex usage limit: keep Codex working on your next key',
    lede: 'Codex stops when your ChatGPT plan or API key runs out. pocket gives Codex a list of keys instead of one, and moves to the next when a provider refuses for quota.',
    body: `
<h2>How it works with Codex</h2>
<ul>
<li><strong>Codex CLI:</strong> pocket adds a <code>pocket</code> profile to <code>~/.codex/config.toml</code> (with a backup). Run <code>codex-pocket</code>; plain <code>codex</code> is unchanged.</li>
<li><strong>Codex app:</strong> one click on the setup page points the whole app at pocket. That includes <code>codex</code> in a terminal while it's on. Disconnect puts your config back byte for byte.</li>
</ul>
<p>pocket speaks the Responses API Codex uses, including <code>apply_patch</code> and MCP tools.</p>
<h2>Set it up</h2>
${INSTALL}
<p>Paste free keys, click Connect next to Codex CLI or Codex app.</p>
<h2>What you give up</h2>
<p>Fallback models are open models, weaker than OpenAI's best. Hosted tools like web search don't carry over to other providers.</p>`,
    faq: [
      ['What do I do when Codex says I hit my usage limit?', 'Wait for the reset, add an OpenAI API key, or run Codex through pocket so it moves to your next key (Groq, NVIDIA, OpenRouter or your own) when one runs out.'],
      ['Does pocket change my normal Codex setup?', 'The CLI option only adds a pocket profile, so plain codex is unchanged. The Codex app option switches all of Codex until you disconnect it, and pocket restores the file exactly.'],
    ],
  },
  {
    slug: 'claude-code-free-models',
    title: 'Use Claude Code with free models: Groq, NVIDIA, OpenRouter',
    desc: 'Run Claude Code on free API keys from Groq, NVIDIA and OpenRouter as a fallback. pocket stores keys in your OS keychain and picks a live model for you.',
    h1: 'Claude Code with free models, as a fallback',
    lede: 'Claude Code can talk to any server that speaks the Anthropic API. pocket is that server on your own machine: it translates to Groq, NVIDIA and OpenRouter, keeps your keys in the OS keychain, and fails over between them.',
    body: `
<h2>Free keys pocket uses by default</h2>
<table><thead><tr><th>Provider</th><th>Free per key</th></tr></thead><tbody>
<tr><td>Groq</td><td>1,000 requests/day</td></tr>
<tr><td>NVIDIA</td><td>~40 requests/min</td></tr>
<tr><td>OpenRouter</td><td>50 requests/day (1,000 after a one-time $10 top-up)</td></tr>
</tbody></table>
<p>Also supported, off until you turn them on because of data or trial terms: Mistral, Google Gemini, Z.ai, Kilo, Cohere, Vercel AI Gateway, Cerebras (trial only). Checked against each provider's docs; the <a href="https://github.com/zerwone/pocket#how-much-free-do-you-get">README</a> has the sources and the providers left out.</p>
<h2>Why not just set ANTHROPIC_BASE_URL to one provider?</h2>
<p>You can. One provider means one limit, and most don't speak the Anthropic API, so tool calls break. pocket translates, retries the next key on a 429, drops models a provider retires, and names the model answering in the session.</p>
<h2>Set it up</h2>
${INSTALL}`,
    faq: [
      ['Is Claude Code free with these models?', 'Claude Code itself is free to install; the models answer on each provider\'s free tier, on your own account. Free open models are weaker than Claude.'],
      ['Which free model is best for Claude Code?', 'It changes as providers update their lists. pocket reads each provider\'s live model list and picks a strong tool-calling model for you; pocket models shows the current pick.'],
    ],
  },
  {
    slug: 'claude-desktop-own-api-keys',
    title: 'Claude Desktop with your own API keys: gateway mode via pocket',
    desc: "Run Claude Desktop's chats, Cowork and Code on your own keys with its third-party gateway mode. pocket is the local gateway and fails over between keys.",
    h1: 'Claude Desktop on your own API keys',
    lede: 'Claude Desktop has a third-party mode that sends inference to a gateway you choose instead of a Claude account. pocket can be that gateway, on your machine.',
    body: `
<h2>How</h2>
<ol>
<li>Run <code>pocket</code> and click Connect next to Claude Desktop. It gives you a file to import.</li>
<li>In Claude Desktop, signed out: Help → Troubleshooting → Enable Developer Mode, then Developer → Configure Third-Party Inference.</li>
<li>Import the file (or set Gateway, the URL and key pocket shows), Apply Changes, restart, and choose the third-party option.</li>
</ol>
<h2>Know before you switch</h2>
<ul>
<li>Third-party mode doesn't use your Claude account; its chats stay on your computer. Go back any time with the Anthropic sign-in.</li>
<li>Without an Anthropic API key in pocket, answers come from free open models, which are weaker than Claude.</li>
<li>This follows <a href="https://claude.com/docs/third-party/claude-desktop/gateway">Anthropic's gateway docs</a>; it is new in pocket 0.3.0. If the app's connection test fails, <a href="https://github.com/zerwone/pocket/issues">open an issue</a>.</li>
</ul>
${INSTALL}`,
    faq: [
      ['Can Claude Desktop use my own API key?', 'Yes, through its third-party inference mode, which needs Developer Mode. Point it at a gateway such as pocket, which sends requests to your Anthropic key or free fallback keys.'],
      ['Does this affect my Claude subscription?', 'No. Third-party mode is separate from your Claude account; switch back with the Anthropic sign-in on the sign-in screen.'],
    ],
  },
];

function page(g) {
  const url = `${BASE}${g.slug}/`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'TechArticle', headline: g.h1, description: g.desc, url, dateModified: TODAY, author: { '@type': 'Person', name: 'Mohamad Aljadaan' }, about: { '@id': `${BASE}#app` } },
      { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'pocket', item: BASE }, { '@type': 'ListItem', position: 2, name: g.h1, item: url }] },
      { '@type': 'FAQPage', mainEntity: g.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
  };
  const others = guides.filter((x) => x !== g).map((x) => `<li><a href="../${x.slug}/">${esc(x.h1)}</a></li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.title)}</title>
<meta name="description" content="${esc(g.desc)}">
<link rel="canonical" href="${url}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="article">
<meta property="og:site_name" content="pocket">
<meta property="og:title" content="${esc(g.title)}">
<meta property="og:description" content="${esc(g.desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${BASE}social.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicon.ico" sizes="48x48">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../style.css">
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="../" aria-label="pocket home">pocket</a>
    <nav aria-label="Main">
      <a href="../#how">How it works</a>
      <a href="../#use">Use it</a>
      <a href="https://github.com/zerwone/pocket">GitHub</a>
    </nav>
  </div>
</header>
<main>
  <article class="wrap guide">
    <p class="small"><a href="../">pocket</a> › guide</p>
    <h1>${esc(g.h1)}</h1>
    <p class="lede">${esc(g.lede)}</p>
${g.body}
    <h2>FAQ</h2>
${g.faq.map(([q, a]) => `    <details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}
    <h2>More guides</h2>
    <ul>
${others}
    </ul>
  </article>
</main>
<footer>
  <div class="wrap">
    <span>Built by Mohamad Aljadaan at <strong>ZerwOne</strong> · MIT</span>
    <span><a href="https://github.com/zerwone/pocket">GitHub</a> · <a href="https://www.npmjs.com/package/@zerwone/pocket">npm</a></span>
  </div>
</footer>
</body>
</html>
`;
}

const here = new URL('./', import.meta.url);
for (const g of guides) {
  if (g.title.length > 70) throw new Error(`${g.slug}: title ${g.title.length} chars`);
  if (g.desc.length > 160) throw new Error(`${g.slug}: description ${g.desc.length} chars`);
  mkdirSync(new URL(`${g.slug}/`, here), { recursive: true });
  writeFileSync(new URL(`${g.slug}/index.html`, here), page(g));
}
const urls = [BASE, ...guides.map((g) => `${BASE}${g.slug}/`)];
writeFileSync(new URL('sitemap.xml', here), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod></url>`).join('\n')}\n</urlset>\n`);
export { guides };
console.log(`wrote ${guides.length} guides and sitemap.xml`);
