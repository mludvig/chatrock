# 47. Persist the navigation split as a proportion

## Status

Accepted.

## Context

Recent chats and Projects scroll independently, but their fixed 3:2 allocation can
leave the list a user cares about cramped. The sidebar width is already draggable
and persisted, so the horizontal divider should offer the same control.

A fixed pixel height would reproduce the exact position after reload, but it would
behave poorly when the browser or mobile viewport height changes.

## Decision

Make the divider between Recent chats and Projects draggable and keyboard
adjustable. Persist the Recent chats share as a proportion of the available
navigation height, defaulting to 60 percent and clamped between 20 and 80 percent.
Retain a minimum height on both panels.

Keep Sign out out of the everyday navigation footer and expose it only while
Settings is open.

## Consequences

The chosen balance survives reloads while adapting to viewport-height changes.
Both lists remain reachable, and keyboard users can adjust the separator with the
arrow, Home, and End keys.

We rejected storing pixels because the saved value could crowd out a panel after a
window resize. We rejected allowing either panel to collapse completely because it
would make part of the primary navigation appear to disappear.
