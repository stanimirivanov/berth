BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected owner'; END IF;
END $$;
CREATE SCHEMA berth_executor AUTHORIZATION neondb_owner;
REVOKE ALL ON SCHEMA berth_executor FROM PUBLIC;
CREATE TABLE berth_executor.work (
 operation uuid PRIMARY KEY REFERENCES berth_ledger.trials,
 phase text NOT NULL DEFAULT 'bucket' CHECK(phase IN ('bucket','object','observe','cleanup')),
 bucket jsonb, receipt jsonb, pending_upload boolean NOT NULL DEFAULT false,
 failed boolean NOT NULL DEFAULT false, cleanup_requested boolean NOT NULL DEFAULT false,
 object_removed boolean NOT NULL DEFAULT false, reason text,
 state jsonb, synthetic jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE berth_executor.deliveries(operation uuid REFERENCES berth_ledger.trials,delivery text CHECK(delivery~'^[a-f0-9]{64}$'),generation bigint,at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(operation,delivery));
REVOKE ALL ON ALL TABLES IN SCHEMA berth_executor FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_executor.report(p_operation uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('trial',to_jsonb(t),'phase',coalesce(w.phase,'bucket'),'bucket',w.bucket,'receipt',w.receipt,'pending_upload',coalesce(w.pending_upload,false),'failed',coalesce(w.failed,false),'cleanup_requested',coalesce(w.cleanup_requested,false),'object_removed',coalesce(w.object_removed,false),'reason',w.reason)
 FROM berth_ledger.trials t LEFT JOIN berth_executor.work w ON w.operation=t.operation WHERE t.operation=p_operation
$$;
CREATE FUNCTION berth_executor.open(p_operation uuid,p_owner uuid,p_delivery text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; c jsonb;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF t.outcome IN ('succeeded','failed') THEN RETURN '{"kind":"terminal"}'; END IF;
 IF clock_timestamp()>=t.expires_at THEN RETURN '{"kind":"expired"}'; END IF;
 IF p_delivery IS NULL OR p_delivery!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Delivery rejected'; END IF;
 IF EXISTS(SELECT FROM berth_executor.deliveries WHERE operation=p_operation AND delivery=p_delivery) THEN RETURN '{"kind":"duplicate"}'; END IF;
 IF t.lease_until>clock_timestamp() THEN RETURN '{"kind":"busy"}'; END IF;
 IF (SELECT count(*) FROM berth_executor.deliveries WHERE operation=p_operation)>=64 THEN RAISE EXCEPTION 'Delivery budget'; END IF;
 c:=berth_ledger.claim(p_operation,p_owner,60);
 INSERT INTO berth_executor.work(operation) VALUES(p_operation) ON CONFLICT DO NOTHING;
 INSERT INTO berth_executor.deliveries(operation,delivery,generation) VALUES(p_operation,p_delivery,(c->>'generation')::bigint);
 RETURN jsonb_build_object('kind','claimed','claim',c,'snapshot',berth_executor.report(p_operation));
END $$;
CREATE FUNCTION berth_executor.valid_bucket(v jsonb,t berth_ledger.trials) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT v IS NOT NULL AND jsonb_typeof(v)='object' AND (SELECT count(*) FROM jsonb_object_keys(v))=4 AND v->>'operation'=t.operation::text AND v->>'marker'=t.marker::text AND v->>'id'~'^ocid1[.]bucket[.][A-Za-z0-9._-]{1,200}$' AND jsonb_typeof(v->'etag')='string' AND length(v->>'etag') BETWEEN 1 AND 256
$$;
CREATE FUNCTION berth_executor.valid_state(p jsonb,t berth_ledger.trials,depth integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text;v jsonb;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR depth>4 OR octet_length(p::text)>32768 THEN RETURN false; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p) LOOP
 CASE k
 WHEN 'props' THEN IF v<>jsonb_build_object('operation',t.operation) THEN RETURN false; END IF;
 WHEN 'attr' THEN IF v<>'null' AND NOT coalesce(berth_executor.valid_bucket(v,t),false) THEN RETURN false; END IF;
 WHEN 'old' THEN IF NOT berth_executor.valid_state(v,t,depth+1) THEN RETURN false; END IF;
 WHEN 'resourceType' THEN IF v<>'"Berth.OCI.Bucket"' THEN RETURN false; END IF;
 WHEN 'fqn','logicalId' THEN IF v<>'"bucket"' THEN RETURN false; END IF;
 WHEN 'namespace' THEN IF v<>'null' THEN RETURN false; END IF;
 WHEN 'instanceId' THEN IF jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^[A-Za-z0-9_-]{1,128}$' THEN RETURN false; END IF;
 WHEN 'providerVersion' THEN IF v<>'1' THEN RETURN false; END IF;
 WHEN 'status' THEN IF jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('creating','created','updating','updated','deleting') THEN RETURN false; END IF;
 WHEN 'bindings','downstream' THEN IF v<>'[]' THEN RETURN false; END IF;
 WHEN 'kind' THEN IF v<>'"resource"' THEN RETURN false; END IF;
 WHEN 'removalPolicy' THEN IF v<>'"destroy"' THEN RETURN false; END IF;
 WHEN 'providerMode' THEN IF v<>'"live"' THEN RETURN false; END IF;
 ELSE RETURN false;
 END CASE;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION berth_executor.access(p_operation uuid,p_owner uuid,p_generation bigint,p_command text,p_value jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; w berth_executor.work%ROWTYPE;
BEGIN
 t:=berth_ledger.guard(p_operation,p_owner,p_generation);
 SELECT * INTO STRICT w FROM berth_executor.work WHERE operation=p_operation;
 CASE p_command
 WHEN 'snapshot' THEN RETURN berth_executor.report(p_operation);
 WHEN 'bucket' THEN
  IF NOT coalesce(berth_executor.valid_bucket(p_value,t),false) OR (w.bucket IS NOT NULL AND w.bucket->>'id'<>p_value->>'id') THEN RAISE EXCEPTION 'Bucket identity rejected'; END IF;
  UPDATE berth_executor.work SET bucket=p_value,state=CASE WHEN state IS NOT NULL THEN state||jsonb_build_object('attr',p_value,'status','created') ELSE state END WHERE operation=p_operation;
 WHEN 'pending-upload' THEN UPDATE berth_executor.work SET pending_upload=true WHERE operation=p_operation;
 WHEN 'receipt' THEN
  IF w.bucket IS NULL OR jsonb_typeof(p_value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_value))<>3 OR p_value->>'bucketId' IS DISTINCT FROM w.bucket->>'id' OR p_value->>'digest' IS DISTINCT FROM t.digest OR jsonb_typeof(p_value->'etag') IS DISTINCT FROM 'string' OR coalesce(length(p_value->>'etag'),0) NOT BETWEEN 1 AND 256 OR (w.receipt IS NOT NULL AND w.receipt->>'etag'<>p_value->>'etag') THEN RAISE EXCEPTION 'Object identity rejected'; END IF;
  UPDATE berth_executor.work SET receipt=p_value WHERE operation=p_operation;
 WHEN 'phase' THEN
  IF p_value#>>'{}' NOT IN ('object','observe','cleanup') OR (w.phase='cleanup' AND p_value<>'"cleanup"') THEN RAISE EXCEPTION 'Phase rejected'; END IF;
  UPDATE berth_executor.work SET phase=p_value#>>'{}' WHERE operation=p_operation;
 WHEN 'failed' THEN UPDATE berth_executor.work SET failed=true,phase='cleanup' WHERE operation=p_operation;
 WHEN 'reason' THEN
  IF p_value#>>'{}' NOT IN ('unresolved-provider-call','deadline','provider-rejected','budget-or-lease','state-uncertain','external-removal') THEN RAISE EXCEPTION 'Reason rejected'; END IF;
  UPDATE berth_executor.work SET reason=p_value#>>'{}' WHERE operation=p_operation;
 WHEN 'object-removed' THEN UPDATE berth_executor.work SET object_removed=true WHERE operation=p_operation;
 WHEN 'synthetic' THEN
  IF t.namespace<>'berthsynthetic' OR t.compartment<>'ocid1.compartment.oc1..synthetic' THEN RAISE EXCEPTION 'Synthetic target required'; END IF;
  IF p_value<>'null' THEN
   IF jsonb_typeof(p_value)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_value))<>2 OR jsonb_typeof(p_value->'bucket') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_value->'object') IS DISTINCT FROM 'boolean' OR (p_value->'object'='true' AND p_value->'bucket'='false') THEN RAISE EXCEPTION 'Synthetic state rejected'; END IF;
   UPDATE berth_executor.work SET synthetic=p_value WHERE operation=p_operation;RETURN p_value;
  END IF;
  RETURN '{"bucket":false,"object":false}'::jsonb||w.synthetic;
 WHEN 'get-state' THEN RETURN w.state;
 WHEN 'set-state' THEN
  IF NOT berth_executor.valid_state(p_value,t) OR p_value->>'resourceType' IS DISTINCT FROM 'Berth.OCI.Bucket' OR p_value->>'fqn' IS DISTINCT FROM 'bucket' OR p_value->>'logicalId' IS DISTINCT FROM 'bucket' OR NOT(p_value ?& ARRAY['status','instanceId','providerVersion','downstream','bindings']) THEN RAISE EXCEPTION 'State rejected'; END IF;
  UPDATE berth_executor.work SET state=p_value WHERE operation=p_operation;
 WHEN 'delete-state' THEN UPDATE berth_executor.work SET state=NULL WHERE operation=p_operation;
 ELSE RAISE EXCEPTION 'Command rejected';
 END CASE;
 RETURN 'null';
