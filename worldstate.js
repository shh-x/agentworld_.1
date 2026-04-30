// AGENT ROSTER - Available agents for spawning
const AGENT_ROSTER = [
  { name: 'NOVA',  color: '#ef5350' },
  { name: 'AXEL',  color: '#42a5f5' },
  { name: 'ZIRA',  color: '#66bb6a' },
  { name: 'KAGE',  color: '#ffca28' },
  { name: 'PULSE', color: '#ab47bc' },
  { name: 'VERA',  color: '#26c6da' },
];

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

// AGENT STATE - Individual AI agent management
class AgentState {
  constructor(id, name, color, role, startRoomId) {
    this.id = id
    this.name = name
    this.color = color
    this.role = role              // 'crewmate' | 'impostor'
    this.alive = true
    this.currentRoom = startRoomId
    this.previousRoom = null
    this.path = []                // planned path (array of roomIds)
    this.currentTask = null       // Task object they're working on
    this.assignedTasks = []       // Task IDs assigned to this agent
    this.completedTasks = []
    this.memory = []              // last N observations (capped at MEMORY_SIZE)
    this.suspicions = {}          // { agentName: suspicionScore }
    this.killCooldown = 0
    this.personality = null       // set in Phase 3
    this.state = 'idle'           // idle | moving | working | hunting | fleeing
    this.targetPosition = null   // THREE.Vector3
    this.isMoving = false
  }

  addMemory(observation) {
    this.memory.unshift(observation)
    if (this.memory.length > (window.GAME_CONFIG ? window.GAME_CONFIG.MEMORY_SIZE : 10)) {
      this.memory.pop()
    }
  }

  raiseSuspicion(agentName, amount) {
    this.suspicions[agentName] = (this.suspicions[agentName] || 0) + amount
  }

  getTopSuspect() {
    return Object.entries(this.suspicions).sort((a,b) => b[1]-a[1])[0] || null
  }

  // Helper methods for agent state management
  moveToRoom(roomId) {
    this.previousRoom = this.currentRoom
    this.currentRoom = roomId
    this.path = []
  }

  setPath(path) {
    this.path = path
  }

  assignTask(task) {
    this.assignedTasks.push(task.id)
    this.currentTask = task
  }

  completeTask(task) {
    const index = this.assignedTasks.indexOf(task.id)
    if (index > -1) {
      this.assignedTasks.splice(index, 1)
    }
    this.completedTasks.push(task.id)
    if (this.currentTask && this.currentTask.id === task.id) {
      this.currentTask = null
    }
  }

  setState(newState) {
    this.state = newState
  }

  isImpostor() {
    return this.role === 'impostor'
  }

  canKill() {
    return this.isImpostor() && this.alive && this.killCooldown === 0
  }

  setKillCooldown(ticks) {
    this.killCooldown = ticks
  }

  reduceKillCooldown() {
    if (this.killCooldown > 0) {
      this.killCooldown--
    }
  }

  getTaskProgress() {
    if (!this.currentTask) return 0
    return this.currentTask.getProgress()
  }

  getCompletedTaskCount() {
    return this.completedTasks.length
  }

  getAssignedTaskCount() {
    return this.assignedTasks.length
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
    console.log('=== WORLDSTATE CONSTRUCTOR CALLED ===')
    this.rooms = {}          // roomId → RoomState
    this.agents = []         // array of AgentState objects
    this.gameTick = 0        // current simulation tick counter
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
    
    // Agents will be spawned after page loads completely
  }

