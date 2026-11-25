-- Owner prepares the exact continuation. Retry can approve it; only the existing
-- fenced executor can spend its independent dispatch and cleanup allowances.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
END $$;

-- Preserve the historical result. An expired source can relinquish the single
-- execution slot only in the same transaction that approves its qualified child.
ALTER TABLE berth_ledger.trials ADD COLUMN retry_slot_released boolean NOT NULL DEFAULT false;
DROP INDEX berth_ledger.one_active_trial;
CREATE UNIQUE INDEX one_active_trial ON berth_ledger.trials ((true))
  WHERE outcome IN ('active','needs-reconciliation') AND NOT retry_slot_released;

-- A released source remains readable. The shared runtime cannot reacquire its
-- lease or queue more execution after it relinquishes the slot.
CREATE OR REPLACE FUNCTION berth_ledger.claim(p_operation uuid,p_owner uuid,p_ttl integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 IF p_owner IS NULL OR p_ttl IS NULL OR p_ttl NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Invalid claim'; END IF;
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF t.retry_slot_released OR t.outcome NOT IN ('active','needs-reconciliation') THEN RAISE EXCEPTION 'Trial closed'; END IF;
 IF EXISTS(SELECT FROM berth_ledger.claims WHERE owner=p_owner) THEN
  IF t.owner IS DISTINCT FROM p_owner OR t.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Retired claim'; END IF;
 ELSE
  IF t.lease_until>clock_timestamp() THEN RAISE EXCEPTION 'Trial owned'; END IF;
  UPDATE berth_ledger.trials SET owner=p_owner,generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>p_ttl)
   WHERE operation=p_operation RETURNING * INTO t;
  INSERT INTO berth_ledger.claims VALUES(p_owner,p_operation,t.generation);
 END IF;
 RETURN jsonb_build_object('operation',p_operation,'owner',p_owner,'generation',t.generation::text);
END $$;

-- Private fence: callers retain this row lock through every ledger transaction.
CREATE OR REPLACE FUNCTION berth_ledger.guard(p_operation uuid,p_owner uuid,p_generation bigint)
RETURNS berth_ledger.trials LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF t.retry_slot_released OR p_owner IS NULL OR p_generation IS NULL OR t.owner IS DISTINCT FROM p_owner OR t.generation<>p_generation
 OR t.lease_until<=clock_timestamp() OR t.outcome NOT IN ('active','needs-reconciliation') THEN RAISE EXCEPTION 'Ownership rejected'; END IF;
 RETURN t;
END $$;