END $$;
CREATE FUNCTION berth_executor.cleanup(p_operation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF t.outcome IN ('succeeded','failed') THEN RETURN; END IF;
 INSERT INTO berth_executor.work(operation,cleanup_requested) VALUES(p_operation,true) ON CONFLICT(operation) DO UPDATE SET cleanup_requested=true;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_executor FROM PUBLIC,berth_runtime;
GRANT USAGE ON SCHEMA berth_executor TO berth_runtime;
GRANT EXECUTE ON FUNCTION berth_executor.report(uuid),berth_executor.open(uuid,uuid,text),berth_executor.access(uuid,uuid,bigint,text,jsonb),berth_executor.cleanup(uuid) TO berth_runtime;
-- Extend settlement only for provably read-only interruption or same-owner unsent calls.
CREATE OR REPLACE FUNCTION berth_ledger.settle(p_operation uuid,p_owner uuid,p_generation bigint,p_id uuid,p_outcome text,p_basis text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE r berth_ledger.requests%ROWTYPE;
BEGIN
 PERFORM berth_ledger.guard(p_operation,p_owner,p_generation);
 IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded','rejected') OR p_basis IS NULL OR p_basis NOT IN ('provider-response','reconciled-provider','read-only-interruption','not-dispatched') THEN RAISE EXCEPTION 'Invalid resolution'; END IF;
 SELECT * INTO STRICT r FROM berth_ledger.requests WHERE id=p_id AND operation=p_operation;
 IF p_basis IN ('provider-response','not-dispatched') AND r.generation<>p_generation THEN RAISE EXCEPTION 'Reconciliation required'; END IF;
 IF p_basis='read-only-interruption' AND (r.mutation OR p_outcome<>'rejected') THEN RAISE EXCEPTION 'Mutation cannot be retired'; END IF;
 IF p_basis='not-dispatched' AND p_outcome<>'rejected' THEN RAISE EXCEPTION 'Invalid unsent outcome'; END IF;
 IF r.outcome<>'unresolved' THEN
  IF r.outcome<>p_outcome OR r.basis<>p_basis THEN RAISE EXCEPTION 'Resolution conflict'; END IF;
  RETURN;
 END IF;
 UPDATE berth_ledger.requests SET outcome=p_outcome,basis=p_basis,resolved_at=clock_timestamp(),resolution_generation=p_generation WHERE id=p_id;
END $$;

COMMIT;
