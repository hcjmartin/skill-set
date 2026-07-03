import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

const HELP = `skill-set — define, share, and install named, versioned sets of agent skills.

Pre-release scaffold: commands are not yet implemented.

Docs: https://skill-set.md
Repo: https://github.com/hcjmartin/skill-set
`

// Meta-flags are intercepted before any dispatch — `<verb> --help` must never execute (see CHANGELOG).
export function run(argv: readonly string[]): number {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return 0
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION)
    return 0
  }
  console.error('skill-set: commands are not yet implemented (pre-release scaffold)')
  return 1
}
