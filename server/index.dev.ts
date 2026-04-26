/**
 * Development entry point — runs on port 3001 alongside production (port 3000).
 * Usage: npm run dev:internal
 */
process.env.PORT = '3001'
await import('./index.js')
