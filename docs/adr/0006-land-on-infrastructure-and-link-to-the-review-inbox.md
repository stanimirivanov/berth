# Land on Infrastructure and link to the Review inbox

The owner's first question is what Berth offers and which managed resources may
still exist. Use **Infrastructure** at `/` for that view and **Operation history**
at `/operations` for reviewing lifecycle records. These are the two main
navigation items in the owner-only, read-only console. This supersedes the
landing route in [ADR 0004](0004-make-operation-history-a-read-only-owner-console.md).
Its operation detail route at `/operations/:operation` and detail behavior continue
to apply.

## Infrastructure

- Show every offering, including offerings with no known instances. Show its
  name, provider, short description and qualification. Start with the **OCI
  Object Storage bucket**, marked **Trial only · Partial / no-go**. The fixed
  probe object is part of that lifecycle. The
  [trial bounds](../../SPEC.md#proposed-trial-bounds) still govern what can run.
- Keep each offering expanded. Show every managed instance in its own row,
  placing **Uncertain** instances first and sorting the remaining rows by
  display name. If a list needs pagination, **Show more** appends rows within
  that offering and leaves the already loaded rows visible.
- Give each instance a display name, region, presence status and last verified
  provider observation time. Show **No verified observation yet** when that
  time is unavailable. Give **Uncertain** a short reason, such as “Delete
  result unresolved.”
- Include placeholders for **Usage**, **Cost**, and **Free-plan headroom**,
  each marked **Not yet available**. Application request budgets belong in the
  operation detail view.
- **Review operation** opens the operation associated with the instance's
  latest recorded change. The first release uses the instance row for its
  resource summary and defers a separate instance detail screen.

## Operation history

Use the **Review inbox** layout selected in the prototype. Group the loaded
operations into **Needs attention** and **Other operations**. Keep the existing
detail hierarchy, linkable details and responsive list/detail layout. The
feasibility verdict, resource presence and each recorded operation outcome
remain distinct. See the [history API decision](0005-use-existing-history-api-with-independent-read-states.md).
