-- Owner-approved single experiment: no Functions quota is invented or inferred.
BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected owner'; END IF;
END $$;
CREATE TABLE berth_executor.functions_exception (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 operation uuid NOT NULL UNIQUE REFERENCES berth_ledger.trials,
 started_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 binding jsonb NOT NULL, evidence jsonb NOT NULL
);
REVOKE ALL ON berth_executor.functions_exception FROM PUBLIC,berth_runtime;
-- Invoker helper; no runtime grant. SECURITY DEFINER callers still validate all inputs.
CREATE FUNCTION berth_executor.valid_functions_exception(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS boolean LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(
 p_evidence->>'functionsMode'='free-functions-one-trial'
 AND NOT (p_evidence ?| ARRAY['neonInvocations','neonComputeSeconds','measuredComputeSeconds'])
 AND p_binding->'neonLimit'='64'::jsonb
 AND p_evidence->>'accountType' IN ('always-free','free-trial')
 AND p_evidence->>'homeRegion'=p_binding->>'region'
 AND p_evidence->'neonFree'='true'::jsonb AND p_evidence->'iamReviewed'='true'::jsonb
 AND (p_evidence->>'checkedAt')::numeric BETWEEN extract(epoch FROM p_start+interval '30 minutes'-interval '24 hours')*1000 AND extract(epoch FROM clock_timestamp())*1000
 AND (p_evidence->>'iamCheckedAt')::numeric BETWEEN extract(epoch FROM p_start+interval '30 minutes'-interval '24 hours')*1000 AND extract(epoch FROM clock_timestamp())*1000
 AND (p_evidence->>'storageBytes')::numeric>=10485760
 AND (p_evidence->>'objectRequests')::numeric>=200
 AND (p_evidence->>'transferBytes')::numeric>=1048576
 AND (p_evidence->>'monitoringRequests')::numeric>=(p_binding->>'monitoringLimit')::numeric
 AND p_evidence->'functionsException'->>'operation'=p_operation::text
 AND p_evidence->'functionsException'->'startedAt'=to_jsonb(extract(epoch FROM p_start)*1000)
 AND p_evidence->'functionsException'->'expiresAt'=to_jsonb(extract(epoch FROM p_start+interval '4 hours')*1000)
 AND p_evidence->'functionsException'->'shutdownBy'=to_jsonb(extract(epoch FROM p_start+interval '4 hours 15 minutes')*1000)
 AND p_evidence->'functionsException'->'unknownAllowanceAccepted'='true'::jsonb
 AND p_evidence->'functionsException'->'partialVerdictAccepted'='true'::jsonb
 AND p_evidence->'functionsException'->'exclusiveProjectUse'='true'::jsonb
 AND p_evidence->'functionsException'->'manualRecoveryReady'='true'::jsonb
 AND p_evidence->'functionsException'->>'otherServicesEvidence' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND p_evidence->'functionsException'->>'scenario'='64x60-plus36x60-v1'
 AND (p_evidence->'functionsException'->>'probeClientMs')::numeric>0
 AND (p_evidence->'functionsException'->>'probeClientMs')::numeric<=3000
 AND NOT EXISTS(SELECT FROM jsonb_each(p_evidence) v WHERE v.key IN ('checkedAt','iamCheckedAt','storageBytes','objectRequests','transferBytes','monitoringRequests') AND jsonb_typeof(v.value)<>'number')
 AND jsonb_typeof(p_evidence->'functionsException'->'probeClientMs')='number', false)
$$;
REVOKE ALL ON FUNCTION berth_executor.valid_functions_exception(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
ALTER FUNCTION berth_executor.prepare(uuid,timestamptz,jsonb,jsonb) RENAME TO prepare_without_exception;
CREATE FUNCTION berth_executor.prepare(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF current_user<>'neondb_owner' THEN RAISE EXCEPTION 'Expected owner'; END IF;
 IF p_evidence->>'functionsMode'='free-functions-one-trial' THEN
  IF NOT berth_executor.valid_functions_exception(p_operation,p_start,p_binding,p_evidence) THEN RAISE EXCEPTION 'Functions exception rejected'; END IF;
 ELSIF coalesce(p_evidence->>'functionsMode','verified')<>'verified' OR p_evidence ? 'functionsException' THEN
  RAISE EXCEPTION 'Functions mode rejected';
 END IF;
 result:=berth_executor.prepare_without_exception(p_operation,p_start,p_binding,p_evidence);
 IF p_evidence->>'functionsMode'='free-functions-one-trial' THEN
  -- Unique constant key serializes concurrent preparation. Never delete on failure/cleanup.
  INSERT INTO berth_executor.functions_exception(operation,started_at,expires_at,binding,evidence)
  VALUES(p_operation,p_start,p_start+interval '4 hours',p_binding,p_evidence);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION berth_executor.prepare(uuid,timestamptz,jsonb,jsonb),berth_executor.prepare_without_exception(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
-- Normal admission must enforce the same service thresholds as HTTP preflight.
CREATE FUNCTION berth_executor.valid_verified_headroom(p_binding jsonb,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 RETURN coalesce(
 (NOT p_evidence ? 'functionsMode' OR p_evidence->'functionsMode'='"verified"'::jsonb)
 AND NOT p_evidence ? 'functionsException'
 AND p_evidence->>'accountType' IN ('always-free','free-trial')
 AND p_evidence->>'homeRegion'=p_binding->>'region'
 AND p_evidence->'neonFree'='true'::jsonb
 AND (p_evidence->>'storageBytes')::numeric>=10485760
 AND (p_evidence->>'objectRequests')::numeric>=200
 AND (p_evidence->>'transferBytes')::numeric>=1048576
 AND (p_evidence->>'monitoringRequests')::numeric>=(p_binding->>'monitoringLimit')::numeric
 AND (p_evidence->>'neonInvocations')::numeric>=(p_binding->>'neonLimit')::numeric
 AND (p_evidence->>'measuredComputeSeconds')::numeric>0
 AND (p_evidence->>'neonComputeSeconds')::numeric>=(p_evidence->>'measuredComputeSeconds')::numeric
 AND NOT EXISTS(SELECT FROM jsonb_each(p_evidence) v
   WHERE v.key IN ('storageBytes','objectRequests','transferBytes','monitoringRequests','neonInvocations','measuredComputeSeconds','neonComputeSeconds')
   AND (jsonb_typeof(v.value)<>'number' OR abs((v.value #>> '{}')::numeric)>1.7976931348623157e308)), false);
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION berth_executor.valid_verified_headroom(jsonb,jsonb) FROM PUBLIC,berth_runtime;
ALTER FUNCTION berth_executor.admit(uuid,jsonb) RENAME TO admit_without_exception;
REVOKE ALL ON FUNCTION berth_executor.admit_without_exception(uuid,jsonb) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.admit(p_operation uuid,p_binding jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE a berth_executor.admission%ROWTYPE; t berth_ledger.trials%ROWTYPE; x berth_executor.functions_exception%ROWTYPE;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 SELECT * INTO STRICT a FROM berth_executor.admission WHERE operation=p_operation FOR UPDATE;
 SELECT * INTO x FROM berth_executor.functions_exception WHERE operation=p_operation;
 IF x.operation IS NOT NULL OR a.evidence->>'functionsMode'='free-functions-one-trial' THEN
  IF x.operation IS NULL OR x.binding IS DISTINCT FROM p_binding OR x.evidence IS DISTINCT FROM a.evidence
   OR x.started_at<>t.started_at OR x.expires_at<>t.expires_at THEN RAISE EXCEPTION 'Functions exception binding rejected'; END IF;
  IF NOT a.admitted AND NOT berth_executor.valid_functions_exception(p_operation,t.started_at,p_binding,a.evidence) THEN RAISE EXCEPTION 'Functions exception rejected'; END IF;
 ELSIF coalesce(a.evidence->>'functionsMode','verified')<>'verified' OR a.evidence ? 'functionsException' THEN
  RAISE EXCEPTION 'Functions mode rejected';
 ELSIF NOT a.admitted AND NOT berth_executor.valid_verified_headroom(p_binding,a.evidence) THEN
  RAISE EXCEPTION 'Admission evidence or creation margin rejected';
 END IF;
 RETURN berth_executor.admit_without_exception(p_operation,p_binding);
END $$;
REVOKE ALL ON FUNCTION berth_executor.admit(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.admit(uuid,jsonb) TO berth_runtime;
-- Durable qualification is independent of mutable lifecycle outcome, including succeeded.
ALTER FUNCTION berth_executor.report(uuid) RENAME TO report_without_exception;
REVOKE ALL ON FUNCTION berth_executor.report_without_exception(uuid) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.report(p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; x berth_executor.functions_exception%ROWTYPE;
BEGIN
 result:=berth_executor.report_without_exception(p_operation);
 SELECT * INTO x FROM berth_executor.functions_exception WHERE operation=p_operation;
 IF x.operation IS NOT NULL THEN
  result:=result || jsonb_build_object('feasibility',jsonb_build_object(
   'mode','free-functions-one-trial','verdict','partial','functionsAllowance','unknown','hardSpendingCap',false,
   'scenario','64x60-plus36x60-v1','scenarioCapacitySeconds',6000,'scenarioInvocations',100,
   'shutdownBy',extract(epoch FROM x.expires_at+interval '15 minutes')*1000));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION berth_executor.report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.report(uuid) TO berth_runtime;
-- Every new hosted entry point requires this revision and the immutable slot binding.
-- This projection remains readable on inconsistency so cleanup/evidence stay available.
ALTER FUNCTION berth_executor.admission_status(uuid,jsonb) RENAME TO admission_status_without_exception;
REVOKE ALL ON FUNCTION berth_executor.admission_status_without_exception(uuid,jsonb) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.admission_status(p_operation uuid,p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; x berth_executor.functions_exception%ROWTYPE; t berth_ledger.trials%ROWTYPE; bound boolean;
BEGIN
 result:=berth_executor.admission_status_without_exception(p_operation,p_binding);
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation;
 SELECT * INTO x FROM berth_executor.functions_exception WHERE operation=p_operation;
 IF x.operation IS NOT NULL THEN
  bound:=x.binding=p_binding AND x.evidence=result->'evidence'
   AND x.started_at=t.started_at AND x.expires_at=t.expires_at;
 ELSE
  bound:=(NOT (result->'evidence') ? 'functionsMode' OR result->'evidence'->'functionsMode'='"verified"'::jsonb)
   AND NOT (result->'evidence') ? 'functionsException'
   AND berth_executor.valid_verified_headroom(p_binding,result->'evidence');
 END IF;
 RETURN result || jsonb_build_object('authorizationVersion',1,'evidenceBound',coalesce(bound,false));
END $$;
REVOKE ALL ON FUNCTION berth_executor.admission_status(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.admission_status(uuid,jsonb) TO berth_runtime;
-- Both begin_attempt and reserve call this guard while holding the trial row lock.
-- Recheck qualification at each creation boundary, not just at HTTP admission.
ALTER FUNCTION berth_executor.creation_admitted(uuid) RENAME TO creation_admitted_without_qualification;
REVOKE ALL ON FUNCTION berth_executor.creation_admitted_without_qualification(uuid) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.creation_admitted(p_operation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a berth_executor.admission%ROWTYPE; status jsonb;
BEGIN
 PERFORM berth_executor.creation_admitted_without_qualification(p_operation);
 SELECT * INTO a FROM berth_executor.admission WHERE operation=p_operation FOR SHARE;
 IF a.operation IS NOT NULL THEN
  PERFORM 1 FROM berth_executor.functions_exception WHERE operation=p_operation FOR SHARE;
  status:=berth_executor.admission_status(p_operation,a.binding);
  IF status->'authorizationVersion' IS DISTINCT FROM '1'::jsonb
   OR status->'evidenceBound' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Creation qualification rejected'; END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION berth_executor.creation_admitted(uuid) FROM PUBLIC,berth_runtime;
COMMIT;
