// Rádio AutoDJ compatível com Shoutcast/ICY - zero dependências
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8000;
const STATION = process.env.STATION_NAME || 'Minha Rádio AutoDJ';
const GENRE = process.env.STATION_GENRE || 'Variado';
const MUSIC_DIR = path.join(__dirname, 'music');
const METAINT = 16000;

const clients = new Set();
let current = { title: 'Iniciando...', file: null, startedAt: Date.now() };

if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ---------- MP3 helpers ----------
const BR_V1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const BR_V2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];

function analyze(buf) {
  let start = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = (buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f);
    start = 10 + size;
  }
  let end = buf.length;
  if (end > 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;

  let kbps = 128;
  const limit = Math.min(end - 4, start + 50000);
  for (let i = start; i < limit; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const ver = (buf[i + 1] >> 3) & 3;     // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layer = (buf[i + 1] >> 1) & 3;   // 1 = Layer III
      const br = buf[i + 2] >> 4;
      if (ver !== 1 && layer === 1 && br > 0 && br < 15) {
        kbps = ver === 3 ? BR_V1[br] : BR_V2[br];
        break;
      }
    }
  }
  return { start, end, kbps };
}

function listTracks() {
  try {
    return fs.readdirSync(MUSIC_DIR)
      .filter(f => f.toLowerCase().endsWith('.mp3'))
      .map(f => path.join(MUSIC_DIR, f));
  } catch { return []; }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Envio para ouvintes ----------
function metaBlock(c) {
  if (c.lastTitle === current.title) return Buffer.from([0]);
  c.lastTitle = current.title;
  const text = `StreamTitle='${current.title.replace(/'/g, '')}';`;
  const b = Buffer.from(text, 'utf8').subarray(0, 4080);
  const len = Math.ceil(b.length / 16);
  const out = Buffer.alloc(1 + len * 16);
  out[0] = len;
  b.copy(out, 1);
  return out;
}

function sendTo(c, data) {
  if (!c.wantMeta) { c.res.write(data); return; }
  let off = 0;
  while (off < data.length) {
    const n = Math.min(METAINT - c.count, data.length - off);
    c.res.write(data.subarray(off, off + n));
    c.count += n;
    off += n;
    if (c.count === METAINT) { c.res.write(metaBlock(c)); c.count = 0; }
  }
}

function broadcast(data) {
  for (const c of clients) {
    if (c.res.writableLength > 1_000_000) { c.res.destroy(); clients.delete(c); continue; }
    try { sendTo(c, data); } catch { clients.delete(c); }
  }
}

// ---------- AutoDJ ----------
async function playTrack(file) {
  const buf = fs.readFileSync(file);
  const { start, end, kbps } = analyze(buf);
  const bytesPerSec = kbps * 125;
  const chunk = Math.floor(bytesPerSec * 0.1);

  current = {
    title: path.basename(file, path.extname(file)).replace(/_/g, ' '),
    file: path.basename(file),
    startedAt: Date.now(),
  };
  console.log(`▶ ${current.title} (${kbps} kbps)`);

  const t0 = Date.now();
  let pos = start, sent = 0;
  while (pos < end) {
    const n = Math.min(chunk, end - pos);
    broadcast(buf.subarray(pos, pos + n));
    pos += n; sent += n;
    // mantém ~500ms à frente do tempo real (buffer para os players)
    const wait = t0 + (sent / bytesPerSec) * 1000 - Date.now() - 500;
    if (wait > 0) await sleep(wait);
  }
}

async function autoDJ() {
  let last = null;
  for (;;) {
    let tracks = listTracks();
    if (!tracks.length) {
      current.title = 'Sem músicas na pasta /music';
      await sleep(5000);
      continue;
    }
    tracks = shuffle(tracks);
    if (tracks.length > 1 && tracks[0] === last) tracks.push(tracks.shift());
    for (const f of tracks) {
      if (!fs.existsSync(f)) continue;
      try { await playTrack(f); } catch (e) { console.error('Erro:', e.message); await sleep(1000); }
      last = f;
    }
  }
}

// ---------- HTTP ----------
const PLAYER = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${STATION}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f6;--fg:#1a1a1f;--card:#fff;--mut:#6b6b76}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--fg:#f0f0f4;--card:#1c1c22;--mut:#9a9aa6}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}
.card{background:var(--card);padding:32px;border-radius:16px;max-width:420px;width:90%;text-align:center;box-shadow:0 4px 24px #0002}
h1{margin:0 0 4px;font-size:1.4rem}.mut{color:var(--mut);font-size:.9rem}
#np{font-size:1.1rem;margin:20px 0;min-height:2.6em}audio{width:100%}
</style></head><body><div class="card">
<h1>${STATION}</h1><div class="mut">${GENRE}</div>
<div id="np">Carregando...</div>
<audio controls src="/stream"></audio>
<p class="mut" id="l"></p>
<p class="mut">Stream: <code>/stream</code></p>
</div>
<script>
async function u(){try{const r=await fetch('/now');const d=await r.json();
document.getElementById('np').textContent='♪ '+d.title;
document.getElementById('l').textContent=d.listeners+' ouvinte(s)'}catch(e){}}
u();setInterval(u,5000);
</script></body></html>`;

http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/stream' || url === '/;' || url === '/;stream.mp3' || url === '/listen.mp3') {
    const wantMeta = req.headers['icy-metadata'] === '1';
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'close',
      'icy-name': STATION,
      'icy-genre': GENRE,
      'icy-pub': '0',
      'Access-Control-Allow-Origin': '*',
    };
    if (wantMeta) headers['icy-metaint'] = String(METAINT);
    res.writeHead(200, headers);
    const c = { res, wantMeta, count: 0, lastTitle: null };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return;
  }

  if (url === '/now') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ title: current.title, listeners: clients.size, station: STATION }));
  }

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PLAYER);
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`📻 ${STATION} no ar na porta ${PORT}`);
  console.log(`   Coloque seus .mp3 na pasta /music`);
});

autoDJ();
