"""Spike only: make the app honour WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (wry passes its own
AdditionalBrowserArguments, which wins over the env var on WebView2 154), so WebDriver can attach."""
p = "src-tauri/src/windows.rs"
s = open(p, encoding="utf-8").read()
old = "    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;"
new = """    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    #[cfg(windows)]
    let builder = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(extra) if !extra.is_empty() => builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required {extra}"
        )),
        _ => builder,
    };
    let window = builder.build()?;"""
assert old in s
open(p, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("patched", p)
