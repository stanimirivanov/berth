-- Owner-only, atomic fresh bootstrap. No CREATE OR REPLACE or adoption.
-- Fixed schema/functions for one synthetic stack; not a general state service.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated database owner';
  END IF;
END $$;
CREATE SCHEMA berth_state AUTHORIZATION neondb_owner;
REVOKE ALL ON SCHEMA berth_state FROM PUBLIC;
CREATE TABLE berth_state.ownership (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner uuid, generation bigint NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 128),
  expires_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO berth_state.ownership(singleton) VALUES(true);
CREATE TABLE berth_state.claims (owner uuid PRIMARY KEY, generation bigint NOT NULL UNIQUE);
CREATE TABLE berth_state.records (
  key text PRIMARY KEY CHECK(key IN ('synthetic','$output')), value jsonb NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA berth_state FROM PUBLIC, berth_runtime;

-- Closed synthetic JSON vocabulary, including update history. No arbitrary strings,
-- credentials, bindings, actions or provider-specific payloads are admitted.
CREATE FUNCTION berth_state.valid_fragment(p jsonb, depth integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR depth>4 OR octet_length(p::text)>16384 THEN RETURN false; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(p) LOOP
  CASE k
   WHEN 'props','attr' THEN
    IF v NOT IN ('{"marker":"first"}'::jsonb,'{"marker":"second"}'::jsonb,'null'::jsonb) THEN RETURN false; END IF;
   WHEN 'old' THEN IF NOT berth_state.valid_fragment(v,depth+1) THEN RETURN false; END IF;
   WHEN 'resourceType' THEN IF v <> '"Berth.FencedProbe"'::jsonb THEN RETURN false; END IF;
   WHEN 'fqn','logicalId' THEN IF v <> '"synthetic"'::jsonb THEN RETURN false; END IF;
   WHEN 'namespace' THEN IF v <> 'null'::jsonb THEN RETURN false; END IF;
   WHEN 'instanceId' THEN IF jsonb_typeof(v)<>'string' OR (v#>>'{}') !~ '^[A-Za-z0-9_-]{1,128}$' THEN RETURN false; END IF;
   WHEN 'providerVersion' THEN IF v <> '1'::jsonb THEN RETURN false; END IF;
   WHEN 'status' THEN IF jsonb_typeof(v)<>'string' OR (v#>>'{}') NOT IN ('creating','created','updating','updated','deleting') THEN RETURN false; END IF;
   WHEN 'bindings','downstream' THEN IF v <> '[]'::jsonb THEN RETURN false; END IF;
   WHEN 'kind' THEN IF v <> '"resource"'::jsonb THEN RETURN false; END IF;
   WHEN 'removalPolicy' THEN IF v <> '"destroy"'::jsonb THEN RETURN false; END IF;
   WHEN 'providerMode' THEN IF v <> '"live"'::jsonb THEN RETURN false; END IF;
   ELSE RETURN false;
  END CASE;
 END LOOP;
 RETURN true;
END $$;

-- Repeating an uncertain acquisition with the SAME ID may observe its still-active
-- claim, but never extends it. A retired ID can never acquire a new generation.
CREATE FUNCTION berth_state.claim(p_owner uuid, p_ttl integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE current_row berth_state.ownership%ROWTYPE;
BEGIN
 IF p_owner IS NULL OR p_ttl IS NULL OR p_ttl<1 OR p_ttl>60 THEN RAISE EXCEPTION 'Invalid state claim'; END IF;
 SELECT * INTO STRICT current_row FROM berth_state.ownership WHERE singleton FOR UPDATE;
 IF EXISTS(SELECT FROM berth_state.claims WHERE owner=p_owner) THEN
  IF current_row.owner=p_owner AND current_row.expires_at>clock_timestamp() THEN
   RETURN jsonb_build_object('owner',p_owner,'generation',current_row.generation::text);
  END IF;
  RAISE EXCEPTION 'State claim unavailable';
 END IF;
 IF current_row.expires_at>clock_timestamp() OR current_row.generation>=128 THEN RAISE EXCEPTION 'State claim unavailable'; END IF;
 UPDATE berth_state.ownership SET owner=p_owner,generation=generation+1,
   expires_at=clock_timestamp()+make_interval(secs=>p_ttl) WHERE singleton
   RETURNING * INTO current_row;
 INSERT INTO berth_state.claims VALUES(p_owner,current_row.generation);
 RETURN jsonb_build_object('owner',p_owner,'generation',current_row.generation::text);
END $$;

-- Every state operation and takeover lock this SAME row through transaction commit.
-- A connection failure rolls back its transaction; no separate advisory-lock session.
CREATE FUNCTION berth_state.access(p_owner uuid,p_generation bigint,p_op text,p_key text DEFAULT NULL,p_value jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET lock_timeout='2s' AS $$
DECLARE current_row berth_state.ownership%ROWTYPE; result jsonb;
BEGIN
 SELECT * INTO STRICT current_row FROM berth_state.ownership WHERE singleton FOR UPDATE;
 IF p_owner IS NULL OR p_generation IS NULL OR current_row.owner IS DISTINCT FROM p_owner
    OR current_row.generation<>p_generation OR current_row.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'State ownership rejected';
 END IF;
 CASE p_op
  WHEN 'snapshot' THEN
   SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO result FROM berth_state.records;
   RETURN result;
  WHEN 'renew' THEN UPDATE berth_state.ownership SET expires_at=clock_timestamp()+interval '30 seconds' WHERE singleton;
  WHEN 'release' THEN UPDATE berth_state.ownership SET expires_at=clock_timestamp() WHERE singleton;
  WHEN 'clear' THEN DELETE FROM berth_state.records;
  WHEN 'delete' THEN
   IF p_key IS DISTINCT FROM 'synthetic' THEN RAISE EXCEPTION 'Invalid state key'; END IF;
   DELETE FROM berth_state.records WHERE key=p_key;
  WHEN 'set' THEN
   IF p_key IS DISTINCT FROM 'synthetic' OR NOT berth_state.valid_fragment(p_value)
      OR p_value->>'resourceType' IS DISTINCT FROM 'Berth.FencedProbe'
      OR p_value->>'fqn' IS DISTINCT FROM 'synthetic' OR p_value->>'logicalId' IS DISTINCT FROM 'synthetic'
      OR NOT(p_value ?& ARRAY['status','instanceId','providerVersion','downstream','bindings']) THEN
     RAISE EXCEPTION 'Invalid state payload';
   END IF;
   INSERT INTO berth_state.records VALUES(p_key,p_value) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  WHEN 'output' THEN
   IF p_value IS NULL OR p_value NOT IN ('{}'::jsonb,'{"marker":"first"}'::jsonb,'{"marker":"second"}'::jsonb) THEN RAISE EXCEPTION 'Invalid state output'; END IF;
   INSERT INTO berth_state.records VALUES('$output',p_value) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  ELSE RAISE EXCEPTION 'Invalid state operation';
 END CASE;
 RETURN 'null'::jsonb;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA berth_state FROM PUBLIC, berth_runtime;
GRANT USAGE ON SCHEMA berth_state TO berth_runtime;
GRANT EXECUTE ON FUNCTION berth_state.claim(uuid,integer), berth_state.access(uuid,bigint,text,text,jsonb) TO berth_runtime;
COMMIT;
