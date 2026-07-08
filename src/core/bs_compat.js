/**
 * parseBS · B/S 字符串解析
 *
 * 格式: "B{birth_set}/S{survive_set}"
 *   - 例: "B3/S23" → { birth: [3], survive: [2, 3] }
 *   - 例: "B3/S12345" → { birth: [3], survive: [1, 2, 3, 4, 5] }
 *   - 例: "B36/S23" → { birth: [3, 6], survive: [2, 3] }  (不连续阈值)
 *   - 例: "B2/S" → { birth: [2], survive: [] }            (只有 birth, 没有 survive)
 *
 * 注意:
 *   - 用 set (Array<int>) 表达, 不退化成 [min, max] 范围
 *   - B36 = [3, 6] 不是 [3, 6] (后者会包含 4, 5, 错!)
 */

/**
 * 解析 B/S 字符串
 * @param {string} bs - 例 "B3/S12345"
 * @returns {{birth: number[], survive: number[]}}
 */
export function parseBS(bs) {
  if (typeof bs !== 'string') {
    throw new Error(`parseBS: expected string, got ${typeof bs}`);
  }
  bs = bs.trim().toUpperCase();

  // 分割 B 和 S
  const match = bs.match(/^B([0-9]*)\/S([0-9]*)$/);
  if (!match) {
    throw new Error(`parseBS: invalid format "${bs}" (expected "B{}/S{}")`);
  }

  const [, birthStr, surviveStr] = match;

  const birth = birthStr === ''
    ? []
    : birthStr.split('').map(c => parseInt(c, 10)).sort((a, b) => a - b);

  const survive = surviveStr === ''
    ? []
    : surviveStr.split('').map(c => parseInt(c, 10)).sort((a, b) => a - b);

  return { birth, survive };
}