# Developing pocket


```sh
npm install
npm test     # build + vitest: translator, meter, router against fake providers, keychain, attach/detach, daemon, a real Claude Code session if `claude` is installed
```

On Linux, the keychain tests need a Secret Service in a D-Bus session, e.g. `dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock --components=secrets; npm test'`; without one they are skipped and the "refuse without keychain" test runs instead.
