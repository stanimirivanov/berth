-- Owner-only additive proof fixture, installed after fenced-state.sql. Never replace/adopt.
BEGIN;
DO $$ BEGIN
 IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
  RAISE EXCEPTION 'Expected dedicated owner';
 END IF;
END $$;
CREATE TABLE berth_state.probe_events (
 phase text PRIMARY KEY CHECK(phase IN ('first','finish')),
 id_hash text UNIQUE NOT NULL CHECK(id_hash ~ '^[a-f0-9]{64}$'),
 boot uuid NOT NULL, generation bigint NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz, done boolean NOT NULL DEFAULT false
);
REVOKE ALL ON berth_state.probe_events FROM PUBLIC,berth_runtime;
CREATE FUNCTION berth_state.probe_report() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'terminal',(SELECT count(*)=2 AND bool_and(done) FROM berth_state.probe_events),
  'records',(SELECT count(*) FROM berth_state.records),
  'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY started_at),'[]'::jsonb) FROM berth_state.probe_events e)
 );
$$;
CREATE FUNCTION berth_state.probe_step(p_owner uuid,p_generation bigint,p_hash text,p_boot uuid,p_complete boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE step text;
BEGIN
 -- Reuse the authoritative fence and hold its row lock through this transaction.
 PERFORM berth_state.access(p_owner,p_generation,'snapshot');
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_boot IS NULL OR p_complete IS NULL THEN RAISE EXCEPTION 'Invalid proof input'; END IF;
 IF p_complete THEN
  UPDATE berth_state.probe_events SET done=true,completed_at=clock_timestamp()
   WHERE id_hash=p_hash AND generation=p_generation AND boot=p_boot AND NOT done RETURNING phase INTO step;
  IF step IS NULL THEN RAISE EXCEPTION 'Proof completion rejected'; END IF;
  RETURN step;
 END IF;
 IF EXISTS(SELECT FROM berth_state.probe_events WHERE NOT done) THEN RAISE EXCEPTION 'Proof requires reconciliation'; END IF;
 IF EXISTS(SELECT FROM berth_state.probe_events WHERE id_hash=p_hash) THEN RETURN 'duplicate'; END IF;
 IF (SELECT count(*) FROM berth_state.probe_events)=2 THEN RETURN 'terminal'; END IF;
 step := CASE WHEN EXISTS(SELECT FROM berth_state.probe_events) THEN 'finish' ELSE 'first' END;
 INSERT INTO berth_state.probe_events(phase,id_hash,boot,generation) VALUES(step,p_hash,p_boot,p_generation);
 RETURN step;
END $$;
REVOKE ALL ON FUNCTION berth_state.probe_report(),berth_state.probe_step(uuid,bigint,text,uuid,boolean) FROM PUBLIC,berth_runtime;
GRANT EXECUTE ON FUNCTION berth_state.probe_report(),berth_state.probe_step(uuid,bigint,text,uuid,boolean) TO berth_runtime;
COMMIT;
