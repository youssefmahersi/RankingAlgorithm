/** Every error thrown by this library is a `RankingError`. */
export class RankingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RankingError';
  }
}
