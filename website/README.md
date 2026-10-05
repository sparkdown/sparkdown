# SparkDown website

Marketing landing for SparkDown, served by GitHub Pages at
<https://sparkdown.dev/>. One static page, no build step,
no external fonts, scripts, trackers or CDNs.

## Deploy

`.github/workflows/pages.yml` publishes this folder as-is on every push to
`main` that touches `website/**` (or by manual dispatch). One-time setup:
Settings → Pages → Source: **GitHub Actions**. Custom domain is
`sparkdown.dev` (`website/CNAME`). Assets use relative paths (`assets/...`);
only the canonical, Open Graph and Twitter URLs are absolute.

## Copy rules

- Describe only what ships. Check claims against the root README and the code.
- Plain, specific language: sentence case, active voice, no hype, no
  unverifiable comparisons with other apps.
- Primary CTA: the Download section, then `releases/latest` (never a
  hard-coded tag or a direct DMG link).
- Size: about **4 MB** installed on Mac (4.2 MB `.app`), 3 MB DMG, measured
  with `scripts/package-macos.sh` for 0.3.1. Re-measure when the bundle
  changes.
- Platforms: Apple Silicon, macOS 10.15+ (`tauri.conf.json`
  `minimumSystemVersion`); Linux x86_64 `.deb` and AppImage; Windows is a
  preview (one line in Download, pointing at `docs/windows.md`); AUR
  `sparkdown-bin` is marked **coming** until it is submitted.
- License: free and open source (MIT). No pricing section.

## Colors

The palette is the app's "Silver" themes from
`frontend/src/styles/themes.css` (light Paper, dark Charcoal). Change both
together.

## Screenshots

- `assets/screenshot.png` (1280 × 800, dark theme): the hero fallback when
  JavaScript is off, and the Open Graph / Twitter image. If its size changes,
  update the `width`/`height` attributes on the `<img>` and
  `og:image:width`/`og:image:height`.
- `assets/review.png` (1280 × 352): the Changes queue.
- `assets/diff-reading.png`, `assets/diff-full.png` (993 × 500): the Reading |
  Full toggle.

Each `<img>` hides its figure if the file fails to load (`onerror`).

## Files

- `index.html`: the page (inline CSS and a small inline script for the
  Reading | Full toggle)
- `assets/logo.svg`: bolt mark, also the favicon
- `assets/demo.js`, `assets/demo.css`: the two animated demos (hero view
  modes + terminal grid; the review loop). Mini app windows built from the
  app's dark tokens, each driven by a `{ at, do }` timeline. Keep the copy
  inside them in line with the app (shortcuts, labels, badge rules).

## Checking a demo frame

Debug hook: `?demo=hero&t=5400` (or `demo=loop`) seeks that demo to 5.4 s and
holds it, for headless screenshots. The hero runs 12.6 s, the review loop
20.6 s.

## Preview

`python3 -m http.server 8000 --directory website`, then open
<http://localhost:8000/>.
