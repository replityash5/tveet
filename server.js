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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public-frontend.html'));
});

// Optimized 720p layout scale
const CORNER_R = 24;
const SIDE_PAD = 20;

const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > 30 * 60 * 1000) {
      if (job.tmpDir && fs.existsSync(job.tmpDir)) {
        fs.rmSync(job.tmpDir, { recursive: true, force: true });
      }
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

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

function getBestVideoDetails(data) {
  const media = data.mediaDetails || data.photos;
  if (!media || !media.length) return null;
  const m = media[0];
  if (m.type !== 'video' && m.type !== 'animated_gif') return null;
  const variants = (m.video_info && m.video_info.variants) || [];
  const mp4s = variants.filter(v => v.content_type === 'video/mp4');
  mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  
  return {
    url: mp4s[0] ? mp4s[0].url : null,
    durationMs: m.video_info?.duration_millis || 0
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

async function renderOverlays(tweet, theme, outWidth, overrides = {}) {
  const t = THEMES[theme] || THEMES.dark;
  const templatePath = path.join(__dirname, 'template.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  const name = escapeHtml(overrides.name || tweet.user?.name);
  const handle = escapeHtml(overrides.handle || tweet.user?.screen_name);
  const avatar = tweet.user?.profile_image_url_https || '';
  const initial = ((overrides.name || tweet.user?.name || '?').trim().charAt(0).toUpperCase()) || '?';
  const verified = !!(tweet.user?.is_blue_verified || tweet.user?.verified);
  const text = escapeHtml(overrides.text || tweet.text || tweet.full_text).replace(/\n/g, '<br>');
  const created = tweet.created_at ? new Date(tweet.created_at) : new Date();
  const time = created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = created.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  
  const likes = overrides.likes !== undefined ? formatCompact(overrides.likes) : formatCompact(tweet.favorite_count ?? 0);
  const replies = overrides.replies !== undefined ? formatCompact(overrides.replies) : formatCompact(tweet.conversation_count ?? 0);

  const viewCount = tweet.view_count ?? tweet.ext_views?.r?.ok?.count ?? null;
  const viewsRow = viewCount ? ` &middot; <b>${formatCompact(viewCount)}</b> Views` : '';

  const fill = {
    '{{BG}}': t.bg, '{{TEXT}}': t.text, '{{SUB}}': t.sub, '{{BORDER}}': t.border,
    '{{AVATAR}}': avatar, '{{NAME}}': name, '{{HANDLE}}': handle, '{{INITIAL}}': initial,
    '{{VERIFIED_DISPLAY}}': verified ? 'inline' : 'none',
    '{{TWEET_TEXT}}': text, '{{TIME}}': time, '{{DATE}}': date,
    '{{LIKES}}': likes, '{{REPLIES}}': replies, '{{VIEWS_ROW}}': viewsRow,
    '{{WIDTH}}': String(outWidth), '{{CORNER_R}}': String(CORNER_R), '{{SIDE_PAD}}': String(SIDE_PAD)
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
    await topEl.screenshot({ path: topPath, omitBackground: true });

    const botEl = await page.$('#bottom-block');
    const botBox = await botEl.boundingBox();
    await botEl.screenshot({ path: botPath, omitBackground: true });

    const evenRound = (n) => Math.max(2, Math.round(n / 2) * 2);
    const topHeight = evenRound(topBox.height);
    const botHeight = evenRound(botBox.height);

    return {
      topPath, botPath, tmp,
      topHeight, botHeight, bgColor: t.bg,
    };
  } finally {
    await browser.close();
  }
}

function runFfmpegWithProgress(args, totalDurationMs, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';

    proc.stdout.on('data', data => {
      const str = data.toString();
      const timeMatch = str.match(/out_time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && totalDurationMs > 0) {
        const hours = parseFloat(timeMatch[1]);
        const mins = parseFloat(timeMatch[2]);
        const secs = parseFloat(timeMatch[3]);
        const currentSecs = hours * 3600 + mins * 60 + secs;
        const totalSecs = totalDurationMs / 1000;
        const pct = Math.min(99, Math.max(1, Math.round((currentSecs / totalSecs) * 100)));
        onProgress(pct);
      }
    });

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

app.post('/api/render-video/start', async (req, res) => {
  // Default to 720p width for ultra-fast encoding
  const { tweetUrl, theme = 'dark', width = 720, overrides = {} } = req.body;
  const jobId = Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  const job = {
    id: jobId,
    status: 'rendering',
    progress: 5,
    outPath: null,
    tmpDir: null,
    error: null,
    createdAt: Date.now(),
    clients: []
  };
  jobs.set(jobId, job);

  res.json({ jobId });

  (async () => {
    try {
      const tweet = await fetchTweetData(tweetUrl);
      const videoDetails = getBestVideoDetails(tweet);
      if (!videoDetails || !videoDetails.url) {
        throw new Error('This tweet has no video to composite.');
      }

      job.progress = 15;
      notifyClients(job);

      const overlays = await renderOverlays(tweet, theme, width, overrides);
      job.tmpDir = overlays.tmp;
      const outPath = path.join(overlays.tmp, 'out.mp4');
      const { topHeight, botHeight, bgColor } = overlays;

      job.progress = 25;
      notifyClients(job);

      const vidWidth = width - (SIDE_PAD * 2);
      const topContentHeight = topHeight - CORNER_R;
      const botContentHeight = botHeight - CORNER_R;

      // Streamlining to 3 inputs & 2 overlays + direct audio stream copy
      const args = [
        '-y',
        '-progress', 'pipe:1',
        '-i', videoDetails.url,
        '-loop', '1', '-i', overlays.topPath,
        '-loop', '1', '-i', overlays.botPath,
        '-filter_complex',
        `[0:v]scale=${vidWidth}:-2[vid];` +
        `[vid]pad=${width}:ih+${topContentHeight}+${botContentHeight}:${SIDE_PAD}:${topContentHeight}:color=${bgColor}[padded];` +
        `[padded][1:v]overlay=0:0[s1];` +
        `[s1][2:v]overlay=0:main_h-overlay_h[outv]`,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '26',
        '-c:a', 'copy',
        '-threads', '0',
        '-shortest',
        outPath,
      ];

      await runFfmpegWithProgress(args, videoDetails.durationMs, (pct) => {
        job.progress = Math.min(98, 25 + Math.round((pct * 73) / 100));
        notifyClients(job);
      });

      job.outPath = outPath;
      job.status = 'done';
      job.progress = 100;
      notifyClients(job);
    } catch (err) {
      console.error(`Job ${jobId} failed:`, err);
      job.status = 'error';
      job.error = err.message;
      notifyClients(job);
    }
  })();
});

function notifyClients(job) {
  const data = JSON.stringify({ status: job.status, progress: job.progress, error: job.error });
  job.clients.forEach(res => res.write(`data: ${data}\n\n`));
}

app.get('/api/render-video/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress, error: job.error })}\n\n`);

  job.clients.push(res);

  req.on('close', () => {
    job.clients = job.clients.filter(c => c !== res);
  });
});

app.get('/api/render-video/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'done' || !job.outPath || !fs.existsSync(job.outPath)) {
    return res.status(404).send('Video not found or job expired.');
  }

  res.download(job.outPath, 'tweet-video.mp4');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tweet-video-server listening on ${PORT}`));
