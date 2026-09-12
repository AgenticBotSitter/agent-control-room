// Test-only dependency injection. Never reads environment or opens a connection.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseClient, DatabaseSession } from '../../src/persistence/database';

export type NativeFixtureDatabase = {
  raw: DatabaseSession & { exec(sql: string): Promise<unknown>; close(): Promise<void> };
  db: DatabaseClient;
};
const context = new AsyncLocalStorage<() => Promise<NativeFixtureDatabase | undefined>>();

export function withNativeFixtureDatabase<T>(factory: () => Promise<NativeFixtureDatabase | undefined>, work: () => Promise<T>): Promise<T> {
  return context.run(factory, work);
}

export function suppliedNativeFixtureDatabase(): Promise<NativeFixtureDatabase | undefined> | undefined {
  return context.getStore()?.();
}
