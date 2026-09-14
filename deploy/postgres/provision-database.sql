-- Operator database-creation template. Run once as superuser; the database name and
-- owner come from psql variables so no deployment value is baked into the repo:
--   psql -v dbname="control_room" -v owner="control_room_schema_owner" \
--     -f deploy/postgres/provision-database.sql "dbname=postgres user=postgres"
-- Creates the database only; roles and grants come from db/roles/*.sql afterwards.
\set ON_ERROR_STOP on
SELECT 'provision_target:' || :'dbname' AS provision_target;
CREATE DATABASE :"dbname" OWNER :"owner" ENCODING 'UTF8' LOCALE_PROVIDER 'libc' LOCALE 'C.UTF-8' TEMPLATE template0;