CREATE OR REPLACE FUNCTION berth_executor.cleanup(p_operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF t.retry_slot_released OR t.outcome IN ('succeeded','failed') THEN RETURN; END IF;
 INSERT INTO berth_executor.work(operation,cleanup_requested) VALUES(p_operation,true) ON CONFLICT(operation) DO UPDATE SET cleanup_requested=true;
END $$;

-- Retain the original metered check. The next POST after expiry may acquire
-- exactly one new after-expiry check with independent read accounting.
CREATE TABLE berth_retry.original_window_checks (LIKE berth_retry.reconciliations INCLUDING ALL);
REVOKE ALL ON berth_retry.original_window_checks FROM PUBLIC, berth_runtime, berth_retry_action;
ALTER FUNCTION berth_retry.begin(uuid,uuid) RENAME TO begin_reconciliation;
CREATE FUNCTION berth_retry.begin(p_operation uuid, p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
DECLARE prior berth_retry.reconciliations%ROWTYPE;
BEGIN
  IF p_claim IS NOT NULL AND EXISTS (SELECT FROM berth_ledger.trials
    WHERE operation = p_operation AND expires_at <= clock_timestamp()) THEN
    SELECT * INTO prior FROM berth_retry.reconciliations
      WHERE operation = p_operation AND scope = 'original-window' FOR UPDATE;
    IF FOUND AND (prior.finished_at IS NOT NULL OR clock_timestamp() >= prior.deadline) THEN
      INSERT INTO berth_retry.original_window_checks SELECT prior.*;
      DELETE FROM berth_retry.reconciliations WHERE operation = p_operation;
    END IF;
  END IF;
  RETURN berth_retry.begin_reconciliation(p_operation,p_claim);
END $$;

CREATE OR REPLACE FUNCTION berth_retry.status(p_operation uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT berth_retry.summary(r) FROM berth_retry.reconciliations r WHERE r.operation = p_operation),
    (SELECT berth_retry.summary(jsonb_populate_record(NULL::berth_retry.reconciliations,to_jsonb(r)))
       FROM berth_retry.original_window_checks r WHERE r.operation=p_operation)
  )
$$;

CREATE TABLE berth_retry.proposals (
  id uuid PRIMARY KEY,
  operation uuid NOT NULL REFERENCES berth_ledger.trials,
  reconciliation_claim uuid NOT NULL,
  source_marker uuid NOT NULL,
  source_observed_at timestamptz NOT NULL,
  source_bucket jsonb,
  proposed_at timestamptz NOT NULL,
  approve_by timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  binding jsonb NOT NULL CHECK (octet_length(binding::text) <= 1024),
  evidence jsonb NOT NULL CHECK (octet_length(evidence::text) <= 8192),
  approved_at timestamptz,
  withdrawn_at timestamptz
);
CREATE UNIQUE INDEX retry_one_approval ON berth_retry.proposals(operation)
  WHERE approved_at IS NOT NULL;
CREATE UNIQUE INDEX retry_one_current_proposal ON berth_retry.proposals(operation)
  WHERE withdrawn_at IS NULL;
CREATE INDEX retry_proposals_for_operation ON berth_retry.proposals(operation, proposed_at DESC);
REVOKE ALL ON berth_retry.proposals FROM PUBLIC, berth_runtime, berth_retry_action;

-- Only closed public reason codes survive a failed requalification.
CREATE TABLE berth_retry.preparation_stops (
  operation uuid PRIMARY KEY REFERENCES berth_ledger.trials,
  reason text NOT NULL CHECK (reason IN (
    'allowance-evidence-unqualified','credential-evidence-unqualified','cleanup-evidence-unqualified'
  ))
);
REVOKE ALL ON berth_retry.preparation_stops FROM PUBLIC, berth_runtime, berth_retry_action;

-- A fixed stored result classifies the only two eligible next steps. Provider
-- absence never overrides an unsettled mutation; a reused bucket keeps its ID.
CREATE FUNCTION berth_retry.source_qualified(t berth_ledger.trials, r berth_retry.reconciliations)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    t.operation = r.operation AND r.scope = 'after-expiry'
    AND r.observed_at BETWEEN statement_timestamp() - interval '24 hours' AND statement_timestamp()
    AND t.expires_at <= statement_timestamp() AND t.outcome IN ('active','failed','needs-reconciliation')
    AND t.generation = r.generation AND t.lease_until <= statement_timestamp()
    AND NOT t.cleanup_started AND t.object_name = 'trial.bin'
    AND t.bucket = 'berth-' || replace(t.operation::text,'-','')
    AND t.digest = 'fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83'
    AND NOT EXISTS (SELECT FROM berth_executor.work w WHERE w.operation = t.operation
      AND (w.pending_upload OR w.receipt IS NOT NULL OR w.cleanup_requested OR w.phase IN ('observe','cleanup')))
    AND NOT EXISTS (SELECT FROM berth_ledger.requests q JOIN berth_ledger.attempts a ON a.id = q.attempt
      WHERE q.operation = t.operation AND q.mutation AND (q.outcome='unresolved'
        OR a.action <> 'create_bucket' OR (
          r.result = 'safe-write-needed' AND (q.outcome <> 'rejected'
            OR coalesce(q.basis,'') NOT IN ('provider-response','not-dispatched'))
        )))
    AND NOT EXISTS (SELECT FROM berth_ledger.attempts a WHERE a.operation = t.operation
      AND a.action IN ('delete_bucket','delete_object'))
    AND CASE r.result
      WHEN 'safe-write-needed' THEN
        NOT EXISTS (SELECT FROM berth_executor.work w WHERE w.operation=t.operation
          AND (w.bucket IS NOT NULL OR w.state IS NOT NULL OR w.phase <> 'bucket'))
        AND NOT EXISTS (SELECT FROM berth_inventory.executor_events e WHERE e.operation=t.operation)
        AND NOT EXISTS (SELECT FROM berth_inventory.instances i WHERE i.operation=t.operation)
      WHEN 'owned-instance' THEN
        EXISTS (SELECT FROM berth_inventory.instances i JOIN berth_inventory.observations o USING (provider_id)
          WHERE i.operation=t.operation AND i.provider_id=r.provider_observation->>'id'
            AND o.kind='present' AND o.observed_at=r.observed_at)
        AND NOT EXISTS (SELECT FROM berth_inventory.observations o
          WHERE o.provider_id=r.provider_observation->>'id' AND
            (o.kind='removed' OR (o.observed_at >= r.observed_at AND o.kind <> 'present')))
        AND NOT EXISTS (SELECT FROM berth_executor.work w WHERE w.operation=t.operation
          AND w.bucket IS NOT NULL AND w.bucket->>'id' IS DISTINCT FROM r.provider_observation->>'id')
        AND NOT EXISTS (SELECT FROM berth_inventory.executor_events e
          WHERE e.operation=t.operation AND (e.provider_id <> r.provider_observation->>'id' OR e.kind='removed'))
      ELSE false END,
    false)
