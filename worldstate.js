// TASK SYSTEM - Individual task management
class Task {
  constructor(id, roomId, name, ticksToComplete) {
    this.id = id
    this.roomId = roomId
    this.name = name
    this.ticksToComplete = ticksToComplete  // how many ticks agent must stay
    this.ticksSpent = 0
    this.completedBy = null   // agentId
    this.isComplete = false
  }

  workOn(agentId, ticks = 1) {
    if (this.isComplete) return false;
    
    this.ticksSpent += ticks;
    
    if (this.ticksSpent >= this.ticksToComplete) {
      this.isComplete = true;
      this.completedBy = agentId;
      return true; // Task completed
    }
    
    return false; // Task not yet completed
  }

  getProgress() {
    return Math.min(this.ticksSpent / this.ticksToComplete, 1);
  }
}

// ROOM STATE - Individual room management
class RoomState {
  constructor(id, name, connectedTo) {
    this.id = id
    this.name = name
    this.connectedTo = connectedTo   // array of roomIds
    this.agents = new Set()          // agent IDs currently here
    this.tasks = []                  // task objects assigned to this room
    this.hasBody = false             // dead body present?
    this.bodyOf = null               // which agent died here
    this.isLightsOut = false         // sabotage state (Phase 6)
  }

  addAgent(agentId) {
    this.agents.add(agentId);
  }

  removeAgent(agentId) {
    this.agents.delete(agentId);
  }

  getAgents() {
    return Array.from(this.agents);
  }

  hasAgent(agentId) {
    return this.agents.has(agentId);
  }

  addBody(agentId) {
    this.hasBody = true;
    this.bodyOf = agentId;
  }

  clearBody() {
    this.hasBody = false;
    this.bodyOf = null;
  }

  setLightsOut(state) {
    this.isLightsOut = state;
  }
}

// WORLD STATE - Live Game World Management
class WorldState {
  constructor() {
    this.rooms = {}          // roomId → RoomState
    this.agents = []         // array of AgentState objects
    this.tick = 0            // current simulation tick
    this.phase = 'idle'      // idle | roaming | meeting | voting | gameover
    this.winner = null       // null | 'crewmates' | 'impostors'
    this.events = []         // global event history
    this.pendingMeeting = false
    this.bodyFound = null    // which agent's body triggered meeting
    
    this.initializeWorld();
    this.setupEventListeners();
  }

  initializeWorld() {
    // Initialize all 7 rooms using ROOMS config
    const ROOMS = {
      cafeteria:  { x:  0,  z: -4, size: 'large'  },
      reactor:    { x: -8,  z:  0, size: 'medium' },
      medbay:     { x: -5,  z:  3, size: 'small'  },
      security:   { x: -2,  z:  1, size: 'small'  },
      electrical: { x:  0,  z:  5, size: 'medium' },
      storage:    { x:  4,  z:  4, size: 'medium' },
      admin:      { x:  6,  z: -1, size: 'large'  }
    };

    // Room connections matching the connection graph from Phase 1
    const roomConnections = {
      cafeteria: ['reactor', 'security', 'admin'],
      reactor: ['cafeteria', 'medbay'],
      medbay: ['reactor', 'security'],
      security: ['cafeteria', 'medbay', 'electrical'],
      electrical: ['security', 'storage'],
      storage: ['electrical', 'admin'],
      admin: ['cafeteria', 'storage']
    };

    // Initialize RoomState objects
    Object.keys(ROOMS).forEach(roomId => {
      const roomName = roomId.charAt(0).toUpperCase() + roomId.slice(1);
      const connectedTo = roomConnections[roomId] || [];
      this.rooms[roomId] = new RoomState(roomId, roomName, connectedTo);
    });

    // Log all room names and connections to console for verification
    console.log('=== ROOM INITIALIZATION ===');
    Object.keys(this.rooms).forEach(roomId => {
      const room = this.rooms[roomId];
      console.log(`${room.name} (${room.id}) -> connected to: [${room.connectedTo.join(', ')}]`);
    });
    console.log('=== END ROOM INITIALIZATION ===');
    
    // Initialize task system
    this.initializeTasks();
    
    this.logEvent('system', 'World initialized with 7 rooms and tasks');
  }