  spawnAgents() {
    if (this.agents.length > 0) {
      console.log('Agents already spawned, clearing first...')
      this.agents = []
      this.rooms['cafeteria'].agents = new Set()
    }
    console.log('=== SPAWN AGENTS CALLED ===')
    console.log('WORLD.agents before spawn:', this.agents.length)
    
    const impostorCount = window.GAME_CONFIG ? window.GAME_CONFIG.IMPOSTOR_COUNT : 1;
    const tasksPerAgent = window.GAME_CONFIG ? window.GAME_CONFIG.TASKS_PER_AGENT : 3;
    
    // 1. Pick IMPOSTOR_COUNT random agents to be impostors
    const agentIndices = Array.from({length: AGENT_ROSTER.length}, (_, i) => i);
    const impostorIndices = [];
    
    // Randomly select impostors
    for (let i = 0; i < impostorCount; i++) {
      const randomIndex = Math.floor(Math.random() * agentIndices.length);
      impostorIndices.push(agentIndices.splice(randomIndex, 1)[0]);
    }
    
    // 2. Create AgentState objects
    AGENT_ROSTER.forEach((agentData, index) => {
      const isImpostor = impostorIndices.includes(index);
      const role = isImpostor ? 'impostor' : 'crewmate';
      
      // Create agent with unique ID
      const agent = new AgentState(
        index,
        agentData.name,
        agentData.color,
        role,
        'cafeteria' // All agents start in cafeteria
      );
      
      // 3. Assign tasks to crewmates (impostors get fake tasks)
      if (!isImpostor) {
        this.assignTasksToAgent(agent, tasksPerAgent);
      } else {
        // Impostors get fake tasks for appearance
        this.assignFakeTasksToAgent(agent, tasksPerAgent);
      }
      
      // 4. Add to WORLD.agents
      this.agents.push(agent);
      console.log('Pushed agent, total now:', this.agents.length);
      
      // 5. Add to cafeteria room
      const cafeteria = this.getRoom('cafeteria');
      if (cafeteria) {
        cafeteria.addAgent(agent.id);
      }
      
      // 6. Create 3D mesh for agent
      this.spawnAgentMesh(agent);
    });
    
    // 7. Update UI
    this.updateAgentPanel();
    this.updateTaskHUD();
    
    // 8. Debug logging
    console.log('=== AGENT SPAWNING ===');
    this.agents.forEach(agent => {
      console.log(`${agent.name} (${agent.role.toUpperCase()}) - Tasks: ${agent.assignedTasks.length}`);
    });
    console.log(`IMPOSTORS: ${this.agents.filter(a => a.isImpostor()).map(a => a.name).join(', ')}`);
    console.log('=== END AGENT SPAWNING ===');
    
    this.logEvent('system', `Spawned ${this.agents.length} agents (${impostorCount} impostors)`);
    
    console.log('=== SPAWN COMPLETE ===')
    console.log('WORLD.agents after spawn:', this.agents.length)
    this.agents.forEach(a => console.log(a.name, a.color, a.currentRoom, a.role))
  }

  assignTasksToAgent(agent, taskCount) {
    const roomIds = Object.keys(this.rooms);
    const assignedTasks = [];
    
    for (let i = 0; i < taskCount; i++) {
      // Find a room with available tasks
      const availableRooms = roomIds.filter(roomId => {
        const room = this.rooms[roomId];
        return room.tasks.some(task => !task.isComplete && !assignedTasks.includes(task.id));
      });
      
      if (availableRooms.length === 0) break;
      
      const randomRoomId = availableRooms[Math.floor(Math.random() * availableRooms.length)];
      const room = this.rooms[randomRoomId];
      
      // Find an unassigned task in this room
      const availableTask = room.tasks.find(task => !task.isComplete && !assignedTasks.includes(task.id));
      
      if (availableTask) {
        agent.assignTask(availableTask);
        assignedTasks.push(availableTask.id);
      }
    }
  }

