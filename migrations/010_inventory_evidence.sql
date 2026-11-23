-- Install after the fenced executor and managed inventory. Existing checkpoints
-- stay unqualified until receipt intake establishes what happened.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
END $$;

CREATE ROLE berth_inventory_recorder NOLOGIN NOINHERIT;
-- Evidence intake validates retained operations with ordinary reads. Do not
-- acquire an FK lock on the operation row that also carries the cleanup fence.
ALTER TABLE berth_inventory.instances DROP CONSTRAINT instances_operation_fkey;
ALTER TABLE berth_inventory.operation_coverage DROP CONSTRAINT operation_coverage_operation_fkey;
CREATE TABLE berth_inventory.evidence (
  source text NOT NULL CHECK (source IN ('executor', 'owner')),
  reference text NOT NULL,
  operation uuid NOT NULL,
  provider_id text NOT NULL,
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  kind text NOT NULL,
  proof jsonb NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('recorded', 'conflict')),
  PRIMARY KEY (source, reference)
);
CREATE TABLE berth_inventory.evidence_conflicts (
  source text NOT NULL,
  reference text NOT NULL,
  conflicting_receipt jsonb NOT NULL,
  FOREIGN KEY (source, reference) REFERENCES berth_inventory.evidence(source, reference)
);
REVOKE ALL ON berth_inventory.evidence, berth_inventory.evidence_conflicts
  FROM PUBLIC, berth_runtime, berth_inventory_reader, berth_inventory_recorder;

-- Serialize the projection separately from the operation and provider budgets.
-- The unique OCI identity also serializes competing claims across operations.
CREATE FUNCTION berth_inventory.append_evidence(
  p_operation uuid, p_provider_id text, p_time timestamptz, p_kind text,
  p_source text, p_reference text, p_proof jsonb
) RETURNS text LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  trial berth_ledger.trials%ROWTYPE;
  prior berth_inventory.evidence%ROWTYPE;
  same_time text;
  conflict boolean := false;
BEGIN
  SELECT * INTO STRICT trial FROM berth_ledger.trials
    WHERE operation = p_operation;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation::text, 90310));

  -- Record a source reference once, even if two operations claim it concurrently.
  INSERT INTO berth_inventory.evidence
    (source, reference, operation, provider_id, observed_at, kind, proof, disposition)
  VALUES (p_source, p_reference, p_operation, p_provider_id, p_time, p_kind, p_proof, 'recorded')
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO STRICT prior FROM berth_inventory.evidence
      WHERE source = p_source AND reference = p_reference;
    IF (prior.operation, prior.provider_id, prior.observed_at, prior.kind, prior.proof)
      IS NOT DISTINCT FROM (p_operation, p_provider_id, p_time, p_kind, p_proof) THEN
      RETURN CASE WHEN prior.disposition = 'recorded' THEN 'already-recorded' ELSE 'conflict' END;
    END IF;
    INSERT INTO berth_inventory.evidence_conflicts VALUES (
      p_source, p_reference, jsonb_build_object(
        'operation', p_operation, 'id', p_provider_id, 'observedAt', p_time,
        'kind', p_kind, 'proof', p_proof
      )
    );
    INSERT INTO berth_inventory.operation_coverage VALUES (p_operation, 'gap', p_time)
      ON CONFLICT (operation) DO UPDATE SET disposition = 'gap';
    RETURN 'conflict';
  END IF;

  INSERT INTO berth_inventory.instances (provider_id, operation, region, display_name)
    SELECT p_provider_id, p_operation, trial.region, trial.bucket
    WHERE NOT EXISTS (
      SELECT FROM berth_executor.work
      WHERE operation = p_operation AND bucket IS NOT NULL AND bucket->>'id' <> p_provider_id
    )
    ON CONFLICT DO NOTHING;
  SELECT kind INTO same_time FROM berth_inventory.observations
    WHERE provider_id = p_provider_id AND observed_at = p_time;
  conflict := NOT EXISTS (
    SELECT FROM berth_inventory.instances WHERE provider_id = p_provider_id AND operation = p_operation
  ) OR EXISTS (
    SELECT FROM berth_executor.work
    WHERE operation = p_operation AND bucket IS NOT NULL AND bucket->>'id' <> p_provider_id
  ) OR (same_time IS NOT NULL AND same_time <> p_kind) OR EXISTS (
    SELECT FROM berth_inventory.observations o WHERE o.provider_id = p_provider_id AND (
      (p_kind <> 'removed' AND o.kind = 'removed' AND o.observed_at < p_time)
      OR (p_kind = 'removed' AND o.kind = 'present' AND o.observed_at > p_time)
    )
  );

  IF conflict THEN
    UPDATE berth_inventory.evidence SET disposition = 'conflict'
      WHERE source = p_source AND reference = p_reference;
    INSERT INTO berth_inventory.operation_coverage VALUES (p_operation, 'gap', p_time)
      ON CONFLICT (operation) DO UPDATE SET disposition = 'gap';
    RETURN 'conflict';
  END IF;

  INSERT INTO berth_inventory.observations (provider_id, observed_at, kind, source)
    VALUES (p_provider_id, p_time, p_kind, p_source)
    ON CONFLICT DO NOTHING;
  RETURN 'recorded';