  initializeTasks() {
    // Available tasks per room
    const taskDefinitions = {
      cafeteria:  { name: 'Fix Wiring',     ticks: 3 },
      reactor:    { name: 'Start Reactor',  ticks: 5 },
      medbay:     { name: 'Submit Scan',    ticks: 2 },
      security:   { name: 'Check Cameras',  ticks: 2 },
      electrical: { name: 'Reset Breakers', ticks: 4 },
      storage:    { name: 'Fuel Engines',   ticks: 3 },
      admin:      { name: 'Swipe Card',     ticks: 1 }
    };

    // Calculate total tasks needed
    const totalTasks = (window.GAME_CONFIG ? window.GAME_CONFIG.TASKS_PER_AGENT : 3) * 
                      (window.GAME_CONFIG ? window.GAME_CONFIG.TOTAL_AGENTS : 6);
    
    const roomIds = Object.keys(taskDefinitions);
    const tasks = [];
    let taskId = 0;

    // Create tasks and distribute randomly across rooms
    for (let i = 0; i < totalTasks; i++) {
      const roomId = roomIds[Math.floor(Math.random() * roomIds.length)];
      const taskDef = taskDefinitions[roomId];
      
      const task = new Task(
        taskId++,
        roomId,
        taskDef.name,
        taskDef.ticks
      );
      
      tasks.push(task);
    }

    // Assign tasks to rooms
    tasks.forEach(task => {
      const room = this.rooms[task.roomId];
      if (room) {
        room.tasks.push(task);
      }
    });

    // Log task distribution for verification
    console.log('=== TASK ASSIGNMENT ===');
    Object.keys(this.rooms).forEach(roomId => {
      const room = this.rooms[roomId];
      console.log(`${room.name}: ${room.tasks.length} tasks`);
      room.tasks.forEach(task => {
        console.log(`  - ${task.name} (${task.ticksToComplete} ticks)`);
      });
    });
    console.log(`Total tasks created: ${totalTasks}`);
    console.log('=== END TASK ASSIGNMENT ===');
  }

  getTotalTasks() {
    let total = 0;
    Object.values(this.rooms).forEach(room => {
      total += room.tasks.length;
    });
    return total;
  }

  getCompletedTasks() {
    let completed = 0;
    Object.values(this.rooms).forEach(room => {
      completed += room.tasks.filter(task => task.isComplete).length;
    });
    return completed;
  }

  // PHASE MANAGER
  setPhase(newPhase) {
    const oldPhase = this.phase;
    this.phase = newPhase;
    this.logEvent('system', `Phase changed from ${oldPhase} to ${newPhase}`);
    
    // Update HUD
    this.updatePhaseHUD(newPhase);
    
    // Dispatch event for other systems
    document.dispatchEvent(new CustomEvent('phaseChange', { 
      detail: { oldPhase, newPhase, tick: this.tick }
    }));
  }

  // EVENT BUS SYSTEM
  setupEventListeners() {
    // Phase change listener
    document.addEventListener('phaseChange', (event) => {
      this.updatePhaseHUD(event.detail.newPhase);
    });

    // Agent died listener
    document.addEventListener('agentDied', (event) => {
      const { agent, killer, room } = event.detail;
      this.updateAgentPanel();
      this.checkWinCondition();
    });

    // Task completed listener
    document.addEventListener('taskDone', (event) => {
      const { agent, task } = event.detail;
      this.updateTaskHUD();
      this.checkWinCondition();
    });

    // Body found listener
    document.addEventListener('bodyFound', (event) => {
      const { reporter, body, room } = event.detail;
      
      // Trigger meeting after 1 tick delay
      setTimeout(() => {
        this.startMeeting(reporter, body);
      }, window.GAME_CONFIG ? window.GAME_CONFIG.TICK_RATE_MS : 1000);
    });
  }

