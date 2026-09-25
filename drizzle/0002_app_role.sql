-- The app's own database user for IAM authentication (decision D10): read and write
-- DraftPage's data, nothing else (no DDL, no roles). It has no password; the app signs in
-- with a 15-minute IAM token. The admin user is only used by this migration runner.
--
-- Only on RDS, where the rds_iam role exists. Local and test databases skip it and keep
-- connecting with their URL user.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'draftpage_app') THEN
      CREATE ROLE draftpage_app WITH LOGIN;
    END IF;
    GRANT rds_iam TO draftpage_app;
    GRANT USAGE ON SCHEMA public TO draftpage_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO draftpage_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO draftpage_app;
    -- Tables and sequences created by later migrations (run as the same admin) get the same grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO draftpage_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO draftpage_app;
  END IF;
END
$$;
