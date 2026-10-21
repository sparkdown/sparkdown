use tauri::{
    menu::{
        AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder,
        SubmenuBuilder,
    },
    AppHandle, Wry,
};

/// The built menu plus the "Allow JavaScript in HTML Preview" check item, kept
/// so its checkmark can be synced when the toggle is flipped from the preview's
/// floating button (not just the menu).
pub struct AppMenu {
    pub menu: tauri::menu::Menu<Wry>,
    /// The Window submenu; its window list is rebuilt by lifecycle.rs.
    pub window_menu: tauri::menu::Submenu<Wry>,
    pub allow_html_js: CheckMenuItem<Wry>,
    /// File > Close Folder (#127), enabled per focused window.
    pub close_folder: tauri::menu::MenuItem<Wry>,
}

/// File > Close Folder, managed so lifecycle.rs can grey it out (#127).
pub struct CloseFolderItem(pub tauri::menu::MenuItem<Wry>);

/// Handle to the app menu so Windows/Linux can pop it up from the toolbar
/// icon instead of showing a permanent in-window menu bar.
pub struct AppMenuHandle(pub tauri::menu::Menu<Wry>);

/// What SparkDown > About shows (#120): name, version, website and license.
pub(crate) fn about_metadata(
    name: &str,
    version: &str,
    copyright: Option<String>,
    icon: Option<tauri::image::Image<'static>>,
) -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some(name.to_string()),
        version: Some(version.to_string()),
        comments: Some("Read every change your agent makes.".into()),
        copyright,
        license: Some("MIT".into()),
        website: Some("https://sparkdown.dev".into()),
        website_label: Some("sparkdown.dev".into()),
        icon,
        ..Default::default()
    }
}

