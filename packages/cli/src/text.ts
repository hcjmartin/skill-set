/** Pluralises a count with its word: `1 skill`, `2 skills`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
