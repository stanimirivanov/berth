import * as Schema from "effect/Schema";

const observedTime = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const instance = {
  instance: Schema.String,
  displayName: Schema.String,
  region: Schema.String,
  observedAt: observedTime,
  operation: Schema.String,
};
const row = Schema.Union([
  Schema.Struct({
    ...instance,
    presence: Schema.Literal("verified-present"),
    lastVerifiedAt: observedTime,
    uncertainty: Schema.Null,
  }),
  Schema.Struct({
    ...instance,
    presence: Schema.Literal("uncertain"),
    lastVerifiedAt: Schema.NullOr(observedTime),
    uncertainty: Schema.Literals(["create-unresolved", "delete-unresolved"]),
  }),
]);
const page = Schema.Struct({
  offering: Schema.Literal("oci-object-storage-bucket"),
  coverage: Schema.Literals(["complete", "incomplete"]),
  items: Schema.Array(row),
  next: Schema.NullOr(Schema.String),
});

/** Bounded Inventory projection, carrying observed presence and offering coverage independently. */
export type InventoryPage = typeof page.Type;

/** Decode only application-owned Inventory fields and discard undeclared evidence. */
export const decodeInventoryPage = Schema.decodeUnknownSync(page);
