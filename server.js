import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

// Serve the frontend directly from this server (same-origin — avoids
// file:// / content:// CORS and network-request restrictions in mobile browsers).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-frontend.html'));
});

const CORNER_R = 28; // px radius for the rounded video corners

// ---- Tweet fetching (server-side = no CORS problems at all) ----
function getToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function extractTweetId(url) {
  const m = String(url).match(/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchTweetData(url) {
  const id = extractTweetId(url);
  if (!id) throw new Error('Could not find a tweet ID in that URL');
  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${getToken(id)}&lang=en`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`Twitter syndication endpoint returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.__typename === 'TweetTombstone' || data.errors) {
    throw new Error('Tweet unavailable (deleted, protected, or age-restricted)');
  }
  return data;
}

function getBestVideoUrl(data) {
  const media = data.mediaDetails || data.photos;
  if (!media || !media.length) return null;
  const m = media[0];
  if (m.type !== 'video' && m.type !== 'animated_gif') return null;
  const variants = (m.video_info && m.video_info.variants) || [];
  const mp4s = variants.filter(v => v.content_type === 'video/mp4');
  mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4s[0] ? mp4s[0].url : null;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Twitter-style abbreviated counts: 2302 -> "2.3K", 43200 -> "43.2K"
function formatCompact(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

const THEMES = {
  dark: { bg: '#000000', text: '#e7e9ea', sub: '#71767b', border: '#2f3336' },
  dim: { bg: '#15202b', text: '#f7f9f9', sub: '#8b98a5', border: '#38444d' },
  light: { bg: '#ffffff', text: '#0f1419', sub: '#536471', border: '#eff3f4' },
};

// ---- Render the overlay images (top text block, bottom stats block, and
// 4 tiny rounded-corner masks) with headless Chrome ----
async function renderOverlays(tweet, theme, outWidth) {
  const t = THEMES[theme] || THEMES.dark;
  const templatePath = path.join(__dirname, 'template.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  const name = escapeHtml(tweet.user?.name);
  const handle = escapeHtml(tweet.user?.screen_name);
  const avatar = tweet.user?.profile_image_url_https || '';
  const initial = (tweet.user?.name || '?').trim().charAt(0).toUpperCase() || '?';
  const verified = !!(tweet.user?.is_blue_verified || tweet.user?.verified);
  const text = escapeHtml(tweet.text || tweet.full_text).replace(/\n/g, '<br>');
  const created = tweet.created_at ? new Date(tweet.created_at) : new Date();
  const time = created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = created.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const likes = formatCompact(tweet.favorite_count ?? 0);
  const replies = formatCompact(tweet.conversation_count ?? 0);

  // View counts aren't reliably exposed by the syndication endpoint — show
  // them only if present, rather than guessing or faking a number.
  const viewCount = tweet.view_count ?? tweet.ext_views?.r?.ok?.count ?? null;
  const viewsRow = viewCount ? ` &middot; <b>${formatCompact(viewCount)}</b> Views` : '';

  const fill = {
    '{{BG}}': t.bg, '{{TEXT}}': t.text, '{{SUB}}': t.sub, '{{BORDER}}': t.border,
    '{{AVATAR}}': avatar, '{{NAME}}': name, '{{HANDLE}}': handle, '{{INITIAL}}': initial,
    '{{VERIFIED_DISPLAY}}': verified ? 'inline' : 'none',
    '{{TWEET_TEXT}}': text, '{{TIME}}': time, '{{DATE}}': date,
    '{{LIKES}}': likes, '{{REPLIES}}': replies, '{{VIEWS_ROW}}': viewsRow,
    '{{WIDTH}}': String(outWidth), '{{CORNER_R}}': String(CORNER_R),
  };
  for (const [k, v] of Object.entries(fill)) {
    html = html.split(k).join(v);
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: outWidth, height: 1400, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-'));
    const topPath = path.join(tmp, 'top.png');
    const botPath = path.join(tmp, 'bot.png');
    const ctlPath = path.join(tmp, 'ctl.png');
    const ctrPath = path.join(tmp, 'ctr.png');
    const cblPath = path.join(tmp, 'cbl.png');
    const cbrPath = path.join(tmp, 'cbr.png');

    const topEl = await page.$('#top-block');
    const topBox = await topEl.boundingBox();
    await topEl.screenshot({ path: topPath });
    const botEl = await page.$('#bottom-block');
    const botBox = await botEl.boundingBox();
    await botEl.screenshot({ path: botPath });

    await (await page.$('#corner-tl')).screenshot({ path: ctlPath });
    await (await page.$('#corner-tr')).screenshot({ path: ctrPath });
    await (await page.$('#corner-bl')).screenshot({ path: cblPath });
    await (await page.$('#corner-br')).screenshot({ path: cbrPath });

    // boundingBox() returns CSS pixels (not multiplied by deviceScaleFactor).
    // Since the viewport width equals outWidth, scaling the (2x-resolution)
    // screenshot back down to outWidth naturally lands on these CSS heights.
    // Round to even numbers since libx264 requires even output dimensions.
    const evenRound = (n) => Math.max(2, Math.round(n / 2) * 2);
    const topHeight = evenRound(topBox.height);
    const botHeight = evenRound(botBox.height);

    return {
      topPath, botPath, ctlPath, ctrPath, cblPath, cbrPath, tmp,
      topHeight, botHeight, bgColor: t.bg,
    };
  } finally {
    await browser.close();
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg failed: ' + stderr.slice(-2000)));
    });
    proc.on('error', reject);
  });
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/tweet', async (req, res) => {
  try {
    const data = await fetchTweetData(req.body.url);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/render-video', async (req, res) => {
  const { tweetUrl, theme = 'dark', width = 1080 } = req.body;
  let tmp;
  try {
    const tweet = await fetchTweetData(tweetUrl);
    const videoUrl = getBestVideoUrl(tweet);
    if (!videoUrl) {
      return res.status(400).json({ error: 'This tweet has no video to composite.' });
    }

    const overlays = await renderOverlays(tweet, theme, width);
    tmp = overlays.tmp;
    const outPath = path.join(tmp, 'out.mp4');
    const { topHeight, botHeight, bgColor } = overlays;

    const args = [
      '-y',
      '-i', videoUrl,
      '-loop', '1', '-i', overlays.topPath,
      '-loop', '1', '-i', overlays.botPath,
      '-loop', '1', '-i', overlays.ctlPath,
      '-loop', '1', '-i', overlays.ctrPath,
      '-loop', '1', '-i', overlays.cblPath,
      '-loop', '1', '-i', overlays.cbrPath,
      '-filter_complex',
      `[0:v]scale=${width}:-2,fps=30[vid];` +
      `[1:v]scale=${width}:${topHeight},fps=30[top];` +
      `[2:v]scale=${width}:${botHeight},fps=30[bot];` +
      `[3:v]scale=${CORNER_R}:${CORNER_R}[ctl];` +
      `[4:v]scale=${CORNER_R}:${CORNER_R}[ctr];` +
      `[5:v]scale=${CORNER_R}:${CORNER_R}[cbl];` +
      `[6:v]scale=${CORNER_R}:${CORNER_R}[cbr];` +
      `[vid]pad=${width}:ih+${topHeight}+${botHeight}:0:${topHeight}:color=${bgColor}[padded];` +
      `[padded][top]overlay=0:0[s1];` +
      `[s1][bot]overlay=0:main_h-overlay_h[s2];` +
      `[s2][ctl]overlay=0:${topHeight}[s3];` +
      `[s3][ctr]overlay=W-w:${topHeight}[s4];` +
      `[s4][cbl]overlay=0:H-${botHeight}-h[s5];` +
      `[s5][cbr]overlay=W-w:H-${botHeight}-h[outv]`,
      '-map', '[outv]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-pix_fmt', 'yuv420p',
      '-threads', '1',
      '-shortest',
      outPath,
    ];
    await runFfmpeg(args);

    res.download(outPath, 'tweet-video.mp4', (err) => {
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      if (err) console.error('Download stream error:', err);
    });
  } catch (err) {
    if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tweet-video-server listening on ${PORT}`));
