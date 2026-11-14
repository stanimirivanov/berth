-- Owner prepares a fixed window before deployment. Runtime cannot extend or replace it.
BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected owner'; END IF;
END $$;
CREATE TABLE berth_executor.admission (
 operation uuid PRIMARY KEY REFERENCES berth_ledger.trials,
 binding jsonb NOT NULL, evidence jsonb NOT NULL,
 verified_at timestamptz, admitted boolean NOT NULL DEFAULT false
);
REVOKE ALL ON berth_executor.admission FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.prepare(p_operation uuid,p_start timestamptz,p_binding jsonb,p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_user<>'neondb_owner' OR p_start IS NULL OR p_start<clock_timestamp()-interval '5 minutes' OR p_start>clock_timestamp()+interval '1 hour'
 OR coalesce((p_binding->>'neonLimit')::integer,0)<40
 OR EXISTS(SELECT FROM berth_ledger.trials WHERE operation=p_operation) THEN RAISE EXCEPTION 'Fresh owner preparation required'; END IF;
 PERFORM berth_ledger.start_trial(p_operation,p_binding->>'compartment',p_binding->>'region',p_binding->>'namespace',
 'fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83',(p_binding->>'monitoringLimit')::integer,(p_binding->>'neonLimit')::integer);
 UPDATE berth_ledger.trials SET started_at=p_start,expires_at=p_start+interval '4 hours' WHERE operation=p_operation;
 INSERT INTO berth_executor.admission(operation,binding,evidence) VALUES(p_operation,p_binding,p_evidence);
 RETURN berth_executor.report(p_operation)->'trial';
END $$;
CREATE FUNCTION berth_executor.admission_status(p_operation uuid,p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a berth_executor.admission%ROWTYPE;
BEGIN
 SELECT * INTO STRICT a FROM berth_executor.admission WHERE operation=p_operation;
 IF a.binding IS DISTINCT FROM p_binding THEN RAISE EXCEPTION 'Deployment binding mismatch'; END IF;
 RETURN jsonb_build_object('admitted',a.admitted,'verifiedAt',extract(epoch FROM a.verified_at)*1000,'evidence',a.evidence);
END $$;
CREATE FUNCTION berth_executor.admission_verified(p_operation uuid,p_owner uuid,p_generation bigint,p_binding jsonb,p_attempt uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 t:=berth_ledger.guard(p_operation,p_owner,p_generation);
 PERFORM berth_executor.admission_status(p_operation,p_binding);
 IF clock_timestamp()>=t.started_at+interval '5 minutes'
 OR NOT EXISTS(SELECT FROM berth_ledger.attempts WHERE id=p_attempt AND operation=p_operation AND generation=p_generation AND action='inspect' AND outcome='open')
 OR (SELECT count(*) FROM berth_ledger.requests WHERE attempt=p_attempt AND operation=p_operation AND generation=p_generation AND meter='normal' AND NOT mutation AND outcome='succeeded')<>2
 OR (SELECT count(*) FROM berth_ledger.requests WHERE attempt=p_attempt)<>2 THEN RAISE EXCEPTION 'Credential receipt rejected'; END IF;
 UPDATE berth_executor.admission SET verified_at=clock_timestamp() WHERE operation=p_operation AND NOT admitted;
END $$;
CREATE FUNCTION berth_executor.admit(p_operation uuid,p_binding jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE a berth_executor.admission%ROWTYPE; t berth_ledger.trials%ROWTYPE; n timestamptz;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 n:=clock_timestamp();
 PERFORM berth_executor.admission_status(p_operation,p_binding);
 SELECT * INTO STRICT a FROM berth_executor.admission WHERE operation=p_operation FOR UPDATE;
 IF a.admitted THEN RETURN false; END IF;
 IF n<t.started_at OR n>=t.started_at+interval '5 minutes' OR a.verified_at IS NULL OR a.verified_at<n-interval '5 minutes'
 OR t.outcome<>'active' OR t.cleanup_started OR EXISTS(SELECT FROM berth_executor.work WHERE operation=p_operation AND cleanup_requested)
 OR a.evidence->>'iamReviewed' IS DISTINCT FROM 'true'
 OR coalesce((a.evidence->>'checkedAt')::numeric,0) NOT BETWEEN extract(epoch FROM n-interval '24 hours')*1000 AND extract(epoch FROM n)*1000
 OR coalesce((a.evidence->>'iamCheckedAt')::numeric,0) NOT BETWEEN extract(epoch FROM n-interval '24 hours')*1000 AND extract(epoch FROM n)*1000
 THEN RAISE EXCEPTION 'Admission evidence or creation margin rejected'; END IF;
 UPDATE berth_executor.admission SET admitted=true WHERE operation=p_operation;
 RETURN true;
END $$;
-- HTTP receipts share the existing Neon counter, including terminal evidence calls.
CREATE TABLE berth_executor.http_receipts(id uuid PRIMARY KEY, operation uuid NOT NULL REFERENCES berth_ledger.trials,purpose text NOT NULL CHECK(purpose IN ('admission','control','cleanup','scheduled')),reserved_cleanup boolean NOT NULL,at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON berth_executor.http_receipts FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.meter_http(p_operation uuid,p_binding jsonb,p_id uuid,p_purpose text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; cleanup boolean;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 PERFORM berth_executor.admission_status(p_operation,p_binding);
 cleanup:=p_purpose='cleanup' OR (p_purpose='scheduled' AND (clock_timestamp()>=t.started_at+interval '3 hours' OR EXISTS(SELECT FROM berth_executor.work WHERE operation=p_operation AND cleanup_requested)));
 IF clock_timestamp()<t.started_at OR clock_timestamp()>=t.expires_at OR t.neon_limit<40
 OR (NOT cleanup AND t.neon_used>=t.neon_limit-12)
 OR (p_purpose='admission' AND (SELECT count(*) FROM berth_executor.http_receipts WHERE operation=p_operation AND purpose='admission')>=6)
 OR (NOT cleanup AND (SELECT count(*) FROM berth_executor.http_receipts r WHERE r.operation=p_operation AND NOT r.reserved_cleanup)>=52)
 OR (cleanup AND (SELECT count(*) FROM berth_executor.http_receipts r WHERE r.operation=p_operation AND r.reserved_cleanup)>=12) THEN RAISE EXCEPTION 'HTTP invocation budget'; END IF;
 INSERT INTO berth_executor.http_receipts(id,operation,purpose,reserved_cleanup) VALUES(p_id,p_operation,p_purpose,cleanup);
 UPDATE berth_ledger.trials SET neon_used=neon_used+1 WHERE operation=p_operation;
END $$;
REVOKE ALL ON FUNCTION berth_executor.meter_http(uuid,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.meter_http(uuid,jsonb,uuid,text) TO berth_runtime;
-- Preserve existing ledger logic, but enforce the live gate again at both mutation boundaries.
ALTER FUNCTION berth_ledger.begin_attempt(uuid,uuid,bigint,uuid,text) RENAME TO begin_attempt_unadmitted;
ALTER FUNCTION berth_ledger.reserve(uuid,uuid,bigint,uuid,uuid) RENAME TO reserve_unadmitted;
REVOKE ALL ON FUNCTION berth_ledger.begin_attempt_unadmitted(uuid,uuid,bigint,uuid,text),berth_ledger.reserve_unadmitted(uuid,uuid,bigint,uuid,uuid) FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.creation_admitted(p_operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM 1 FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF NOT EXISTS(SELECT FROM berth_executor.admission WHERE operation=p_operation AND admitted)
 AND NOT EXISTS(SELECT FROM berth_ledger.trials WHERE operation=p_operation AND namespace='berthsynthetic' AND compartment='ocid1.compartment.oc1..synthetic')
 OR EXISTS(SELECT FROM berth_executor.work WHERE operation=p_operation AND cleanup_requested) THEN RAISE EXCEPTION 'Creation not admitted'; END IF;
END $$;
CREATE FUNCTION berth_ledger.begin_attempt(p_operation uuid,p_owner uuid,p_generation bigint,p_id uuid,p_action text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
BEGIN
 IF p_action IN ('create_bucket','put_object') THEN PERFORM berth_executor.creation_admitted(p_operation); END IF;
 RETURN berth_ledger.begin_attempt_unadmitted(p_operation,p_owner,p_generation,p_id,p_action);
END $$;
CREATE FUNCTION berth_ledger.reserve(p_operation uuid,p_owner uuid,p_generation bigint,p_attempt uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
BEGIN
 PERFORM 1 FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF EXISTS(SELECT FROM berth_ledger.attempts WHERE id=p_attempt AND operation=p_operation AND action IN ('create_bucket','put_object')) THEN PERFORM berth_executor.creation_admitted(p_operation); END IF;
 IF EXISTS(SELECT FROM berth_executor.admission WHERE operation=p_operation)
 AND EXISTS(SELECT FROM berth_ledger.attempts WHERE id=p_attempt AND operation=p_operation AND action='invoke')
 AND EXISTS(SELECT FROM berth_ledger.trials WHERE operation=p_operation AND neon_used>=neon_limit-12 AND clock_timestamp()<started_at+interval '3 hours')
 AND NOT EXISTS(SELECT FROM berth_executor.work WHERE operation=p_operation AND cleanup_requested) THEN RAISE EXCEPTION 'Protected Neon cleanup reserve'; END IF;
 RETURN berth_ledger.reserve_unadmitted(p_operation,p_owner,p_generation,p_attempt,p_id);
END $$;
REVOKE ALL ON FUNCTION berth_executor.prepare(uuid,timestamptz,jsonb,jsonb),berth_executor.creation_admitted(uuid),berth_executor.admission_status(uuid,jsonb),berth_executor.admission_verified(uuid,uuid,bigint,jsonb,uuid),berth_executor.admit(uuid,jsonb) FROM PUBLIC,berth_runtime;
REVOKE ALL ON FUNCTION berth_ledger.begin_attempt(uuid,uuid,bigint,uuid,text),berth_ledger.reserve(uuid,uuid,bigint,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berth_executor.admission_status(uuid,jsonb),berth_executor.admission_verified(uuid,uuid,bigint,jsonb,uuid),berth_executor.admit(uuid,jsonb),berth_ledger.begin_attempt(uuid,uuid,bigint,uuid,text),berth_ledger.reserve(uuid,uuid,bigint,uuid,uuid) TO berth_runtime;
COMMIT;
