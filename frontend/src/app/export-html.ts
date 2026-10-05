import { escapeHtml } from '../utils';

/**
 * Wrap rendered preview HTML in a standalone document for Export HTML. The
 * inline stylesheet snapshots the current theme's preview colours from the
 * live CSS variables, so the export looks like what the user saw.
 */
export function buildExportHtml(body: string, title: string): string {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;

  const fg = v('--preview-fg', '#1e1e1e');
  const bg = v('--preview-bg', '#ffffff');
  const codeBg = v('--preview-code-bg', '#f6f8fa');
  const codeFg = v('--preview-code-fg', fg);
  const link = v('--preview-link', '#0078d4');
  const tableBorder = v('--preview-table-border', '#d0d7de');
  const tableHeaderBg = v('--preview-table-header-bg', codeBg);
  const blockBorder = v('--preview-blockquote-border', '#d0d7de');
  const blockFg = v('--preview-blockquote-fg', '#57606a');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; line-height: 1.6; color: ${fg}; background: ${bg}; }
    a { color: ${link}; }
    pre { background: ${codeBg}; color: ${codeFg}; padding: 16px; border-radius: 6px; overflow-x: auto; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9em; color: ${codeFg}; }
    img { max-width: 100%; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid ${tableBorder}; padding: 8px 12px; text-align: left; }
    th { background: ${tableHeaderBg}; }
    blockquote { border-left: 4px solid ${blockBorder}; margin: 0; padding: 0 16px; color: ${blockFg}; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}
