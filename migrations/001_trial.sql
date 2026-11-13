-- Fresh, owner-only migration. Refuse adoption; never install from hosted runtime.
BEGIN;
DO $$ BEGIN
 IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
  RAISE EXCEPTION 'Expected dedicated owner';
 END IF;
END $$;
CREATE SCHEMA berth_ledger AUTHORIZATION neondb_owner;
REVOKE ALL ON SCHEMA berth_ledger FROM PUBLIC;
CREATE TABLE berth_ledger.gate (singleton boolean PRIMARY KEY CHECK(singleton));
INSERT INTO berth_ledger.gate VALUES(true);
CREATE TABLE berth_ledger.trials (
 operation uuid PRIMARY KEY, compartment text NOT NULL, region text NOT NULL,
 namespace text NOT NULL, digest text NOT NULL, marker uuid NOT NULL DEFAULT gen_random_uuid(),
 bucket text NOT NULL, object_name text NOT NULL DEFAULT 'trial.bin',
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 outcome text NOT NULL DEFAULT 'active' CHECK(outcome IN ('active','needs-reconciliation','succeeded','failed')),
 owner uuid, generation bigint NOT NULL DEFAULT 0, lease_until timestamptz NOT NULL DEFAULT '-infinity',
 cleanup_started boolean NOT NULL DEFAULT false,
 normal_used integer NOT NULL DEFAULT 0 CHECK(normal_used BETWEEN 0 AND 160),
 cleanup_used integer NOT NULL DEFAULT 0 CHECK(cleanup_used BETWEEN 0 AND 40),
 monitoring_used integer NOT NULL DEFAULT 0, neon_used integer NOT NULL DEFAULT 0,
 monitoring_limit integer NOT NULL CHECK(monitoring_limit BETWEEN 1 AND 1000),
 neon_limit integer NOT NULL CHECK(neon_limit BETWEEN 1 AND 1000),
 CHECK(monitoring_used BETWEEN 0 AND monitoring_limit), CHECK(neon_used BETWEEN 0 AND neon_limit)
);
CREATE UNIQUE INDEX one_active_trial ON berth_ledger.trials((true)) WHERE outcome IN ('active','needs-reconciliation');
CREATE TABLE berth_ledger.claims (
 owner uuid PRIMARY KEY, operation uuid NOT NULL REFERENCES berth_ledger.trials,
 generation bigint NOT NULL, UNIQUE(operation,generation)
);
CREATE TABLE berth_ledger.attempts (
 id uuid PRIMARY KEY, operation uuid NOT NULL REFERENCES berth_ledger.trials,
 action text NOT NULL CHECK(action IN ('create_bucket','put_object','inspect','inspect_cleanup','delete_object','delete_bucket','monitor','invoke')),
 generation bigint NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 outcome text NOT NULL DEFAULT 'open' CHECK(outcome IN ('open','succeeded','failed')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operation,action,ordinal)
);
CREATE TABLE berth_ledger.requests (
 id uuid PRIMARY KEY, attempt uuid NOT NULL REFERENCES berth_ledger.attempts,
 operation uuid NOT NULL REFERENCES berth_ledger.trials, generation bigint NOT NULL,
 meter text NOT NULL, mutation boolean NOT NULL, reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL DEFAULT 'unresolved' CHECK(outcome IN ('unresolved','succeeded','rejected')),
 resolved_at timestamptz, resolution_generation bigint, basis text
);
REVOKE ALL ON ALL TABLES IN SCHEMA berth_ledger FROM PUBLIC,berth_runtime;

