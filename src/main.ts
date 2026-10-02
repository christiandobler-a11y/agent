import { loadDotEnv, loadEnv } from "./config/env.js";

// Startpunkt für Bot, Worker und Scheduler. Die Module kommen in den Schritten 2–8 dazu.
loadDotEnv();
const env = loadEnv();
console.log(JSON.stringify({ level: "info", msg: "avelio gestartet", env: env.NODE_ENV }));
