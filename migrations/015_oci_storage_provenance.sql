-- Keep the settled slot separate from the latest claim and stamp new claims on the database clock.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
END $$;

ALTER TABLE berth_oci_allowances.storage
  ADD COLUMN last_settled_attempt_at timestamptz,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN previous_observation_stale boolean NOT NULL DEFAULT false;
-- A legacy pending slot overwrote the previous slot timestamp. Leave both times unknown.
UPDATE berth_oci_allowances.storage SET last_settled_attempt_at = attempted_at WHERE settled;

CREATE OR REPLACE FUNCTION berth_oci_allowances.storage_snapshot(target text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
      'attemptedAt', to_char(attempted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'gap', gap, 'reading', reading,
      'provenance', jsonb_build_object(
        'lastSettledAttemptAt', to_char(last_settled_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'pending', CASE WHEN NOT settled THEN jsonb_build_object(
          'startedAt', to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'overdueAt', to_char((claimed_at + interval '10 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) || CASE WHEN previous_observation_stale THEN '{"previousObservationStale":true}'::jsonb
                  ELSE '{}'::jsonb END END
      ))
      FROM berth_oci_allowances.storage WHERE tenancy = target),
    '{"attemptedAt":null,"gap":null,"reading":null}'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION berth_oci_allowances.claim_storage(target text, delivery_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  claimed boolean;
BEGIN
  IF delivery_at > clock_timestamp() OR delivery_at < clock_timestamp() - interval '5 minutes' THEN
    RETURN false;
  END IF;

  INSERT INTO berth_oci_allowances.storage AS state (tenancy, attempted_at, claimed_at)
    VALUES (target, delivery_at, clock_timestamp())
    ON CONFLICT (tenancy) DO UPDATE
      SET attempted_at = delivery_at, claimed_at = clock_timestamp(), settled = false,
        -- Compare the old claim at the same millisecond precision exposed by storage_snapshot.
        previous_observation_stale = NOT state.settled AND (
          state.previous_observation_stale OR state.claimed_at IS NULL OR
          date_trunc('milliseconds', state.claimed_at) <= clock_timestamp() - interval '10 seconds'
        )
      WHERE date_trunc('hour', state.attempted_at, 'UTC') < date_trunc('hour', delivery_at, 'UTC')
    RETURNING true INTO claimed;
  RETURN COALESCE(claimed, false);
END
$$;

CREATE OR REPLACE FUNCTION berth_oci_allowances.finish_storage(
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
      last_settled_attempt_at = delivery_at,
      claimed_at = NULL,
      previous_observation_stale = false,
      settled = true
    WHERE tenancy = target AND attempted_at = delivery_at AND NOT settled;
  RETURN FOUND;
END
$$;

COMMIT;
