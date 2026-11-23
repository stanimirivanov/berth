-- Bounded retry reconciliation has its own authority and counters.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
END $$;

CREATE ROLE berth_retry_action NOLOGIN NOINHERIT;
CREATE SCHEMA berth_retry AUTHORIZATION neondb_owner;
REVOKE ALL ON SCHEMA berth_retry FROM PUBLIC;
ALTER TABLE berth_inventory.evidence DROP CONSTRAINT evidence_source_check,
  ADD CONSTRAINT evidence_source_check CHECK (source IN ('executor','owner','reconciliation'));
ALTER TABLE berth_inventory.observations DROP CONSTRAINT observations_source_check,
  ADD CONSTRAINT observations_source_check CHECK (source IN ('executor','owner','reconciliation'));

-- The saved operation is checked on admission and completion without taking its
-- execution fence. Holding a retry transaction cannot lock out old cleanup.
CREATE TABLE berth_retry.reconciliations (
  operation uuid PRIMARY KEY,
  claim uuid NOT NULL,
  generation bigint NOT NULL,
  scope text NOT NULL CHECK (scope IN ('original-window','after-expiry')),
  started_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  used integer NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 2),
  finished_at timestamptz,
  result text CHECK (result IN ('owned-instance','safe-write-needed')),
  reason text,
  observed_at timestamptz
);
REVOKE ALL ON ALL TABLES IN SCHEMA berth_retry FROM PUBLIC, berth_runtime, berth_retry_action;

-- The same allowlist applies to first replies, duplicate starts and retained status.
CREATE FUNCTION berth_retry.summary(r berth_retry.reconciliations)
RETURNS jsonb LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp SET timezone = 'UTC' AS $$
  SELECT jsonb_build_object(
    'operation', r.operation,
    'stage', CASE WHEN r.result IS NOT NULL THEN 'completed'
      WHEN r.finished_at IS NOT NULL OR statement_timestamp() >= r.deadline THEN 'needs-attention'
      ELSE 'checking-provider' END,
    'scope', r.scope,
    'result', r.result,
    'reason', coalesce(r.reason, CASE WHEN r.finished_at IS NULL
      AND statement_timestamp() >= r.deadline THEN 'check-interrupted' END),
    'ownerProcedure', CASE WHEN r.reason = 'read-scope-unavailable'
      THEN 'https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-reconciliation.md#installation-prerequisites'
      WHEN r.reason IS NOT NULL OR
      (r.finished_at IS NULL AND statement_timestamp() >= r.deadline)
      THEN 'https://github.com/stanimirivanov/berth/blob/main/docs/trial/owner-recovery.md#4-stop-conditions-and-leftovers' END,
    'observedAt', r.observed_at,
    'startedAt', r.started_at,
    'checks', jsonb_build_object('used', r.used, 'limit', 2)
  )
$$;

