import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const previewRoot = new URL('../../', import.meta.url);

test('preview configures both cards before assigning hass', async () => {
  const html = await readFile(new URL('local-preview.html', previewRoot), 'utf8');
  const cookbookConfig = html.indexOf('card.setConfig(');
  const randomConfig = html.indexOf('randomCard.setConfig(');
  const cookbookHass = html.indexOf('card.hass = hass;');
  const randomHass = html.indexOf('randomCard.hass = hass;');

  assert.ok(cookbookConfig >= 0);
  assert.ok(randomConfig >= 0);
  assert.ok(cookbookConfig < cookbookHass);
  assert.ok(randomConfig < randomHass);
  assert.match(html.slice(randomConfig, randomHass), /duration:\s*'1s'/);
});

test('preview accepts a language override through the lang query parameter', async () => {
  const html = await readFile(new URL('local-preview.html', previewRoot), 'utf8');
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('lang'\)/);
  assert.match(html, /document\.documentElement\.lang = previewLanguage === 'auto' \? 'de' : previewLanguage/);
  assert.equal((html.match(/language: previewLanguage/g) || []).length, 3);
});

test('preview serves missing images and favicon without HTTP errors', async t => {
  const port = 4174;
  const server = execFile('node', ['local-preview-server.mjs'], {
    cwd: previewRoot,
    env: { ...process.env, PORT: String(port) },
  });
  t.after(() => server.kill());

  await new Promise((resolvePromise, reject) => {
    server.stdout.on('data', data => {
      if (data.toString().includes(`localhost:${port}`)) resolvePromise();
    });
    server.once('error', reject);
  });

  const missingImage = await fetch(`http://localhost:${port}/api/cookbook/recipes/missing/image`);
  const favicon = await fetch(`http://localhost:${port}/favicon.ico`);

  assert.ok(missingImage.status < 500);
  assert.ok(favicon.status < 500);
});
