'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFood,
  createInitialState,
  changeDirection,
  step,
  start,
} = require('./game.js');

test('startet deterministisch in der Spielfeldmitte', () => {
  const state = createInitialState(() => 0, 10);

  assert.deepEqual(state.snake[0], { x: 5, y: 5 });
  assert.deepEqual(state.food, { x: 0, y: 0 });
  assert.equal(start(state).status, 'running');
});

test('bewegt die Snake und verhindert direktes Umkehren', () => {
  const running = start(createInitialState(() => 0, 10));
  const reversed = changeDirection(running, 'ArrowLeft');
  const moved = step(reversed, () => 0);

  assert.deepEqual(moved.snake[0], { x: 6, y: 5 });
  assert.equal(moved.snake.length, 3);
});

test('frisst Futter, erhöht den Score und wächst', () => {
  const state = {
    ...start(createInitialState(() => 0, 10)),
    food: { x: 6, y: 5 },
  };
  const next = step(state, () => 0);

  assert.equal(next.score, 1);
  assert.equal(next.snake.length, 4);
  assert.notDeepEqual(next.food, next.snake[0]);
});

test('erkennt Wand- und Selbstkollisionen', () => {
  const wallState = {
    ...start(createInitialState(() => 0, 4)),
    snake: [{ x: 3, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }],
  };
  assert.equal(step(wallState, () => 0).status, 'gameover');

  const selfState = {
    ...wallState,
    snake: [
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
    ],
    direction: { x: 1, y: 0 },
    pendingDirection: { x: 0, y: 1 },
  };
  assert.equal(step(selfState, () => 0).status, 'gameover');
});

test('platziert Futter ausschließlich auf freien Zellen', () => {
  const snake = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];

  assert.deepEqual(createFood(snake, 2, () => 0.999), { x: 1, y: 1 });
  assert.equal(createFood([...snake, { x: 1, y: 1 }], 2, () => 0), null);
});
