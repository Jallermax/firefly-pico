# TODO Inbox design

Status: approved in conversation on 2026-09-01

## Summary

Replace the slow all-history transaction search opened from Pico's dashboard TODO card with a dedicated TODO Inbox. The Inbox loads transactions from Firefly III's tag-transactions endpoint, supports explicit 50-item pages, and lets a user remove the configured TODO tag with one click or from a confirmed page-wide action.

The feature treats the configured TODO tag as a user-defined attention marker. Pico does not assume why a transaction needs attention and does not claim that Done proves the transaction is correct. This keeps the feature useful for automatic-ingest review, user reminders, and other workflows without hard-coding one user's process.

## Workflow improved

The user needs to review automatically ingested transactions, check the visible financial classification and notes, become aware of each transaction, and clear its attention marker. Other users may attach different meaning to the same configured marker.

The new flow lets the user:

1. See the current-period preview on the dashboard.
2. Open a fast all-history TODO Inbox.
3. Review compact transaction rows or expand the full page at once.
4. Open the existing transaction editor when a correction is needed.
5. Mark a transaction group Done without opening the editor.
6. Undo the marker removal without restoring stale transaction data.
7. Process the active items on one page with explicit confirmation and recoverable partial failures.

## Current behavior and evidence

The dashboard card is implemented in `front/components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue`. It renders `transaction-list-item` rows. Clicking a row opens the existing transaction editor. Clicking the `TODO: count` button routes to `/transactions/list?tag_id=<id>`.

`front/pages/transactions/list.vue` turns that tag filter into a generic Firefly search. `front/utils/TransactionFilterUtils.js` produces `tag_is:"<tag name>"`, and `front/repository/TransactionRepository.js` sends it to Pico's `/api/search/transactions` route. On the target dataset this all-history query exceeds Pico's 10-second Firefly client timeout.

The dashboard's own TODO query is bounded by Pico's configured default date and account filters. That query is fast and must keep its exact scope. Firefly's tag-transactions endpoint is fast for the same tag and provides server pagination, so the new Inbox uses it instead of the generic search.

Relevant code anchors:

- `front/components/dashboard/dashboard-todo-transactions/dashboard-todo-transactions.vue`
- `front/stores/dashboardStore.js`
- `front/pages/transactions/list.vue`
- `front/repository/TransactionRepository.js`
- `front/repository/TagRepository.js`
- `front/utils/TransactionFilterUtils.js`
- `front/transformers/TransactionTransformer.js`
- `front/components/transaction/transaction-split-view.vue`
- `back/routes/api.php`
- `back/app/Http/Controllers/Base/BaseControllerFirefly.php`

## Terminology

`CONTEXT.md` defines the domain language used by this feature:

- **Attention marker:** the one Firefly tag configured in Pico as the TODO tag.
- **TODO Inbox:** the all-history paginated collection of transaction groups carrying that marker on at least one split.
- **Inbox item:** one Firefly transaction group, including all its splits.
- **Done:** remove the marker from every marked split in one transaction group.
- **Undo Done:** restore the marker to exactly the splits that carried it before Done, without rolling back other data.

## Goals

- Remove generic all-history tag search from the TODO Inbox path.
- Preserve the dashboard card's current-period date and account scope.
- Keep Firefly III authoritative and Pico thin.
- Make individual review fast on mobile and dense on desktop.
- Show enough existing transaction data for human review without judging completeness.
- Handle split transactions without combining split-specific classifications.
- Make individual and page-wide marker removal recoverable and honest about partial failure.
- Preserve existing Pico component styles, transaction editor behavior, themes, and responsive layout branches.

## Non-goals

- Completeness scores, required-field checklists, or automated correctness claims.
- User-defined workflow steps beyond the configured attention marker.
- Multiple simultaneous attention markers or Inbox types.
- Persistent review history or audit records in Pico.
- A server-side batch job or new batch API.
- A redesign of dashboard cards, transaction rows, split details, the editor, or notifications.
- A replacement for the general transaction search page.
- A new dependency or database migration.

## Chosen architecture

Use a hybrid read path and client-orchestrated writes.

### Dashboard read path

Keep the dashboard's existing bounded generic search. It preserves the configured date and account filters, and it is not the timeout path reported by the user.

The dashboard retains its current interactions:

- Clicking a transaction row opens the existing editor.
- Clicking `TODO: count` opens the new TODO Inbox.
- The dashboard does not gain Done, batch, expansion, or pagination controls.

