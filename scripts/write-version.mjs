// Runs at the start of every Netlify build: stamps the commit into the API so /api/health
// reports exactly which version is live in each environment.
import fs from 'node:fs'
const commit = (process.env.COMMIT_REF || 'local').slice(0, 40)
fs.writeFileSync(new URL('../server/version.js', import.meta.url), `// Written by scripts/write-version.mjs at build time.\nexport const COMMIT = ${JSON.stringify(commit)}\n`)
console.log(`Build version: ${commit}`)
