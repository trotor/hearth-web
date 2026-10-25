// The browser's side of the saves and settings (Web 7/10): localStorage, called synchronously from C# (WebStorage), and the page's
// hidden and closing events for the autosave (as the Godot view saves when it loses focus and when it quits).

export function get(key) { return localStorage.getItem(key); }
export function set(key, value) { localStorage.setItem(key, value); }
export function remove(key) { localStorage.removeItem(key); }

export function keys(prefix) {
  const found = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && k.startsWith(prefix)) found.push(k);
  }
  return found.sort();
}

// True when the storage can be written (it throws when blocked).
export function probe() {
  const k = 'hearth:probe';
  localStorage.setItem(k, '1');
  localStorage.removeItem(k);
  return true;
}

let page = null;

// Two tabs of one game would overwrite each other's saves (Web 10/10). Each page that keeps saves claims them under the game's owner key
// with an id of its own; when another tab claims them, the browser tells this one (the storage event fires in every other tab), and this
// page stops saving and says so (PageConflict). Reloading takes them back.
let owner = null, ownerId = null;

export function claim(key) {
  owner = key;
  ownerId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
  window.addEventListener('storage', storage);
  try { localStorage.setItem(key, ownerId); } catch (e) { console.error('[ERROR] owner key', e); }
}

function storage(e) {
  if (!page || !owner || e.key !== owner || e.newValue === null || e.newValue === ownerId) return;
  page.invokeMethod('PageConflict');
}

export function reload() { location.reload(); }

function visibility() {
  if (!page) return;
  page.invokeMethod(document.visibilityState === 'hidden' ? 'PageHidden' : 'PageShown');
}

function closing() {
  if (page) page.invokeMethod('PageClosing');
}

// The page's C# object gets PageHidden, PageShown and PageClosing; synchronous calls, so a save is written before the browser moves on.
export function watch(ref) {
  unwatch();
  page = ref;
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', closing);
  window.addEventListener('keydown', pageKey, { capture: true });
}

export function unwatch() {
  window.removeEventListener('storage', storage);
  owner = null;
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('pagehide', closing);
  window.removeEventListener('keydown', pageKey, { capture: true });
  page = null;
}

// The settings' Fullscreen / Window (the browser asks for a tap first, so it is not remembered between visits).
export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

export function isFullscreen() { return !!document.fullscreenElement; }

// The splash's button that takes Enter (the most recent game's Continue).
export function focus(selector) {
  const el = document.querySelector(selector);
  if (el) el.focus();
}

// The window's size before the canvas starts (the splash's UI unit).
export function windowWidth() { return window.innerWidth; }
export function windowHeight() { return window.innerHeight; }
// The browser's preferred language ("fi-FI"), which picks the game's language until the player chooses one. The page runs without the
// browser's culture data (InvariantGlobalization, Web 9/10), so .NET's CurrentUICulture cannot tell it.
export function language() { return (navigator.languages && navigator.languages[0]) || navigator.language || ''; }

// Keys for the page's own layers (the splash, a notice): Esc, and Enter or Space on "Tap to begin". The house's keys stay in hearth-canvas.js.
function pageKey(e) {
  if (!page || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== 'Escape' && e.key !== 'Enter' && e.key !== ' ') return;
  // handled here, the house's own key listener (hearth-canvas.js) never sees it
  if (page.invokeMethod('PageKey', e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
}

// The page's fonts before the canvas starts (the splash is drawn in them too); the canvas loads them again for itself.
const loaded = new Set();
export async function loadFont(family, url) {
  if (loaded.has(family)) return;
  const face = new FontFace(family, `url(${url})`);
  await face.load();
  document.fonts.add(face);
  loaded.add(family);
}
