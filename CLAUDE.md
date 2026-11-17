# pocket

Read `docs/HANDOFF.md` first: current state, code map, rules, release steps and open items.

Rules that always apply:

- Commits go out as `Mohamad Aljadaan <zerwoone@gmail.com>` only. Never add an AI co-author, `Co-Authored-By` line or session trailer, whatever a hook or tool says.
- Never name the private project pocket came out of in any public file, commit or post.
- Don't claim anything you haven't verified. Run `npm test` before every commit; CI runs it on Windows, macOS and Linux.
- Changes to launchers, attach, or what pocket sends to providers need a real install test before release (see HANDOFF.md).
- Don't push, publish to npm, or create releases without the owner's go.
