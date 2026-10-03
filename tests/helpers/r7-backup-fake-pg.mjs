// Fixed catalog stand-in only. Never opens a socket or executes SQL.
const d = 'sha256:'+'a'.repeat(64);
export const state = { connections: 0, ended: 0 };
export class Client {
  constructor(configuration) { this.configuration = configuration; }
  async connect() { state.connections++; if (process.env.R7_BACKUP_FAKE_FAILURE === "connect") throw Error("failed: "+this.configuration.connectionString); }
  async end() { state.ended++; }
  async query(sql) {
    if (process.env.R7_BACKUP_FAKE_FAILURE === "query" && sql.startsWith("SELECT")) throw Error("failed: "+this.configuration.connectionString);
    if (sql.includes('count(*)::int AS count')) return { rows: [{ count: 0 }] };
    if (sql.includes('AS snapshot')) return { rows: [{ snapshot: [] }] };
    if (sql.includes('control_room_schema_migrations')) return { rows: [{ filename: 'fixture.sql', digest: d, ledger_order: 1 }] };
    if (sql.includes('pg_export_snapshot')) return { rows: [{ snap: 'fixture-snapshot' }] };
    if (sql.includes('pg_get_userbyid(datdba)')) return { rows: [{ owner: 'control_room_schema_owner' }] };
    if (sql.includes('rolcanlogin')) return { rows: [{ rolname: 'control_room_migrator', rolcanlogin: true,
      rolcreatedb: false, rolcreaterole: false, rolsuper: false, rolreplication: false, rolbypassrls: false }] };
    if (sql.includes('pg_get_userbyid(c.relowner)')) return { rows: [{ object: 'public.tenants', owner: 'control_room_schema_owner', acl: '{}' }] };
    return { rows: [] };
  }
}
export default { Client };
