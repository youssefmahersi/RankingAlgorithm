/** @deprecated The v1 API. Removed in 3.0.0. See MIGRATION.md. */
export type argType = {
  field: string;
  valuable: boolean;
  typeOfAdd: string;
  ref: string;
};

/** @deprecated The v1 class, preserved bug-for-bug. */
export class RankingAlgorithm {
  constructor(stretch: number, startValue: number, config: argType[]);
  stretch: number;
  startValue: number;
  config: argType[];
  time(t: number): number;
  calc(...sumProps: number[]): number;
}