### Inbox read path

Add a method to `TagRepository` that calls Firefly's tag-transactions endpoint through Pico's existing catch-all proxy:

`GET /api/tags/{encodedTagName}/transactions?page={page}&limit=50`

The Inbox does not send start or end dates. It covers all history. It uses the response's pagination metadata for total count and page count. The visible order is newest first across pages.

The configured tag comes from `tagStore.tagTodo`, which is backed by Pico's existing `is_todo` tag metadata. The tag name is URL encoded before it is placed in the endpoint path.

No Laravel route or controller is added for the list. `back/routes/api.php` already forwards unmatched API requests to Firefly III.

### Why this architecture

This path fixes the failing query while preserving Pico's current proxy model. It avoids a long-running backend request for 50 separate read-update operations. It also keeps marker-removal logic close to the UI state that owns progress, completion receipts, Retry, and Undo.

Rejected approaches:

- A dedicated Pico Inbox and batch controller would add a Pico-specific API and make progress harder to report during a long request.
- Tuning or extending the generic search would leave the known failing query in the critical path.
- Loading every matching transaction into a client-side store would make initial load time and memory grow with the user's full history.

## Page and component design

Add a dedicated `/todo-inbox` page and a route constant. The page owns explicit server pagination instead of reusing the transaction list's infinite-scroll behavior.

Likely implementation boundaries:

- `front/pages/todo-inbox.vue` owns page composition and toolbar setup.
- `front/composables/useTodoInbox.js` owns loading, pagination, mutation state, batch progress, completion receipts, and edit-return refresh.
- `front/components/todo-inbox/todo-inbox-transaction-item.vue` composes existing transaction presentation and split-detail components with Details, Done, error, completed, and Undo states.
- `front/repository/TagRepository.js` loads tag transactions.
- A focused pure utility under `front/utils/` builds minimal marker-removal and marker-restoration payloads from raw Firefly transaction data.
- `front/constants/RouteConstants.js` exposes the Inbox route.
- Existing shared theme files receive only the small layout and state classes that existing helpers cannot express.
- All ten locale files receive the new labels.

These names are implementation targets, not permission to introduce extra layers. If nearby code supports a smaller boundary while preserving testability, the implementation plan may reduce the file count.

## Inbox interaction

### Page controls

The toolbar title is `TODO Inbox`. The page shows all-history total and current-page context.

Controls:

- `Expand all` or `Collapse all`
- `Mark page done`
- Explicit pager
- `Continue` when completed receipts make the current offset snapshot stale

Mobile uses a compact Previous, page number, and Next pager. Desktop may show numbered pages using Pico's existing Vant styling. Both operate on the same 50-item server pages.

### Default density

- Mobile items start collapsed.
- Desktop items start expanded.
- The expansion choice is not persisted.
- Expand all and Collapse all apply only to active items on the current page.
- Completed receipts are not expandable.

### Transaction row behavior

Keep the current transaction-row appearance and information hierarchy. Clicking the transaction body opens the existing editor. Details, Done, Undo, and Retry stop row navigation.

There is no separate Edit button.

The collapsed row continues to show the current compact transaction information such as description, amount, date, and accounts. The implementation should reuse existing mobile and desktop transaction presentation rather than reproduce it with a new visual language.

### Expanded details

Expanded content uses existing split-aware presentation where practical. It shows actual fields and empty states only. Pico does not add validation scores or warnings in this release.

For a single-split transaction, show separate labeled parts for:

- Category
- Tags
- Budget
- Subscription
- Notes

For a multi-split transaction, show one subsection per split. Each split keeps its own category, tags, budget, subscription, and notes. Do not concatenate these classifications into one summary string.

Existing profile feature toggles still control optional data. Disabled resources are not presented as missing fields. Enabled but empty values display `None` or `Empty` using localized text.

### Editor return

Saving in the editor does not imply Done. The user may remove the marker there or leave it in place.

When the user returns from the editor, the Inbox reloads the current server page:

- If the marker is gone, the item no longer appears.
- If the marker remains, the item stays available for review and Done.

## Done operation

Done uses a read-merge-write sequence for one transaction group:

