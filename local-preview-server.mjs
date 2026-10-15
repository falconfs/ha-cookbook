import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const cardRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const recipeRoot = resolve(
  process.env.COOKBOOK_RECIPES_DIR || join(cardRoot, '../../recipes-export'),
);
const port = Number(process.env.PORT || 4173);

async function recipes() {
  const ids = await readdir(recipeRoot, { withFileTypes: true });
  return Promise.all(ids.filter(entry => entry.isDirectory()).map(async entry => {
    const recipe = JSON.parse(await readFile(join(recipeRoot, entry.name, 'recipe.json'), 'utf8'));
    return {
      id: recipe.id,
      name: recipe.name,
      recipeCategory: recipe.recipeCategory,
      keywords: recipe.keywords,
      _ha_rating: recipe._ha_rating,
      dateCreated: recipe.dateCreated,
      dateModified: recipe.dateModified,
    };
  }));
}

const tmpImages = new Map(); // token -> { data: Buffer, ext: string }

// In-memory meal plan for the weekly-calendar preview (feature-10). Not
// persisted; a server restart resets it. Mirrors the integration's document
// shape closely enough to exercise the card flow in a real browser.
const BUILTIN_SLOT_IDS = ['meal', 'breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'side'];
const mealPlan = {
  version: 1,
  slots: BUILTIN_SLOT_IDS.map(id => ({ id, kind: 'builtin', enabled: id === 'meal' })),
  entries: [],
};
let mealPlanSeq = 0;

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'slot';
}

