-- Owner-installed read projections only. No historical rows or execution rules change.
BEGIN;
DO $$ BEGIN
 IF current_user<>'neondb_owner' OR current_database()<>'neondb' THEN RAISE EXCEPTION 'Expected dedicated owner'; END IF;
END $$;

CREATE INDEX trials_history_order ON berth_ledger.trials(started_at DESC,operation DESC);
CREATE INDEX requests_history_operation ON berth_ledger.requests(operation);

-- Private shared allowlist. Missing work is unknown, never an invented bucket phase.
CREATE FUNCTION berth_executor.history_record(p_operation uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'operation',t.operation,'startedAt',t.started_at,'expiresAt',t.expires_at,
  'outcome',t.outcome,'phase',w.phase,
  'pendingUpload',coalesce(w.pending_upload,false),
  'cleanupRequested',coalesce(w.cleanup_requested,false),
  'objectRemoved',coalesce(w.object_removed,false),'verdict','partial',
  'budgets',jsonb_build_object(
   'normal',jsonb_build_object('used',t.normal_used,'limit',160),
   'cleanup',jsonb_build_object('used',t.cleanup_used,'limit',40),
   'monitoring',jsonb_build_object('used',t.monitoring_used,'limit',t.monitoring_limit),
   'neon',jsonb_build_object('used',t.neon_used,'limit',t.neon_limit)),
  'unresolved',(SELECT jsonb_build_object('requests',count(*),'mutations',count(*) FILTER(WHERE r.mutation))
   FROM berth_ledger.requests r WHERE r.operation=t.operation AND r.outcome='unresolved'))
 FROM berth_ledger.trials t LEFT JOIN berth_executor.work w ON w.operation=t.operation
 WHERE t.operation=p_operation
$$;

CREATE FUNCTION berth_executor.history_detail(p_operation uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET statement_timeout='2s' AS $$
 SELECT berth_executor.history_record(p_operation)
$$;

CREATE FUNCTION berth_executor.history_page(p_before uuid DEFAULT NULL,p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET statement_timeout='2s' AS $$
DECLARE anchor timestamptz; row record; items jsonb:='[]'; last_id uuid; next_id uuid; n integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid history limit'; END IF;
 IF p_before IS NOT NULL THEN
  SELECT started_at INTO STRICT anchor FROM berth_ledger.trials WHERE operation=p_before;
 END IF;
 FOR row IN SELECT operation FROM berth_ledger.trials
  WHERE p_before IS NULL OR (started_at,operation)<(anchor,p_before)
  ORDER BY started_at DESC,operation DESC LIMIT p_limit+1
 LOOP
  n:=n+1;
  IF n>p_limit THEN next_id:=last_id; EXIT; END IF;
  items:=items||jsonb_build_array(berth_executor.history_record(row.operation));
  last_id:=row.operation;
 END LOOP;
 RETURN jsonb_build_object('items',items,'next',next_id);
END $$;

REVOKE ALL ON FUNCTION berth_executor.history_record(uuid),berth_executor.history_detail(uuid),berth_executor.history_page(uuid,integer) FROM PUBLIC,berth_runtime;
GRANT EXECUTE ON FUNCTION berth_executor.history_detail(uuid),berth_executor.history_page(uuid,integer) TO berth_runtime;
COMMIT;
