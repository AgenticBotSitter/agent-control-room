import { createInterface } from 'node:readline';
import { runMacUpgradeV1 } from '../../scripts/mac-local/upgrade.mjs';
const lines = createInterface({ input:process.stdin });
const next = () => new Promise(resolve => lines.once('line',resolve));
const after = 'b'.repeat(40);
let current = after;
const go = next(); process.stdout.write('ready\n'); await go;
try {
  const options = { protectedRoot:process.argv[2], write:()=>{}, wait:async()=>{},
    git:async args => {
      const op = args.join(' ');
      if (op === 'branch --show-current') return 'main';
      if (op === 'status --porcelain' || args[0] === 'fetch') return '';
      if (op === 'rev-parse HEAD') return current;
      if (op === 'rev-parse origin/main') return after;
      if (args[0] === 'merge') { current = after; return ''; }
      throw new Error('unexpected_fixture_git');
    },
    readLedgerHead:async()=>({order:238,file:'db/migrations/0238_fixture.sql',digest:`sha256:${'a'.repeat(64)}`}),
    run:async args => {
      if (args[0] === (process.argv[3] === 'real-rollback' ? 'build' : 'mac:down')) { const resume = next(); process.stdout.write('entered\n'); await resume; }
      return 0;
    },
    prepare:async input=>({mainCommit:input.mainCommit}),finish:async input=>({mainCommit:input.mainCommit}) };
  if (process.argv[3] === "default-effects") delete options.run;
  if (process.argv[3] === "real-rollback") {
    delete options.git;options.repositoryRoot=process.argv[4];options.rollback=true;
  }
  await runMacUpgradeV1(options);
  process.stdout.write('complete\n');
} catch (error) { process.stdout.write(`refused ${error.message}\n`); }
finally { lines.close(); }
