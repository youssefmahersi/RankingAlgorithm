/**
 * The v1 API, preserved bug-for-bug so a 1.x codebase keeps running while it
 * migrates. It emits a deprecation notice once per process.
 *
 * Nothing here is maintained. The v1 formula saturates (as `t` grows the
 * denominator tends to `1 + startValue`, so time stops discriminating entirely),
 * burns 99.8% of its dynamic range in the first 10% of the tuning window,
 * couples its two parameters, and multiplies a zero engagement sum by the
 * freshness boost — so a new item with no engagement scores zero forever and
 * never surfaces.
 *
 * See MIGRATION.md. This entry point is removed in 3.0.0.
 *
 * @module
 * @deprecated Use `rank()`, `score()` and `explain()` from the package root.
 */
import { VERSION } from './index.js';

let warned = false;

function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    [
      ``,
      `  @youssefmahersi/ranking-js ${VERSION} — you are calling the v1 API.`,
      ``,
      `  RankingAlgorithm is deprecated and will be removed in 3.0.0. The v1 formula`,
      `  saturates: past a few multiples of \`stretch\`, two items with equal engagement`,
      `  score the same whether they are a day or a year old. An item with no`,
      `  engagement scores zero regardless of age and can never surface.`,
      ``,
      `  v2:  import { rank } from '@youssefmahersi/ranking-js'`,
      `       const ordered = rank(posts, { preset: 'social-feed' })`,
      ``,
      `  Migration guide: https://github.com/youssefmahersi/RankingAlgorithm/blob/main/MIGRATION.md`,
      ``,
    ].join('\n'),
  );
}

/**
 * @deprecated The v1 class. Preserved verbatim, including the positional-argument
 * rule that a `ref` property must appear immediately after its target.
 */
export class RankingAlgorithm {
  constructor(stretch, startValue, config) {
    this.stretch = stretch;
    this.startValue = startValue;
    this.config = config;
    warnOnce();
  }

  time(t) {
    return 1 - Math.exp(-(t / this.stretch)) + this.startValue;
  }

  calc(...sumProps) {
    let total = 0;
    let i = 0;
    for (const config of this.config) {
      if (config.valuable === true) {
        const refargIndex = this.config.findIndex((arg) => arg.ref === this.config[i].field);
        if (refargIndex !== -1) {
          switch (config.typeOfAdd) {
            case 'Sum':
              total = total + (sumProps[i] + sumProps[refargIndex]);
              break;
            case 'Multiplication':
              total = total + sumProps[i] * sumProps[refargIndex];
              break;
          }
        } else {
          total = total + sumProps[i];
        }
      } else {
        total = total + sumProps[i];
      }
      i++;
    }
    return total / this.time(sumProps[sumProps.length - 1]);
  }
}