  assignFakeTasksToAgent(agent, taskCount) {
    // Impostors get fake tasks that don't actually exist in the world
    // This makes them appear to have tasks like crewmates
    const fakeTaskNames = ['Fix Wiring', 'Start Reactor', 'Submit Scan', 'Check Cameras', 'Reset Breakers', 'Fuel Engines', 'Swipe Card'];
    
    for (let i = 0; i < taskCount; i++) {
      const fakeTask = {
        id: `fake_${agent.id}_${i}`,
        name: fakeTaskNames[Math.floor(Math.random() * fakeTaskNames.length)],
        roomId: 'cafeteria',
        isComplete: false,
        getProgress: () => 0
      };
      
      agent.assignTask(fakeTask);
    }
  }

  spawnAgentMesh(agent) {
    console.log(`WorldState.spawnAgentMesh called for ${agent.name}`);
    // Call the global 3D mesh creation function
    if (window.spawnAgentMesh && typeof window.spawnAgentMesh === 'function') {
      console.log(`Calling window.spawnAgentMesh for ${agent.name}`);
      window.spawnAgentMesh(agent);
    } else {
      console.log(`Would create 3D mesh for ${agent.name} at cafeteria position`);
    }
  }

  // Find shortest path between rooms using BFS
  findPath(fromRoomId, toRoomId) {
    if (fromRoomId === toRoomId) return [fromRoomId];
    
    const queue = [[fromRoomId]];
    const visited = new Set([fromRoomId]);
    
    while (queue.length > 0) {
      const path = queue.shift();
      const currentRoom = path[path.length - 1];
      
      // Get connected rooms
      const currentRoomState = this.rooms[currentRoom];
      if (!currentRoomState) continue;
      
      for (const connectedRoomId of currentRoomState.connectedTo) {
        if (connectedRoomId === toRoomId) {
          return [...path, connectedRoomId];
        }
        
        if (!visited.has(connectedRoomId)) {
          visited.add(connectedRoomId);
          queue.push([...path, connectedRoomId]);
        }
      }
    }
    
    // No path found
    return [];
  }

  // Decide destination for agent based on role
  decideDestination(agent) {
    if (agent.role === 'crewmate') {
      // Go to next incomplete assigned task room
      const nextTask = agent.assignedTasks.find(taskId => {
        const task = this.tasks.find(t => t.id === taskId);
        return task && !task.isComplete;
      });
      
      if (nextTask) {
        const task = this.tasks.find(t => t.id === nextTask);
        return task ? task.roomId : 'cafeteria';
      }
      
      // If no tasks, wander randomly
      const roomIds = Object.keys(this.rooms);
      return roomIds[Math.floor(Math.random() * roomIds.length)];
    }
    
    if (agent.role === 'impostor') {
      // Go to room with most crewmates
      const rooms = Object.values(this.rooms);
      const target = rooms
        .filter(room => room.id !== agent.currentRoom)
        .map(room => ({
          id: room.id,
          crewmateCount: room.agents.size
        }))
        .sort((a, b) => b.crewmateCount - a.crewmateCount)[0];
      
      return target ? target.id : 'cafeteria';
    }
    
    return 'cafeteria';
  }

