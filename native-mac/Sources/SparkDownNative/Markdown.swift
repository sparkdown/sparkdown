import Foundation
import cmark_gfm
import cmark_gfm_extensions

/// GitHub-flavoured markdown -> HTML via cmark-gfm (the C reference parser).
enum Markdown {
    private static let registered: Bool = {
        cmark_gfm_core_extensions_ensure_registered()
        return true
    }()

    static func html(_ source: String) -> String {
        _ = registered
        let opts = CMARK_OPT_DEFAULT | CMARK_OPT_UNSAFE | CMARK_OPT_FOOTNOTES
        guard let parser = cmark_parser_new(opts) else { return "" }
        defer { cmark_parser_free(parser) }
        for name in ["table", "strikethrough", "autolink", "tasklist", "tagfilter"] {
            if let ext = cmark_find_syntax_extension(name) {
                cmark_parser_attach_syntax_extension(parser, ext)
            }
        }
        source.withCString { cmark_parser_feed(parser, $0, strlen($0)) }
        guard let doc = cmark_parser_finish(parser) else { return "" }
        defer { cmark_node_free(doc) }
        guard let out = cmark_render_html(doc, opts, cmark_parser_get_syntax_extensions(parser)) else { return "" }
        defer { free(out) }
        return String(cString: out)
    }

    static let pageTemplate = """
    <!doctype html><html><head><meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 24px 32px 64px; max-width: 860px; }
    h1, h2 { border-bottom: 1px solid rgba(128,128,128,.3); padding-bottom: .3em; }
    code, pre { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    code { background: rgba(128,128,128,.15); padding: .1em .35em; border-radius: 4px; }
    pre { background: rgba(128,128,128,.12); padding: 12px 14px; border-radius: 6px; overflow: auto; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 0; padding: 0 1em; color: rgba(128,128,128,1); border-left: 4px solid rgba(128,128,128,.35); }
    table { border-collapse: collapse; } th, td { border: 1px solid rgba(128,128,128,.35); padding: 4px 10px; }
    img { max-width: 100%; } a { color: #2f81f7; }
    .empty { color: rgba(128,128,128,.9); font-style: italic; }
    </style></head><body><div id="c"></div>
    <script>function sdSet(h){document.getElementById('c').innerHTML=h||'<p class="empty">Nothing to preview</p>';}</script>
    </body></html>
    """
}
