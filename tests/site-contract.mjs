import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "site");
const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
const css = fs.readFileSync(path.join(site, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(site, "main.js"), "utf8");
const pages = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");

for (const required of ["index.html", "styles.css", "main.js", "favicon.svg", ".nojekyll"]) {
  assert.ok(fs.existsSync(path.join(site, required)), `site/${required} must exist`);
}

assert.match(html, /<link rel="canonical" href="https:\/\/guojiz\.github\.io\/FastCUA\/">/);
assert.match(html, /irm https:\/\/raw\.githubusercontent\.com\/Guojiz\/FastCUA\/main\/install\.ps1 \| iex/);
assert.match(html, /data-set-language="en"/);
assert.match(html, /data-set-language="zh"/);
assert.match(html, /data-demo-step="uia"/);
assert.match(html, /data-demo-step="grid"/);
assert.match(html, /data-demo-step="act"/);
assert.match(html, /recorded screen content, interaction evidence, and narration/);
assert.match(html, /录制的屏幕内容、操作证据和旁白/);
assert.doesNotMatch(html, /npm (?:install|publish)|fastcua\.mjs/i);

assert.match(css, /:focus-visible/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /@media \(max-width: 580px\)/);
assert.match(js, /navigator\.clipboard/);
assert.match(js, /IntersectionObserver/);
assert.match(js, /aria-pressed/);

const assetPattern = /(?:href|src)="([^"]+)"/g;
for (const match of html.matchAll(assetPattern)) {
  const reference = match[1];
  if (/^(?:https?:|#|mailto:|data:)/.test(reference)) continue;
  const clean = reference.split(/[?#]/, 1)[0];
  const resolved = path.resolve(site, clean);
  assert.ok(resolved.startsWith(site + path.sep), `${reference} must stay inside site/`);
  assert.ok(fs.existsSync(resolved), `${reference} must resolve inside site/`);
}

assert.match(pages, /actions\/configure-pages@v5/);
assert.match(pages, /actions\/upload-pages-artifact@v4/);
assert.match(pages, /actions\/deploy-pages@v4/);
assert.match(pages, /path: site/);
assert.ok(fs.existsSync(path.join(root, "web.html")), "runtime control center must remain separate");

console.log("PASS site contract: local source, bilingual content, targeting demo, accessible motion, valid assets, and Pages deployment");
