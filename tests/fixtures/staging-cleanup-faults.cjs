const fs = require('node:fs');
const name = process.env.FILES3_CLEANUP_FAULT_NAME;
if (process.env.FILES3_CLEANUP_FAULT === 'writer_inaccessible') {
  const original = process.kill;
  process.kill = function(pid, signal) {
    if (signal === 0) throw Object.assign(new Error('writer_inaccessible'), {code: 'EPERM'});
    return original.call(this, pid, signal);
  };
}
if (process.env.FILES3_CLEANUP_FAULT === 'entry_replaced') {
  const original = fs.lstatSync;
  let reads = 0;
  fs.lstatSync = function(path, ...args) {
    if (path === name && ++reads === 2) {
      fs.renameSync(name, name + '.held');
      fs.writeFileSync(name, 'replacement', {mode: 0o600});
    }
    return original.call(this, path, ...args);
  };
}
