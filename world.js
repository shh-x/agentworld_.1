// WORLD CONFIG - Game Constants
const GAME_CONFIG = {
  // Timing
  TICK_RATE_MS: 1000,          // how fast the simulation runs
  KILL_COOLDOWN_TICKS: 4,      // ticks before impostor can kill again
  MEETING_DURATION_MS: 8000,   // how long meetings last

  // Agents
  TOTAL_AGENTS: 6,
  IMPOSTOR_COUNT: 1,
  TASKS_PER_AGENT: 3,

  // Win conditions
  TASK_WIN: true,              // crewmates win by finishing all tasks
  VOTE_WIN: true,              // crewmates win by ejecting all impostors

  // Perception
  VISION_RANGE: 1,             // agents only see their room + adjacent rooms
  MEMORY_SIZE: 10,             // max events each agent remembers
};

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = GAME_CONFIG;
} else {
  window.GAME_CONFIG = GAME_CONFIG;
}
