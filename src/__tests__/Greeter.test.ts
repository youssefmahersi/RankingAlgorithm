import { RankingAlgorithm } from '../index';
const rankingAlgorithm = new RankingAlgorithm(8, 0.0002, [
  {
    field: 'like',
    valuable: true,
    typeOfAdd: 'Multiplication',
    ref: '',
  },
  {
    field: 'popularity',
    valuable: false,
    typeOfAdd: '',
    ref: 'like',
  },
]);

test('first second', () => {
  expect(rankingAlgorithm.calc(12, 13, 0)).toBe(845000);
});
