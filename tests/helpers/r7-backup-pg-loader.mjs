export async function resolve(specifier, context, next) {
  if (specifier === 'pg') return { url: new URL('./r7-backup-fake-pg.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
