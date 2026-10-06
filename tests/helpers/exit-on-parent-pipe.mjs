// Test targets terminate when the test driver's pipe closes, including abrupt exit.
process.stdin.resume();
process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
