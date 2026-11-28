-- Store one current collector result per tenancy, with a durable hourly claim.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_roles r
    WHERE r.rolname = 'berth_oci_storage_runtime' AND r.rolcanlogin
      AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb
        OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
  ) THEN
    RAISE EXCEPTION 'Expected dedicated OCI storage runtime without role memberships';
  END IF;
END $$;

CREATE SCHEMA berth_oci_allowances;
REVOKE ALL ON SCHEMA berth_oci_allowances FROM PUBLIC;

CREATE TABLE berth_oci_allowances.storage (
  tenancy text PRIMARY KEY CHECK (tenancy ~ '^ocid1\.tenancy\.oc1\.\.[A-Za-z0-9]{1,128}$'),
  attempted_at timestamptz NOT NULL,
  gap text CHECK (gap IN ('oci-unavailable', 'account-unverified', 'region-coverage-unverified', 'storage-coverage-unverified', 'response-time-unverified', 'accounting-cutoff-unverified')),
  reading jsonb,
  settled boolean NOT NULL DEFAULT false
);

CREATE FUNCTION berth_oci_allowances.storage_snapshot(target text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
      'attemptedAt', to_char(attempted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'gap', gap, 'reading', reading)
      FROM berth_oci_allowances.storage WHERE tenancy = target),
    '{"attemptedAt":null,"gap":null,"reading":null}'::jsonb
  )
$$;

CREATE FUNCTION berth_oci_allowances.claim_storage(target text, delivery_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  claimed boolean;
BEGIN
  IF delivery_at > clock_timestamp() OR delivery_at < clock_timestamp() - interval '5 minutes' THEN
    RETURN false;
  END IF;

  INSERT INTO berth_oci_allowances.storage AS state (tenancy, attempted_at)
    VALUES (target, delivery_at)
    ON CONFLICT (tenancy) DO UPDATE
      SET attempted_at = delivery_at, settled = false
      WHERE date_trunc('hour', state.attempted_at, 'UTC') < date_trunc('hour', delivery_at, 'UTC')
    RETURNING true INTO claimed;
  RETURN COALESCE(claimed, false);
END
$$;

CREATE FUNCTION berth_oci_allowances.finish_storage(
  target text, delivery_at timestamptz, outcome_gap text, successful_reading jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  IF (outcome_gap IS NULL OR outcome_gap = 'accounting-cutoff-unverified')
       IS DISTINCT FROM (successful_reading IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid OCI storage outcome';
  END IF;
  IF successful_reading IS NOT NULL THEN
    IF jsonb_typeof(successful_reading) <> 'object'
       OR NOT successful_reading ?& ARRAY['usedBytes', 'limitBytes', 'source', 'observedAt',
         'respondedAt', 'accountingCutoff', 'expiresAt']
       OR successful_reading - ARRAY['usedBytes', 'limitBytes', 'source', 'observedAt',
         'respondedAt', 'accountingCutoff', 'expiresAt'] <> '{}'::jsonb
       OR successful_reading->'source' <> '"OCI"'::jsonb
       OR successful_reading->'limitBytes' <> '20000000000'::jsonb
       OR jsonb_typeof(successful_reading->'usedBytes') <> 'number'
       OR successful_reading->>'usedBytes' !~ '^\d{1,16}$'
       OR (successful_reading->>'usedBytes')::numeric > 9007199254740991
       OR (successful_reading->'accountingCutoff' = 'null'::jsonb) IS DISTINCT FROM
         (outcome_gap IS NOT NULL)
       OR EXISTS (
         SELECT FROM unnest(ARRAY['observedAt', 'respondedAt', 'accountingCutoff', 'expiresAt']) key
         WHERE NOT (key = 'accountingCutoff' AND outcome_gap IS NOT NULL)
           AND (successful_reading->>key ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') IS DISTINCT FROM true
       )
       OR (successful_reading->>'observedAt')::timestamptz < delivery_at
       OR (successful_reading->>'observedAt')::timestamptz > clock_timestamp() + interval '30 seconds'
       OR (successful_reading->>'accountingCutoff')::timestamptz > (successful_reading->>'respondedAt')::timestamptz
       OR (successful_reading->>'respondedAt')::timestamptz > (successful_reading->>'observedAt')::timestamptz
       OR (successful_reading->>'observedAt')::timestamptz >= (successful_reading->>'expiresAt')::timestamptz
       OR (successful_reading->>'expiresAt')::timestamptz >
         COALESCE((successful_reading->>'accountingCutoff')::timestamptz,
                  (successful_reading->>'respondedAt')::timestamptz) + interval '2 hours'
    THEN
      RAISE EXCEPTION 'Invalid OCI storage reading';
    END IF;
  END IF;
  UPDATE berth_oci_allowances.storage
    SET gap = outcome_gap,
      reading = CASE WHEN outcome_gap = 'accounting-cutoff-unverified'
        AND reading->>'accountingCutoff' IS NOT NULL THEN reading
        ELSE COALESCE(successful_reading, reading) END,
      settled = true
    WHERE tenancy = target AND attempted_at = delivery_at AND NOT settled;
  RETURN FOUND;
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_oci_allowances FROM PUBLIC;
GRANT USAGE ON SCHEMA berth_oci_allowances TO berth_oci_storage_runtime;
GRANT EXECUTE ON FUNCTION berth_oci_allowances.storage_snapshot(text),
  berth_oci_allowances.claim_storage(text,timestamptz),
  berth_oci_allowances.finish_storage(text,timestamptz,text,jsonb)
  TO berth_oci_storage_runtime;
COMMIT;
