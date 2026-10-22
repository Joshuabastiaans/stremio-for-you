// Talks to the Stremio account API (the same API the official apps use).
import { TTLCache } from './cache.js';

const API = 'https://api.strem.io/api';
const libraryCache = new TTLCache(10 * 60 * 1000, 200);

async function call(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Stremio API ${method} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Stremio API ${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

// Moves an installed addon to the front of the account's addon list. Stremio
// orders Board rows by addon order (right after Continue Watching), so this
// puts the addon's rows at the top. `before` is the order of addon ids found.
export async function moveAddonToTop(authKey, addonId) {
  const { addons } = await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  const before = addons.map((a) => a.manifest?.id);
  const index = before.indexOf(addonId);
  if (index > 0) {
    addons.unshift(...addons.splice(index, 1));
    await call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons });
  }
  return { found: index !== -1, moved: index > 0, before };
}

// Returns every library item, including watch-history-only items
// (Stremio keeps those as `temp: true`) and removed ones.
export function getLibrary(authKey) {
  return libraryCache.wrap(authKey, () =>
    call('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true }),
  );
}
