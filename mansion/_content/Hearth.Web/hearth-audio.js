// The engine's sound player in the browser (Web 8/10), the Godot addon's SoundPlayer and SoundBank on Web Audio. C# (WebSound) decides
// what plays and how loud (Hearth.View's SoundCues and SoundTable, the player's sound setting and volume); this module only plays a key at
// a gain. A key's recording is loaded once at the start: the Ogg Vorbis file, or its AAC copy (.m4a) where the browser cannot play Ogg
// (Safari); a key without a recording, or whose recording does not decode, plays the synthesized sound, whose samples come from C#
// (Hearth.View's SoundSynth, the Godot addon's recipes). Eight voices are used in turn, as in the Godot view: a ninth sound cuts the oldest.
// Browsers start audio suspended until the player does something, so the first tap, click or key (the splash's Continue among them)
// resumes it. stats() counts what was asked and what played, for a headless browser. Names no game.

const VOICES = 8;

let ctx = null, dotnet = null, base = '', ext = 'ogg', fileQuery = '';   // fileQuery: "?v=" and the release (WebAssets)
const buffers = new Map();        // key -> AudioBuffer (a recording or the synthesized sound)
const loading = new Map();        // key -> Promise
const voices = new Array(VOICES).fill(null);
let next = 0;
const stats = { asked: 0, played: 0, silent: 0, locked: 0, missing: 0, unlocked: false, byKey: {}, last: null, synth: [], files: [] };

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

// Resumes the audio on a gesture (the browser allows it only then); the listeners stay until it is running.
function unlock() {
  const c = context();
  if (!c) return;
  if (c.state !== 'running') c.resume().then(() => { stats.unlocked = c.state === 'running'; }).catch(() => {});
  else stats.unlocked = true;
}

const gestures = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'];

// The player's object gets Synth(key) (the samples as float32 bytes) and UiSound(action). keys: every sound key; files: the keys that
// have a recording, served at url + key + '.ogg' (and '.m4a').
export function start(ref, url, keys, files, query) {
  dotnet = ref;
  base = url.endsWith('/') ? url : url + '/';
  fileQuery = query || '';
  const probe = document.createElement('audio');
  ext = probe.canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'm4a';
  gestures.forEach(g => window.addEventListener(g, unlock, { capture: true, passive: true }));
  document.addEventListener('click', buttonClick, { capture: true });
  if (!context()) { console.error('[ERROR] sound: this browser has no Web Audio'); return; }
  for (const key of keys) load(key, files.includes(key));
}

export function stop() {
  gestures.forEach(g => window.removeEventListener(g, unlock, { capture: true }));
  document.removeEventListener('click', buttonClick, { capture: true });
  dotnet = null;
}

// Every button press clicks (the Godot addon's UiTheme buttons play sounds.json's "button"); C# knows the key and the volume.
function buttonClick(e) {
  const b = e.target instanceof Element ? e.target.closest('button') : null;
  if (!b || b.disabled || !dotnet) return;
  dotnet.invokeMethod('UiSound', b.dataset.sound || 'button');
}

async function fetchDecode(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const data = await r.arrayBuffer();
  return await new Promise((ok, fail) => {
    const p = ctx.decodeAudioData(data, ok, fail);   // the callback form works in older Safari too
    if (p && p.catch) p.catch(fail);
  });
}

// A recording: the browser's format first; Ogg that does not decode tries the AAC copy; if neither does, the synthesized sound (logged once).
function load(key, recorded) {
  if (loading.has(key)) return loading.get(key);
  const job = (async () => {
    if (recorded) {
      for (const e of ext === 'ogg' ? ['ogg', 'm4a'] : ['m4a']) {
        try {
          buffers.set(key, await fetchDecode(`${base}${key}.${e}${fileQuery}`));
          stats.files.push(`${key}.${e}`);
          return;
        }
        catch (err) { if (e === 'm4a' || ext !== 'ogg') console.error(`[ERROR] cannot load sound file ${base}${key}.${e} (${err}); using the synthesized sound`); }
      }
    }
    synth(key);
  })();
  loading.set(key, job);
  return job;
}

function synth(key) {
  if (!dotnet) return;
  const r = dotnet.invokeMethod('Synth', key);
  if (!r || !r.pcm) { stats.missing++; return; }
  const bytes = typeof r.pcm === 'string' ? Uint8Array.from(atob(r.pcm), ch => ch.charCodeAt(0)) : r.pcm;
  const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const b = ctx.createBuffer(1, Math.max(1, samples.length), r.rate);
  b.copyToChannel(samples, 0);
  buffers.set(key, b);
  stats.synth.push(key);
}

// Plays a key at a linear gain (the Godot view's VolumeDb = LinearToDb(gain)). Nothing when the gain is 0 (the sound is off) or the
// browser has not let the audio start yet.
export function play(key, gain) {
  stats.asked++;
  stats.byKey[key] = (stats.byKey[key] || 0) + 1;
  stats.last = { key, gain };
  if (!(gain > 0)) { stats.silent++; return; }
  const c = context();
  if (!c) { stats.locked++; return; }
  if (c.state !== 'running') {
    // the gesture that unlocks the audio (the splash's Continue) has its own click: it plays once the audio is running
    if (navigator.userActivation?.isActive) c.resume().then(() => { if (c.state === 'running') voice(key, gain); }).catch(() => {});
    else stats.locked++;
    return;
  }
  voice(key, gain);
}

function voice(key, gain) {
  const c = ctx;
  const b = buffers.get(key);
  if (!b) {
    if (!loading.has(key)) load(key, false);   // a key the start did not know: synthesized from now on
    stats.missing++;
    return;
  }
  const slot = next++ % VOICES;
  try { voices[slot]?.stop(); } catch { }
  const src = c.createBufferSource(), g = c.createGain();
  src.buffer = b;
  g.gain.value = gain;
  src.connect(g).connect(c.destination);
  src.start();
  voices[slot] = src;
  stats.played++;
}

// What was asked and played so far (and resets the counts when asked to), for a headless browser.
export function soundStats(reset) {
  const out = JSON.parse(JSON.stringify({ ...stats, state: ctx ? ctx.state : 'none', ext, buffers: buffers.size }));
  if (reset) Object.assign(stats, { asked: 0, played: 0, silent: 0, locked: 0, missing: 0, byKey: {}, last: null });
  return out;
}