CREATE FUNCTION berth_retry.status(p_operation uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT berth_retry.summary(r) FROM berth_retry.reconciliations r WHERE r.operation = p_operation
$$;

-- Claim a single attempt per saved operation. A duplicate never receives a
-- target or an execution claim, even after the deadline passes.
CREATE FUNCTION berth_retry.begin(p_operation uuid, p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
DECLARE
  t berth_ledger.trials%ROWTYPE;
  r berth_retry.reconciliations%ROWTYPE;
  w berth_executor.work%ROWTYPE;
  now_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO r FROM berth_retry.reconciliations WHERE operation = p_operation;
  IF FOUND THEN RETURN jsonb_build_object('status', berth_retry.summary(r)); END IF;

  SELECT * INTO t FROM berth_ledger.trials WHERE operation = p_operation;
  IF NOT FOUND OR p_claim IS NULL OR t.started_at > now_at
    OR (t.namespace = 'berthsynthetic' AND t.compartment = 'ocid1.compartment.oc1..synthetic')
    OR t.bucket <> 'berth-' || replace(t.operation::text, '-', '')
  THEN RETURN NULL; END IF;

  r.operation := p_operation;
  r.claim := p_claim;
  r.generation := t.generation;
  r.started_at := now_at;
  r.scope := CASE WHEN now_at < t.expires_at THEN 'original-window' ELSE 'after-expiry' END;
  r.deadline := CASE WHEN r.scope = 'original-window'
    THEN least(now_at + interval '20 seconds', t.started_at + interval '30 minutes', t.expires_at)
    ELSE now_at + interval '20 seconds' END;
  r.used := 0;
  SELECT * INTO w FROM berth_executor.work WHERE operation = p_operation;
  r.reason := CASE
    WHEN t.outcome = 'succeeded' THEN 'operation-completed'
    WHEN t.lease_until > now_at THEN 'operation-busy'
    WHEN r.scope = 'original-window' AND
      (t.cleanup_started OR coalesce(w.cleanup_requested, false) OR w.phase = 'cleanup')
      THEN 'cleanup-started'
    WHEN r.scope = 'original-window' AND (now_at >= r.deadline OR t.outcome <> 'active')
      THEN 'creation-window-closed' END;
  -- Admission denials do not consume the one available provider check.
  IF r.reason IS NOT NULL THEN
    r.finished_at := now_at;
    RETURN jsonb_build_object('status', berth_retry.summary(r));
  END IF;

  INSERT INTO berth_retry.reconciliations VALUES (r.*)
    ON CONFLICT (operation) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', berth_retry.status(p_operation));
  END IF;
  RETURN jsonb_build_object(
    'status', berth_retry.summary(r), 'deadline', r.deadline,
    'target', jsonb_build_object('region',t.region,'namespace',t.namespace,'compartment',t.compartment,'bucket',t.bucket)
  );
END $$;

-- Reserve and commit one GET before dispatch. A lost request or acknowledgement
-- keeps its charge. Re-check the original operation without locking its fence.
CREATE FUNCTION berth_retry.reserve(p_operation uuid, p_claim uuid, p_probe text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
DECLARE
  authority text;
BEGIN
  SELECT scope INTO authority FROM berth_retry.reconciliations
    WHERE operation = p_operation AND claim = p_claim;
  -- In-window inspections share the original normal-request budget. The trial
  -- row is locked only for that original authority, never after expiry.
  IF authority = 'original-window' THEN
    PERFORM 1 FROM berth_ledger.trials
      WHERE operation = p_operation AND normal_used < 160
        AND clock_timestamp() < expires_at FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  UPDATE berth_retry.reconciliations r SET used = used + 1
  FROM berth_ledger.trials t
  WHERE r.operation = p_operation AND t.operation = r.operation AND r.claim = p_claim
    AND r.finished_at IS NULL AND clock_timestamp() < r.deadline
    AND (r.used,p_probe) IN ((0,'bucket'),(1,'list'))
    AND r.generation = t.generation AND t.lease_until <= clock_timestamp()
    AND (r.scope = 'after-expiry' OR (
      t.outcome = 'active' AND NOT t.cleanup_started AND NOT EXISTS (
        SELECT FROM berth_executor.work w WHERE w.operation = r.operation
          AND (w.cleanup_requested OR w.phase = 'cleanup')
      )
    ));
  IF NOT FOUND THEN RETURN false; END IF;
  IF authority = 'original-window' THEN
    UPDATE berth_ledger.trials SET normal_used = normal_used + 1 WHERE operation = p_operation;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION berth_retry.finish(p_operation uuid, p_claim uuid, p_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
DECLARE
  t berth_ledger.trials%ROWTYPE;
  w berth_executor.work%ROWTYPE;
  r berth_retry.reconciliations%ROWTYPE;
  kind text := p_proof->>'kind';
  identity text := p_proof->>'id';
  observed timestamptz := clock_timestamp();
  provider_time timestamptz;
  unresolved boolean;
  cleanup boolean;
  recorded text;
BEGIN
  SELECT * INTO r FROM berth_retry.reconciliations
    WHERE operation = p_operation AND claim = p_claim FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.finished_at IS NOT NULL OR observed >= r.deadline THEN
    RETURN berth_retry.summary(r);
  END IF;
  IF kind IN ('present','absent') AND coalesce(
    p_proof->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$', false
  ) THEN
    BEGIN
      provider_time := (p_proof->>'observedAt')::timestamptz;
    EXCEPTION WHEN data_exception THEN
      provider_time := NULL;
    END;
  END IF;
  IF provider_time < r.started_at - interval '1 second'
    OR provider_time > observed + interval '1 second'
  THEN provider_time := NULL; END IF;
  SELECT * INTO t FROM berth_ledger.trials WHERE operation = p_operation;
  SELECT * INTO w FROM berth_executor.work WHERE operation = p_operation;
  SELECT EXISTS (SELECT FROM berth_ledger.requests q
    JOIN berth_ledger.attempts a ON a.id = q.attempt
    WHERE q.operation = p_operation AND q.mutation AND q.outcome = 'unresolved'
      AND (kind <> 'present' OR a.action <> 'create_bucket')) INTO unresolved;
  cleanup := t.cleanup_started OR coalesce(w.cleanup_requested OR w.phase = 'cleanup', false) OR EXISTS (
    SELECT FROM berth_ledger.attempts WHERE operation = p_operation
      AND action IN ('delete_bucket','delete_object')
  );

  IF t.operation IS NULL OR r.generation <> t.generation OR t.lease_until > observed
    OR (r.scope = 'original-window' AND (t.outcome <> 'active' OR t.cleanup_started OR cleanup OR w.phase = 'cleanup'))
  THEN r.reason := 'operation-changed';
  ELSIF kind = 'scope-unavailable' AND r.used = 0 THEN
    r.reason := 'read-scope-unavailable';
  ELSIF kind = 'reservation-refused' THEN
    r.reason := CASE WHEN r.scope = 'original-window' AND t.normal_used >= 160
      THEN 'normal-budget-exhausted' ELSE 'operation-changed' END;
  ELSIF kind = 'present' AND provider_time IS NOT NULL AND r.used = 1 AND octet_length(p_proof::text) <= 4096 THEN
    IF p_proof->>'operation' IS DISTINCT FROM t.operation::text
      OR p_proof->>'marker' IS DISTINCT FROM t.marker::text
      OR p_proof->>'namespace' IS DISTINCT FROM t.namespace
      OR p_proof->>'compartment' IS DISTINCT FROM t.compartment
      OR p_proof->>'name' IS DISTINCT FROM t.bucket
      OR NOT coalesce(identity ~ '^ocid1[.]bucket[.][A-Za-z0-9._-]{1,200}$', false)
      OR NOT coalesce(length(p_proof->>'etag') BETWEEN 1 AND 256, false)
      OR NOT coalesce(p_proof->>'requestId' ~ '^[A-Za-z0-9._:/-]{1,200}$', false)
      OR (w.bucket IS NOT NULL AND w.bucket->>'id' IS DISTINCT FROM identity)
      OR (w.state->'attr'->>'id' IS NOT NULL AND w.state->'attr'->>'id' <> identity)
      OR EXISTS (SELECT FROM berth_inventory.executor_events
        WHERE operation = p_operation AND provider_id <> identity)
    THEN r.reason := 'ownership-conflict';
    ELSE
      r.observed_at := provider_time;
      BEGIN
        recorded := berth_inventory.append_evidence(
          p_operation, identity, provider_time, 'present', 'reconciliation',
          'retry/' || r.claim::text, p_proof
        );
      EXCEPTION WHEN lock_not_available THEN
        r.reason := 'evidence-unavailable';
      END;
      IF r.reason IS NULL THEN
        CASE
          WHEN recorded = 'conflict' THEN r.reason := 'ownership-conflict';
          WHEN cleanup THEN r.reason := 'cleanup-started';
          WHEN EXISTS (SELECT FROM berth_inventory.observations o
            WHERE o.provider_id = identity AND o.kind = 'removed' AND o.observed_at >= provider_time
          ) OR EXISTS (SELECT FROM berth_inventory.executor_events e
            WHERE e.operation = p_operation AND e.provider_id = identity
              AND e.kind = 'removed' AND e.observed_at >= provider_time
          ) THEN r.reason := 'newer-removal-recorded';
          WHEN p_proof->'configurationMatches' IS DISTINCT FROM 'true'::jsonb
            THEN r.reason := 'bucket-configuration-drift';
          WHEN unresolved THEN r.reason := 'unresolved-prior-write';
          ELSE r.result := 'owned-instance';
        END CASE;
      END IF;
    END IF;
  ELSIF kind = 'absent' AND provider_time IS NOT NULL AND r.used = 2 THEN
    r.observed_at := provider_time;
    CASE
      WHEN cleanup THEN r.reason := 'cleanup-started';
      WHEN unresolved THEN r.reason := 'unresolved-prior-write';
      WHEN w.bucket IS NOT NULL OR w.state->'attr'->>'id' IS NOT NULL OR EXISTS (
        SELECT FROM berth_inventory.executor_events WHERE operation = p_operation
      ) OR EXISTS (
        SELECT FROM berth_inventory.instances WHERE operation = p_operation
      ) OR EXISTS (
        SELECT FROM berth_ledger.requests q
        JOIN berth_ledger.attempts a ON a.id = q.attempt
        WHERE q.operation = p_operation AND a.action = 'create_bucket'
          AND (q.outcome <> 'rejected' OR q.basis IS NULL OR q.basis NOT IN ('provider-response','not-dispatched'))
      ) THEN r.reason := 'expected-instance-not-found';
      ELSE r.result := 'safe-write-needed';
    END CASE;
  ELSE
    r.reason := 'provider-check-inconclusive';
  END IF;

  UPDATE berth_retry.reconciliations SET finished_at = observed,
    result = r.result, reason = r.reason, observed_at = r.observed_at
    WHERE operation = p_operation RETURNING * INTO r;
  RETURN berth_retry.summary(r);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_retry FROM PUBLIC, berth_runtime, berth_retry_action;
GRANT USAGE ON SCHEMA berth_retry TO berth_retry_action;
GRANT EXECUTE ON FUNCTION berth_retry.status(uuid), berth_retry.begin(uuid,uuid),
  berth_retry.reserve(uuid,uuid,text), berth_retry.finish(uuid,uuid,jsonb)
TO berth_retry_action;
COMMIT;
