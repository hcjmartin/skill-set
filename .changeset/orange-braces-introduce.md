---
'@skill-set/cli': minor
---

Add a branded one-line intro (`{skill-set} v<version> — <tagline>`) before commands in interactive TTY sessions. It prints to stderr so stdout stays pipeable, and is suppressed under `--json`, pipes, and CI. Also fixes terminal colors never being emitted on real TTYs (the injected-stream detection in `createUi` always tripped), and adds `Ui.accent()` — the brand accent `#ff5733` as truecolor, degrading to xterm-256 202 and then `redBright` by terminal depth.
