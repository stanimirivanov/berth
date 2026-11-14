BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected owner'; END IF;
END $$;
CREATE SCHEMA berth_usage AUTHORIZATION neondb_owner;
REVOKE ALL ON SCHEMA berth_usage FROM PUBLIC;
CREATE TABLE berth_usage.state (
 operation uuid PRIMARY KEY REFERENCES berth_ledger.trials,
 uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_due timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
 polled_at timestamptz, closed_at timestamptz
);
CREATE TABLE berth_usage.observations (
 operation uuid REFERENCES berth_usage.state, observed_at timestamptz NOT NULL,
 samples jsonb NOT NULL, PRIMARY KEY(operation,observed_at)
);
CREATE TABLE berth_usage.warnings (
 operation uuid PRIMARY KEY REFERENCES berth_usage.state,
 source_at timestamptz NOT NULL, observed_at timestamptz NOT NULL, bytes double precision NOT NULL CHECK(bytes>=1048576)
);
REVOKE ALL ON ALL TABLES IN SCHEMA berth_usage FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_usage.control(p_operation uuid,p_owner uuid,p_generation bigint,p_command text,p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; w berth_executor.work%ROWTYPE; s berth_usage.state%ROWTYPE; v jsonb; n text; at timestamptz; observed timestamptz; amount double precision; expected_warning boolean;
BEGIN
 t:=berth_ledger.guard(p_operation,p_owner,p_generation);
 SELECT * INTO STRICT w FROM berth_executor.work WHERE operation=p_operation;
 SELECT * INTO s FROM berth_usage.state WHERE operation=p_operation;
 IF p_command='uploaded' THEN
  IF w.receipt IS NULL OR w.bucket IS NULL OR w.phase NOT IN ('object','observe') OR w.cleanup_requested OR w.failed THEN RAISE EXCEPTION 'Upload unverified'; END IF;
  INSERT INTO berth_usage.state(operation) VALUES(p_operation) ON CONFLICT DO NOTHING;
 ELSIF p_command='close' THEN
  UPDATE berth_usage.state SET closed_at=coalesce(closed_at,clock_timestamp()) WHERE operation=p_operation;
 ELSIF p_command IN ('allowed','due') THEN
  IF s.operation IS NULL OR s.closed_at IS NOT NULL OR w.phase<>'observe' OR w.cleanup_requested OR w.failed OR t.cleanup_started OR t.outcome<>'active' OR clock_timestamp()>=t.started_at+interval '3 hours' THEN
   RETURN CASE WHEN p_command='allowed' THEN 'false'::jsonb ELSE 'null'::jsonb END;
  END IF;
  IF p_command='allowed' THEN RETURN to_jsonb(s.polled_at IS NOT NULL AND s.polled_at>clock_timestamp()-interval '50 seconds'); END IF;
  IF clock_timestamp()<s.next_due THEN RETURN 'null'; END IF;
  UPDATE berth_usage.state SET polled_at=clock_timestamp(),next_due=clock_timestamp()+interval '1 hour' WHERE operation=p_operation;
  RETURN jsonb_build_object('bucketId',w.bucket->>'id','bucket',t.bucket,'compartment',t.compartment,'uploadedAt',extract(epoch FROM s.uploaded_at)*1000);
 ELSIF p_command='record' THEN
  IF s.operation IS NULL OR s.polled_at IS NULL OR s.closed_at IS NOT NULL THEN RAISE EXCEPTION 'Poll missing'; END IF;
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_value))<>2 OR jsonb_typeof(p_value->'warning') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid warning policy'; END IF;
  expected_warning:=(p_value->>'warning')::boolean; p_value:=p_value->'samples';
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'array' OR jsonb_array_length(p_value)<>3 OR octet_length(p_value::text)>2048 THEN RAISE EXCEPTION 'Invalid observations'; END IF;
  FOR v,n IN SELECT value, (ARRAY['StoredBytes','ObjectCount','AllRequests'])[ordinality::int] FROM jsonb_array_elements(p_value) WITH ORDINALITY LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(v))<>5 OR v->>'metric' IS DISTINCT FROM n OR v->>'status' IS NULL OR v->>'status' NOT IN ('known','unknown') THEN RAISE EXCEPTION 'Invalid observation'; END IF;
   observed:=(v->>'observedAt')::timestamptz;
   IF observed IS NULL OR observed<s.polled_at-interval '5 seconds' OR observed>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'Invalid observation time'; END IF;
   IF v->>'status'='known' THEN
    at:=(v->>'sourceAt')::timestamptz; amount:=(v->>'value')::double precision;
    IF jsonb_typeof(v->'value') IS DISTINCT FROM 'number' OR amount IS NULL OR amount<0 OR amount='Infinity'::float8 OR at IS NULL OR at<s.uploaded_at+interval '1 hour' OR at>observed OR clock_timestamp()-at>interval '90 minutes' THEN RAISE EXCEPTION 'Invalid source evidence'; END IF;
   ELSE
    IF v->'value' IS DISTINCT FROM 'null'::jsonb OR v->'sourceAt' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Unknown is not zero'; END IF;
   END IF;
  END LOOP;
  IF expected_warning IS DISTINCT FROM (p_value->0->>'status'='known' AND (p_value->0->>'value')::double precision>=1048576) THEN RAISE EXCEPTION 'Warning policy mismatch'; END IF;
  IF EXISTS(SELECT FROM berth_usage.observations WHERE operation=p_operation AND observed_at=s.polled_at AND samples IS DISTINCT FROM p_value) THEN RAISE EXCEPTION 'Observation conflict'; END IF;
  INSERT INTO berth_usage.observations VALUES(p_operation,s.polled_at,p_value) ON CONFLICT DO NOTHING;
  v:=p_value->0;
  IF v->>'status'='known' AND (v->>'value')::double precision>=1048576 THEN
   INSERT INTO berth_usage.warnings VALUES(p_operation,(v->>'sourceAt')::timestamptz,(v->>'observedAt')::timestamptz,(v->>'value')::double precision) ON CONFLICT DO NOTHING;
  END IF;
 ELSE RAISE EXCEPTION 'Unknown usage command'; END IF;
 RETURN 'null';
