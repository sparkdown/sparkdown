//! macOS Quit interception.
//!
//! tao (Tauri's windowing layer) implements `applicationWillTerminate:` but NOT
//! `applicationShouldTerminate:` — the AppKit delegate method that asks whether
//! the app may quit. Without it, dock-icon Quit and the app-menu Quit terminate
//! unconditionally, bypassing any save prompt (Tauri's RunEvent::ExitRequested
//! only fires for window-close-driven exits, not NSApplication termination).
//!
//! We add `applicationShouldTerminate:` to the live app delegate's class at
//! runtime. It emits `exit-requested` to the frontend and returns
//! NSTerminateCancel, so the quit is deferred; the frontend resolves unsaved
//! changes and then calls the `quit` command (AppHandle::exit), which exits the
//! process directly without re-consulting the delegate.

use std::ffi::c_char;
use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::NSApplication;
use objc2_foundation::MainThreadMarker;
use tauri::{AppHandle, Emitter, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

// NSApplicationTerminateReply::NSTerminateCancel
const NS_TERMINATE_CANCEL: usize = 0;

/// Injected `applicationShouldTerminate:`. Emits the quit request to the
/// frontend and cancels native termination so the save prompt can run.
extern "C-unwind" fn application_should_terminate(
    _self: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> usize {
    if let Some(app) = APP_HANDLE.get() {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("exit-requested", ());
        }
    }
    NS_TERMINATE_CANCEL
}

/// Install the `applicationShouldTerminate:` hook onto the running app
/// delegate's class. Call once, after the Tauri app is built.
pub fn install(app: &AppHandle) {
    if APP_HANDLE.set(app.clone()).is_err() {
        return; // already installed
    }

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);

    unsafe {
        let delegate: *mut AnyObject = msg_send![&*ns_app, delegate];
        if delegate.is_null() {
            return;
        }
        // The delegate's class is tao's TaoAppDelegate; add the method to it.
        let class: *mut AnyClass = msg_send![delegate, class];

        // Type encoding: NSUInteger return (Q), self (@), _cmd (:), sender (@).
        let types = c"Q@:@".as_ptr() as *const c_char;
        let imp: Imp = std::mem::transmute::<
            extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(application_should_terminate);

        class_addMethod(class, sel!(applicationShouldTerminate:), imp, types);
    }
}
