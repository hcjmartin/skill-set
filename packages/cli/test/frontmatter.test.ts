import { describe, expect, it } from 'vitest'
import { readSkillDescription } from '../src/frontmatter.ts'

const md = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nBody.\n`

describe('readSkillDescription', () => {
  it.each([
    ['plain scalar', md('name: x\ndescription: Does things. Use when needed.'), 'Does things. Use when needed.'],
    ['double-quoted', md('description: "Quoted \\"stuff\\", commas, colons: yes."'), 'Quoted "stuff", commas, colons: yes.'],
    ['single-quoted', md("description: 'It''s quoted.'"), "It's quoted."],
    ['literal block', md('description: |\n  line one\n  line two'), 'line one\nline two'],
    ['literal block, chomped', md('description: |-\n  line one\n  line two'), 'line one\nline two'],
    ['folded block', md('description: >-\n  folds\n  into one line'), 'folds into one line'],
    ['later key wins nothing — first description is used', md('description: first\nother: x'), 'first'],
  ])('%s', (_label, input, expected) => {
    expect(readSkillDescription(input)).toBe(expected)
  })

  it.each([
    ['no frontmatter', '# Just a heading\n'],
    ['no description key', md('name: x\nlicense: MIT')],
    ['empty description', md('name: x\ndescription:')],
  ])('%s yields undefined', (_label, input) => {
    expect(readSkillDescription(input)).toBeUndefined()
  })
})