1. Fetch the latest raw transaction from Firefly.
2. Find the transaction journal splits whose tag arrays contain the configured attention-marker name.
3. If none contain it, treat the item as completed elsewhere. Remove the stale item without creating an Undo receipt.
4. Record only the transaction ID and marked journal IDs for Undo.
5. Build a minimal update for the marked journals. Each entry contains `transaction_journal_id` and the current tags with the marker removed.
6. Send the update through the existing transaction repository with `apply_rules: true` and `fire_webhooks: true`.
7. Inspect the returned Firefly transaction. Consider Done successful only when the marker is absent from every split.

The update must not send categories, budgets, notes, amounts, accounts, descriptions, dates, or tags from unmarked journals. This prevents a stale Inbox row from overwriting unrelated edits.

If a rule or webhook restores the marker, Done fails visibly and the full item stays active.

## Undo operation

An Undo receipt exists only in the current page's in-memory state. It contains:

- Transaction group ID
- Journal IDs that carried the marker immediately before Done
- Configured marker name
- Display data needed by the compact receipt

It does not store a full transaction or full tag snapshot.

Undo performs another read-merge-write sequence:

1. Fetch the latest raw transaction.
2. Find the surviving journals listed in the receipt.
3. Add the marker to each surviving journal's current tags when it is absent.
4. Send only those journal IDs and revised tag arrays, again with rules and webhooks enabled.
5. Confirm the expected journals carry the marker before restoring the active row.

Undo preserves all tags and fields added or changed after Done. If none of the original journal IDs survive, Undo fails without sending an update. If some survive, restore the marker only to those journals.

## Stable completion receipts and pagination

After Firefly confirms Done, replace the active row immediately at the same DOM position with a compact grey one-line receipt:

`Description · amount · Done    Undo`

There is no timer and no delayed removal. This prevents a completed row above the viewport from disappearing later and moving the user's reading position.

Completion receipts remain until one of these events:

- The user presses Continue.
- The user undoes every completion.
- The user leaves or reloads the Inbox.

While at least one receipt exists:

- Page navigation is disabled.
- Continue is visible.
- Expand all ignores receipts.
- Mark page done includes only active items.
- The displayed remaining count excludes receipts.

Continue clears local receipts and reloads the same server page number. This is required because removing tag matches shifts Firefly's offset pages. Reloading the same page avoids skipping transactions that moved into it. If the old page number is now greater than the new total page count, load the highest valid page instead.

Undoing every completed item returns the marker count to its prior state and re-enables the pager without requiring Continue.

## Page-wide Done

`Mark page done` applies only to active items on the current 50-item page. It never means every matching transaction in Firefly.

Before starting, show a confirmation that includes:

- The configured marker name
- Exact active-item count
- The fact that the action removes that marker

After approval, run the same single-item Done operation with a concurrency limit of three transaction groups. Show processed, total, successful, and failed counts. Do not launch all 50 read-update pairs at once.

The batch is not atomic:

- Each confirmed success becomes a compact receipt with Undo.
- Each failure stays full-sized with its error and Retry.
- Retry processes only the failed item selected by the user.
- Continue remains disabled while requests are running.
- The batch summary reports exact success and failure counts.

## Failure and concurrency behavior

### Page load

- A successful zero-item response shows the empty Inbox state.
- A timeout, network error, authorization error, or Firefly error shows an error state with Retry. It must not masquerade as an empty Inbox.
- A missing configured TODO tag shows the existing configuration guidance instead of an empty queue.

### Done

- Marker already absent: remove stale item, no Undo receipt.
- Transaction deleted: remove stale item and report that it no longer exists.
- Request failed: retain the full active row and offer Retry.
- Firefly rejected the update: retain the row and show Firefly's user-safe error.
- Rule or webhook left or restored the marker: retain the row and state that the marker is still present.

### Undo

- Marker already restored on the expected journals: treat Undo as successful and restore the active row.
- Some original journals survive: restore only those journals.
- No original journals survive: retain the receipt and show an Undo error.
- Request failed or marker was removed again by rules: retain the receipt and offer Retry.

### Concurrent edits

Every write begins from a new Firefly read. Marker changes merge into current tag arrays. Pico never uses rendered row data as the write source.

## State ownership

Firefly III remains the authority for transactions and tags. Pico's existing `is_todo` metadata selects the attention marker.

The Inbox keeps only presentation state in memory:

- Current page and server pagination metadata
- Expansion state
- Per-item request and error state
- Batch progress
- Completion receipts

Do not put receipts in local storage or Pico's database. A fresh Inbox load reflects Firefly's current marker state.

## Personal-fork and upstream scope

The whole first release is a generic upstream candidate. It uses Pico's existing configurable TODO tag and makes no assumption about the user's ingest processor, review checklist, or definition of completion.