END $$;

-- The owner vouches for the retained authenticated source. SQL validates
-- the normalized proof, the exact operation binding, and append ordering.
CREATE FUNCTION berth_inventory.submit_owner_receipt(p_receipt jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  trial berth_ledger.trials%ROWTYPE;
  target jsonb := p_receipt->'bucket';
  proof jsonb := p_receipt->'observation';
  kind text := p_receipt->>'kind';
  observed timestamptz;
  ref_pattern constant text := '^[A-Za-z0-9._:/-]{1,200}$';
BEGIN
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object'
    OR octet_length(p_receipt::text) > 8192
    OR (SELECT count(*) FROM jsonb_object_keys(p_receipt)) <> 6
    OR NOT (p_receipt ?& ARRAY['reference','operation','observedAt','kind','bucket','observation'])
    OR jsonb_typeof(p_receipt->'reference') IS DISTINCT FROM 'string'
    OR NOT coalesce(p_receipt->>'reference' ~ ref_pattern, false)
    OR NOT coalesce(p_receipt->>'operation' ~ '^[a-f0-9-]{36}$', false)
    OR NOT coalesce(p_receipt->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$', false)
    OR kind IS NULL OR kind NOT IN ('present', 'removed')
    OR jsonb_typeof(target) IS DISTINCT FROM 'object'
    OR jsonb_typeof(proof) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'Owner receipt rejected';
  END IF;

  BEGIN
    SELECT * INTO trial FROM berth_ledger.trials WHERE operation = (p_receipt->>'operation')::uuid;
    observed := (p_receipt->>'observedAt')::timestamptz;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'Owner receipt rejected';
  END;
  IF trial.operation IS NULL
    OR (trial.namespace = 'berthsynthetic' AND trial.compartment = 'ocid1.compartment.oc1..synthetic')
    OR observed < trial.started_at
    OR observed > clock_timestamp() + interval '1 minute'
    OR (SELECT count(*) FROM jsonb_object_keys(target)) <> 8
    OR target->>'region' IS DISTINCT FROM trial.region
    OR target->>'namespace' IS DISTINCT FROM trial.namespace
    OR target->>'compartment' IS DISTINCT FROM trial.compartment
    OR target->>'name' IS DISTINCT FROM trial.bucket
    OR target->>'operationTag' IS DISTINCT FROM trial.operation::text
    OR target->>'marker' IS DISTINCT FROM trial.marker::text
    OR NOT coalesce(target->>'id' ~ '^ocid1[.]bucket[.][A-Za-z0-9._-]{1,200}$', false)
    OR jsonb_typeof(target->'etag') IS DISTINCT FROM 'string'
    OR NOT coalesce(length(target->>'etag') BETWEEN 1 AND 256, false)
  THEN
    RAISE EXCEPTION 'Owner receipt rejected';
  END IF;

  IF kind = 'present' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(proof)) <> 2
      OR proof->'status' IS DISTINCT FROM '200'::jsonb
      OR jsonb_typeof(proof->'requestId') IS DISTINCT FROM 'string'
      OR NOT coalesce(proof->>'requestId' ~ ref_pattern, false)
    THEN
      RAISE EXCEPTION 'Owner receipt rejected';
    END IF;
  ELSE
    IF (SELECT count(*) FROM jsonb_object_keys(proof)) <> 8
      OR proof->'deleteStatus' IS DISTINCT FROM '204'::jsonb
      OR jsonb_typeof(proof->'ifMatch') IS DISTINCT FROM 'string'
      OR proof->>'ifMatch' IS DISTINCT FROM target->>'etag'
      OR proof->'absentStatus' IS DISTINCT FROM '404'::jsonb
      OR proof->'listingComplete' IS DISTINCT FROM 'true'::jsonb
      OR proof->'targetListed' IS DISTINCT FROM 'false'::jsonb
      OR jsonb_typeof(proof->'deleteRequestId') IS DISTINCT FROM 'string'
      OR NOT coalesce(proof->>'deleteRequestId' ~ ref_pattern, false)
      OR jsonb_typeof(proof->'getRequestId') IS DISTINCT FROM 'string'
      OR NOT coalesce(proof->>'getRequestId' ~ ref_pattern, false)
      OR jsonb_typeof(proof->'listRequestId') IS DISTINCT FROM 'string'
      OR NOT coalesce(proof->>'listRequestId' ~ ref_pattern, false)
      OR (SELECT count(DISTINCT id) FROM unnest(ARRAY[
        proof->>'deleteRequestId', proof->>'getRequestId', proof->>'listRequestId'
      ]) id) <> 3
    THEN
      RAISE EXCEPTION 'Owner receipt rejected';
    END IF;
  END IF;

  RETURN berth_inventory.append_evidence(
    trial.operation, target->>'id', observed, kind, 'owner',
    p_receipt->>'reference', p_receipt
  );
END $$;

-- Only the fenced executor writes this outbox. Owner receipt transactions
-- never take the executor's row lock or hold a lock on the outbox.
CREATE TABLE berth_inventory.executor_events (
  reference text PRIMARY KEY,
  operation uuid NOT NULL,
  provider_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('present', 'removed', 'delete-prepared')),
  proof jsonb NOT NULL
);
REVOKE ALL ON berth_inventory.executor_events
  FROM PUBLIC, berth_runtime, berth_inventory_reader, berth_inventory_recorder;

