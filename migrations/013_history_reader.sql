-- Grant the dedicated History login only the existing bounded projections.
BEGIN;
DO $$ BEGIN
  IF current_user <> 'neondb_owner' OR current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Expected dedicated owner';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_roles r
    WHERE r.rolname = 'berth_history_runtime' AND r.rolcanlogin
      AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb
        OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid)
  ) THEN
    RAISE EXCEPTION 'Expected dedicated History login without role memberships';
  END IF;
END $$;

GRANT USAGE ON SCHEMA berth_executor TO berth_history_runtime;
GRANT EXECUTE ON FUNCTION berth_executor.history_page(uuid,integer),
  berth_executor.history_detail(uuid) TO berth_history_runtime;
COMMIT;
