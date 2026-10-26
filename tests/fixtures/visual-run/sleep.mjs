// Fixture flow: sleeps for the given seconds (default 10).
const s = Number(process.argv[2] ?? 10);
setTimeout(() => {}, s * 1000);