-- The executor supplies the exact validated create or GET response reference.
CREATE FUNCTION berth_inventory.executor_presence(
  p_operation uuid, p_owner uuid, p_generation bigint, p_request uuid, p_bucket jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '150ms' AS $$
DECLARE
  trial berth_ledger.trials%ROWTYPE;
  observed timestamptz;
BEGIN
  trial := berth_ledger.guard(p_operation, p_owner, p_generation);
  IF trial.namespace = 'berthsynthetic' AND trial.compartment = 'ocid1.compartment.oc1..synthetic'
    THEN RETURN; END IF;
  IF NOT coalesce(berth_executor.valid_bucket(p_bucket, trial), false)
    OR NOT EXISTS (SELECT FROM berth_ledger.requests r JOIN berth_ledger.attempts a ON a.id = r.attempt
      WHERE r.operation = p_operation AND r.outcome IN ('unresolved', 'succeeded')
        AND a.action = 'create_bucket') THEN
    RAISE EXCEPTION 'Executor evidence rejected';
  END IF;
  SELECT r.resolved_at INTO STRICT observed FROM berth_ledger.requests r
    JOIN berth_ledger.attempts a ON a.id = r.attempt
    WHERE r.operation = p_operation AND r.id = p_request AND r.outcome = 'succeeded'
      AND r.generation = p_generation AND a.action IN ('create_bucket', 'inspect', 'inspect_cleanup');
  INSERT INTO berth_inventory.executor_events VALUES (
    p_request::text || '/presence', p_operation, p_bucket->>'id',
    observed, 'present', p_bucket
  ) ON CONFLICT DO NOTHING;
END $$;

-- Pin the revision before sending DELETE. Record removal only from the
-- provider path that verified a complete, empty listing after that request.
CREATE FUNCTION berth_inventory.executor_receipt(
  p_operation uuid, p_owner uuid, p_generation bigint, p_request uuid,
  p_listing uuid, p_bucket jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '150ms' AS $$
DECLARE
  trial berth_ledger.trials%ROWTYPE;
  request berth_ledger.requests%ROWTYPE;
  prepared berth_inventory.executor_events%ROWTYPE;
  observed timestamptz;
BEGIN
  trial := berth_ledger.guard(p_operation, p_owner, p_generation);
  IF trial.namespace = 'berthsynthetic' AND trial.compartment = 'ocid1.compartment.oc1..synthetic'
    THEN RETURN; END IF;
  SELECT r.* INTO STRICT request FROM berth_ledger.requests r
    JOIN berth_ledger.attempts a ON a.id = r.attempt
    WHERE r.operation = p_operation AND r.id = p_request AND a.action = 'delete_bucket';
  IF NOT coalesce(berth_executor.valid_bucket(p_bucket, trial), false)
    OR NOT EXISTS (SELECT FROM berth_executor.work WHERE operation = p_operation
      AND bucket->>'id' = p_bucket->>'id') THEN
    RAISE EXCEPTION 'Executor evidence rejected';
  END IF;

  IF p_listing IS NULL THEN
    IF request.generation <> p_generation OR request.outcome <> 'unresolved' THEN
      RAISE EXCEPTION 'Executor evidence rejected';
    END IF;
    INSERT INTO berth_inventory.executor_events VALUES (
      p_request::text || '/delete-prepared', p_operation, p_bucket->>'id',
      request.reserved_at, 'delete-prepared', p_bucket
    );
    RETURN;
  END IF;

  SELECT * INTO prepared FROM berth_inventory.executor_events
    WHERE reference = p_request::text || '/delete-prepared' AND operation = p_operation;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT r.resolved_at INTO STRICT observed FROM berth_ledger.requests r
    JOIN berth_ledger.attempts a ON a.id = r.attempt
    WHERE r.operation = p_operation AND r.id = p_listing AND r.outcome = 'succeeded'
      AND r.generation = p_generation AND a.action = 'inspect_cleanup'
      AND r.reserved_at >= coalesce(request.resolved_at, request.reserved_at);
  IF request.outcome NOT IN ('succeeded', 'unresolved')
    OR prepared.provider_id <> p_bucket->>'id' THEN
    RAISE EXCEPTION 'Executor evidence rejected';
  END IF;
  INSERT INTO berth_inventory.executor_events VALUES (
    p_request::text || '/removal', p_operation, prepared.provider_id, observed,
    'removed', prepared.proof || jsonb_build_object('absenceRequest', p_listing)
  ) ON CONFLICT DO NOTHING;
END $$;

-- Flush at most the closed trial's bounded evidence set, without an execution
-- claim. Only the trusted outbox can source these observations.
CREATE FUNCTION berth_inventory.publish_executor(p_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '150ms' AS $$
DECLARE
  item berth_inventory.executor_events%ROWTYPE;
BEGIN
  FOR item IN SELECT queued.* FROM berth_inventory.executor_events queued
      WHERE queued.operation = p_operation AND queued.kind <> 'delete-prepared'
        AND NOT EXISTS (SELECT FROM berth_inventory.evidence saved
          WHERE saved.source = 'executor' AND saved.reference = queued.reference)
      ORDER BY queued.observed_at
  LOOP
    PERFORM berth_inventory.append_evidence(
      item.operation, item.provider_id, item.observed_at, item.kind,
      'executor', item.reference, item.proof
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION berth_inventory.inventory_page(p_after uuid DEFAULT NULL, p_limit integer DEFAULT 20)
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
      SELECT FROM berth_inventory.executor_events queued
      WHERE queued.kind <> 'delete-prepared' AND NOT EXISTS (
        SELECT FROM berth_inventory.evidence saved
        WHERE saved.source = 'executor' AND saved.reference = queued.reference
      )
    )
    AND NOT EXISTS (
      SELECT
      FROM berth_ledger.trials t
      LEFT JOIN berth_inventory.instances i ON i.operation = t.operation
      LEFT JOIN berth_inventory.operation_coverage c ON c.operation = t.operation
      WHERE NOT (t.namespace = 'berthsynthetic' AND t.compartment = 'ocid1.compartment.oc1..synthetic')
        AND (c.disposition = 'gap'
        OR (i.id IS NULL AND c.disposition IS DISTINCT FROM 'no-instance')
        OR (i.id IS NOT NULL AND (
          c.disposition = 'no-instance'
          OR NOT EXISTS (
            SELECT FROM berth_inventory.observations o WHERE o.provider_id = i.provider_id
          )
        )))
    )
  INTO complete;

  FOR item IN
    SELECT i.id, i.display_name, i.region, i.operation, latest.kind,
      latest.observed_at, verified.observed_at AS last_verified_at
    FROM berth_inventory.instances i
    JOIN LATERAL (
      SELECT dated.kind, dated.observed_at FROM (
        SELECT o.kind, o.observed_at, false AS pending FROM berth_inventory.observations o
        WHERE o.provider_id = i.provider_id
        UNION ALL
        SELECT 'delete-unresolved', r.reserved_at, true
        FROM berth_ledger.requests r
        JOIN berth_ledger.attempts a ON a.id = r.attempt
        JOIN berth_executor.work w ON w.operation = r.operation
        WHERE r.operation = i.operation AND w.bucket->>'id' = i.provider_id
          AND a.action = 'delete_bucket' AND r.outcome <> 'rejected'
          AND NOT EXISTS (SELECT FROM berth_inventory.observations removed
            WHERE removed.provider_id = i.provider_id AND removed.kind = 'removed'
              AND removed.observed_at >= r.reserved_at)
      ) dated
      ORDER BY dated.pending DESC, dated.observed_at DESC, dated.kind
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_inventory FROM PUBLIC, berth_runtime;
GRANT USAGE ON SCHEMA berth_inventory TO berth_inventory_recorder, berth_runtime;
GRANT EXECUTE ON FUNCTION berth_inventory.submit_owner_receipt(jsonb) TO berth_inventory_recorder;
GRANT EXECUTE ON FUNCTION berth_inventory.executor_receipt(uuid,uuid,bigint,uuid,uuid,jsonb),
  berth_inventory.executor_presence(uuid,uuid,bigint,uuid,jsonb),
  berth_inventory.publish_executor(uuid) TO berth_runtime;
COMMIT;
