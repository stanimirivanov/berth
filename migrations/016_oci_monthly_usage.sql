-- Retain monthly request and outbound observations in the existing hourly slot.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
END $$;

ALTER TABLE berth_oci_allowances.storage ADD COLUMN monthly jsonb;

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
      )) || CASE WHEN monthly IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('monthly', monthly) END
      FROM berth_oci_allowances.storage WHERE tenancy = target),
    '{"attemptedAt":null,"gap":null,"reading":null}'::jsonb
  )
$$;

CREATE FUNCTION berth_oci_allowances.retain_monthly_meter(
  meter text, outcome jsonb, prior jsonb, delivery_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  observation jsonb := NULLIF(outcome->'reading', 'null'::jsonb);
  previous jsonb := NULLIF(prior->'reading', 'null'::jsonb);
  gap text := outcome->>'gap';
  complete boolean := gap IS NULL;
  observed timestamptz;
  responded timestamptz;
  expires timestamptz;
  period_start timestamptz;
  period_end timestamptz;
  through_at timestamptz;
BEGIN
  IF jsonb_typeof(outcome) IS DISTINCT FROM 'object'
    OR NOT outcome ?& ARRAY['gap', 'reading']
    OR outcome - ARRAY['gap', 'reading'] <> '{}'::jsonb
    OR (gap IS NOT NULL AND gap NOT IN ('account-unverified', 'oci-unavailable',
      'response-time-unverified', 'usage-coverage-unverified', 'accounting-cutoff-unverified')
      AND NOT (meter = 'outbound' AND gap = 'outbound-scope-unverified'))
    OR ((complete OR COALESCE(gap = 'accounting-cutoff-unverified', false))
      IS DISTINCT FROM (observation IS NOT NULL))
  THEN
    RAISE EXCEPTION 'Invalid monthly OCI outcome';
  END IF;
  IF observation IS NOT NULL THEN
    IF jsonb_typeof(observation) <> 'object'
      OR NOT observation ?& ARRAY['sku','used','source','coverage','periodStart','periodEnd',
        'observedAt','respondedAt','reportedThrough','accountingCutoff','expiresAt']
      OR observation - ARRAY['sku','used','source','coverage','periodStart','periodEnd',
        'observedAt','respondedAt','reportedThrough','accountingCutoff','expiresAt'] <> '{}'::jsonb
      OR (CASE WHEN meter = 'requests' THEN observation->>'sku' = 'B91627'
               ELSE observation->>'sku' IN ('B88327','B93455','B93456') END) IS DISTINCT FROM true
      OR observation->'source' <> '"OCI Usage API"'::jsonb
      OR observation->'coverage' IS DISTINCT FROM to_jsonb(CASE WHEN complete THEN 'complete' ELSE 'partial' END)
      OR observation->'accountingCutoff' IS DISTINCT FROM
        (CASE WHEN complete THEN observation->'reportedThrough' ELSE 'null'::jsonb END)
      OR jsonb_typeof(observation->'used') <> 'number'
      OR (observation->>'used' ~ '^\d{1,16}$') IS DISTINCT FROM true
      OR (observation->>'used')::numeric > 9007199254740991
      OR (NOT complete AND (observation->>'used')::numeric = 0)
      OR EXISTS (
        SELECT FROM unnest(ARRAY['periodStart','periodEnd','observedAt','respondedAt','reportedThrough','expiresAt']) key
        WHERE (observation->>key ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') IS DISTINCT FROM true
          OR to_char((observation->>key)::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            IS DISTINCT FROM observation->>key
      )
    THEN
      RAISE EXCEPTION 'Invalid monthly OCI reading';
    END IF;

    observed := (observation->>'observedAt')::timestamptz;
    responded := (observation->>'respondedAt')::timestamptz;
    expires := (observation->>'expiresAt')::timestamptz;
    period_start := (observation->>'periodStart')::timestamptz;
    period_end := (observation->>'periodEnd')::timestamptz;
    through_at := (observation->>'reportedThrough')::timestamptz;
    IF period_start <> date_trunc('month', observed, 'UTC')
      OR period_end <> ((period_start AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC')
      OR observed < delivery_at OR observed > clock_timestamp() + interval '30 seconds'
      OR through_at <= period_start OR through_at > responded OR responded > observed
      OR expires <= observed OR expires > period_end
      OR expires > (CASE WHEN complete THEN observed + interval '24 hours'
                         ELSE responded + interval '2 hours' END)
    THEN
      RAISE EXCEPTION 'Invalid monthly OCI period';
    END IF;
    -- A provisional refresh within the same month cannot replace a qualified observation.
    IF NOT complete AND previous->>'coverage' = 'complete'
      AND previous->>'periodStart' = observation->>'periodStart'
    THEN
      observation := previous;
    END IF;
  END IF;
  RETURN jsonb_build_object('gap', gap, 'reading', COALESCE(observation, previous));
END
$$;

ALTER FUNCTION berth_oci_allowances.finish_storage(text,timestamptz,text,jsonb) RENAME TO finish_storage_base;
REVOKE EXECUTE ON FUNCTION berth_oci_allowances.finish_storage_base(text,timestamptz,text,jsonb)
  FROM berth_oci_storage_runtime;

CREATE FUNCTION berth_oci_allowances.finish_storage(
  target text, delivery_at timestamptz, outcome_gap text, successful_reading jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  report jsonb := successful_reading->'monthly';
  storage_reading jsonb := successful_reading;
  unavailable constant jsonb := '{"gap":"oci-unavailable","reading":null}'::jsonb;
BEGIN
  IF report IS NOT NULL THEN
    IF NOT successful_reading ? 'storage'
      OR successful_reading - ARRAY['storage', 'monthly'] <> '{}'::jsonb
      OR jsonb_typeof(report) <> 'object'
      OR NOT report ?& ARRAY['requests', 'outbound']
      OR report - ARRAY['requests', 'outbound'] <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'Invalid monthly OCI result';
    END IF;
    storage_reading := NULLIF(successful_reading->'storage', 'null'::jsonb);
  END IF;

  IF NOT berth_oci_allowances.finish_storage_base(target, delivery_at, outcome_gap, storage_reading)
  THEN
    RETURN false;
  END IF;

  -- The old settlement holds the claimed row lock through validation and this update.
  UPDATE berth_oci_allowances.storage
    SET monthly = jsonb_build_object(
      'requests', berth_oci_allowances.retain_monthly_meter('requests', COALESCE(report->'requests', unavailable), monthly->'requests', delivery_at),
      'outbound', berth_oci_allowances.retain_monthly_meter('outbound', COALESCE(report->'outbound', unavailable), monthly->'outbound', delivery_at)
    )
    WHERE tenancy = target AND (report IS NOT NULL OR monthly IS NOT NULL);
  RETURN true;
END
$$;

REVOKE EXECUTE ON FUNCTION berth_oci_allowances.retain_monthly_meter(text,jsonb,jsonb,timestamptz),
  berth_oci_allowances.finish_storage(text,timestamptz,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_oci_allowances.finish_storage(text,timestamptz,text,jsonb)
  TO berth_oci_storage_runtime;
COMMIT;