  // HUD UPDATE METHODS
  updatePhaseHUD(phase) {
    const phaseElement = document.getElementById('phase-display');
    if (phaseElement) {
      const phaseText = {
        'idle': 'IDLE',
        'roaming': 'ROAMING',
        'meeting': 'MEETING',
        'voting': 'VOTING',
        'gameover': this.winner ? `${this.winner.toUpperCase()} WIN` : 'GAME OVER'
      };
      
      phaseElement.textContent = phaseText[phase] || phase.toUpperCase();
      
      // Update phase pill class for color
      phaseElement.className = 'phase-pill';
      if (phase === 'meeting') {
        phaseElement.classList.add('meeting');
      } else if (phase === 'voting') {
        phaseElement.classList.add('voting');
      } else if (phase === 'gameover') {
        phaseElement.classList.add('gameover');
      } else {
        phaseElement.classList.add('roaming');
      }
    }
  }

  updateAgentPanel() {
    const agentCardsContainer = document.getElementById('agent-cards');
    if (!agentCardsContainer || !this.agents.length) return;

    let agentHTML = '';
    this.agents.forEach(agent => {
      const isDead = !agent.alive;
      const agentColor = agent.color || '#00e5ff';
      const currentRoom = agent.currentRoom?.toUpperCase() || 'UNKNOWN';
      
      // Calculate health (100% for alive, 0% for dead)
      const healthPercent = isDead ? 0 : 100;
      
      // Calculate task progress
      const totalTasks = agent.tasks?.length || 0;
      const completedTasks = agent.tasks?.filter(task => task.isComplete).length || 0;
      const taskPercent = totalTasks > 0 ? (completedTasks / totalTasks * 100) : 0;
      
      // Determine role badge
      let roleBadge = '';
      if (isDead && agent.isImpostor) {
        roleBadge = '<span class="role-badge imp">IMP</span>';
      } else if (isDead) {
        roleBadge = '<span class="role-badge crew">CREW</span>';
      } else {
        roleBadge = '<span class="role-badge hidden">???</span>';
      }
      
      // Health bar color based on percentage
      let healthColor = '#00ff00'; // green
      if (healthPercent <= 30) healthColor = '#ff0000'; // red
      else if (healthPercent <= 60) healthColor = '#ffff00'; // yellow
      
      agentHTML += `
        <div class="agent-card ${isDead ? 'dead' : ''}">
          <div class="agent-card-header">
            <div class="agent-info">
              <span class="agent-dot" style="background-color: ${isDead ? '#ff4444' : agentColor}">${isDead ? '✕' : ''}</span>
              <span class="agent-name">${agent.name.toUpperCase()}</span>
              ${roleBadge}
            </div>
          </div>
          <div class="agent-status">
            <div class="progress-bar">
              <div class="progress-fill health-fill" style="width: ${healthPercent}%; background: linear-gradient(to right, #ff0000 0%, #ffff00 50%, #00ff00 100%); background-size: 300% 100%; background-position: ${100 - healthPercent}% 0%;"></div>
            </div>
            <span class="room-name">${currentRoom}</span>
          </div>
          <div class="agent-stats">
            <span class="health-text">Health: ${healthPercent}%</span>
            <span class="task-text">Tasks: ${completedTasks}/${totalTasks}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill task-fill" style="width: ${taskPercent}%"></div>
          </div>
        </div>
      `;
    });

    agentCardsContainer.innerHTML = agentHTML;
  }

  updateTaskHUD() {
    const totalTasks = this.getTotalTasks();
    const completedTasks = this.getCompletedTasks();

    // Update task counter in stat chips
    const taskCounter = document.getElementById('task-counter');
    if (taskCounter) {
      taskCounter.textContent = `${completedTasks}/${totalTasks}`;
    }

    // Update alive counter
    const aliveCounter = document.getElementById('alive-counter');
    if (aliveCounter && this.agents.length > 0) {
      const aliveCount = this.agents.filter(agent => agent.alive).length;
      const totalCount = this.agents.length;
      aliveCounter.textContent = `${aliveCount}/${totalCount}`;
    }
  }

