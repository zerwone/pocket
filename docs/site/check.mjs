// Fails the deploy if the FAQ structured data and the visible FAQ drift apart,
// or if required SEO tags are missing. Run: node docs/site/check.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const here = new URL('./', import.meta.url);
const pages = ['index.html', ...readdirSync(here, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(new URL(`${d.name}/index.html`, here))).map((d) => `${d.name}/index.html`)];
const errors = [];
const report = [];
for (const page of pages) {
const html = readFileSync(new URL(page, here), 'utf8');
const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
const faq = ld['@graph'].find((n) => n['@type'] === 'FAQPage');
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const visible = [...html.matchAll(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => [strip(m[1]), strip(m[2])]);
if (visible.length !== faq.mainEntity.length) errors.push(`${page}: FAQ count: ${visible.length} visible vs ${faq.mainEntity.length} in JSON-LD`);
faq.mainEntity.forEach((q, i) => {
  const [vq, va] = visible[i] ?? [];
  if (vq !== q.name) errors.push(`${page}: question ${i + 1} differs:\n  visible: ${vq}\n  json-ld: ${q.name}`);
  if (va !== q.acceptedAnswer.text) errors.push(`${page}: answer ${i + 1} differs`);
});
for (const tag of ['<title>', 'name="description"', 'rel="canonical"', 'property="og:title"', 'property="og:image"']) if (!html.includes(tag)) errors.push(`${page}: missing ${tag}`);
const title = html.match(/<title>(.*?)<\/title>/)[1];
const desc = html.match(/name="description" content="(.*?)"/)[1];
if (title.length > 70) errors.push(`${page}: title is ${title.length} chars (keep ≤ 70)`);
if (desc.length > 160) errors.push(`${page}: description is ${desc.length} chars (keep ≤ 160)`);
report.push(`${page}: ${faq.mainEntity.length} FAQ, title ${title.length}, description ${desc.length}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('site ok\n  ' + report.join('\n  '));
