import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { compatFolderHash } from '../src/hash.ts'
import { parseSkillsLock } from '../src/lock.ts'
import { resolveMember } from '../src/resolver.ts'

// The D12 guard: spawns the real pinned `npx skills`, so gated out of the hermetic suite.
// Uses a local source because byte-parity with the upstream lock is only defined for
// disk-based installs — GitHub blob installs record a server-side snapshot hash instead.
const RUN = process.env.RUN_COMPAT === '1'

const SKILL_MD = `---
name: probe-skill
description: Fixture skill for the skill-set compatibility test.
---

# Probe skill

Instructions body for the compatibility fixture.
`

const dirs: string[] = []
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe.runIf(RUN)('upstream compatibility (RUN_COMPAT=1)', () => {
  it(
    'a real upstream install records the folder hash our compat hasher reproduces',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'skill-set-compat-'))
      dirs.push(root)

      // Source skill folder: metadata.json exercises the quirk that the folder hash
      // includes it even though the installer strips it from the installed copy.
      const source = join(root, 'src', 'probe-skill')
      mkdirSync(join(source, 'scripts'), { recursive: true })
      writeFileSync(join(source, 'SKILL.md'), SKILL_MD)
      writeFileSync(join(source, 'metadata.json'), '{ "category": "testing" }\n')
      writeFileSync(join(source, 'scripts', 'helper.sh'), '#!/bin/sh\necho probe\n')

      const cwd = join(root, 'proj')
      mkdirSync(cwd)
      // A package.json makes the tmp dir a project, so the install stays project-scoped.
      writeFileSync(join(cwd, 'package.json'), '{ "name": "compat-fixture", "private": true }\n')

      const result = await resolveMember(source, { cwd })
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
      if (!result.ok) return
      expect(result.data.skill).toBe('probe-skill')
      expect(result.data.computedHash).toMatch(/^[a-f0-9]{64}$/)

      const lock = parseSkillsLock(readFileSync(join(cwd, 'skills-lock.json'), 'utf8'))
      expect(lock.ok, lock.ok ? '' : lock.error.message).toBe(true)
      if (!lock.ok) return
      const entry = lock.data.skills['probe-skill']
      expect(entry).toBeDefined()
      // The guard itself: upstream hashed the source folder; we must reproduce it byte-for-byte.
      expect(compatFolderHash(source)).toBe(entry!.computedHash)

      // Reinstalling the same unnamed locator adds no lock key, so discovery must fall
      // through to the source lookup (tier 2) and still name the skill.
      const again = await resolveMember(source, { cwd })
      expect(again.ok, again.ok ? '' : again.error.message).toBe(true)
      if (!again.ok) return
      expect(again.data.skill).toBe('probe-skill')
    },
    300_000,
  )
})

describe.runIf(!RUN)('upstream compatibility (skipped)', () => {
  it.skip('set RUN_COMPAT=1 to run the live upstream fixture', () => {})
})