$$;

CREATE FUNCTION berth_retry.credentials_qualified(binding jsonb, evidence jsonb, starts_at timestamptz)
RETURNS boolean LANGUAGE sql
SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    binding->>'tenancy' ~ '^ocid1[.]tenancy[.]oc1[.][.][A-Za-z0-9]{1,128}$'
    AND binding->>'user' ~ '^ocid1[.]user[.]oc1[.][.][A-Za-z0-9]{1,128}$'
    AND binding->>'fingerprint' ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){15}$'
    AND evidence->'iamReviewed' = 'true'::jsonb
    AND CASE WHEN jsonb_typeof(evidence->'iamCheckedAt') = 'number'
      THEN (evidence->>'iamCheckedAt')::numeric BETWEEN
        extract(epoch FROM starts_at + interval '30 minutes' - interval '24 hours') * 1000
        AND extract(epoch FROM clock_timestamp()) * 1000
      ELSE false END,
    false)
$$;

CREATE FUNCTION berth_retry.preparation_valid(
  p berth_retry.proposals, t berth_ledger.trials, r berth_retry.reconciliations
) RETURNS boolean LANGUAGE sql
SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    p.withdrawn_at IS NULL AND p.operation = t.operation AND r.claim = p.reconciliation_claim
    AND p.source_marker = t.marker AND p.source_observed_at = r.observed_at
    AND p.source_bucket IS NOT DISTINCT FROM r.provider_observation
    AND r.observed_at >= p.starts_at + interval '30 minutes' - interval '24 hours'
    AND berth_retry.source_qualified(t,r)
    AND p.binding->>'region' = t.region AND p.binding->>'compartment' = t.compartment
    AND p.binding->>'namespace' = t.namespace
    AND p.binding->'monitoringLimit' = '20'::jsonb AND p.binding->'neonLimit' = '64'::jsonb
    AND berth_retry.credentials_qualified(p.binding,p.evidence,p.starts_at)
    AND (SELECT count(*) = 8 FROM jsonb_object_keys(p.binding))
    AND p.evidence->>'accountType' = 'always-free'
    AND (NOT p.evidence ? 'functionsKnownInsufficient' OR p.evidence->'functionsKnownInsufficient'='false'::jsonb)
    AND NOT p.evidence ? 'allowanceException'
    AND berth_executor.valid_functions_policy_strict(p.id,p.starts_at,p.binding,p.evidence),
    false)
$$;

CREATE FUNCTION berth_retry.prepare_continuation(
  p_operation uuid, p_id uuid, p_starts_at timestamptz, p_binding jsonb, p_evidence jsonb
) RETURNS text LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
DECLARE
  t berth_ledger.trials%ROWTYPE;
  r berth_retry.reconciliations%ROWTYPE;
  p berth_retry.proposals%ROWTYPE;
  at timestamptz;
  stop_reason text;
