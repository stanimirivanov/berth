-- Owner-only, operation-bound policy. Never reset or adopt the consumed #55 slot.
BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected owner'; END IF;
END $$;
CREATE TABLE berth_executor.functions_policy (
 operation uuid PRIMARY KEY REFERENCES berth_ledger.trials,
 started_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 binding jsonb NOT NULL, evidence jsonb NOT NULL
);
REVOKE ALL ON berth_executor.functions_policy FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.immutable_functions_policy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Retain operation authorization'; END $$;
CREATE TRIGGER immutable_functions_policy BEFORE UPDATE OR DELETE ON berth_executor.functions_policy
FOR EACH ROW EXECUTE FUNCTION berth_executor.immutable_functions_policy();
REVOKE ALL ON FUNCTION berth_executor.immutable_functions_policy() FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.valid_functions_policy(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE x jsonb:=p_evidence->'functionsPolicy'; a jsonb:=x->'allowances'; plan jsonb:=x->'plan'; billing jsonb:=x->'billing'; minimum_time numeric:=extract(epoch FROM p_start+interval '30 minutes'-interval '24 hours')*1000; maximum_time numeric:=extract(epoch FROM clock_timestamp())*1000;
BEGIN
 -- The shared helper validates common commitments only; no historical authorization is read or written.
 RETURN coalesce(p_evidence->>'functionsMode'='free-plan-unknown-v1'
 AND p_evidence->'functionsUsage'='"unknown"'::jsonb AND p_evidence->'functionsAllowance'='"unknown"'::jsonb
 AND NOT p_evidence ? 'functionsException'
 AND berth_executor.valid_functions_exception(p_operation,p_start,p_binding,
   (p_evidence-'functionsPolicy') || jsonb_build_object('functionsMode','free-functions-one-trial','functionsException',x))
 AND jsonb_typeof(x->'reviewer')='string'
 AND NOT EXISTS(SELECT FROM jsonb_each(plan) v WHERE v.key IN ('project','branch','period','evidence') AND jsonb_typeof(v.value)<>'string')
 AND jsonb_typeof(billing->'evidence')='string'
 AND trunc((plan->>'checkedAt')::numeric)=(plan->>'checkedAt')::numeric AND trunc((billing->>'reviewedAt')::numeric)=(billing->>'reviewedAt')::numeric
 AND x->>'policyVersion'='free-plan-v1' AND x->>'reviewer' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND plan->>'status'='free' AND plan->>'source' IN ('owner-console','provider-api')
 AND plan->>'project' ~ '^[A-Za-z0-9_-]{1,80}$' AND plan->>'branch' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND plan->>'period' ~ '^[A-Za-z0-9_-]{1,80}$' AND plan->>'evidence' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND jsonb_typeof(plan->'checkedAt')='number' AND (plan->>'checkedAt')::numeric BETWEEN minimum_time AND maximum_time
 AND billing->>'source'='neon-free-no-overage-2026-11-19' AND billing->>'evidence' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND jsonb_typeof(billing->'reviewedAt')='number' AND (billing->>'reviewedAt')::numeric BETWEEN minimum_time AND maximum_time
 AND (a->>'requiredPostgresStorageBytes')::numeric>=1048576 AND (a->>'postgresStorageBytes')::numeric>=(a->>'requiredPostgresStorageBytes')::numeric
 AND (a->>'requiredPostgresComputeCuSeconds')::numeric>=28800 AND (a->>'postgresComputeCuSeconds')::numeric>=(a->>'requiredPostgresComputeCuSeconds')::numeric
 AND (a->>'requiredSharedTransferBytes')::numeric>=1048576 AND (a->>'sharedTransferBytes')::numeric>=(a->>'requiredSharedTransferBytes')::numeric
 AND (SELECT count(*)=6 AND bool_and(jsonb_typeof(v.value)='number' AND (v.value #>> '{}')::numeric BETWEEN 1 AND 9007199254740991 AND trunc((v.value #>> '{}')::numeric)=(v.value #>> '{}')::numeric)
      FROM jsonb_each(a) v WHERE v.key IN ('postgresStorageBytes','requiredPostgresStorageBytes','postgresComputeCuSeconds','requiredPostgresComputeCuSeconds','sharedTransferBytes','requiredSharedTransferBytes')),false);
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION berth_executor.valid_functions_policy(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
-- Preparation is intentionally invoker-only. A runtime SQL call cannot mint authorization.
CREATE OR REPLACE FUNCTION berth_executor.prepare(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF current_user<>'neondb_owner' OR NOT berth_executor.valid_functions_policy(p_operation,p_start,p_binding,p_evidence)
 THEN RAISE EXCEPTION 'Reviewed Free policy required'; END IF;
 result:=berth_executor.prepare_without_exception(p_operation,p_start,p_binding,p_evidence);
 INSERT INTO berth_executor.functions_policy VALUES(p_operation,p_start,p_start+interval '4 hours',p_binding,p_evidence);
 RETURN result;
END $$;
-- Freeze qualification separately from mutable lifecycle and admission state.
ALTER FUNCTION berth_executor.report(uuid) RENAME TO report_before_free_policy;
REVOKE ALL ON FUNCTION berth_executor.report_before_free_policy(uuid) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.report(p_operation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; x berth_executor.functions_policy%ROWTYPE;
BEGIN
 result:=berth_executor.report_before_free_policy(p_operation);
 SELECT * INTO x FROM berth_executor.functions_policy WHERE operation=p_operation;
 IF x.operation IS NOT NULL THEN result:=result || jsonb_build_object('feasibility',jsonb_build_object(
  'unknownAllowanceAccepted',true,'manualRecoveryReady',true,'mode','free-plan-unknown-v1','policyVersion','free-plan-v1','verdict','partial','functionsUsage','unknown','functionsAllowance','unknown','hardSpendingCap',false,
  'scenario','64x60-plus36x60-v1','scenarioCapacitySeconds',6000,'scenarioInvocations',100,
  'shutdownBy',extract(epoch FROM x.expires_at+interval '15 minutes')*1000)); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION berth_executor.report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.report(uuid) TO berth_runtime;
-- Readable even when evidence expires or drifts: cleanup/evidence do not need creation eligibility.
CREATE OR REPLACE FUNCTION berth_executor.admission_status(p_operation uuid,p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a berth_executor.admission%ROWTYPE; t berth_ledger.trials%ROWTYPE; x berth_executor.functions_policy%ROWTYPE; bound boolean;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation;
 SELECT * INTO STRICT a FROM berth_executor.admission WHERE operation=p_operation;
 IF a.binding IS DISTINCT FROM p_binding THEN RAISE EXCEPTION 'Deployment binding mismatch'; END IF;
 SELECT * INTO x FROM berth_executor.functions_policy WHERE operation=p_operation;
 bound:=x.operation IS NOT NULL AND x.binding=p_binding AND x.evidence=a.evidence AND x.started_at=t.started_at AND x.expires_at=t.expires_at
  AND berth_executor.valid_functions_policy(p_operation,t.started_at,p_binding,a.evidence)
  AND a.evidence->'iamReviewed'='true'::jsonb;
 -- Version 1 is the existing projection protocol; the policy has its own explicit version.
 RETURN jsonb_build_object('admitted',a.admitted,'verifiedAt',extract(epoch FROM a.verified_at)*1000,'evidence',a.evidence,
  'authorizationVersion',1,'evidenceBound',coalesce(bound,false));
END $$;
CREATE OR REPLACE FUNCTION berth_executor.admit(p_operation uuid,p_binding jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE status jsonb;
BEGIN
 PERFORM 1 FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 PERFORM 1 FROM berth_executor.admission WHERE operation=p_operation FOR UPDATE;
 status:=berth_executor.admission_status(p_operation,p_binding);
 IF status->'evidenceBound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Free policy authorization rejected'; END IF;
 RETURN berth_executor.admit_without_exception(p_operation,p_binding);
END $$;
-- Existing begin/reserve wrappers call this guard for every creation boundary.
-- Invalid legacy records remain readable/recoverable, never grandfathered into new creation.
CREATE OR REPLACE FUNCTION berth_executor.creation_admitted(p_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a berth_executor.admission%ROWTYPE; status jsonb;
BEGIN
 PERFORM berth_executor.creation_admitted_without_qualification(p_operation);
 SELECT * INTO a FROM berth_executor.admission WHERE operation=p_operation FOR SHARE;
 IF a.operation IS NOT NULL THEN
  status:=berth_executor.admission_status(p_operation,a.binding);
  IF status->'evidenceBound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Creation qualification rejected'; END IF;
 END IF;
END $$;
COMMIT;
