/**
 * Debug console wrapper
 */
const DEBUG = false; // Set to true for development logging
const debugLog = DEBUG ? console.log.bind(console) : () => {};

/**
 * Conway's Game of Life - Background Animation
 * Runs as a subtle background effect behind the entire page
 */
class ConwayBackground {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.grid = [];
    this.nextGrid = [];
    this.cols = 0;
    this.rows = 0;
    this.cellSize = 4; // Default, will be updated from CSS
    this.isRunning = false;
    this.intervalId = null;

    // Configuration will be loaded from CSS variables
    this.config = {
      updateInterval: 10000, // 10 second interval
      initialDensity: 0.15,
      fadeOpacity: 0.08,
      glowIntensity: 0.3,
      color: {
        r: 0,
        g: 255,
        b: 0,
      },
    };

    this.loadConfigFromCSS();
    this.init();
  }

  loadConfigFromCSS() {
    // Load configuration from CSS custom properties
    const computedStyle = getComputedStyle(document.documentElement);

    // Load Conway-specific CSS variables
    this.cellSize =
      parseInt(computedStyle.getPropertyValue("--conway-cell-size")) || 4;
    this.config.updateInterval =
      parseInt(computedStyle.getPropertyValue("--conway-update-speed")) ||
      10000;
    this.config.fadeOpacity =
      parseFloat(computedStyle.getPropertyValue("--conway-opacity")) || 0.08;
    this.config.glowIntensity =
      parseFloat(computedStyle.getPropertyValue("--conway-glow-intensity")) ||
      0.3;
    this.config.color.r =
      parseInt(computedStyle.getPropertyValue("--conway-color-r")) || 0;
    this.config.color.g =
      parseInt(computedStyle.getPropertyValue("--conway-color-g")) || 255;
    this.config.color.b =
      parseInt(computedStyle.getPropertyValue("--conway-color-b")) || 0;
  }

  init() {
    debugLog("Conway Background: Initializing...");

    // Check if animation should be disabled
    if (this.shouldDisableAnimation()) {
      debugLog("Conway Background: Animation disabled due to conditions");
      return;
    }

    debugLog("Conway Background: Creating canvas and starting animation");
    this.createCanvas();
    this.setupGrid();
    this.seedRandom();
    this.preRunSimulation();
    this.start();

    // Handle window resize
    window.addEventListener("resize", () => {
      this.handleResize();
    });

    // Pause when tab is not visible for performance
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.pause();
      } else {
        this.start();
      }
    });
  }

  shouldDisableAnimation() {
    debugLog("Conway Background: Checking if animation should be disabled...");
    debugLog("Screen size:", window.innerWidth, "x", window.innerHeight);
    debugLog("Hardware concurrency:", navigator.hardwareConcurrency);

    // Disable on small screens
    if (window.innerWidth < 480 || window.innerHeight < 480) {
      debugLog("Conway Background: Disabled - small screen");
      return true;
    }

    // Respect user's motion preferences
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      debugLog("Conway Background: Disabled - reduced motion preference");
      return true;
    }

    // Disable on potentially slow devices
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 2) {
      debugLog("Conway Background: Disabled - low hardware concurrency");
      return true;
    }

    debugLog("Conway Background: Animation enabled");
    return false;
  }

  createCanvas() {
    debugLog("Conway Background: Creating canvas...");

    // Create canvas element
    this.canvas = document.createElement("canvas");
    this.canvas.id = "conway-background";
    this.canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: -1;
      opacity: ${this.config.fadeOpacity};
    `;

    // Insert canvas as the first child of body
    document.body.insertBefore(this.canvas, document.body.firstChild);
    debugLog("Conway Background: Canvas inserted into DOM");

    this.ctx = this.canvas.getContext("2d");
    this.setupCanvasSize();
    debugLog(
      "Conway Background: Canvas setup complete, size:",
      this.cols,
      "x",
      this.rows
    );
  }

  setupCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Set actual canvas size
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    // Scale context for high DPI
    this.ctx.scale(dpr, dpr);

    // Calculate grid dimensions
    this.cols = Math.floor(rect.width / this.cellSize);
    this.rows = Math.floor(rect.height / this.cellSize);
  }

  setupGrid() {
    this.grid = [];
    this.nextGrid = [];

    for (let i = 0; i < this.rows; i++) {
      this.grid[i] = [];
      this.nextGrid[i] = [];
      for (let j = 0; j < this.cols; j++) {
        this.grid[i][j] = 0;
        this.nextGrid[i][j] = 0;
      }
    }
  }

  seedRandom() {
    // Create random initial pattern
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        this.grid[i][j] = Math.random() < this.config.initialDensity ? 1 : 0;
      }
    }

    // Add some classic patterns for interest
    this.addGliders();
    this.addOscillators();
  }

  addGliders() {
    // Add a few gliders in random positions
    const numGliders = Math.floor((this.cols * this.rows) / 10000);

    for (let i = 0; i < numGliders; i++) {
      const x = Math.floor(Math.random() * (this.cols - 5));
      const y = Math.floor(Math.random() * (this.rows - 5));

      // Standard glider pattern
      const glider = [
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 1],
      ];

      this.addPattern(x, y, glider);
    }
  }

  addOscillators() {
    // Add some oscillators for variety
    const numOscillators = Math.floor((this.cols * this.rows) / 8000);

    for (let i = 0; i < numOscillators; i++) {
      const x = Math.floor(Math.random() * (this.cols - 3));
      const y = Math.floor(Math.random() * (this.rows - 3));

      // Blinker pattern
      if (Math.random() > 0.5) {
        const blinker = [[1, 1, 1]];
        this.addPattern(x, y, blinker);
      } else {
        // Beacon pattern
        const beacon = [
          [1, 1, 0, 0],
          [1, 0, 0, 0],
          [0, 0, 0, 1],
          [0, 0, 1, 1],
        ];
        this.addPattern(x, y, beacon);
      }
    }
  }

  addPattern(startX, startY, pattern) {
    for (let i = 0; i < pattern.length; i++) {
      for (let j = 0; j < pattern[i].length; j++) {
        const x = startX + j;
        const y = startY + i;
        if (x >= 0 && x < this.cols && y >= 0 && y < this.rows) {
          this.grid[y][x] = pattern[i][j];
        }
      }
    }
  }

  preRunSimulation() {
    // Run several iterations before showing to get the animation "warmed up"
    debugLog("Conway Background: Pre-running simulation to warm up...");
    const preRunIterations = Math.floor(Math.random() * 20) + 10; // Random 10-30 iterations

    for (let i = 0; i < preRunIterations; i++) {
      this.update();
    }

    // Initial draw to show the warmed-up state
    this.draw();
    debugLog(`Conway Background: Pre-ran ${preRunIterations} iterations`);
  }

  countNeighbors(x, y) {
    let count = 0;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        if (i === 0 && j === 0) continue;

        const newX = x + j;
        const newY = y + i;

        // Wrap around edges for seamless effect
        const wrappedX = ((newX % this.cols) + this.cols) % this.cols;
        const wrappedY = ((newY % this.rows) + this.rows) % this.rows;

        count += this.grid[wrappedY][wrappedX];
      }
    }
    return count;
  }

  update() {
    // Apply Conway's rules
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        const neighbors = this.countNeighbors(j, i);
        const current = this.grid[i][j];

        if (current === 1) {
          // Live cell
          if (neighbors < 2 || neighbors > 3) {
            this.nextGrid[i][j] = 0; // Dies
          } else {
            this.nextGrid[i][j] = 1; // Lives
          }
        } else {
          // Dead cell
          if (neighbors === 3) {
            this.nextGrid[i][j] = 1; // Becomes alive
          } else {
            this.nextGrid[i][j] = 0; // Stays dead
          }
        }
      }
    }

    // Swap grids
    [this.grid, this.nextGrid] = [this.nextGrid, this.grid];

    // Occasionally add new random elements to prevent stagnation
    if (Math.random() < 0.005) {
      this.addRandomElements();
    }
  }

  addRandomElements() {
    // Add a few random live cells to keep things interesting
    for (let i = 0; i < 3; i++) {
      const x = Math.floor(Math.random() * this.cols);
      const y = Math.floor(Math.random() * this.rows);
      this.grid[y][x] = 1;
    }
  }

  draw() {
    // Clear canvas with subtle fade effect
    this.ctx.fillStyle = "rgba(0, 0, 0, 0.05)";
    this.ctx.fillRect(
      0,
      0,
      this.canvas.width / (window.devicePixelRatio || 1),
      this.canvas.height / (window.devicePixelRatio || 1)
    );

    // Draw living cells
    const { r, g, b } = this.config.color;

    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        if (this.grid[i][j] === 1) {
          const x = j * this.cellSize;
          const y = i * this.cellSize;

          // Add subtle glow effect
          this.ctx.shadowBlur = 2;
          this.ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${this.config.glowIntensity})`;

          this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.6)`;
          this.ctx.fillRect(x, y, this.cellSize - 1, this.cellSize - 1);

          // Reset shadow
          this.ctx.shadowBlur = 0;
        }
      }
    }
  }

  start() {
    debugLog("Conway Background: Starting animation...");
    if (!this.isRunning) {
      this.isRunning = true;
      this.intervalId = setInterval(() => {
        this.update();
        this.draw();
      }, this.config.updateInterval);
      debugLog(
        "Conway Background: Animation started with interval:",
        this.config.updateInterval
      );
    }
  }

  pause() {
    if (this.isRunning) {
      this.isRunning = false;
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    }
  }

  handleResize() {
    // Debounce resize events
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      this.setupCanvasSize();
      this.setupGrid();
      this.seedRandom();
      this.preRunSimulation();
    }, 250);
  }

  // Method to reinitialize with new CSS settings
  reinitialize() {
    this.pause();
    this.loadConfigFromCSS();
    if (!this.shouldDisableAnimation()) {
      this.setupGrid();
      this.seedRandom();
      this.preRunSimulation();
      this.start();
    }
  }

  destroy() {
    this.pause();
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    window.removeEventListener("resize", this.handleResize);
  }
}

// Initialize Conway's Game of Life background when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Small delay to ensure page is fully rendered
  setTimeout(() => {
    window.conwayBackground = new ConwayBackground();
  });
});

// Export for potential external use
if (typeof module !== "undefined" && module.exports) {
  module.exports = ConwayBackground;
}
