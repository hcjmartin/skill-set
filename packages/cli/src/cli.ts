import { run } from './run.ts'

// A consumer closing the pipe early (`skill-set … --json | head`) is a normal exit, not a crash.
const exitOnEpipe = (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
}
process.stdout.on('error', exitOnEpipe)
process.stderr.on('error', exitOnEpipe)

process.exitCode = await run(process.argv.slice(2))