  getRoom(roomId) {
    return this.rooms[roomId] || null;
  }

  getAgentsInRoom(roomId) {
    const room = this.getRoom(roomId);
    if (!room) return [];
    
    // Get agent IDs from room and return full agent objects
    return room.getAgents()
      .map(agentId => this.agents.find(agent => agent.id === agentId))
      .filter(agent => agent && agent.alive);
  }

  getAdjacentRooms(roomId) {
    const room = this.getRoom(roomId);
    return room ? room.connectedTo : [];
  }

  findPath(fromRoomId, toRoomId) {
    // BFS shortest path algorithm
    if (fromRoomId === toRoomId) return [fromRoomId];
    
    const visited = new Set();
    const queue = [{ room: fromRoomId, path: [fromRoomId] }];
    visited.add(fromRoomId);
    
    while (queue.length > 0) {
      const { room, path } = queue.shift();
      
      const adjacentRooms = this.getAdjacentRooms(room);
      for (const adjacentRoom of adjacentRooms) {
        if (adjacentRoom === toRoomId) {
          return [...path, adjacentRoom];
        }
        
        if (!visited.has(adjacentRoom)) {
          visited.add(adjacentRoom);
          queue.push({ room: adjacentRoom, path: [...path, adjacentRoom] });
        }
      }
    }
    
    return null; // No path found
  }

  logEvent(type, message, involvedAgents = []) {
    const event = {
      tick: this.tick,
      type,
      message,
      involvedAgents: involvedAgents.map(agent => agent.id),
      timestamp: new Date().toISOString()
    };
    
    this.events.push(event);
    
    // Keep event history manageable
    if (this.events.length > 1000) {
      this.events = this.events.slice(-500);
    }
    
    // Call addLog for UI updates
    this.addLog(message, type);
  }

  addLog(message, type = 'info') {
    // This will be connected to the UI event log
    const eventLog = document.querySelector('.event-log');
    if (eventLog) {
      const eventItem = document.createElement('div');
      eventItem.className = 'event-item';
      
      const time = new Date().toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      let className = '';
      if (type === 'kill') className = 'hud-danger';
      else if (type === 'meeting' || type === 'vote') className = 'hud-accent';
      else className = 'hud-text';
      
      eventItem.innerHTML = `
        <span class="event-time">${time}</span>
        <span class="${className}">${message}</span>
      `;
      
      eventLog.appendChild(eventItem);
      eventLog.scrollTop = eventLog.scrollHeight;
      
      // Limit displayed events
      while (eventLog.children.length > 50) {
        eventLog.removeChild(eventLog.firstChild);
      }
    }
  }

  checkWinCondition() {
    const aliveAgents = this.agents.filter(agent => agent.alive);
    const aliveCrewmates = aliveAgents.filter(agent => !agent.isImpostor);
    const aliveImpostors = aliveAgents.filter(agent => agent.isImpostor);
    
    // Check if crewmates win by completing all tasks
    if (window.GAME_CONFIG && window.GAME_CONFIG.TASK_WIN) {
      const totalTasks = this.agents.reduce((sum, agent) => sum + agent.tasks.length, 0);
      const completedTasks = this.agents.reduce((sum, agent) => 
        sum + agent.tasks.filter(task => task.completed).length, 0);
      
      if (totalTasks > 0 && completedTasks === totalTasks) {
        this.winner = 'crewmates';
        this.phase = 'gameover';
        this.logEvent('victory', 'Crewmates win by completing all tasks!');
        return 'crewmates';
      }
    }
    
    // Check if crewmates win by ejecting all impostors
    if (window.GAME_CONFIG && window.GAME_CONFIG.VOTE_WIN && aliveImpostors.length === 0) {
      this.winner = 'crewmates';
      this.phase = 'gameover';
      this.logEvent('victory', 'Crewmates win by ejecting all impostors!');
      return 'crewmates';
    }
    
    // Check if impostors win (impostors >= crewmates)
    if (aliveImpostors.length >= aliveCrewmates.length) {
      this.winner = 'impostors';
      this.phase = 'gameover';
      this.logEvent('victory', 'Impostors win by equalizing crewmates!');
      return 'impostors';
    }
    
    return null; // No winner yet
  }

