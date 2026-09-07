(function snakeModule(globalScope) {
  'use strict';

  const GRID_SIZE = 20;
  const TICK_MS = 115;
  const DIRECTIONS = Object.freeze({
    ArrowUp: Object.freeze({ x: 0, y: -1 }),
    ArrowDown: Object.freeze({ x: 0, y: 1 }),
    ArrowLeft: Object.freeze({ x: -1, y: 0 }),
    ArrowRight: Object.freeze({ x: 1, y: 0 }),
  });

  function samePosition(left, right) {
    return left.x === right.x && left.y === right.y;
  }

  function createFood(snake, gridSize = GRID_SIZE, random = Math.random) {
    const occupied = new Set(snake.map(part => `${part.x},${part.y}`));
    const freeCells = [];

    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        if (!occupied.has(`${x},${y}`)) freeCells.push({ x, y });
      }
    }

    if (freeCells.length === 0) return null;
    const randomIndex = Math.min(freeCells.length - 1, Math.floor(random() * freeCells.length));
    return freeCells[randomIndex];
  }

  function createInitialState(random = Math.random, gridSize = GRID_SIZE) {
    const center = Math.floor(gridSize / 2);
    const snake = [
      { x: center, y: center },
      { x: center - 1, y: center },
      { x: center - 2, y: center },
    ];
    const direction = { ...DIRECTIONS.ArrowRight };

    return {
      snake,
      food: createFood(snake, gridSize, random),
      direction,
      pendingDirection: direction,
      score: 0,
      status: 'idle',
      gridSize,
    };
  }

  function changeDirection(state, key) {
    const nextDirection = DIRECTIONS[key];
    if (!nextDirection || state.status === 'gameover' || state.status === 'won') return state;

    const isReverse = nextDirection.x + state.direction.x === 0
      && nextDirection.y + state.direction.y === 0;
    if (isReverse) return state;

    return { ...state, pendingDirection: { ...nextDirection } };
  }

  function step(state, random = Math.random) {
    if (state.status !== 'running') return state;

    const direction = state.pendingDirection;
    const head = state.snake[0];
    const nextHead = { x: head.x + direction.x, y: head.y + direction.y };
    const hitWall = nextHead.x < 0
      || nextHead.y < 0
      || nextHead.x >= state.gridSize
      || nextHead.y >= state.gridSize;
    const ateFood = state.food && samePosition(nextHead, state.food);
    const collisionBody = ateFood ? state.snake : state.snake.slice(0, -1);
    const hitSelf = collisionBody.some(part => samePosition(part, nextHead));

    if (hitWall || hitSelf) {
      return { ...state, direction, pendingDirection: direction, status: 'gameover' };
    }

    const snake = [nextHead, ...state.snake];
    if (!ateFood) snake.pop();

    const food = ateFood ? createFood(snake, state.gridSize, random) : state.food;
    return {
      ...state,
      snake,
      food,
      direction,
      pendingDirection: direction,
      score: ateFood ? state.score + 1 : state.score,
      status: food === null ? 'won' : state.status,
    };
  }

  function start(state) {
    if (state.status !== 'idle') return state;
    return { ...state, status: 'running' };
  }

  const api = { GRID_SIZE, DIRECTIONS, createFood, createInitialState, changeDirection, step, start };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!globalScope || !globalScope.document) return;

  const document = globalScope.document;
  const canvas = document.getElementById('game-board');
  const context = canvas.getContext('2d');
  const scoreElement = document.getElementById('score');
  const overlay = document.getElementById('game-overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayMessage = document.getElementById('overlay-message');
  const startButton = document.getElementById('start-button');
  let state = createInitialState();
  let timer = null;

  function drawGrid() {
    const cellSize = canvas.width / state.gridSize;
    context.strokeStyle = 'rgba(110, 231, 183, 0.065)';
    context.lineWidth = 1;
    for (let index = 1; index < state.gridSize; index += 1) {
      const point = index * cellSize;
      context.beginPath();
      context.moveTo(point, 0);
      context.lineTo(point, canvas.height);
      context.stroke();
      context.beginPath();
      context.moveTo(0, point);
      context.lineTo(canvas.width, point);
      context.stroke();
    }
  }

  function drawCell(position, color, inset = 2) {
    const cellSize = canvas.width / state.gridSize;
    context.fillStyle = color;
    context.fillRect(
      position.x * cellSize + inset,
      position.y * cellSize + inset,
      cellSize - inset * 2,
      cellSize - inset * 2,
    );
  }

  function render() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#07150f';
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    if (state.food) drawCell(state.food, '#fb7185', 4);
    state.snake.forEach((part, index) => drawCell(part, index === 0 ? '#a7f3d0' : '#4ade80'));
    scoreElement.textContent = String(state.score);

    const finished = state.status === 'gameover' || state.status === 'won';
    overlay.hidden = state.status === 'running';
    if (finished) {
      overlayTitle.textContent = state.status === 'won' ? 'Gewonnen!' : 'Game Over';
      overlayMessage.textContent = `Du hast ${state.score} ${state.score === 1 ? 'Punkt' : 'Punkte'} erreicht.`;
      startButton.textContent = 'Neu starten';
    } else if (state.status === 'idle') {
      overlayTitle.textContent = 'Bereit?';
      overlayMessage.textContent = 'Starte das Spiel und steuere mit den Pfeiltasten.';
      startButton.textContent = 'Spiel starten';
    }
  }

  function stopTimer() {
    if (timer !== null) globalScope.clearInterval(timer);
    timer = null;
  }

  function tick() {
    state = step(state);
    render();
    if (state.status === 'gameover' || state.status === 'won') stopTimer();
  }

  function begin() {
    stopTimer();
    if (state.status === 'gameover' || state.status === 'won') state = createInitialState();
    state = start(state);
    render();
    timer = globalScope.setInterval(tick, TICK_MS);
  }

  startButton.addEventListener('click', begin);
  document.addEventListener('keydown', event => {
    if (!DIRECTIONS[event.key]) return;
    event.preventDefault();
    state = changeDirection(state, event.key);
    if (state.status === 'idle') begin();
  });

  render();
}(typeof window !== 'undefined' ? window : null));