pub fn build_menu(app: &AppHandle) -> Result<AppMenu, tauri::Error> {
    // Use the PREDEFINED Quit item (not a custom one). A custom item that
    // hijacks Cmd+Q disrupts AppKit's applicationShouldTerminate flow, so
    // dock-icon Quit then terminates directly (RunEvent::Exit, unpreventable)
    // without ever firing ExitRequested. The predefined quit keeps the normal
    // terminate path, so BOTH Cmd+Q and dock Quit surface as a preventable
    // ExitRequested that we route through the unsaved-changes guard (main.rs).
    // Settings under the app menu with the standard macOS Cmd+, accelerator.
    let settings = MenuItemBuilder::with_id("show-settings", "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // macOS: under the app menu (platform convention). Elsewhere: Help menu.
    let check_updates =
        MenuItemBuilder::with_id("check-updates", "Check for Updates...").build(app)?;

    // #120: muda's About with no metadata does nothing on GTK and Windows
    // (only macOS fills the panel from the bundle), so always pass it.
    let pkg = app.package_info();
    let about = about_metadata(
        &pkg.name,
        &pkg.version.to_string(),
        app.config().bundle.copyright.clone(),
        app.default_window_icon().map(|i| i.clone().to_owned()),
    );
    let app_menu = SubmenuBuilder::new(app, "SparkDown").about(Some(about));
    #[cfg(target_os = "macos")]
    let app_menu = app_menu.item(&check_updates);
    let app_menu = app_menu
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_file = MenuItemBuilder::with_id("new-file", "New File")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_tab = MenuItemBuilder::with_id("new-tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    // Open Folder is the cockpit primary (welcome screen). Keep Open Remote
    // immediately beside it so both macOS menu bar and Win/Linux brand-icon
    // popup expose the same pair. Open... remains the single-file picker.
    let open_folder = MenuItemBuilder::with_id("open-folder", "Open Folder...")
        .accelerator("CmdOrCtrl+Alt+O")
        .build(app)?;
    let open_remote = MenuItemBuilder::with_id("open-remote", "Open Remote Folder...")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let open_file = MenuItemBuilder::with_id("open-file", "Open...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let save = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let save_as = MenuItemBuilder::with_id("save-as", "Save As...")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let export_html = MenuItemBuilder::with_id("export-html", "Export HTML...").build(app)?;
    let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    // #128: New Window sits with the folder items and shows its shortcut.
    // The accelerator lives here only (not also on Window > New Window), so
    // one key never maps to two items; both ids open an empty window.
    let file_new_window = MenuItemBuilder::with_id(
        format!("{}-file", crate::lifecycle::NEW_WINDOW_ID),
        "New Window",
    )
    .accelerator("CmdOrCtrl+Shift+N")
    .build(app)?;
    // #127: closes this window's folder and leaves the window empty. Greyed
    // out until the focused window has a folder (lifecycle.rs).
    let close_folder = MenuItemBuilder::with_id("close-folder", "Close Folder")
        .enabled(false)
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_file)
        .item(&new_tab)
        .separator()
        .item(&file_new_window)
        .item(&open_folder)
        .item(&open_remote)
        .item(&open_file)
        .item(&close_folder)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&export_html)
        .separator()
        .item(&close_tab)
        .build()?;

    let find = MenuItemBuilder::with_id("find", "Find...")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;

    // Cmd+P / Cmd+Shift+P open the one palette overlay (palette.ts): files
    // by default, commands with the `>` prefix. Toggle Preview gave up
    // Cmd+Shift+P for it (the view control's Cmd+1..4 replaces it).
    let quick_open = MenuItemBuilder::with_id("quick-open", "Go to File...")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let command_palette = MenuItemBuilder::with_id("command-palette", "Command Palette...")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
    // One view per document (the title bar's Edit | Split | Preview | Diff
    // control). Cmd/Ctrl+1–4 match the control's order. The frontend
    // ignores a view the active file can't show (e.g. Preview for a .rs
    // file, Diff for a file without git changes). These replace the old
    // Toggle Preview / Toggle Editor items.
    let view_edit = MenuItemBuilder::with_id("view-edit", "Edit Only")
        .accelerator("CmdOrCtrl+1")
        .build(app)?;
    let view_split = MenuItemBuilder::with_id("view-split", "Edit and Preview")
        .accelerator("CmdOrCtrl+2")
        .build(app)?;
    let view_preview = MenuItemBuilder::with_id("view-preview", "Preview Only")
        .accelerator("CmdOrCtrl+3")
        .build(app)?;
    let view_diff = MenuItemBuilder::with_id("view-diff", "Changes in This File (Diff)")
        .accelerator("CmdOrCtrl+4")
        .build(app)?;
    // Activity bar views (phase 1). Native accelerators so they fire while the
    // terminal has focus too. Shift+Cmd+G replaces CodeMirror's "find previous"
    // (Shift+Enter / Shift+F3 in the find widget still do that).
    let show_files = MenuItemBuilder::with_id("show-files", "Files")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let show_changes = MenuItemBuilder::with_id("show-changes", "Changes")
        .accelerator("CmdOrCtrl+Shift+G")
        .build(app)?;
    let search_files = MenuItemBuilder::with_id("search-in-files", "Search in Files")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    // Native menu (not a JS keybinding) so it fires even when the embedded
    // terminal has keyboard focus and swallows keystrokes. Ctrl+` matches the
    // convention used by VS Code and other editors for the terminal toggle.
    let toggle_terminal = MenuItemBuilder::with_id("toggle-terminal", "Toggle Terminal")
        .accelerator("Ctrl+`")
        .build(app)?;
    // Native menu so it fires when the embedded terminal has focus (same
    // reason as Toggle Terminal). Ctrl+Shift+` maximizes the terminal into
    // the center column; toggle again to restore editor+preview.
    let toggle_terminals_only = MenuItemBuilder::with_id("toggle-terminals-only", "Terminals Only")
        .accelerator("Ctrl+Shift+`")
        .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+Shift+B")
        .build(app)?;
    let toggle_word_wrap = MenuItemBuilder::with_id("toggle-word-wrap", "Toggle Word Wrap")
        .accelerator("Alt+Z")
        .build(app)?;
    let toggle_theme = MenuItemBuilder::with_id("toggle-theme", "Toggle Theme").build(app)?;

    // Off by default each launch — enabling lets previewed HTML run scripts.
    let allow_html_js =
        CheckMenuItemBuilder::with_id("toggle-html-js", "Allow JavaScript in HTML Preview")
            .checked(false)
            .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&command_palette)
        .item(&quick_open)
        .separator()
        .item(&view_edit)
        .item(&view_split)
        .item(&view_preview)
        .item(&view_diff)
        .separator()
        .item(&show_files)
        .item(&show_changes)
        .item(&search_files)
        .item(&toggle_sidebar)
        .item(&toggle_terminal)
        .item(&toggle_terminals_only)
        .separator()
        .item(&toggle_word_wrap)
        .item(&toggle_theme)
        .separator()
        .item(&allow_html_js)
        .build()?;

    // Terminal split grid. No accelerators here on purpose: ⌘D / ⌘⇧D and
    // ⌘[ / ⌘] act only while a terminal pane has focus (handled in the
    // terminal, see frontend/src/shortcuts.ts `terminalPaneAction`), so the
    // editor keeps ⌘D (select next occurrence) and ⌘[ / ⌘] (indent). Close
    // pane is ⌘W with a terminal focused, routed from File → Close Tab.
    let terminal_menu = SubmenuBuilder::new(app, "Terminal")
        .item(&MenuItemBuilder::with_id("terminal-split-right", "Split Right").build(app)?)
        .item(&MenuItemBuilder::with_id("terminal-split-down", "Split Down").build(app)?)
        .item(&MenuItemBuilder::with_id("terminal-close-pane", "Close Pane").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("terminal-focus-next", "Focus Next Pane").build(app)?)
        .item(&MenuItemBuilder::with_id("terminal-focus-prev", "Focus Previous Pane").build(app)?)
        .build()?;

    // Multi-window (#65): New Window, then the open windows (appended by
    // lifecycle::refresh after the last separator).
    let new_window =
        MenuItemBuilder::with_id(crate::lifecycle::NEW_WINDOW_ID, "New Window").build(app)?;
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&new_window)
        .separator()
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .separator()
        .build()?;

    // NOTE: macOS reserves Cmd+? (Cmd+Shift+/) for the Help menu's search
    // field, so a menu item with that accelerator under a "Help" submenu is
    // shadowed by the OS and never fires. Use Cmd+Shift+H, which is not
    // system-reserved. Cmd+? still opens the dialog via the JS shortcut
    // handler (and is forwarded out of the preview iframe); this menu item
    // adds a discoverable, always-available entry point with its own key.
    let shortcuts = MenuItemBuilder::with_id("show-shortcuts", "Keyboard Shortcuts")
        .accelerator("CmdOrCtrl+Shift+H")
        .build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&shortcuts);
    #[cfg(not(target_os = "macos"))]
    let help_menu = help_menu.separator().item(&check_updates);
    let help_menu = help_menu.build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&terminal_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok(AppMenu {
        menu,
        window_menu,
        allow_html_js,
        close_folder,
    })
}

