const fs = require('node:fs');
const original = fs.lstatSync;
fs.lstatSync = function(path, ...args) {
  const value = original.call(this, path, ...args);
  if (path === '.' && process.env.FILES3_SWAP_ROOT && process.cwd() === process.env.FILES3_SWAP_ROOT) {
    const root = process.env.FILES3_SWAP_ROOT;
    delete process.env.FILES3_SWAP_ROOT;
    fs.renameSync(root, process.env.FILES3_SWAP_OLD);
    fs.symlinkSync(process.env.FILES3_SWAP_OUTSIDE, root);
  }
  return value;
};
