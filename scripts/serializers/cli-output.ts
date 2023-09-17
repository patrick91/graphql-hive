export function normalizeCliOutput(value: string) {
  return value
    .split('\n')
    .map(line =>
      line
        .replaceAll('✔', 'v')
        .replaceAll('ℹ', 'i')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B[[(?);]{0,2}(;?\d)*./g, '')
        .replace(
          /http:\/\/localhost:8080\/[$]*\w+\/[$]*\w+\/production/i,
          'http://localhost:8080/$organization/$project/production',
        )
        .replace(/history\/[$]*\w+-\w+-\w+-\w+-\w+/i, 'history/$version')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}
