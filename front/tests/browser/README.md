# Inbox browser checks

From `front`, run `node tests/browser/server.mjs`, then open
`http://127.0.0.1:6981/todo-inbox`. This uses the real Inbox page, components,
transaction transformer, badges, theme, and completion composable with in-memory
repositories and synthetic stores. It never connects to Firefly or reads saved
credentials. Reloading resets the synthetic ledger. The server binds to loopback
only and refuses to take an occupied port.

Run `node --test tests/*.test.js` for the automated checks. The transport test
uses the real Axios interceptor and transaction repository with a synthetic
adapter, separately from this visual harness.

Check both themes at desktop width and at 390px and 320px with Mobile layout
selected. Mobile should start collapsed; Expand all reveals every detail panel.
Check long tags, split-specific fields, wrapped code, tables, and Source/Rendered.
Done replaces the card immediately; Saving and Undo receipts are both 44px high.
Undo restores the prior expansion state.

The first item has long tags and five review properties. With it expanded, use
Check layout to verify a neutral Done icon, no grey filler cell, dates directly
below Subscription without being pushed down by Tags, and no horizontal overflow.
Run this check in both layouts and themes.

For deterministic failure/scroll checks:

1. Select Fail saves and Hold saves.
2. Mark page done and confirm. All 30 rows become compact immediately; three are
   Saving and the rest Queued.
3. Scroll past several rows and note a visible row's position.
4. Release saves. The three failed cards return with Retry while the reading
   position stays fixed. Repeat while later batches are pending.

The harness disables native scroll anchoring so this check exercises Pico's
page-level correction. Also check the successful path with Fail saves off:
receipts must remain until Continue, Undo, or navigation, without a delayed
height change. Editing is represented by a harmless dialog; the unchanged real
editor and real-ledger mutations are not tested by this harness.
