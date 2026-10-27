import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import assert from 'node:assert/strict';

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(join(directory, entry.name)) : join(directory, entry.name)));
  return files.flat();
}

const files = await filesIn('dist');
assert.equal((await readFile('dist/robots.txt', 'utf8')).trim(), 'User-agent: *\nDisallow: /');
assert.ok(!files.some(file => /\.(pdf|env)$/i.test(file) || /resume|checklist|review|\.map$/i.test(file)), 'Standalone Aegis must exclude portfolio/private files.');
const pages = new Map(await Promise.all(files.filter((file) => file.endsWith('.html')).map(async (file) => [file, await readFile(file, 'utf8')])));
let checkedLinks = 0;
for (const [file, html] of pages) {
  assert.match(html, /name="robots" content="noindex, nofollow, noarchive"/);
  assert.ok(!/href="(?:undefined|)"/.test(html), 'Hide missing links.');
  assert.ok(!/<(?:iframe|form)\b/.test(html), 'No external embeds or form services.');
  const currentPath = '/' + posix.relative('dist', file);
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const url = new URL(match[1], 'https://portfolio.local' + currentPath);
    if (url.origin !== 'https://portfolio.local') continue;
    const target = 'dist' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname);
    assert.ok(files.includes(target), `Missing link target: ${file} -> ${match[1]}`);
    if (url.hash) {
      const targetHtml = pages.get(target);
      assert.ok(targetHtml, `Anchor points to non-HTML: ${match[1]}`);
      const ids = new Set([...targetHtml.matchAll(/\bid="([^"]+)"/g)].map((item) => item[1]));
      assert.ok(ids.has(decodeURIComponent(url.hash.slice(1))), `Broken anchor: ${file} -> ${match[1]}`);
    }
    checkedLinks++;
  }
}
console.log(`Output checks passed: ${pages.size} pages, ${checkedLinks} local links, noindex, and no portfolio/private assets.`);
