/**
 * The v1 API, preserved bug-for-bug so that a 1.x codebase keeps compiling while
 * it migrates. It emits a deprecation notice once per process.
 *
 * Nothing here is maintained. The v1 formula saturates (as `t` grows the
 * denominator tends to `1 + startValue`, so time stops discriminating entirely),
 * burns 99.8% of its dynamic range in the first 10% of the tuning window, couples
 * its two parameters, and multiplies a zero engagement sum by the freshness boost
 * — so a new item with no engagement scores zero forever and never surfaces.
 *
 * See MIGRATION.md. This entry point is removed in 3.0.0.
 *
 * @deprecated Use `rank()`, `score()` and `explain()` from the package root.
 */
import { VERSION } from './version.js';

/** @deprecated v1 shape. Only `field` is documentation; nothing looks up by name. */
export type argType = {
  field: string;
  valuable: boolean;
  typeOfAdd: string;
  ref: string;
};

/** @deprecated v1 shape. */
export enum TypeOfAdd {
  Sum,
  Multiplication,
}

let warned = false;

function warnOnce(): void {
  if (warned) return;
  warned = true;
  const message = [
    ``,
    `  @youssefmahersi/ranking ${VERSION} — you are calling the v1 API.`,
    ``,
    `  RankingAlgorithm is deprecated and will be removed in 3.0.0. The v1 formula`,
    `  saturates: past a few multiples of \`stretch\`, two items with equal engagement`,
    `  score the same whether they are a day or a year old. An item with no`,
    `  engagement scores zero regardless of age and can never surface.`,
    ``,
    `  v2:  import { rank } from '@youssefmahersi/ranking'`,
    `       const ordered = rank(posts, { preset: 'social-feed' })`,
    ``,
    `  Migration guide: https://github.com/youssefmahersi/RankingAlgorithm/blob/main/MIGRATION.md`,
    ``,
  ].join('\n');
  // eslint-disable-next-line no-console
  console.warn(message);
}

/**
 * @deprecated The v1 class. Preserved verbatim, including the positional-argument
 * rule that a `ref` property must appear immediately after its target.
 */
export class RankingAlgorithm {
  constructor(
    public stretch: number,
    public startValue: number,
    public config: argType[],
  ) {
    warnOnce();
  }

  time(t: number): number {
    return 1 - Math.exp(-(t / this.stretch)) + this.startValue;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  calc(...sumProps: any[]): number {
    let total = 0;
    let i = 0;
    for (const config of this.config) {
      if (config.valuable === true) {
        const refargIndex = this.config.findIndex((arg) => arg.ref === this.config[i]!.field);
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
