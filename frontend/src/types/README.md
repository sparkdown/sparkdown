Generated TypeScript types from Rust structs via [ts-rs](https://github.com/Aleph-Alpha/ts-rs).

Do not edit these files by hand. Regenerate with:

    cd src-tauri && cargo test export_bindings

Source structs live in `src-tauri/src/`. To add a new type, derive
`#[cfg_attr(test, derive(TS), ts(export, export_to = "../../frontend/src/types/"))]`
on the Rust struct, then re-run the test.