  advanceTick() {
    this.tick++;
    this.logEvent('tick', `Simulation tick ${this.tick}`);
    
    // Check win conditions after each tick
    if (this.phase === 'roaming') {
      this.checkWinCondition();
    }
  }

  startMeeting(calledBy, bodyFound = null) {
    if (this.phase !== 'roaming') return false;
    
    this.phase = 'meeting';
    this.pendingMeeting = true;
    this.bodyFound = bodyFound;
    
    const reason = bodyFound ? `Body found in ${bodyFound.currentRoom}` : 'Emergency meeting called';
    this.logEvent('meeting', `${reason} by ${calledBy.name}`, [calledBy]);
    
    // Set meeting timer
    setTimeout(() => {
      this.startVoting();
    }, window.GAME_CONFIG ? window.GAME_CONFIG.MEETING_DURATION_MS : 8000);
    
    return true;
  }

  startVoting() {
    this.phase = 'voting';
    this.pendingMeeting = false;
    this.logEvent('vote', 'Voting phase started');
    
    // Auto-resolve voting after a delay
    setTimeout(() => {
      this.resolveVoting();
    }, 5000);
  }

  resolveVoting() {
    // Simple voting logic - can be expanded
    const aliveAgents = this.agents.filter(agent => agent.alive);
    
    // For now, skip voting and return to roaming
    this.phase = 'roaming';
    this.bodyFound = null;
    this.logEvent('vote', 'Voting ended, returning to roaming');
  }

  killAgent(killer, victim) {
    if (!killer.alive || !victim.alive) return false;
    if (killer.killCooldown > 0) return false;
    
    victim.alive = false;
    victim.deathTick = this.tick;
    victim.deathRoom = victim.currentRoom;
    
    // Add body to room using RoomState method
    const room = this.getRoom(victim.currentRoom);
    if (room) {
      room.addBody(victim.id);
    }
    
    // Set kill cooldown
    killer.killCooldown = window.GAME_CONFIG ? window.GAME_CONFIG.KILL_COOLDOWN_TICKS : 4;
    
    this.logEvent('kill', `${killer.name} killed ${victim.name} in ${victim.currentRoom}`, [killer, victim]);
    
    // Dispatch agentDied event instead of direct calls
    document.dispatchEvent(new CustomEvent('agentDied', {
      detail: { agent: victim, killer, room: victim.currentRoom }
    }));
    
    return true;
  }

  reportBody(reporter, body) {
    const victim = this.agents.find(agent => agent.id === body.agentId);
    if (victim) {
      this.startMeeting(reporter, victim);
    }
  }

  moveAgent(agent, newRoomId) {
    const oldRoomId = agent.currentRoom;
    
    // Remove from old room
    if (oldRoomId) {
      const oldRoom = this.getRoom(oldRoomId);
      if (oldRoom) {
        oldRoom.removeAgent(agent.id);
      }
    }
    
    // Add to new room
    const newRoom = this.getRoom(newRoomId);
    if (newRoom) {
      agent.currentRoom = newRoomId;
      newRoom.addAgent(agent.id);
      this.logEvent('move', `${agent.name} moved to ${newRoomId}`, [agent]);
      return true;
    }
    
    return false;
  }

  completeTask(agent, task) {
    if (!agent.alive) return false;
    
    task.completed = true;
    task.completedTick = this.tick;
    
    this.logEvent('task', `${agent.name} completed task in ${agent.currentRoom}`, [agent]);
    
    // Dispatch taskDone event instead of direct calls
    document.dispatchEvent(new CustomEvent('taskDone', {
      detail: { agent, task }
    }));
    
    return true;
  }
}

// Create global world instance
window.WORLD = new WorldState();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WorldState, WORLD: window.WORLD };
}
