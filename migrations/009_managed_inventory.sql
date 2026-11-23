-- Owner-installed storage and read projection for the OCI Object Storage bucket offering.
-- Evidence admission and legacy seeding are separate from schema installation.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
END $$;

CREATE ROLE berth_inventory_reader NOLOGIN NOINHERIT;
CREATE SCHEMA berth_inventory AUTHORIZATION neondb_owner;
REVOKE ALL ON SCHEMA berth_inventory FROM PUBLIC, berth_runtime, berth_inventory_reader;

-- The operation binds the saved intent. The OCI ID identifies its incarnation.
-- The opaque ID stays stable across projections and excludes the private OCI ID.
CREATE TABLE berth_inventory.instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL UNIQUE
    CHECK (provider_id ~ '^ocid1[.]bucket[.][A-Za-z0-9._-]{1,200}$'),
  operation uuid NOT NULL UNIQUE REFERENCES berth_ledger.trials(operation),
  region text NOT NULL CHECK (region ~ '^[a-z]{2}-[a-z]+-[1-9]$' AND length(region) <= 40),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256 AND display_name ~ '^[A-Za-z0-9._-]+$')
);

-- Evidence is keyed by the exact provider ID and observation time. Conflicting
-- events at one time require reconciliation before admission.
CREATE TABLE berth_inventory.observations (
  provider_id text NOT NULL REFERENCES berth_inventory.instances(provider_id),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  kind text NOT NULL CHECK (kind IN ('present', 'removed', 'create-unresolved', 'delete-unresolved')),
  source text NOT NULL CHECK (source IN ('executor', 'owner')),
  PRIMARY KEY (provider_id, observed_at)
);
CREATE INDEX inventory_verified_presence
  ON berth_inventory.observations(provider_id, observed_at DESC)
  WHERE kind = 'present';

-- A scope review accounts for records beyond the durable operation list.
-- Per-operation facts account for known legacy gaps and verified no-instance cases.
CREATE TABLE berth_inventory.scope_review (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  reviewed_at timestamptz NOT NULL CHECK (isfinite(reviewed_at))
);
CREATE TABLE berth_inventory.operation_coverage (
  operation uuid PRIMARY KEY REFERENCES berth_ledger.trials(operation),
  disposition text NOT NULL CHECK (disposition IN ('gap', 'no-instance')),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at))
);

REVOKE ALL ON ALL TABLES IN SCHEMA berth_inventory FROM PUBLIC, berth_runtime, berth_inventory_reader;

-- One bounded page of the allowlisted offering summary. An after cursor is an
-- opaque instance ID and remains usable if that instance is later removed.
CREATE FUNCTION berth_inventory.inventory_page(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET timezone = 'UTC'
AS $$
DECLARE
  item record;
  items jsonb := '[]';
  last_id uuid;
  next_id uuid;
  page_size integer := 0;
  complete boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid inventory limit';
  END IF;

  SELECT EXISTS (SELECT FROM berth_inventory.scope_review)
    AND NOT EXISTS (
      SELECT
      FROM berth_ledger.trials t
      LEFT JOIN berth_inventory.instances i ON i.operation = t.operation
      LEFT JOIN berth_inventory.operation_coverage c ON c.operation = t.operation
      WHERE c.disposition = 'gap'
        OR (i.id IS NULL AND c.disposition IS DISTINCT FROM 'no-instance')
        OR (i.id IS NOT NULL AND (
          c.disposition = 'no-instance'
          OR NOT EXISTS (
            SELECT FROM berth_inventory.observations o WHERE o.provider_id = i.provider_id
          )
        ))
    )
  INTO complete;

  FOR item IN
    SELECT i.id, i.display_name, i.region, i.operation, latest.kind,
      latest.observed_at, verified.observed_at AS last_verified_at
    FROM berth_inventory.instances i
    JOIN LATERAL (
      SELECT o.kind, o.observed_at
      FROM berth_inventory.observations o
      WHERE o.provider_id = i.provider_id
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) latest ON latest.kind <> 'removed'
    LEFT JOIN LATERAL (
      SELECT o.observed_at
      FROM berth_inventory.observations o
      WHERE o.provider_id = i.provider_id AND o.kind = 'present'
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) verified ON true
    WHERE p_after IS NULL OR i.id > p_after
    ORDER BY i.id
    LIMIT p_limit + 1
  LOOP
    page_size := page_size + 1;
    IF page_size > p_limit THEN
      next_id := last_id;
      EXIT;
    END IF;
    items := items || jsonb_build_array(jsonb_build_object(
      'instance', item.id,
      'displayName', item.display_name,
      'region', item.region,
      'presence', CASE WHEN item.kind = 'present' THEN 'verified-present' ELSE 'uncertain' END,
      'observedAt', item.observed_at,
      'lastVerifiedAt', item.last_verified_at,
      'uncertainty', NULLIF(item.kind, 'present'),
      'operation', item.operation
    ));
    last_id := item.id;
  END LOOP;

  RETURN jsonb_build_object(
    'offering', 'oci-object-storage-bucket',
    'coverage', CASE WHEN complete THEN 'complete' ELSE 'incomplete' END,
    'items', items,
    'next', next_id
  );
END $$;

REVOKE ALL ON FUNCTION berth_inventory.inventory_page(uuid, integer)
  FROM PUBLIC, berth_runtime, berth_inventory_reader;
GRANT USAGE ON SCHEMA berth_inventory TO berth_inventory_reader;
GRANT EXECUTE ON FUNCTION berth_inventory.inventory_page(uuid, integer) TO berth_inventory_reader;
COMMIT;
