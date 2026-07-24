# Tweet Video Server

Composites a tweet's header/text/stats onto its real video using ffmpeg
(server-side, not a screen recording). Works for videos of any length —
processing time scales with ffmpeg's encode speed, not real-time playback.

## Files
- `server.js` — the API (Express)
- `template.html` — HTML used by headless Chrome to render the overlay images
- `Dockerfile` — builds an image with Node + Chromium + ffmpeg
- `public-frontend.html` — a simple page to use the deployed server from your phone/browser
- `cloudflare-deploy/` — extra files only needed if you deploy on Cloudflare instead of Render

---

## Step 0 — Get this onto GitHub without git (upload the zip)

1. Create a **new empty repo** on GitHub (don't initialize with a README).
2. Click **Add file → Create new file**. Name it exactly:
   `.github/workflows/unpack-zip.yml`
   Paste in the workflow content below, then **Commit directly to main**.
   (This step must happen first — the workflow has to already exist in the
   repo before a push can trigger it.)

   ```yaml
   name: Unpack uploaded zip

   on:
     push:
       paths:
         - '*.zip'
     workflow_dispatch:

   permissions:
     contents: write

   jobs:
     unpack:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             fetch-depth: 0

         - name: Unzip and restructure
           run: |
             set -e
             ZIPFILE=$(ls *.zip 2>/dev/null | head -n1 || true)
             if [ -z "$ZIPFILE" ]; then
               echo "No .zip file found at repo root — nothing to do."
               exit 0
             fi
             unzip -o "$ZIPFILE" -d .
             TOPDIR=$(unzip -Z1 "$ZIPFILE" | awk -F/ '{print $1}' | sort -u)
             TOPDIR_COUNT=$(echo "$TOPDIR" | wc -l)
             if [ "$TOPDIR_COUNT" -eq 1 ] && [ -d "$TOPDIR" ]; then
               shopt -s dotglob
               mv "$TOPDIR"/* .
               rmdir "$TOPDIR"
             fi
             rm "$ZIPFILE"

         - name: Commit and push
           run: |
             git config user.name "github-actions[bot]"
             git config user.email "github-actions[bot]@users.noreply.github.com"
             git add -A
             git commit -m "Unpack zip and restructure repo [skip ci]" || echo "Nothing to commit"
             git push
   ```

3. **Enable write access for the workflow**: go to repo **Settings → Actions →
   General → Workflow permissions**, select **"Read and write permissions"**,
   Save. (Without this, the Action can't push its commit back.)
4. Click **Add file → Upload files**, drag in `tweet-video-server.zip`
   (the whole zip, unmodified), commit. This push matches `*.zip` and
   triggers the workflow automatically — check the **Actions** tab; within
   ~10 seconds it'll unzip everything to the repo root and delete the zip.

You now have a normal repo with `server.js`, `Dockerfile`, etc. at the root.

---

## Path A — Deploy on Render (simplest, free tier sleeps when idle)

1. Render.com → **New +** → **Web Service** → connect your repo
2. Environment: **Docker**, Instance type: **Free** → Create
3. Wait for the build, grab the URL (e.g. `https://xxxx.onrender.com`)
4. Open `public-frontend.html`, paste that URL in, use it

Free tier sleeps after 15 min idle — first request after sleep takes
~30–50s to wake up, otherwise normal speed.

---

## Path B — Deploy on Cloudflare Containers (no sleep, needs $5/mo plan)

Cloudflare Containers run full Docker images (ffmpeg and Puppeteer both work),
unlike plain Cloudflare Workers which can't run native binaries at all.

1. Requires the **Workers Paid plan** ($5/mo base) — Containers aren't
   available on the free Workers plan.
2. From inside `cloudflare-deploy/`:
   ```
   cd cloudflare-deploy
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
3. `wrangler.jsonc` already sets `autoscaling.minimum_instances: 1` — this
   keeps one container instance permanently warm, so there's no cold start
   and no sleep, ever. You're billed for that instance's actual CPU-seconds
   (Cloudflare now bills by real usage, not by reservation, so an idle
   instance costs very little — but it isn't free).
4. Point `public-frontend.html` at the Worker URL Wrangler prints after deploy.

Cloudflare Containers is a newer product and its exact config field names
have shifted before — if `wrangler deploy` errors on `wrangler.jsonc`,
check the current schema at https://developers.cloudflare.com/containers/
and adjust field names accordingly.

---

## Notes

- `theme` accepts `dark`, `dim`, or `light` — matching X's three real themes.
- Keep `template.html` in sync with the browser tool's CSS if you tweak the design.
- `/api/tweet` (`POST { url }`) returns raw tweet JSON if you want your own front-end.
