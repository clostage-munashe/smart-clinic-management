import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tasks = [
  ['clinic-api', ['--watch', 'backend/server.js']],
  ['clinic-web', ['node_modules/vite/bin/vite.js', 'frontend', '--config', 'frontend/vite.config.ts']],
]
const children = tasks.map(([name, args]) => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env })
  child.on('error', error => { console.error(`[${name}] ${error.message}`); stop(1) })
  child.on('exit', code => {
    if (!stopping && code !== 0) {
      console.error(`[${name}] exited with code ${code}`)
      stop(code || 1)
    }
  })
  return child
})

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) if (child.exitCode === null) child.kill()
  process.exitCode = code
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
