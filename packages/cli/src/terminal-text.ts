/** Removes C0/C1 controls and ANSI CSI sequences from captured terminal output. */
export function stripTerminalSequences(value: string): string {
  let plain = ''
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index)!
    if (codePoint === 0x1b) {
      if (value.codePointAt(index + 1) === 0x5b) {
        index += 2
        while (index < value.length) {
          const final = value.codePointAt(index)!
          if (final >= 0x40 && final <= 0x7e) break
          index++
        }
      }
      continue
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (codePoint === 0x0a) plain += '\n'
      continue
    }
    plain += value[index]!
  }
  return plain
}
