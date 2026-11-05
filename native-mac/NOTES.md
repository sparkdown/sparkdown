# Spike notes — libghostty, licensing, parity

## libghostty maturity (Ghostty v1.4.0, built from source)
- The macOS embedding API we use (`GhosttyKit.xcframework`, `include/ghostty.h`)
  is self-described as **"libghostty-internal"**: "The only consumer of this API
  is the macOS app … not designed for external use … External embedders should
  instead use `libghostty-vt`." Undocumented, unversioned, no stability promise.
- Evidence of churn: between v1.2.3 and v1.4.0 the clipboard callbacks changed
  signature (MIME-typed contents, confirm structs) and `ghostty_surface_config_s`
  gained `context`. Every Ghostty bump will need code changes in our bridge.
- The officially supported embeddable piece is `libghostty-vt` (parser +
  terminal state, C/Zig). README: functionality "extremely stable" but "API
  signatures are still in flux"; "we haven't tagged libghostty with a version
  yet". libghostty-vt has no renderer/pty/input, so using it means writing our
  own Metal/CoreText renderer — a big job.
- Toolchain: Ghostty v1.4.0 requires **Zig 0.17.0** exactly-ish
  (`minimum_zig_version`), upstream CI uses Xcode 27.1; it built on GitHub
  macos-26 with Xcode 26.6 + Zig 0.17.0 in ~9.5 min (cached afterwards). Zig is
  pre-1.0 and breaks between minors, so Ghostty releases pin Zig versions.
- Upstream support for third parties: community projects exist
  (awesome-libghostty, Ghostling example), but for the internal API there is no
  support commitment; we would be tracking the Ghostty macOS app's needs.
- Built flags: `-Demit-xcframework -Demit-macos-app=false -Dxcframework-target=native
  -Dsentry=false -Di18n=false`. Resources (terminfo, shell-integration) are
  copied into `Contents/Resources` where libghostty finds them.

## Licensing
- Ghostty: MIT. cmark-gfm: BSD-2-Clause (+ MIT parts). Both fine for us.
- Ghostty's vendored deps statically linked into libghostty on macOS (pkg/):
  harfbuzz (MIT), freetype (FTL or GPLv2 — use FTL; CoreText is the default
  mac font backend but freetype is still compiled in), libpng (libpng),
  zlib (zlib), oniguruma (BSD-2), simdutf (MIT/Apache-2), highway (Apache-2 /
  BSD-3), wuffs (Apache-2), glslang (BSD-3/Apache-2 mix), spirv-cross
  (Apache-2), dear imgui via dcimgui (MIT, inspector), libxml2? (MIT, only if
  linked), libintl disabled (i18n=false), sentry disabled.
- All permissive; we'd need a THIRD_PARTY_NOTICES entry per lib (FTL requires
  an attribution credit in docs). No copyleft obligation if freetype is taken
  under FTL. Re-audit on every Ghostty bump.
