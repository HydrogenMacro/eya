// SemVer precedence, including arbitrary-length numeric identifiers; build metadata is ignored.
export function compareVersions(a, b) {
  const parse = value => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
    if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) throw Error('Invalid release version.');
    return { core: match.slice(1, 4), pre: match[4]?.split('.') };
  };
  const numeric = (x, y) => x.length !== y.length ? Math.sign(x.length - y.length) : x === y ? 0 : x > y ? 1 : -1;
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) { const n = numeric(x.core[i], y.core[i]); if (n) return n; }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i], r = y.pre[i]; if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    return ln && rn ? numeric(l, r) : ln !== rn ? ln ? -1 : 1 : l > r ? 1 : -1;
  }
  return 0;
}
