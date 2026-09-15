-- Operator database-creation template. Run once as superuser; the database name
-- comes from a psql variable so no deployment value is baked into the repo:
--   psql -v dbname="control_room" \
--     -f deploy/postgres/provision-database.sql "dbname=postgres user=postgres"
-- Creates the database with the invoking superuser as owner. The schema-owner
-- role does not exist yet at this point, so ownership is NOT set here: after
-- db/roles/production_provision.sql creates the roles, the migrate bootstrap
-- transfers database ownership to control_room_schema_owner. Roles, grants and
-- schema come from db/roles/*.sql and the migration applier afterwards.
\set ON_ERROR_STOP on
SELECT 'provision_target:' || :'dbname' AS provision_target;
CREATE DATABASE :"dbname" ENCODING 'UTF8' LOCALE_PROVIDER 'libc' LOCALE 'C.UTF-8' TEMPLATE template0;