#[cfg(test)]
mod tests {
    /// The frontend's MENU table (event-names.ts) mirrors the ids here: the
    /// menu handler emits `menu:<id>`. Every `menu:` event it listens to
    /// must have an item, or that action is unreachable from the menus
    /// (the title bar no longer has buttons for New / Open / Save / theme /
    /// wrap / sidebar, so the menu is where they live).
    #[test]
    fn every_frontend_menu_event_has_a_menu_item() {
        let rust = include_str!("menu.rs");
        let ts = include_str!("../../frontend/src/event-names.ts");
        let menu_block = ts
            .split("export const MENU = {")
            .nth(1)
            .and_then(|rest| rest.split("} as const;").next())
            .expect("MENU table in event-names.ts");
        let mut checked = 0;
        for line in menu_block.lines() {
            let Some(start) = line.find("'menu:") else {
                continue;
            };
            let id = &line[start + "'menu:".len()..];
            let id = &id[..id.find('\'').expect("closing quote")];
            if id == "quit" {
                continue; // the predefined Quit item (no custom id)
            }
            assert!(
                rust.contains(&format!("with_id(\"{id}\"")),
                "menu:{id} has no menu item in menu.rs"
            );
            checked += 1;
        }
        assert!(checked >= 20, "parsed only {checked} menu ids");
    }

    #[test]
    fn file_new_window_shows_its_shortcut_next_to_open_folder() {
        // #128: one shared menu on every platform (macOS bar, Win/Linux
        // popup), so this covers all three.
        let rust = include_str!("menu.rs");
        let at = rust
            .find("\"{}-file\", crate::lifecycle::NEW_WINDOW_ID")
            .unwrap();
        let item = &rust[at..at + rust[at..].find(".build(app)").unwrap()];
        assert!(item.contains("\"CmdOrCtrl+Shift+N\""));
        assert_eq!(
            rust.matches("\"CmdOrCtrl+Shift+N\"").count(),
            1,
            "one item per key"
        );
        let file = &rust[rust.find("SubmenuBuilder::new(app, \"File\")").unwrap()..];
        let file = &file[..file.find(".build()").unwrap()];
        let order: Vec<&str> = file
            .lines()
            .filter_map(|l| l.trim().strip_prefix(".item(&"))
            .map(|l| l.trim_end_matches(')'))
            .collect();
        let nw = order.iter().position(|i| *i == "file_new_window").unwrap();
        assert_eq!(order.get(nw + 1), Some(&"open_folder"), "{order:?}");
    }

    #[test]
    fn about_shows_name_and_version_on_every_platform() {
        // #120: never `About(None)` (a no-op on Linux and Windows).
        let rust = include_str!("menu.rs");
        assert!(!rust.contains(&[".about(", "None)"].concat()));
        let m = super::about_metadata("SparkDown", "0.4.1", None, None);
        assert_eq!(m.name.as_deref(), Some("SparkDown"));
        assert_eq!(m.version.as_deref(), Some("0.4.1"));
        assert_eq!(m.license.as_deref(), Some("MIT"));
        assert_eq!(m.website.as_deref(), Some("https://sparkdown.dev"));
    }

    #[test]
    fn view_items_carry_cmd_1_to_4() {
        let rust = include_str!("menu.rs");
        for (id, n) in [
            ("view-edit", 1),
            ("view-split", 2),
            ("view-preview", 3),
            ("view-diff", 4),
        ] {
            let at = rust
                .find(&format!("with_id(\"{id}\""))
                .unwrap_or_else(|| panic!("no {id} item"));
            let item = &rust[at..at + rust[at..].find(".build(app)").unwrap()];
            assert!(
                item.contains(&format!("\"CmdOrCtrl+{n}\"")),
                "{id} should be CmdOrCtrl+{n}"
            );
        }
    }
}