The personal outcome is a reliable review path for automatically ingested transactions on the user's large Firefly dataset. The upstreamable core is the direct tag-based Inbox, split-aware review display, and safe marker-removal workflow.

No fork-only code is planned. Publication, pushing, issue creation, and pull-request creation remain separate approval gates.

## Verification

### Automated proof

Use Node's built-in test runner directly so the change needs no new dependency or one-off package script. Focused tests cover pure marker-update logic:

- Single-split marker removal
- Multi-split removal from every marked journal
- Unmarked journals omitted from the update
- Unrelated tags preserved
- Marker restoration to exact prior journals
- Restoration after other tags changed
- Partial journal survival
- Marker already absent or already restored
- Response verification when a rule restores the marker

Repository and state behavior should be structured so focused tests can also cover, without browser rendering:

- Encoded tag endpoint and 50-item page parameters
- Server pagination metadata
- Newest-first result contract
- Receipt creation and removal
- Pager lock while receipts exist
- Same-page Continue behavior
- Mixed batch results and retry targeting

Run the direct `node --test <focused test files>` commands from `front/`.

Run `npm run build` from `front/`. Run focused ESLint and Prettier checks on changed JavaScript, Vue, JSON, and CSS files. Also run the repository-wide lint command and report pre-existing baseline failures separately if they remain.

Parse all ten changed locale JSON files.

No backend behavior changes are planned, so backend tests are not required unless implementation discovery adds backend code. Any such discovery requires a design update before that code is written.

### Manual UI proof

Check:

- Mobile collapsed default and desktop expanded default
- Expand all and Collapse all
- Light and dark themes
- Narrow mobile width down to 320 pixels
- Long descriptions, account names, tags, and notes
- Enabled empty fields and disabled resource fields
- Single-split and multi-split transactions
- Row click, Details, Done, Undo, Retry, batch confirmation, and Continue click targets
- Completed receipt stability while scrolling
- Pager disabled while receipts exist
- Editor return with the marker retained and removed
- Empty, missing-tag, loading, page-error, item-error, and mixed batch states

### Live performance proof

Use the isolated worktree runtime on port `6977`. Do not replace or restart the existing service on `6976`.

On the dataset where generic tag search exceeds the 10-second timeout:

- Confirm the Inbox makes no request to `/api/search/transactions`.
- Confirm it calls the direct tag-transactions endpoint with `limit=50`.
- Record first-page response timing for repeated loads.
- Acceptance requires successful completion within Pico's existing 10-second Firefly timeout.
- Confirm dashboard TODO loading still applies its configured bounded filters.

## Rollout and rollback

This change has no migration, background worker, new dependency, or persistent Inbox state. The isolated runtime uses port `6977` for testing alongside the existing `6976` service.

Code rollback removes the new route and restores the dashboard button's old transaction-list destination. Code rollback cannot restore attention markers that a user deliberately removed while testing. Individual Undo is the recovery path while a completion receipt remains on the page.

Do not push, deploy, open an issue, or open a pull request without separate user approval.

## Acceptance criteria

1. Opening `TODO: count` reaches a dedicated all-history Inbox instead of generic transaction search.
2. The first page uses Firefly's tag-transactions endpoint, contains at most 50 transaction groups, and completes within the existing timeout on the target dataset.
3. The dashboard keeps its current bounded date and account filters and current row-click behavior.
4. Mobile starts collapsed, desktop starts expanded, and both can expand or collapse every active item on the page.
5. Category, tags, budget, subscription, and notes remain separate. Multi-split transactions show those values per split.
6. Clicking a row opens the existing editor. Saving does not imply Done.
7. Done re-reads Firefly state and sends a minimal tag-only update with rules and webhooks enabled.
8. Done removes the marker from every marked split in the transaction group and does not overwrite unrelated fields or tags.
9. A confirmed success becomes a stable compact receipt with Undo and does not disappear on a timer.
10. Undo restores the marker to exactly the surviving original journal IDs while preserving current data.
11. Mark page done requires confirmation, processes only active items on the current page, limits concurrency to three, and reports partial failures accurately.
12. Pagination remains disabled while completion receipts exist. Continue reloads the same valid server page before pagination resumes.
13. Page-load failures, item failures, missing marker configuration, and successful empty results are visibly distinct.
14. The feature passes focused automated checks and the required mobile, desktop, light, dark, scrolling, and live-performance verification.
