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

const THEMES = {
  dark: { bg: '#000000', text: '#e7e9ea', sub: '#71767b', border: '#2f3336' },
  dim: { bg: '#15202b', text: '#f7f9f9', sub: '#8b98a5', border: '#38444d' },
  light: { bg: '#ffffff', text: '#0f1419', sub: '#536471', border: '#eff3f4' },
};

// ---- Render the two static overlay images with headless Chrome ----
async function renderOverlays(tweet, theme, outWidth) {
  const t = THEMES[theme] || THEMES.dark;
  const templatePath = path.join(__dirname, 'template.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  const name = escapeHtml(tweet.user?.name);
  const handle = escapeHtml(tweet.user?.screen_name);
  const avatar = tweet.user?.profile_image_url_https || '';
  const verified = !!(tweet.user?.is_blue_verified || tweet.user?.verified);
  const text = escapeHtml(tweet.text || tweet.full_text).replace(/\n/g, '<br>');
  const created = tweet.created_at ? new Date(tweet.created_at) : new Date();
  const time = created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = created.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const likes = (tweet.favorite_count ?? 0).toLocaleString();
  const replies = (tweet.conversation_count ?? 0).toLocaleString();

  const fill = {
    '{{BG}}': t.bg, '{{TEXT}}': t.text, '{{SUB}}': t.sub, '{{BORDER}}': t.border,
    '{{AVATAR}}': avatar, '{{NAME}}': name, '{{HANDLE}}': handle,
    '{{VERIFIED_DISPLAY}}': verified ? 'inline' : 'none',
    '{{TWEET_TEXT}}': text, '{{TIME}}': time, '{{DATE}}': date,
    '{{LIKES}}': likes, '{{REPLIES}}': replies, '{{WIDTH}}': String(outWidth),
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

    const topEl = await page.$('#top-block');
    const topBox = await topEl.boundingBox();
    await topEl.screenshot({ path: topPath });
    const botEl = await page.$('#bottom-block');
    const botBox = await botEl.boundingBox();
    await botEl.screenshot({ path: botPath });

    // boundingBox() returns CSS pixels (not multiplied by deviceScaleFactor).
    // Since the viewport width equals outWidth, scaling the (2x-resolution)
    // screenshot back down to outWidth naturally lands on these CSS heights.
    // Round to even numbers since libx264 requires even output dimensions.
    const evenRound = (n) => Math.max(2, Math.round(n / 2) * 2);
    const topHeight = evenRound(topBox.height);
    const botHeight = evenRound(botBox.height);

    return { topPath, botPath, tmp, topHeight, botHeight };
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

// Lets the front-end auto-fill fields without hitting CORS issues.
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

    const { topHeight, botHeight } = overlays;

    const args = [
      '-y',
      '-i', videoUrl,
      '-loop', '1', '-i', overlays.topPath,
      '-loop', '1', '-i', overlays.botPath,
      '-filter_complex',
      `[0:v]scale=${width}:-2,fps=30[vid];` +
      `[1:v]scale=${width}:${topHeight},fps=30[top];` +
      `[2:v]scale=${width}:${botHeight},fps=30[bot];` +
      `[vid]pad=${width}:ih+${topHeight}+${botHeight}:0:${topHeight}:color=black[padded];` +
      `[padded][top]overlay=0:0[tmp1];` +
      `[tmp1][bot]overlay=0:main_h-overlay_h[outv]`,
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