CREATE FUNCTION berth_ledger.start_trial(p_operation uuid,p_compartment text,p_region text,p_namespace text,p_digest text,p_monitoring integer,p_neon integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; started timestamptz:=clock_timestamp();
BEGIN
 IF p_operation IS NULL OR p_compartment IS NULL OR p_compartment !~ '^ocid1[.]compartment[.]oc1[.][.][A-Za-z0-9]{1,128}$'
 OR p_region IS NULL OR p_region !~ '^[a-z]{2}-[a-z]+-[1-9]$'
 OR p_namespace IS NULL OR p_namespace !~ '^[A-Za-z0-9_-]{1,64}$'
 OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
 OR p_monitoring IS NULL OR p_monitoring NOT BETWEEN 1 AND 1000 OR p_neon IS NULL OR p_neon NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Invalid trial intent';
 END IF;
 PERFORM 1 FROM berth_ledger.gate WHERE singleton FOR UPDATE;
 SELECT * INTO t FROM berth_ledger.trials WHERE operation=p_operation;
 IF FOUND THEN
  IF t.compartment<>p_compartment OR t.region<>p_region OR t.namespace<>p_namespace OR t.digest<>p_digest
   OR t.monitoring_limit<>p_monitoring OR t.neon_limit<>p_neon THEN RAISE EXCEPTION 'Trial intent conflict'; END IF;
 ELSE
  INSERT INTO berth_ledger.trials(operation,compartment,region,namespace,digest,bucket,started_at,expires_at,monitoring_limit,neon_limit)
  VALUES(p_operation,p_compartment,p_region,p_namespace,p_digest,'berth-'||replace(p_operation::text,'-',''),started,started+interval '4 hours',p_monitoring,p_neon) RETURNING * INTO t;
 END IF;
 RETURN to_jsonb(t);
END $$;

CREATE FUNCTION berth_ledger.claim(p_operation uuid,p_owner uuid,p_ttl integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 IF p_owner IS NULL OR p_ttl IS NULL OR p_ttl NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Invalid claim'; END IF;
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF t.outcome NOT IN ('active','needs-reconciliation') THEN RAISE EXCEPTION 'Trial closed'; END IF;
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
CREATE FUNCTION berth_ledger.guard(p_operation uuid,p_owner uuid,p_generation bigint)
RETURNS berth_ledger.trials LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 SELECT * INTO STRICT t FROM berth_ledger.trials WHERE operation=p_operation FOR UPDATE;
 IF p_owner IS NULL OR p_generation IS NULL OR t.owner IS DISTINCT FROM p_owner OR t.generation<>p_generation
 OR t.lease_until<=clock_timestamp() OR t.outcome NOT IN ('active','needs-reconciliation') THEN RAISE EXCEPTION 'Ownership rejected'; END IF;
 RETURN t;
END $$;

CREATE FUNCTION berth_ledger.begin_attempt(p_operation uuid,p_owner uuid,p_generation bigint,p_id uuid,p_action text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; a berth_ledger.attempts%ROWTYPE; n integer;
BEGIN
 t:=berth_ledger.guard(p_operation,p_owner,p_generation);
 SELECT * INTO a FROM berth_ledger.attempts WHERE id=p_id;
 IF FOUND THEN
  IF a.operation<>p_operation OR a.action IS DISTINCT FROM p_action OR (a.generation<>p_generation AND a.action IN ('create_bucket','put_object','delete_object','delete_bucket')) THEN RAISE EXCEPTION 'Attempt conflict'; END IF;
  RETURN a.id;
 END IF;
 IF p_id IS NULL OR p_action IS NULL OR p_action NOT IN ('create_bucket','put_object','inspect','inspect_cleanup','delete_object','delete_bucket','monitor','invoke') THEN RAISE EXCEPTION 'Invalid action'; END IF;
 IF clock_timestamp()>=t.expires_at THEN RAISE EXCEPTION 'Trial expired'; END IF;
 IF p_action IN ('create_bucket','put_object') AND (t.outcome<>'active' OR t.cleanup_started OR clock_timestamp()>=t.started_at+interval '30 minutes') THEN RAISE EXCEPTION 'Creation ended'; END IF;
 IF p_action IN ('create_bucket','put_object','delete_object','delete_bucket') AND EXISTS(
  SELECT FROM berth_ledger.requests WHERE operation=p_operation AND mutation AND outcome='unresolved') THEN RAISE EXCEPTION 'Unresolved mutation'; END IF;
 SELECT count(*)+1 INTO n FROM berth_ledger.attempts WHERE operation=p_operation AND action=p_action;
 IF n>3 THEN RAISE EXCEPTION 'Attempt budget exhausted'; END IF;
 INSERT INTO berth_ledger.attempts(id,operation,action,generation,ordinal) VALUES(p_id,p_operation,p_action,p_generation,n);
 IF p_action IN ('inspect_cleanup','delete_object','delete_bucket') THEN UPDATE berth_ledger.trials SET cleanup_started=true WHERE operation=p_operation; END IF;
 RETURN p_id;
END $$;

CREATE FUNCTION berth_ledger.reserve(p_operation uuid,p_owner uuid,p_generation bigint,p_attempt uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE; a berth_ledger.attempts%ROWTYPE; r berth_ledger.requests%ROWTYPE; m text; mut boolean;
BEGIN
 t:=berth_ledger.guard(p_operation,p_owner,p_generation);
 SELECT * INTO STRICT a FROM berth_ledger.attempts WHERE id=p_attempt AND operation=p_operation;
 SELECT * INTO r FROM berth_ledger.requests WHERE id=p_id;
 IF FOUND THEN
  IF r.attempt<>p_attempt THEN RAISE EXCEPTION 'Reservation conflict'; END IF;
  RETURN jsonb_build_object('id',p_id,'fresh',false);
 END IF;
 IF p_id IS NULL OR (a.generation<>p_generation AND a.action IN ('create_bucket','put_object','delete_object','delete_bucket')) OR a.outcome<>'open' OR clock_timestamp()>=t.expires_at THEN RAISE EXCEPTION 'Dispatch rejected'; END IF;
 IF a.action IN ('create_bucket','put_object') AND (t.outcome<>'active' OR t.cleanup_started OR clock_timestamp()>=t.started_at+interval '30 minutes') THEN RAISE EXCEPTION 'Creation ended'; END IF;
 mut:=a.action IN ('create_bucket','put_object','delete_object','delete_bucket');
 IF mut AND EXISTS(SELECT FROM berth_ledger.requests WHERE attempt=p_attempt) THEN RAISE EXCEPTION 'Mutation attempt already dispatched'; END IF;
 IF mut AND EXISTS(SELECT FROM berth_ledger.requests WHERE operation=p_operation AND mutation AND outcome='unresolved') THEN RAISE EXCEPTION 'Unresolved mutation'; END IF;
 m:=CASE WHEN a.action IN ('inspect_cleanup','delete_object','delete_bucket') THEN 'cleanup' WHEN a.action='monitor' THEN 'monitoring' WHEN a.action='invoke' THEN 'neon' ELSE 'normal' END;
 -- Table CHECKs enforce all ceilings inside this same locked transaction.
 UPDATE berth_ledger.trials SET normal_used=normal_used+(m='normal')::int,cleanup_used=cleanup_used+(m='cleanup')::int,
 monitoring_used=monitoring_used+(m='monitoring')::int,neon_used=neon_used+(m='neon')::int WHERE operation=p_operation;
 INSERT INTO berth_ledger.requests(id,attempt,operation,generation,meter,mutation) VALUES(p_id,p_attempt,p_operation,p_generation,m,mut);
 RETURN jsonb_build_object('id',p_id,'fresh',true);
END $$;

CREATE FUNCTION berth_ledger.settle(p_operation uuid,p_owner uuid,p_generation bigint,p_id uuid,p_outcome text,p_basis text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE r berth_ledger.requests%ROWTYPE;
BEGIN
 PERFORM berth_ledger.guard(p_operation,p_owner,p_generation);
 IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded','rejected') OR p_basis IS NULL OR p_basis NOT IN ('provider-response','reconciled-provider') THEN RAISE EXCEPTION 'Invalid resolution'; END IF;
 SELECT * INTO STRICT r FROM berth_ledger.requests WHERE id=p_id AND operation=p_operation;
 IF p_basis='provider-response' AND r.generation<>p_generation THEN RAISE EXCEPTION 'Reconciliation required'; END IF;
 IF r.outcome<>'unresolved' THEN
  IF r.outcome<>p_outcome OR r.basis<>p_basis THEN RAISE EXCEPTION 'Resolution conflict'; END IF;
  RETURN;
 END IF;
 UPDATE berth_ledger.requests SET outcome=p_outcome,basis=p_basis,resolved_at=clock_timestamp(),resolution_generation=p_generation WHERE id=p_id;
END $$;

CREATE FUNCTION berth_ledger.control(p_operation uuid,p_owner uuid,p_generation bigint,p_op text,p_id uuid DEFAULT NULL,p_outcome text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE t berth_ledger.trials%ROWTYPE;
BEGIN
 t:=berth_ledger.guard(p_operation,p_owner,p_generation);
 CASE p_op
 WHEN 'read' THEN RETURN jsonb_build_object('trial',to_jsonb(t),'attempts',(SELECT coalesce(jsonb_agg(a),'[]'::jsonb) FROM berth_ledger.attempts a WHERE operation=p_operation),'requests',(SELECT coalesce(jsonb_agg(r),'[]'::jsonb) FROM berth_ledger.requests r WHERE operation=p_operation));
 WHEN 'renew' THEN UPDATE berth_ledger.trials SET lease_until=clock_timestamp()+interval '30 seconds' WHERE operation=p_operation;
 WHEN 'release' THEN UPDATE berth_ledger.trials SET lease_until=clock_timestamp() WHERE operation=p_operation;
 WHEN 'end' THEN
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded','failed') OR EXISTS(SELECT FROM berth_ledger.requests WHERE attempt=p_id AND outcome='unresolved') THEN RAISE EXCEPTION 'Attempt unresolved'; END IF;
  UPDATE berth_ledger.attempts SET outcome=p_outcome WHERE id=p_id AND operation=p_operation AND outcome IN ('open',p_outcome);
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt outcome conflict'; END IF;
 WHEN 'finish' THEN
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded','failed','needs-reconciliation') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
  IF p_outcome<>'needs-reconciliation' AND (EXISTS(SELECT FROM berth_ledger.requests WHERE operation=p_operation AND outcome='unresolved') OR EXISTS(SELECT FROM berth_ledger.attempts WHERE operation=p_operation AND outcome='open')) THEN RAISE EXCEPTION 'Trial unresolved'; END IF;
  IF p_outcome<>'needs-reconciliation' AND EXISTS(
   SELECT FROM berth_ledger.requests r JOIN berth_ledger.attempts a ON a.id=r.attempt
   WHERE r.operation=p_operation AND r.outcome='succeeded' AND a.action IN ('create_bucket','put_object'))
   AND NOT EXISTS(SELECT FROM berth_ledger.requests r JOIN berth_ledger.attempts a ON a.id=r.attempt
    WHERE r.operation=p_operation AND r.outcome='succeeded' AND a.action='delete_bucket') THEN
   RAISE EXCEPTION 'Owned resource teardown not confirmed';
  END IF;
  UPDATE berth_ledger.trials SET outcome=p_outcome WHERE operation=p_operation;
 ELSE RAISE EXCEPTION 'Invalid ledger operation';
 END CASE;
 RETURN 'null'::jsonb;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_ledger FROM PUBLIC,berth_runtime;
GRANT USAGE ON SCHEMA berth_ledger TO berth_runtime;
GRANT EXECUTE ON FUNCTION berth_ledger.start_trial(uuid,text,text,text,text,integer,integer),berth_ledger.claim(uuid,uuid,integer),
 berth_ledger.begin_attempt(uuid,uuid,bigint,uuid,text),berth_ledger.reserve(uuid,uuid,bigint,uuid,uuid),
 berth_ledger.settle(uuid,uuid,bigint,uuid,text,text),berth_ledger.control(uuid,uuid,bigint,text,uuid,text) TO berth_runtime;
COMMIT;
