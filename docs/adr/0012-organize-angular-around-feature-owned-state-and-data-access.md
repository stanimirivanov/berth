# Organize Angular around feature-owned state and data access

Organize Angular by feature so Operation history and Infrastructure can evolve
independently. Each feature owns its components, state and data-access
interface. Its data-access adapter builds requests and validates responses
through Owner access for protected reads. The app shell wires routes and shared
providers. Features communicate through routes and explicit shared interfaces.
For example, Infrastructure opens an operation using its saved History URL.
Each feature keeps its store and data-access implementation private.

Use NgRx SignalStore for feature workflows such as loading, pagination, retry
and stale snapshots. Use Angular signals for local UI state and computed
signals for derived values. Choose the store's lifetime to match the feature's
navigation behavior. History can retain its page at shell scope. Owner access
owns the shared tab-memory session and signals when protected state must be
cleared. Each feature store clears its own data.

Page containers coordinate routing, focus and store actions. Presentational
components receive data through `input()`, emit interaction events through
`output()` and can own local display state. Extract them when they have a
clear rendering or interaction responsibility, or a second caller.

Start with a bounded History refactor. Extract requests and response validation
from the store, test store behavior with a fake reader, and test the adapter
with representative API responses. Preserve saved links, Back navigation,
stale results and shared access-denial behavior under
[ADR 0005](0005-use-existing-history-api-with-independent-read-states.md).
Infrastructure follows this pattern when its inventory read is implemented.

[#150](https://github.com/stanimirivanov/berth/issues/150) covers Angular and
Pages import boundaries, including local runtime cycles and browser imports
of server code. After the History refactor proves the feature design, add
separate CI checks that reject imports of sibling features' private stores or
data-access adapters. Those checks also reject imports of any feature store or
data-access adapter from presentational components.
Use behavioral tests for navigation and state transitions.
