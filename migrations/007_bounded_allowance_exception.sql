-- One future issue-76 operation only. This migration grants no live authorization.
BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected owner'; END IF;
END $$;
CREATE TABLE berth_executor.bounded_allowance_exception (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 operation uuid NOT NULL UNIQUE REFERENCES berth_executor.functions_policy,
 started_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 binding jsonb NOT NULL,evidence jsonb NOT NULL
);
REVOKE ALL ON berth_executor.bounded_allowance_exception FROM PUBLIC,berth_runtime;
CREATE TRIGGER immutable_bounded_allowance BEFORE UPDATE OR DELETE ON berth_executor.bounded_allowance_exception
FOR EACH ROW EXECUTE FUNCTION berth_executor.immutable_functions_policy();
CREATE FUNCTION berth_executor.valid_bounded_allowance(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE x jsonb:=p_evidence->'functionsPolicy'; a jsonb:=x->'allowances'; plan jsonb:=x->'plan'; billing jsonb:=x->'billing';
 y jsonb:=p_evidence->'allowanceException'; f jsonb:=y->'ociFree'; m jsonb; k text; required numeric; observed numeric; remaining numeric; factor numeric; cap numeric; floor_value numeric;
 lo numeric:=extract(epoch FROM p_start+interval '30 minutes'-interval '24 hours')*1000; hi numeric:=extract(epoch FROM clock_timestamp())*1000;
BEGIN
 IF NOT coalesce(
 p_evidence->>'functionsMode'='free-plan-unknown-v1' AND p_evidence->'functionsUsage'='"unknown"'::jsonb AND p_evidence->'functionsAllowance'='"unknown"'::jsonb
 AND NOT p_evidence ?| ARRAY['functionsException','neonInvocations','neonComputeSeconds','measuredComputeSeconds','objectRequests','transferBytes','monitoringRequests']
 AND p_binding->'neonLimit'='64'::jsonb AND p_binding->'monitoringLimit'='20'::jsonb
 AND p_evidence->>'accountType'='always-free' AND p_evidence->>'homeRegion'=p_binding->>'region'
 AND p_evidence->'neonFree'='true'::jsonb AND p_evidence->'iamReviewed'='true'::jsonb
 AND (p_evidence->>'checkedAt')::numeric BETWEEN lo AND hi AND (p_evidence->>'iamCheckedAt')::numeric BETWEEN lo AND hi
 AND (p_evidence->>'storageBytes')::numeric>=10485760
 AND (SELECT count(*)=3 AND bool_and(jsonb_typeof(v.value)='number' AND (v.value#>>'{}')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((v.value#>>'{}')::numeric)=(v.value#>>'{}')::numeric)
  FROM jsonb_each(p_evidence) v WHERE v.key IN ('checkedAt','iamCheckedAt','storageBytes'))
 AND p_start=date_trunc('milliseconds',p_start)
 AND x->>'operation'=p_operation::text AND p_operation::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
 AND x->'startedAt'=to_jsonb(extract(epoch FROM p_start)*1000) AND x->'expiresAt'=to_jsonb(extract(epoch FROM p_start+interval '4 hours')*1000)
 AND x->'shutdownBy'=to_jsonb(extract(epoch FROM p_start+interval '4 hours 15 minutes')*1000)
 AND x->>'policyVersion'='free-plan-v1' AND x->'unknownAllowanceAccepted'='true'::jsonb AND x->'partialVerdictAccepted'='true'::jsonb
 AND x->'exclusiveProjectUse'='true'::jsonb AND x->'manualRecoveryReady'='true'::jsonb
 AND jsonb_typeof(x->'reviewer')='string' AND x->>'reviewer' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND jsonb_typeof(x->'otherServicesEvidence')='string' AND x->>'otherServicesEvidence' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND x->>'scenario'='64x60-plus36x60-v1' AND jsonb_typeof(x->'probeClientMs')='number' AND (x->>'probeClientMs')::numeric>0 AND (x->>'probeClientMs')::numeric<=3000
 AND plan->>'status'='free' AND plan->>'source' IN ('owner-console','provider-api')
 AND (SELECT count(*)=4 AND bool_and(jsonb_typeof(v.value)='string' AND (v.value#>>'{}') ~ '^[A-Za-z0-9_-]{1,80}$') FROM jsonb_each(plan) v WHERE v.key IN ('project','branch','period','evidence'))
 AND jsonb_typeof(plan->'checkedAt')='number' AND (plan->>'checkedAt')::numeric BETWEEN lo AND hi AND trunc((plan->>'checkedAt')::numeric)=(plan->>'checkedAt')::numeric
 AND billing->>'source'='neon-free-no-overage-2026-11-19' AND jsonb_typeof(billing->'evidence')='string' AND billing->>'evidence' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND jsonb_typeof(billing->'reviewedAt')='number' AND (billing->>'reviewedAt')::numeric BETWEEN lo AND hi AND trunc((billing->>'reviewedAt')::numeric)=(billing->>'reviewedAt')::numeric
 AND NOT a ? 'sharedTransferBytes'
 AND (SELECT count(*)=5 AND bool_and(jsonb_typeof(v.value)='number' AND (v.value#>>'{}')::numeric BETWEEN 1 AND 9007199254740991 AND trunc((v.value#>>'{}')::numeric)=(v.value#>>'{}')::numeric)
  FROM jsonb_each(a) v WHERE v.key IN ('postgresStorageBytes','requiredPostgresStorageBytes','postgresComputeCuSeconds','requiredPostgresComputeCuSeconds','requiredSharedTransferBytes'))
 AND (a->>'requiredPostgresStorageBytes')::numeric>=1048576 AND (a->>'postgresStorageBytes')::numeric>=(a->>'requiredPostgresStorageBytes')::numeric
 AND (a->>'requiredPostgresComputeCuSeconds')::numeric>=28800 AND (a->>'postgresComputeCuSeconds')::numeric>=(a->>'requiredPostgresComputeCuSeconds')::numeric AND (a->>'requiredSharedTransferBytes')::numeric>=1048576
 AND y->>'version'='issue76-once-v1' AND y->'issue'='76'::jsonb AND y->'unknownActivityAccepted'='true'::jsonb AND y->'quotaFailureAccepted'='true'::jsonb
 AND jsonb_typeof(y->'approvalRef')='string' AND y->>'approvalRef' ~ '^[A-Za-z0-9_-]{1,80}$'
 AND f->>'status'='free-tier' AND f->>'source' IN ('owner-console','provider-api')
 AND (SELECT count(*)=2 AND bool_and(jsonb_typeof(v.value)='string' AND (v.value#>>'{}') ~ '^[A-Za-z0-9_-]{1,80}$') FROM jsonb_each(f) v WHERE v.key IN ('evidence','billingEvidence'))
 AND (SELECT count(*)=2 AND bool_and(jsonb_typeof(v.value)='number' AND (v.value#>>'{}')::numeric BETWEEN lo AND hi AND trunc((v.value#>>'{}')::numeric)=(v.value#>>'{}')::numeric) FROM jsonb_each(f) v WHERE v.key IN ('checkedAt','billingReviewedAt'))
 AND (SELECT array_agg(key ORDER BY key)=ARRAY['neonSharedTransfer','ociMonitoringIngestion','ociMonitoringRetrieval','ociObjectRequests','ociOutboundTransfer'] FROM jsonb_object_keys(y->'meters') key),false)
 THEN RETURN false; END IF;
 FOR k,m IN SELECT key,value FROM jsonb_each(y->'meters') LOOP
  cap:=CASE k WHEN 'neonSharedTransfer' THEN 5000000000 WHEN 'ociObjectRequests' THEN 50000 WHEN 'ociOutboundTransfer' THEN 10000000000000 WHEN 'ociMonitoringIngestion' THEN 500000000 ELSE 1000000000 END;
  floor_value:=CASE k WHEN 'neonSharedTransfer' THEN (a->>'requiredSharedTransferBytes')::numeric WHEN 'ociObjectRequests' THEN 200 WHEN 'ociOutboundTransfer' THEN 1048576 WHEN 'ociMonitoringRetrieval' THEN 100 ELSE 1 END;
  IF NOT coalesce(jsonb_typeof(m->'required')='number' AND (m->>'required')::numeric BETWEEN floor_value AND cap AND trunc((m->>'required')::numeric)=(m->>'required')::numeric
   AND m->'knownInsufficient'='false'::jsonb
   AND jsonb_typeof(m->'checkedAt')='number' AND (m->>'checkedAt')::numeric BETWEEN lo AND hi AND trunc((m->>'checkedAt')::numeric)=(m->>'checkedAt')::numeric
   AND jsonb_typeof(m->'sourceRef')='string' AND m->>'sourceRef' ~ '^[A-Za-z0-9_-]{1,80}$'
   AND jsonb_typeof(m->'periodRef')='string' AND m->>'periodRef' ~ '^[A-Za-z0-9_-]{1,80}$',false) THEN RETURN false; END IF;
  required:=(m->>'required')::numeric;
  IF m->'observed'='"not-exposed"'::jsonb THEN
   IF m->'unit' IS DISTINCT FROM '"not-exposed"'::jsonb OR m->'remaining' IS DISTINCT FROM '"unknown"'::jsonb OR m->'coverage' IS DISTINCT FROM '"unavailable"'::jsonb THEN RETURN false; END IF;
   CONTINUE;
  END IF;
  IF jsonb_typeof(m->'observed') IS DISTINCT FROM 'number' OR (m->>'observed')::numeric NOT BETWEEN 0 AND 9007199254740991 THEN RETURN false; END IF;
  observed:=(m->>'observed')::numeric;
  factor:=CASE WHEN k='neonSharedTransfer' AND m->>'unit'='bytes' THEN 1
   WHEN k='ociObjectRequests' AND m->>'unit'='requests' THEN 1 WHEN k='ociObjectRequests' AND m->>'unit'='10K Requests' THEN 10000
   WHEN k='ociOutboundTransfer' AND m->>'unit'='bytes' THEN 1 WHEN k='ociOutboundTransfer' AND m->>'unit'='GB' THEN 1000000000 WHEN k='ociOutboundTransfer' AND m->>'unit'='GB Months' THEN 0
   WHEN k IN ('ociMonitoringIngestion','ociMonitoringRetrieval') AND m->>'unit'='datapoints' THEN 1 WHEN k IN ('ociMonitoringIngestion','ociMonitoringRetrieval') AND m->>'unit'='Million Datapoints' THEN 1000000 ELSE NULL END;
  IF factor IS NULL OR (factor>0 AND ceil(observed*factor)+required>cap) THEN RETURN false; END IF;
  IF m->'remaining'='"unknown"'::jsonb THEN
   IF m->'coverage' IS DISTINCT FROM '"partial"'::jsonb THEN RETURN false; END IF;
  ELSE
   IF NOT coalesce(factor>0 AND m->>'coverage'='complete' AND jsonb_typeof(m->'remaining')='number'
    AND (m->>'remaining')::numeric BETWEEN required AND cap-ceil(observed*factor) AND trunc((m->>'remaining')::numeric)=(m->>'remaining')::numeric
    AND jsonb_typeof(m->'normalizationRef')='string' AND m->>'normalizationRef' ~ '^[A-Za-z0-9_-]{1,80}$',false) THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION berth_executor.valid_bounded_allowance(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
ALTER FUNCTION berth_executor.valid_functions_policy(uuid,timestamptz,jsonb,jsonb) RENAME TO valid_functions_policy_strict;
CREATE FUNCTION berth_executor.valid_functions_policy(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_evidence ? 'allowanceException' THEN RETURN berth_executor.valid_bounded_allowance(p_operation,p_start,p_binding,p_evidence); END IF;
 RETURN berth_executor.valid_functions_policy_strict(p_operation,p_start,p_binding,p_evidence);
END $$;
REVOKE ALL ON FUNCTION berth_executor.valid_functions_policy(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
ALTER FUNCTION berth_executor.prepare(uuid,timestamptz,jsonb,jsonb) RENAME TO prepare_without_allowance_exception;
REVOKE ALL ON FUNCTION berth_executor.prepare_without_allowance_exception(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.prepare(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF current_user<>'neondb_owner' THEN RAISE EXCEPTION 'Expected owner'; END IF;
 result:=berth_executor.prepare_without_allowance_exception(p_operation,p_start,p_binding,p_evidence);
 IF p_evidence ? 'allowanceException' THEN
  INSERT INTO berth_executor.bounded_allowance_exception(operation,started_at,expires_at,binding,evidence) VALUES(p_operation,p_start,p_start+interval '4 hours',p_binding,p_evidence);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION berth_executor.prepare(uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,berth_runtime;
ALTER FUNCTION berth_executor.admission_status(uuid,jsonb) RENAME TO admission_status_without_bounded_allowance;
REVOKE ALL ON FUNCTION berth_executor.admission_status_without_bounded_allowance(uuid,jsonb) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.admission_status(p_operation uuid,p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; x berth_executor.bounded_allowance_exception%ROWTYPE; t berth_ledger.trials%ROWTYPE;
BEGIN
 result:=berth_executor.admission_status_without_bounded_allowance(p_operation,p_binding);
 SELECT * INTO x FROM berth_executor.bounded_allowance_exception WHERE operation=p_operation;
 IF x.operation IS NOT NULL OR (result->'evidence') ? 'allowanceException' THEN
  SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation;
  result:=result || jsonb_build_object('evidenceBound',coalesce(result->'evidenceBound'='true'::jsonb AND x.operation=p_operation AND x.binding=p_binding AND x.evidence=result->'evidence' AND x.started_at=t.started_at AND x.expires_at=t.expires_at,false));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION berth_executor.admission_status(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.admission_status(uuid,jsonb) TO berth_runtime;
ALTER FUNCTION berth_executor.report(uuid) RENAME TO report_without_bounded_allowance;
REVOKE ALL ON FUNCTION berth_executor.report_without_bounded_allowance(uuid) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.report(p_operation uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb; x berth_executor.bounded_allowance_exception%ROWTYPE;
BEGIN
 result:=berth_executor.report_without_bounded_allowance(p_operation);
 SELECT * INTO x FROM berth_executor.bounded_allowance_exception WHERE operation=p_operation;
 IF x.operation IS NOT NULL THEN result:=jsonb_set(result,'{feasibility}',coalesce(result->'feasibility','{}'::jsonb) || jsonb_build_object('verdict','partial','hardSpendingCap',false,'allowanceException',x.evidence->'allowanceException')); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION berth_executor.report(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.report(uuid) TO berth_runtime;
COMMIT;