BEGIN
  IF current_user <> 'neondb_owner' THEN RAISE EXCEPTION 'Expected dedicated owner'; END IF;
  SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation = p_operation FOR UPDATE;
  at := date_trunc('milliseconds',clock_timestamp());
  SELECT * INTO STRICT r FROM berth_retry.reconciliations WHERE operation = p_operation;
  IF p_id IS NULL OR p_id::text !~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR p_starts_at IS NULL OR p_starts_at < at - interval '1 minute' OR p_starts_at > at + interval '1 hour'
    OR p_starts_at <> date_trunc('milliseconds',p_starts_at)
    OR jsonb_typeof(p_binding) IS DISTINCT FROM 'object' OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR octet_length(p_binding::text) > 1024 OR octet_length(p_evidence::text) > 8192
    OR p_binding->>'region' IS DISTINCT FROM t.region
    OR p_binding->>'compartment' IS DISTINCT FROM t.compartment
    OR p_binding->>'namespace' IS DISTINCT FROM t.namespace
    OR EXISTS (SELECT FROM berth_retry.proposals WHERE id = p_id)
    OR EXISTS (SELECT FROM berth_ledger.trials WHERE operation = p_id)
    OR EXISTS (SELECT FROM berth_retry.proposals WHERE operation = p_operation AND approved_at IS NOT NULL)
  THEN RAISE EXCEPTION 'Fresh continuation preparation required'; END IF;
  p.id := p_id;
  p.operation := p_operation;
  p.reconciliation_claim := r.claim;
  p.source_marker := t.marker;
  p.source_observed_at := r.observed_at;
  p.source_bucket := r.provider_observation;
  p.starts_at := p_starts_at;
  p.proposed_at := at;
  p.approve_by := least(at + interval '5 minutes', p_starts_at + interval '5 minutes');
  p.binding := p_binding;
  p.evidence := p_evidence;
  IF NOT berth_retry.source_qualified(t,r)
    OR r.observed_at < p_starts_at + interval '30 minutes' - interval '24 hours'
  THEN RAISE EXCEPTION 'Safe, settled reconciliation evidence is required through the creation cutoff';
  END IF;
  stop_reason := CASE
    WHEN p_evidence->'functionsPolicy'->'manualRecoveryReady' IS DISTINCT FROM 'true'::jsonb
      THEN 'cleanup-evidence-unqualified'
    WHEN NOT berth_retry.credentials_qualified(p_binding,p_evidence,p_starts_at)
      THEN 'credential-evidence-unqualified'
    WHEN NOT berth_retry.preparation_valid(p,t,r)
      THEN 'allowance-evidence-unqualified'
  END;

  -- Prepare and approve serialize on the same operation row. Return a domain
  -- stop instead of raising so the old proposal stays withdrawn on commit.
  UPDATE berth_retry.proposals SET withdrawn_at = at
    WHERE operation = p_operation AND withdrawn_at IS NULL;
  IF stop_reason IS NOT NULL THEN
    INSERT INTO berth_retry.preparation_stops (operation,reason) VALUES (p_operation,stop_reason)
      ON CONFLICT (operation) DO UPDATE SET reason=excluded.reason;
    RETURN stop_reason;
  END IF;
  INSERT INTO berth_retry.proposals SELECT p.*;
  DELETE FROM berth_retry.preparation_stops WHERE operation=p_operation;
  RETURN 'prepared';
END $$;

