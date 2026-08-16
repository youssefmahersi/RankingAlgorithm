// Hand-written types for the zero-build JavaScript SDK.
//
// They live outside src/ on purpose: a sibling index.d.ts would shadow index.js
// and tsc would stop checking the implementation. `npm run typecheck` runs two
// passes — checkJs over src/ (the JSDoc annotations) and test/types.ts against
// this file — so neither side can drift unnoticed.

export type Item = Record<string, unknown>;
export type DateInput = Date | string | number;
export type SignalWeights = Readonly<Record<string, number>>;
export type PresetName = 'social-feed' | 'ecommerce';
export type FuturePolicy = 'error' | 'clamp';
export type Dialect = 'postgres' | 'mysql';
export type Strategy = 'A' | 'B';

export interface BayesianConfig {
  ratingField: string;
  countField: string;
  prior: number;
  priorCount: number;
  weight: number;
}

export interface RankingConfig {
  gravity: number;
  graceHours: number;
  signals: SignalWeights;
  engagement?: (item: Item) => number;
  dateField: string;
  getDate?: (item: Item) => DateInput;
  idField: string;
  qualityField?: string;
  now?: DateInput;
  onFutureItem: FuturePolicy;
  bayesian?: BayesianConfig;
}

export interface RankingOptions extends Partial<RankingConfig> {
  preset?: PresetName;
}

export interface SQLOptions extends RankingOptions {
  table?: string;
  columns?: Readonly<Record<string, string>>;
  dateColumn?: string;
  epochColumn?: string;
  scoreColumn?: string;
  windowDays?: number;
  limit?: number;
  tauSeconds?: number;
  epochOffset?: number;
  dialect?: Dialect;
}

export interface SignalBreakdown {
  field: string;
  value: number;
  weight: number;
  contribution: number;
  share: number;
}

export interface Explanation {
  id: string | null;
  engagement: number;
  signals: SignalBreakdown[];
  bayesian?: { average: number; count: number; smoothed: number; weight: number; contribution: number };
  quality: number;
  ageHours: number;
  timePenalty: number;
  score: number;
  config: { gravity: number; graceHours: number };
  formula: string;
}

export interface Scored<T> {
  item: T;
  score: number;
}

export const VERSION: string;
export const SPEC_VERSION: number;
export const FORMULA: string;
export const DEFAULT_PRESET: PresetName;
export const EPOCH_OFFSET_2020: number;
export const PRESETS: Readonly<Record<PresetName, RankingConfig>>;

export class RankingError extends Error {}

export function resolveConfig(options?: RankingOptions): RankingConfig;
export function toEpochMs(value: DateInput, label: string): number;

export function engagement(item: Item, options?: RankingOptions): number;
export function quality(item: Item, options?: RankingOptions): number;
export function timePenalty(ageHours: number, options?: RankingOptions): number;
export function ageHours(item: Item, options?: RankingOptions): number;
export function score(item: Item, options?: RankingOptions): number;
export function explain(item: Item, options?: RankingOptions): Explanation;

export function rank<T extends Item>(items: readonly T[], options?: RankingOptions): T[];
export function rankWithScores<T extends Item>(items: readonly T[], options?: RankingOptions): Scored<T>[];
export function top<T extends Item>(items: readonly T[], n: number, options?: RankingOptions): T[];

export function solveGravity(params: { ratio: number; afterHours: number; graceHours: number }): number;
export function engagementRatio(afterHours: number, options?: RankingOptions): number;
export function decadeHours(options?: RankingOptions): number;
export function tauSeconds(options?: RankingOptions): number;

export function sqlExpression(options?: SQLOptions, strategy?: Strategy): string;
export function toSQL(options?: SQLOptions, strategy?: Strategy): string;