function sniffExt(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

async function service(message) {
  const id = message.service_data?.recipe_id;
  if (message.service === 'list_recipes') return { recipes: await recipes() };
  if (message.service === 'get_recipe') {
    return { recipe: JSON.parse(await readFile(join(recipeRoot, String(id), 'recipe.json'), 'utf8')) };
  }
  if (message.service === 'fetch_image_to_tmp') {
    const url = message.service_data?.image_url;
    try {
      const res = await fetch(url);
      if (!res.ok) return { error: `Image download failed (${res.status})` };
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = sniffExt(buffer);
      if (!ext) return { error: 'Unsupported image' };
      const token = 'tmp' + Math.random().toString(36).slice(2);
      tmpImages.set(token, { data: buffer, ext });
      return { ok: true, token, image_ext: ext };
    } catch (error) {
      return { error: `Image download failed: ${error.message}` };
    }
  }
  if (message.service === 'import_recipe_from_url') {
    return importFromUrl(message.service_data?.url);
  }
  if (message.service === 'get_meal_plan') {
    return { plan: mealPlan };
  }
  if (message.service === 'add_meal_plan_entry') {
    const data = message.service_data || {};
    const recipeId = String(data.recipe_id || '');
    const text = String(data.text || '').trim();
    if (!recipeId && !text) return { error: 'A plan entry needs a recipe_id or a text.' };
    mealPlanSeq += 1;
    const entry = {
      id: `e${mealPlanSeq}`,
      date: String(data.date),
      slot_id: String(data.slot_id),
      recipe_id: recipeId,
      text,
    };
    mealPlan.entries.push(entry);
    return { entry };
  }
  if (message.service === 'update_meal_plan_entry') {
    const data = message.service_data || {};
    const entry = mealPlan.entries.find(e => e.id === String(data.entry_id));
    if (!entry) return { error: `Unknown plan entry: ${data.entry_id}` };
    const recipeId = String(data.recipe_id || '');
    const text = String(data.text || '').trim();
    if (!recipeId && !text) return { error: 'A plan entry needs a recipe_id or a text.' };
    entry.date = String(data.date);
    entry.slot_id = String(data.slot_id);
    entry.recipe_id = recipeId;
    entry.text = text;
    return { entry };
  }
  if (message.service === 'delete_meal_plan_entry') {
    const before = mealPlan.entries.length;
    mealPlan.entries = mealPlan.entries.filter(e => e.id !== String(message.service_data?.entry_id));
    return { ok: mealPlan.entries.length !== before };
  }
  if (message.service === 'save_meal_plan_slots') {
    const incoming = Array.isArray(message.service_data?.slots) ? message.service_data.slots : [];
    const seenNames = new Set();
    const normalized = [];
    for (const raw of incoming) {
      if (BUILTIN_SLOT_IDS.includes(raw.id)) {
        normalized.push({ id: raw.id, kind: 'builtin', enabled: Boolean(raw.enabled) });
        continue;
      }
      const name = String(raw.name || '').trim();
      if (!name) return { error: 'Custom slot name must not be empty.' };
      if (seenNames.has(name.toLowerCase())) return { error: `Duplicate slot name: ${name}` };
      seenNames.add(name.toLowerCase());
      normalized.push({ id: raw.id || slugify(name), kind: 'custom', name, enabled: raw.enabled !== false });
    }
    for (const id of BUILTIN_SLOT_IDS) {
      if (!normalized.find(s => s.id === id)) normalized.push({ id, kind: 'builtin', enabled: id === 'meal' });
    }
    const keptIds = new Set(normalized.map(s => s.id));
    const mealActive = normalized.find(s => s.id === 'meal')?.enabled;
    for (const entry of mealPlan.entries) {
      if (!keptIds.has(entry.slot_id)) entry.slot_id = mealActive ? 'meal' : 'unassigned';
    }
    mealPlan.slots = normalized;
    return { plan: mealPlan };
  }
  throw new Error(`Unsupported local service: ${message.service}`);
}

// Local preview only: Node fetches the HTML (no aiohttp), then the real Python
// parser + normalizer produce the v6 draft, so the browser flow is exercised
// against the actual import logic.
async function importFromUrl(url) {
  if (!url) return { error: 'This URL cannot be imported.' };
  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { error: 'The page could not be downloaded.' };
    html = await res.text();
  } catch {
    return { error: 'The page could not be downloaded.' };
  }
  const script = [
    'import sys, json, importlib.util',
    "spec = importlib.util.spec_from_file_location('u', "
      + `${JSON.stringify(join(cardRoot, 'custom_components/cookbook/url_import.py'))})`,
    'u = importlib.util.module_from_spec(spec); spec.loader.exec_module(u)',
    'html = sys.stdin.read()',
    'src = u.extract_jsonld_recipe(html) or u.extract_microdata_recipe(html)',
    'print(json.dumps({"recipe": u.normalize_to_v6(src, source_url=sys.argv[1])}) '
      + 'if src else json.dumps({"error": "No recipe was found on this page."}))',
  ].join('\n');
  return new Promise(resolvePromise => {
    const child = execFile('python3', ['-c', script, url], (error, stdout) => {
      if (error) return resolvePromise({ error: 'The page could not be downloaded.' });
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        resolvePromise({ error: 'Import fehlgeschlagen.' });
      }
    });
    child.stdin.end(html);
  });
}

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url || '/', 'http://localhost').pathname;
    if (requestPath === '/api/local/recipes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(await recipes()));
      return;
    }
    if (requestPath === '/api/local/service' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(await service(JSON.parse(body))));
      return;
    }
    if (requestPath === '/favicon.ico') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const tmpMatch = requestPath.match(/^\/api\/cookbook\/tmp\/([^/]+)$/);
    if (tmpMatch) {
      const entry = tmpImages.get(tmpMatch[1]);
      if (!entry) { response.statusCode = 404; response.end('{"error":"not found"}'); return; }
      response.setHeader('content-type', {
        jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      }[entry.ext] || 'application/octet-stream');
      response.end(entry.data);
      return;
    }
    const imageMatch = requestPath.match(/^\/api\/cookbook\/recipes\/([^/]+)\/image$/);
    if (imageMatch) {
      const imageDir = join(recipeRoot, imageMatch[1]);
      let entries;
      try {
        entries = await readdir(imageDir);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        response.statusCode = 204;
        response.end();
        return;
      }
      const image = entries.find(entry => entry.startsWith('image.'));
      if (!image) {
        response.statusCode = 204;
        response.end();
        return;
      }
      const imagePath = join(imageDir, image);
      response.setHeader('content-type', {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
      }[extname(imagePath)] || 'application/octet-stream');
      response.end(await readFile(imagePath));
      return;
    }
    const path = requestPath === '/' ? '/local-preview.html' : requestPath;
    const file = resolve(cardRoot, `.${path}`);
    if (!file.startsWith(cardRoot)) throw new Error('Invalid path');
    response.setHeader('content-type', {
      '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.webp': 'image/webp',
    }[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});

server.listen(port, () => console.log(`Cookbook local preview: http://localhost:${port}`));
