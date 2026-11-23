# Separate application features from trial execution

History, Inventory and Retry are application capabilities. The trial executor,
qualification probes and independent recovery still have their own callers and
verification. Place application code in `src/application` and keep support for
existing evidence and recovery through a named retained trial ledger adapter.

The adapter has separate History, Inventory and Retry interfaces. History
retains its read-only transaction and existing login checks. Inventory uses the
offering and presence projection with its existing reader role. Retry uses its
own guarded claims, reservations and status. Decode each projection before
passing data to the application. Keep fixed SQL calls and their role checks
behind these interfaces.

Leave SQL migrations, retained records, bundle slugs, current public routes
and recovery procedures intact. The shared empty-body HTTP check lives
outside the application and trial modules. Future application modules may
reach trial storage through the named adapter. Evaluate removal of each
qualification probe once its remaining callers and gates are accounted for.

Inventory's hosted endpoint and same-origin proxy remain in
[#118](https://github.com/stanimirivanov/berth/issues/118). Safe provisioning
continuation remains in [#141](https://github.com/stanimirivanov/berth/issues/141).