-- Withdrawal closes new writes even after approval. Cleanup retains its own reserve.
CREATE FUNCTION berth_retry.withdraw_continuation(p_operation uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
BEGIN
  IF current_user <> 'neondb_owner' THEN RAISE EXCEPTION 'Expected dedicated owner'; END IF;
  PERFORM 1 FROM berth_ledger.trials WHERE operation = p_operation FOR UPDATE;
  UPDATE berth_retry.proposals SET withdrawn_at = clock_timestamp()
    WHERE operation = p_operation AND withdrawn_at IS NULL;
END $$;

CREATE FUNCTION berth_retry.continuation_stop(p_operation uuid, reason text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('operation',p_operation,
    'stage',CASE WHEN reason = 'reconciliation-in-progress' THEN 'checking-provider' ELSE 'needs-attention' END,
    'reason',reason,'ownerProcedure',
    'https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-continuation.md')
$$;

CREATE FUNCTION berth_retry.continuation_status(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  t berth_ledger.trials%ROWTYPE;
  child berth_ledger.trials%ROWTYPE;
  r berth_retry.reconciliations%ROWTYPE;
  p berth_retry.proposals%ROWTYPE;
  active boolean;
  progress text;
  why text;
  original_phase text;
  preparation record;
BEGIN
  SELECT * INTO t FROM berth_ledger.trials WHERE operation = p_operation;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM berth_retry.reconciliations WHERE operation = p_operation;
  -- The selected proposal and qualification stop must share one snapshot.
  SELECT (
    SELECT candidate FROM berth_retry.proposals candidate WHERE operation=p_operation
    ORDER BY (approved_at IS NOT NULL) DESC, (withdrawn_at IS NULL) DESC, proposed_at DESC, id DESC
    LIMIT 1
  ) AS proposal, (
    SELECT reason FROM berth_retry.preparation_stops WHERE operation=p_operation
  ) AS stop_reason INTO preparation;
  p := preparation.proposal;
  IF p.approved_at IS NOT NULL THEN
    SELECT * INTO STRICT child FROM berth_ledger.trials WHERE operation = p.id;
    SELECT admitted INTO active FROM berth_executor.admission WHERE operation = p.id;
    why := CASE
      WHEN child.outcome = 'succeeded' THEN NULL
      WHEN p.withdrawn_at IS NOT NULL THEN 'authorization-withdrawn'
      WHEN NOT berth_retry.preparation_valid(p,t,r) THEN 'source-changed'
      WHEN active IS NOT TRUE AND clock_timestamp() >= child.started_at + interval '5 minutes'
        THEN 'activation-expired'
      WHEN child.outcome <> 'active' OR clock_timestamp() >= child.expires_at
        OR EXISTS (SELECT FROM berth_executor.work w WHERE w.operation=p.id
          AND (w.cleanup_requested OR w.failed)) THEN 'execution-stopped' END;
    progress := CASE WHEN child.outcome = 'succeeded' THEN 'completed'
      WHEN why IS NOT NULL THEN 'stopped'
      WHEN active THEN 'executing' ELSE 'awaiting-activation' END;
    RETURN jsonb_build_object('operation',p_operation,'scope','after-expiry',
      'stage',CASE progress WHEN 'completed' THEN 'completed' WHEN 'stopped' THEN 'needs-attention'
        ELSE 'continuing-provisioning' END,'progress',progress,
      'authorization','approved','continuation',p.id,'approvedAt',p.approved_at,
      'startsAt',child.started_at,'expiresAt',child.expires_at,'reason',why,
      'ownerProcedure','https://github.com/stanimirivanov/berth/blob/main/docs/trial/retry-continuation.md');
  END IF;
  why := CASE WHEN r.operation IS NULL THEN 'reconciliation-required'
    WHEN r.finished_at IS NULL AND clock_timestamp() < r.deadline THEN 'reconciliation-in-progress'
    WHEN r.result IS NULL THEN 'reconciliation-stopped' END;
  IF why IS NOT NULL THEN RETURN berth_retry.continuation_stop(p_operation,why); END IF;

  IF r.scope = 'original-window' AND t.outcome = 'succeeded' THEN
    RETURN jsonb_build_object('operation',p_operation,'stage','completed',
      'scope','original-window','expiresAt',t.expires_at,'creationCutoff',t.started_at + interval '30 minutes');
  END IF;
  IF r.scope = 'original-window' AND clock_timestamp() < t.expires_at THEN
    SELECT w.phase INTO original_phase FROM berth_executor.work w WHERE w.operation=p_operation;
    IF t.outcome = 'active' AND NOT t.cleanup_started AND t.normal_used < 160
      AND t.neon_used < t.neon_limit - 12 AND clock_timestamp() < t.started_at + interval '30 minutes'
      AND NOT EXISTS (SELECT FROM berth_executor.work w WHERE w.operation = p_operation
        AND (w.cleanup_requested OR w.failed OR w.phase NOT IN ('bucket','object')))
      AND NOT EXISTS (SELECT FROM berth_ledger.requests q WHERE q.operation=p_operation AND q.mutation AND q.outcome='unresolved')
      AND (SELECT count(*) FROM berth_ledger.attempts a WHERE a.operation=p_operation AND
        a.action=CASE WHEN original_phase='object' THEN 'put_object' ELSE 'create_bucket' END) < 3
      AND EXISTS (SELECT FROM berth_executor.admission a WHERE a.operation=p_operation AND a.admitted
        AND berth_executor.admission_status(p_operation,a.binding)->'evidenceBound' = 'true'::jsonb)
    THEN
      RETURN jsonb_build_object('operation',p_operation,'stage','continuing-provisioning',
        'scope','original-window','expiresAt',t.expires_at,'creationCutoff',t.started_at + interval '30 minutes');
    END IF;
    RETURN berth_retry.continuation_stop(p_operation,'original-authority-unavailable');
  END IF;

  IF NOT berth_retry.source_qualified(t,r) THEN
    RETURN berth_retry.continuation_stop(p_operation,
      CASE WHEN r.scope='original-window' THEN 'reconciliation-required' ELSE 'source-not-safe' END);
  END IF;
  IF preparation.stop_reason IS NOT NULL
  THEN RETURN berth_retry.continuation_stop(p_operation,preparation.stop_reason); END IF;
  IF p.id IS NULL THEN RETURN berth_retry.continuation_stop(p_operation,'preparation-required'); END IF;
  IF p.withdrawn_at IS NOT NULL THEN RETURN berth_retry.continuation_stop(p_operation,'preparation-withdrawn'); END IF;
  IF clock_timestamp() >= p.approve_by THEN RETURN berth_retry.continuation_stop(p_operation,'proposal-expired'); END IF;
  IF NOT berth_retry.preparation_valid(p,t,r) OR EXISTS (SELECT FROM berth_ledger.trials WHERE operation=p.id)
  THEN RETURN berth_retry.continuation_stop(p_operation,'preparation-changed'); END IF;
  IF EXISTS (SELECT FROM berth_ledger.trials WHERE operation <> p_operation
    AND outcome IN ('active','needs-reconciliation') AND NOT retry_slot_released)
  THEN RETURN berth_retry.continuation_stop(p_operation,'executor-slot-unavailable'); END IF;
  RETURN jsonb_build_object('operation',p_operation,'stage','waiting-for-approval','proposal',p.id,
    'target',jsonb_build_object('region',t.region,'compartment',t.compartment,'namespace',t.namespace,'bucket',t.bucket,
      'instance',(SELECT i.id FROM berth_inventory.instances i WHERE i.operation=t.operation)),
    'steps',CASE WHEN p.source_bucket IS NOT NULL
      THEN jsonb_build_array('upload-fixture','verify-and-remove-fixture')
      ELSE jsonb_build_array('create-bucket','upload-fixture','verify-and-clean-up') END,
    'evidence',jsonb_build_object('observedAt',r.observed_at,
      'allowanceCheckedAt',to_timestamp((p.evidence->>'checkedAt')::numeric / 1000),
      'iamCheckedAt',to_timestamp((p.evidence->>'iamCheckedAt')::numeric / 1000),
      'reference',p.evidence->'functionsPolicy'->>'otherServicesEvidence'),
    'startsAt',p.starts_at,'creationCutoff',p.starts_at + interval '30 minutes',
    'expiresAt',p.starts_at + interval '4 hours','approveBy',p.approve_by,
    'limits',jsonb_build_object('normal',160,'cleanup',40,'monitoring',20,
      'application',64,'applicationCleanup',12,'attemptsPerAction',3));
END $$;

CREATE FUNCTION berth_retry.approve_continuation(p_operation uuid, p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  t berth_ledger.trials%ROWTYPE;
  p berth_retry.proposals%ROWTYPE;
  visible jsonb;
BEGIN
  SELECT * INTO t FROM berth_ledger.trials WHERE operation = p_operation FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM berth_retry.proposals WHERE operation = p_operation AND id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p.approved_at IS NOT NULL THEN RETURN berth_retry.continuation_status(p_operation); END IF;
  visible := berth_retry.continuation_status(p_operation);
  IF visible->>'proposal' IS DISTINCT FROM p_id::text THEN RETURN NULL; END IF;
  BEGIN
    UPDATE berth_ledger.trials SET retry_slot_released = true
      WHERE operation = p_operation AND outcome IN ('active','needs-reconciliation');
    PERFORM berth_executor.prepare(p.id,p.starts_at,p.binding,p.evidence);
    -- Keep the physical target exact. A new ownership tag and marker prevent
    -- the old executor from accepting the child's resources as its own.
    UPDATE berth_ledger.trials SET bucket = t.bucket WHERE operation = p.id;
    IF p.source_bucket IS NOT NULL THEN
      INSERT INTO berth_executor.work(operation,phase,bucket) SELECT c.operation,'object',jsonb_build_object(
        'id',p.source_bucket->>'id','etag',p.source_bucket->>'etag','operation',c.operation,'marker',c.marker)
        FROM berth_ledger.trials c WHERE c.operation=p.id;
    END IF;
    UPDATE berth_retry.proposals SET approved_at = clock_timestamp()
      WHERE id = p.id AND clock_timestamp() < approve_by;
    IF NOT FOUND THEN RAISE SQLSTATE 'BR001'; END IF;
  EXCEPTION WHEN unique_violation OR SQLSTATE 'BR001' THEN
    -- Roll back preparation if the executor slot was taken or approval expired.
    RETURN NULL;
  END;
  RETURN berth_retry.continuation_status(p_operation);
END $$;

-- Reuse approves a PUT against an exact existing bucket and cleanup of the
-- child's fixture only. It cannot allocate a CREATE or bucket DELETE attempt.
CREATE FUNCTION berth_retry.enforce_retained_bucket_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.action IN ('create_bucket','delete_bucket') AND EXISTS (
    SELECT FROM berth_retry.proposals WHERE id=NEW.operation AND approved_at IS NOT NULL AND source_bucket IS NOT NULL
  ) THEN RAISE EXCEPTION 'Retained bucket mutation outside continuation scope'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retry_retained_bucket_scope BEFORE INSERT ON berth_ledger.attempts
  FOR EACH ROW WHEN (NEW.action IN ('create_bucket','delete_bucket'))
  EXECUTE FUNCTION berth_retry.enforce_retained_bucket_scope();

-- A child whose activation was missed can release the slot only if it never
-- acquired a provider mutation. This does not permit replacement approval.
CREATE FUNCTION berth_retry.close_unactivated(p_operation uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp SET lock_timeout = '1s' AS $$
DECLARE child uuid;
BEGIN
  IF current_user <> 'neondb_owner' THEN RAISE EXCEPTION 'Expected dedicated owner'; END IF;
  SELECT id INTO child FROM berth_retry.proposals WHERE operation=p_operation AND approved_at IS NOT NULL;
  PERFORM 1 FROM berth_ledger.trials t WHERE t.operation=child FOR UPDATE;
  UPDATE berth_ledger.trials t SET outcome='failed'
    WHERE t.operation=child AND t.outcome='active' AND t.lease_until<=clock_timestamp()
      AND clock_timestamp() >= t.started_at + interval '5 minutes'
      AND NOT EXISTS (SELECT FROM berth_executor.admission a WHERE a.operation=child AND a.admitted)
      AND NOT EXISTS (SELECT FROM berth_ledger.requests q WHERE q.operation=child AND q.mutation);
  RETURN FOUND;
END $$;

-- Enforce the exact scope on activation and at the existing creation fences.
-- The caller locks the child, then this function locks the original.
CREATE FUNCTION berth_retry.assert_execution_scope(p_operation uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p berth_retry.proposals%ROWTYPE;
  parent berth_ledger.trials%ROWTYPE;
  child berth_ledger.trials%ROWTYPE;
  r berth_retry.reconciliations%ROWTYPE;
  a berth_executor.admission%ROWTYPE;
BEGIN
  SELECT * INTO p FROM berth_retry.proposals WHERE id = p_operation AND approved_at IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO STRICT parent FROM berth_ledger.trials WHERE operation = p.operation FOR SHARE;
  SELECT * INTO STRICT p FROM berth_retry.proposals WHERE id = p_operation;
  SELECT * INTO STRICT r FROM berth_retry.reconciliations WHERE operation = p.operation;
  SELECT * INTO STRICT child FROM berth_ledger.trials WHERE operation = p_operation;
  SELECT * INTO STRICT a FROM berth_executor.admission WHERE operation = p_operation FOR SHARE;
  IF NOT berth_retry.preparation_valid(p,parent,r)
    OR (child.compartment,child.namespace,child.region,child.bucket,child.digest,child.object_name,
      child.started_at,child.expires_at,child.monitoring_limit,child.neon_limit)
      IS DISTINCT FROM (parent.compartment,parent.namespace,parent.region,parent.bucket,parent.digest,parent.object_name,
      p.starts_at,p.starts_at + interval '4 hours',20,64)
    OR (a.binding,a.evidence) IS DISTINCT FROM (p.binding,p.evidence)
  THEN RAISE EXCEPTION 'Retry continuation authorization changed'; END IF;
END $$;

CREATE OR REPLACE FUNCTION berth_executor.creation_admitted(p_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a berth_executor.admission%ROWTYPE;
BEGIN
  PERFORM berth_executor.creation_admitted_without_qualification(p_operation);
  SELECT * INTO a FROM berth_executor.admission WHERE operation=p_operation FOR SHARE;
  IF a.operation IS NOT NULL
    AND berth_executor.admission_status(p_operation,a.binding)->'evidenceBound' IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'Creation qualification rejected'; END IF;
  PERFORM berth_retry.assert_execution_scope(p_operation);
END $$;

CREATE OR REPLACE FUNCTION berth_executor.admit(p_operation uuid,p_binding jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
BEGIN
  PERFORM 1 FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
  PERFORM 1 FROM berth_executor.admission WHERE operation=p_operation FOR UPDATE;
  IF berth_executor.admission_status(p_operation,p_binding)->'evidenceBound' IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'Free policy authorization rejected'; END IF;
  PERFORM berth_retry.assert_execution_scope(p_operation);
  RETURN berth_executor.admit_without_exception(p_operation,p_binding);
END $$;

-- The last SQL fence before CREATE/PUT rechecks the already charged request
-- and the protected account evidence. Never call this on a cleanup action.
CREATE FUNCTION berth_executor.confirm_retry_dispatch(
  p_operation uuid, p_owner uuid, p_generation bigint, p_request uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  t berth_ledger.trials%ROWTYPE;
BEGIN
  t := berth_ledger.guard(p_operation,p_owner,p_generation);
  IF t.outcome <> 'active' OR t.cleanup_started
    OR clock_timestamp() >= least(t.started_at + interval '30 minutes',t.expires_at)
    OR NOT EXISTS (SELECT FROM berth_ledger.requests q
      JOIN berth_ledger.attempts a ON a.id = q.attempt
      WHERE q.id = p_request AND q.operation = p_operation AND a.operation = p_operation
        AND q.generation = p_generation AND a.generation = p_generation
        AND q.mutation AND q.outcome = 'unresolved' AND a.outcome = 'open'
        AND a.action IN ('create_bucket','put_object'))
    OR NOT EXISTS (SELECT FROM berth_retry.proposals WHERE id = p_operation AND approved_at IS NOT NULL)
  THEN RAISE EXCEPTION 'Retry dispatch rejected'; END IF;
  PERFORM berth_executor.creation_admitted(p_operation);
END $$;

-- The retained bucket belongs to the original operation. Terminal scope
-- requires verified cleanup of the child's object, not deletion of that bucket.
CREATE FUNCTION berth_executor.finish_retained_retry(
  p_operation uuid, p_owner uuid, p_generation bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  w berth_executor.work%ROWTYPE;
  uploaded boolean;
  removed boolean;
BEGIN
  PERFORM berth_ledger.guard(p_operation,p_owner,p_generation);
  SELECT * INTO STRICT w FROM berth_executor.work WHERE operation=p_operation;
  IF w.phase <> 'cleanup' OR NOT w.object_removed OR NOT EXISTS (
      SELECT FROM berth_retry.proposals WHERE id=p_operation AND approved_at IS NOT NULL AND source_bucket IS NOT NULL
    ) OR EXISTS (SELECT FROM berth_ledger.attempts WHERE operation=p_operation AND outcome='open')
      OR EXISTS (SELECT FROM berth_ledger.requests WHERE operation=p_operation AND outcome='unresolved')
  THEN RAISE EXCEPTION 'Retained bucket cleanup unresolved'; END IF;
  SELECT coalesce(bool_or(a.action='put_object'),false),coalesce(bool_or(a.action='delete_object'),false)
    INTO uploaded,removed FROM berth_ledger.requests q JOIN berth_ledger.attempts a ON a.id=q.attempt
    WHERE q.operation=p_operation AND q.outcome='succeeded';
  IF uploaded AND NOT removed THEN RAISE EXCEPTION 'Retained bucket fixture removal not confirmed'; END IF;
  UPDATE berth_ledger.trials SET outcome=CASE
    WHEN uploaded AND removed AND w.receipt IS NOT NULL AND NOT w.failed THEN 'succeeded'
    ELSE 'failed' END WHERE operation=p_operation;
END $$;

-- Keep the approved name mapping available to the existing executor and owner
-- recovery, including after withdrawal. Only the execution guard can spend it.
CREATE OR REPLACE FUNCTION berth_executor.report(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  result jsonb;
  bounded berth_executor.bounded_allowance_exception%ROWTYPE;
  linked berth_retry.proposals%ROWTYPE;
BEGIN
  result := berth_executor.report_without_bounded_allowance(p_operation);
  SELECT * INTO bounded FROM berth_executor.bounded_allowance_exception WHERE operation=p_operation;
  IF bounded.operation IS NOT NULL THEN
    result := jsonb_set(result,'{feasibility}',
      coalesce(result->'feasibility','{}'::jsonb) || jsonb_build_object(
        'verdict','partial','hardSpendingCap',false,'allowanceException',bounded.evidence->'allowanceException'));
  END IF;
  IF jsonb_typeof(result->'trial')='object' THEN
    result := jsonb_set(result,'{trial}',(result->'trial')-'retry_slot_released');
  END IF;
  SELECT * INTO linked FROM berth_retry.proposals WHERE id=p_operation AND approved_at IS NOT NULL;
  IF FOUND THEN
    result := result || jsonb_build_object('retrySource',linked.operation);
    IF linked.source_bucket IS NOT NULL THEN
      result := result || jsonb_build_object('retryBucket',jsonb_build_object(
        'id',linked.source_bucket->>'id','etag',linked.source_bucket->>'etag',
        'operation',linked.operation,'marker',linked.source_marker));
    END IF;
  END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION berth_retry.begin_reconciliation(uuid,uuid), berth_retry.begin(uuid,uuid),
  berth_retry.enforce_retained_bucket_scope(), berth_retry.close_unactivated(uuid),
  berth_retry.assert_execution_scope(uuid),
  berth_retry.source_qualified(berth_ledger.trials,berth_retry.reconciliations),
  berth_retry.credentials_qualified(jsonb,jsonb,timestamptz),
  berth_retry.preparation_valid(berth_retry.proposals,berth_ledger.trials,berth_retry.reconciliations),
  berth_retry.prepare_continuation(uuid,uuid,timestamptz,jsonb,jsonb),
  berth_retry.withdraw_continuation(uuid), berth_retry.continuation_stop(uuid,text),
  berth_retry.continuation_status(uuid), berth_retry.approve_continuation(uuid,uuid),
  berth_executor.creation_admitted(uuid),
  berth_executor.confirm_retry_dispatch(uuid,uuid,bigint,uuid),
  berth_executor.finish_retained_retry(uuid,uuid,bigint)
FROM PUBLIC, berth_runtime, berth_retry_action;
GRANT EXECUTE ON FUNCTION berth_retry.begin(uuid,uuid), berth_retry.continuation_status(uuid),
  berth_retry.approve_continuation(uuid,uuid) TO berth_retry_action;
GRANT EXECUTE ON FUNCTION berth_executor.confirm_retry_dispatch(uuid,uuid,bigint,uuid),
  berth_executor.finish_retained_retry(uuid,uuid,bigint)
TO berth_runtime;
COMMIT;
