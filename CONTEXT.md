# Firefly Pico

Firefly Pico is a companion to the Firefly III ledger. This glossary names the concepts Pico adds around transaction attention and review without redefining Firefly's financial records.

## Transaction attention

**Attention marker**:
The single Firefly tag configured in Pico as the TODO tag. Its presence means a transaction needs user-defined follow-up; Pico does not prescribe why it needs attention or what must happen before the marker can be removed.
_Avoid_: Review status, unread flag

**TODO Inbox**:
The all-history, paginated collection of transaction groups that carry the attention marker on at least one split.
_Avoid_: Search results, current-period TODO list

**Inbox item**:
A Firefly transaction group in the TODO Inbox. The whole group is one item even when several transaction journals make up the group.
_Avoid_: Split task, transaction journal item

**Done**:
An explicit Inbox action that removes the attention marker from every marked split in one transaction group. The user decides what must be checked or completed before using it; Pico does not treat Done as proof that the financial fields are correct.
_Avoid_: Read, processed, validated

**Undo Done**:
A short-lived Inbox action that restores the attention marker to exactly the transaction splits that carried it immediately before Done. It merges that marker into the latest Firefly state and does not restore or overwrite other transaction fields or tags.
_Avoid_: Roll back transaction, restore transaction