  moveAgent(agent) {
    try {
      console.log(`moveAgent called for ${agent.name}, alive: ${agent.alive}, currentRoom: ${agent.currentRoom}, path length: ${agent.path?.length || 0}`)
      
      if (!agent.alive) {
        console.log(`${agent.name} is dead, skipping movement`)
        return
      }

      // If no path planned, decide destination
      if (!agent.path || agent.path.length === 0) {
        console.log(`${agent.name} has no path, deciding destination`)
        const dest = this.decideDestination(agent)
        console.log(`${agent.name} decided destination: ${dest}`)
        if (!dest) {
          console.log(`${agent.name} has no destination, skipping`)
          return
        }
        agent.path = this.findPath(agent.currentRoom, dest)
        console.log(`${agent.name} path from ${agent.currentRoom} to ${dest}:`, agent.path)
        if (agent.path && agent.path.length > 0) {
          agent.path.shift() // remove current room from path
          console.log(`${agent.name} path after shift:`, agent.path)
        }
      }

      // Take one step
      if (agent.path && agent.path.length > 0) {
        const nextRoom = agent.path.shift()
        console.log(`${agent.name} moving to ${nextRoom}`)
        
        // Update world room sets
        this.rooms[agent.currentRoom].agents.delete(agent.id)
        agent.previousRoom = agent.currentRoom
        agent.currentRoom = nextRoom
        this.rooms[nextRoom].agents.add(agent.id)
        
        agent.state = 'moving'
        console.log(`MOVE: ${agent.name} → ${this.rooms[nextRoom].name}`)
        this.logEvent('move', `${agent.name} moved to ${this.rooms[nextRoom].name}`)
        
        // Set target position for smooth movement
        console.log(`DEBUG: Setting target position for ${agent.name} (id: ${agent.id}) to ${nextRoom}`)
        console.log(`DEBUG: getRoomPosition exists:`, !!window.getRoomPosition)
        console.log(`DEBUG: agentMeshes exists:`, !!window.agentMeshes)
        console.log(`DEBUG: agentMeshes keys:`, Array.from(window.agentMeshes?.keys() || []))
        console.log(`DEBUG: agentMeshes size:`, window.agentMeshes?.size)
        console.log(`DEBUG: looking for agent.id:`, agent.id)
        console.log(`DEBUG: agent mesh exists:`, !!window.agentMeshes?.[agent.id])
        console.log(`DEBUG: agent mesh via get:`, !!window.agentMeshes?.get(agent.id))
        console.log(`DEBUG: THREE exists:`, !!window.THREE)
        
        if (window.getRoomPosition && window.agentMeshes && window.agentMeshes.get(agent.id)) {
          const roomPos = window.getRoomPosition(nextRoom)
          console.log(`DEBUG: Room position:`, roomPos)
          if (roomPos) {
            try {
              agent.targetPosition = new THREE.Vector3(roomPos.x, 0.5, roomPos.z)
              agent.isMoving = true
              console.log(`SUCCESS: Set target position for ${agent.name}:`, agent.targetPosition)
            } catch (error) {
              console.error(`ERROR creating Vector3:`, error)
            }
          }
        } else {
          console.log(`FAILED: Missing dependencies for target position`)
        }
      } else {
        console.log(`${agent.name} has no path to move`)
      }
    } catch (error) {
      console.error(`Error in moveAgent for ${agent.name}:`, error)
    }
  }

  decideDestination(agent) {
    console.log(`decideDestination for ${agent.name}, role: ${agent.role}, assignedTasks: ${agent.assignedTasks?.length || 0}`)
    
    if (agent.role === 'crewmate') {
      console.log(`${agent.name} assignedTasks:`, agent.assignedTasks)
      
      // Find actual task objects from task IDs
      const allTasks = []
      Object.values(this.rooms).forEach(room => {
        allTasks.push(...room.tasks)
      })
      
      // Head to next incomplete task room
      const nextTaskObj = agent.assignedTasks
        .map(taskId => allTasks.find(t => t.id === taskId))
        .find(t => t && !t.isComplete && t.roomId !== agent.currentRoom)
      
      console.log(`${agent.name} nextTaskObj:`, nextTaskObj)
      if (nextTaskObj) return nextTaskObj.roomId
      
      // All tasks done — wander randomly
      console.log(`${agent.name} has no valid tasks, wandering randomly`)
      const rooms = Object.keys(this.rooms).filter(r => r !== agent.currentRoom)
      return rooms[Math.floor(Math.random() * rooms.length)]
    }

    if (agent.role === 'impostor') {
      // Hunt room with most crewmates
      const target = Object.values(this.rooms)
        .filter(r => r.id !== agent.currentRoom)
        .sort((a, b) => b.agents.size - a.agents.size)[0]
      console.log(`${agent.name} (impostor) hunting target:`, target?.id || 'none')
      return target ? target.id : null
    }
  }