END $$;
CREATE FUNCTION berth_usage.report(p_operation uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('operation',t.operation,'coverage','bucket-operational-not-billing','providerHardCap',false,
  'threshold',jsonb_build_object('bytes',2097152,'warningPercent',50,'enforcement','app'),
  'uploadedAt',s.uploaded_at,'closedAt',s.closed_at,
  'evidence',CASE WHEN latest.samples IS NOT NULL AND NOT EXISTS(SELECT FROM jsonb_array_elements(latest.samples) v WHERE v->>'status'<>'known' OR (s.closed_at IS NULL AND clock_timestamp()-(v->>'sourceAt')::timestamptz>interval '90 minutes')) THEN 'observed' WHEN s.closed_at IS NOT NULL OR t.outcome IN ('succeeded','failed') THEN 'inconclusive' ELSE 'unknown' END,
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('observedAt',o.observed_at,'metrics',o.samples) ORDER BY o.observed_at) FROM berth_usage.observations o WHERE o.operation=t.operation),'[]'),
  'warnings',coalesce((SELECT jsonb_agg(jsonb_build_object('kind','storage-threshold','bytes',a.bytes,'sourceAt',a.source_at,'observedAt',a.observed_at,'enforcement','app','providerHardCap',false)) FROM berth_usage.warnings a WHERE a.operation=t.operation),'[]'))
 FROM berth_ledger.trials t LEFT JOIN berth_usage.state s USING(operation)
 LEFT JOIN LATERAL (SELECT samples FROM berth_usage.observations o WHERE o.operation=t.operation ORDER BY observed_at DESC LIMIT 1) latest ON true WHERE t.operation=p_operation
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_usage FROM PUBLIC,berth_runtime;
GRANT USAGE ON SCHEMA berth_usage TO berth_runtime;
GRANT EXECUTE ON FUNCTION berth_usage.control(uuid,uuid,bigint,text,jsonb),berth_usage.report(uuid) TO berth_runtime;
COMMIT;