  // Game tick - called each frame/time step
  tick() {
    console.log(`=== TICK ${this.gameTick} - Phase: ${this.phase} ===`);
    
    if (this.phase !== 'roaming') {
      console.log('Tick skipped - not in roaming phase');
      return;
    }
    
    this.gameTick++;
    console.log(`Processing ${this.agents.length} agents`);
    
    // Move all alive agents
    const aliveAgents = this.agents.filter(a => a.alive);
    console.log(`Alive agents: ${aliveAgents.length}, moveAgent exists: ${typeof this.moveAgent}`);
    aliveAgents.forEach((agent, index) => {
      console.log(`About to call moveAgent for agent ${index + 1}: ${agent.name}`);
      this.moveAgent(agent);
    });
    
    // Update UI
    this.updateAgentPanel();
    
    // Update agent perceptions
    this.updatePerception();
    
    // Update suspicion scores
    this.updateSuspicions();
  }

  updateSuspicions() {
    const impostors = this.agents.filter(a => a.role === 'impostor' && a.alive)

    for (const agent of this.agents.filter(a => a.alive)) {
      for (const other of this.agents.filter(a => a.alive && a.id !== agent.id)) {

        // Sharing a room with someone raises mild suspicion over time
        if (agent.currentRoom === other.currentRoom) {
          // But less if they're visibly doing a task
          const doingTask = other.currentTask && other.currentTask.roomId === other.currentRoom
          const delta = doingTask ? 0.05 : 0.15
          agent.suspicions[other.name] = (agent.suspicions[other.name] || 0) + delta
        }

        // Being alone with someone is more suspicious
        const roomAgents = this.getAgentsInRoom(agent.currentRoom)
        if (roomAgents.length === 2 && roomAgents.some(a => a.id === other.id)) {
          agent.suspicions[other.name] = (agent.suspicions[other.name] || 0) + 0.3
        }
      }

      // Cap all suspicion scores at 10
      for (const name of Object.keys(agent.suspicions)) {
        agent.suspicions[name] = Math.min(10, agent.suspicions[name])
      }
    }
  }

  updatePerception() {
    for (const agent of this.agents.filter(a => a.alive)) {
      const visibleRooms = [
        agent.currentRoom,
        ...this.getAdjacentRooms(agent.currentRoom)
      ]

      for (const roomId of visibleRooms) {
        const agentsHere = this.getAgentsInRoom(roomId)
        
        for (const other of agentsHere) {
          if (other.id === agent.id) continue
        
          // See someone in same room
          if (roomId === agent.currentRoom) {
            agent.addMemory({
              tick: this.gameTick,
              type: 'saw',
              subject: other.name,
              location: roomId,
              detail: `saw ${other.name} in ${this.getRoom(roomId).name}` 
            })
          }

          // See someone doing task
          if (other.currentTask && other.currentTask.roomId === roomId) {
            agent.addMemory({
              tick: this.gameTick,
              type: 'task_witness',
              subject: other.name,
              detail: `${other.name} appeared to work in ${this.getRoom(roomId).name}` 
            })
            // Witnessing tasks lowers suspicion
            agent.suspicions[other.name] = Math.max(
              0, (agent.suspicions[other.name] || 0) - 0.5
            )
          }
        }

        // See a dead body
        if (this.getRoom(roomId).hasBody && !this.pendingMeeting) {
          agent.addMemory({
            tick: this.gameTick,
            type: 'body',
            detail: `found body of ${this.getRoom(roomId).bodyOf} in ${this.getRoom(roomId).name}` 
          })
          this.pendingMeeting = true
          this.bodyFound = this.getRoom(roomId).bodyOf
          this.logEvent('meeting', `${agent.name} found a body in ${this.getRoom(roomId).name}!`)
        }
    }
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
} // End of WorldState class

// Create global world instance
window.WORLD = new WorldState();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WorldState, WORLD: window.WORLD };
}
