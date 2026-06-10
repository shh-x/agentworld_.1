// ============================================================
// LLM CONFIG
// ============================================================
const LLM_CONFIG = {
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434/api/generate',
  model: 'llama3',
  maxTokens: 60,         // ⬇ was 150 — forces short replies
  temperature: 0.75,
}

async function callLLM(prompt) {
  try {
    const res = await fetch(LLM_CONFIG.ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_CONFIG.model,
        prompt: prompt,
        stream: false,
        options: { num_predict: LLM_CONFIG.maxTokens, temperature: LLM_CONFIG.temperature, stop: ['\n','.','!','?'] }
      })
    })
    const data = await res.json()
    return data.response.trim()
  } catch(e) {
    console.warn('[LLM] Failed:', e.message)
    return null
  }
}
window.callLLM = callLLM
window.LLM_CONFIG = LLM_CONFIG

async function callLLMStream(prompt, onChunk, onDone) {
  try {
    console.log('LLM Stream - Starting request to:', LLM_CONFIG.ollamaUrl)
    console.log('LLM Stream - Model:', LLM_CONFIG.model)
    console.log('LLM Stream - Prompt length:', prompt.length)
    
    const res = await fetch(LLM_CONFIG.ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_CONFIG.model,
        prompt: prompt,
        stream: true,
        options: {
          num_predict: LLM_CONFIG.maxTokens,
          temperature: LLM_CONFIG.temperature,
        }
      })
    })
    
    console.log('LLM Stream - Response status:', res.status, res.statusText)
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        console.log('LLM Stream - Reading complete')
        break
      }
      const lines = decoder.decode(value).split('\n').filter(Boolean)
      console.log('LLM Stream - Lines received:', lines.length)
      for (const line of lines) {
        try {
          const data = JSON.parse(line)
          console.log('LLM Stream - Data:', data)
          if (data.response) {
            fullText += data.response
            console.log('LLM Stream - Chunk received:', data.response)
            console.log('LLM Stream - Full text so far:', fullText)
            if (onChunk) onChunk(data.response, fullText)
          }
          if (data.done) { 
            console.log('LLM Stream - Stream done, final text:', fullText)
            if (onDone) onDone(fullText); 
            return fullText 
          }
        } catch(e) { 
          console.log('LLM Stream - Parse error:', e.message)
          continue 
        }
      }
    }
    if (onDone) onDone(fullText)
    return fullText
  } catch(e) {
    console.warn('[LLM STREAM] Failed:', e.message)
    if (onDone) onDone(null)
    return null
  }
}
window.callLLMStream = callLLMStream

// ============================================================
// AGENT STATEMENTS  (quick fallback lines used in Phase 1)
// ============================================================
function getAgentStatement(agent, context) {
  const aliveNames = WORLD.agents.filter(a => a.alive && a.name !== agent.name).map(a => a.name)
  const topSuspect = agent.getTopSuspect()?.[0]
  const randomName = aliveNames[Math.floor(Math.random() * aliveNames.length)]
  const deadAgent  = context.bodyFound || 'someone'

  if (agent.role === 'impostor') {
    const t = [
      `not me, i was literally just doing tasks`,
      `bro i was in ${WORLD.rooms[agent.currentRoom]?.name || 'the hall'} the whole time`,
      `why is no one talking about ${randomName} tho`,
      `i passed ${randomName} right before this happened`,
    ]
    return t[Math.floor(Math.random() * t.length)]
  }
  if (topSuspect) {
    const mem = agent.memory.find(m => m.subject === topSuspect)
    if (mem) {
      const t = [
        `${topSuspect} was with me and acted weird, sus`,
        `i literally ${mem.detail.toLowerCase()}, just saying`,
        `${topSuspect} was not doing tasks when i was there`,
      ]
      return t[Math.floor(Math.random() * t.length)]
    }
    const t = [
      `${topSuspect} sus, where were you`,
      `im not sure but ${topSuspect} was alone near there`,
      `${topSuspect} can you explain yourself`,
    ]
    return t[Math.floor(Math.random() * t.length)]
  }
  const t = [
    `i was doing tasks, i got nothing`,
    `idk man, someone talk`,
    `no clue, lets hear everyone`,
  ]
  return t[Math.floor(Math.random() * t.length)]
}
window.getAgentStatement = getAgentStatement

// ============================================================
// BUILD AGENT PROMPT  — context-driven, personality-accurate
// ============================================================
function buildAgentPrompt(agent, context, transcript) {
  const aliveNames = WORLD.agents
    .filter(a => a.alive && a.name !== agent.name)
    .map(a => a.name).join(', ')

  // ── Game Facts: surface the most important situational info ──
  const bodyVictim = context.bodyFound || 'someone'
  const bodyRoom = (() => {
    for (const room of Object.values(WORLD.rooms)) {
      if (room.hasBody || room.bodyOf === bodyVictim) return room.name
    }
    return 'unknown location'
  })()

  // ── Memories: only what the agent actually witnessed ──
  const memories = agent.memory
    .slice(0, 4)
    .map(m => `- ${m.detail}`)
    .join('\n') || '- nothing witnessed'

  // ── Top suspects from suspicion scores ──
  const suspicionEntries = Object.entries(agent.suspicions)
    .filter(([name]) => WORLD.agents.find(a => a.name === name && a.alive))
    .sort((a, b) => b[1] - a[1])
  const topSuspect = suspicionEntries[0]
  const hasSuspicion = topSuspect && topSuspect[1] > 0

  // ── Prior chat ──
  const priorChat = transcript.length > 0
    ? transcript.map(t => `${t.name}: ${t.statement}`).join('\n')
    : '(you go first — react to the body being found)'

  // ── Personality-specific Among Us style guide ──
  const p = agent.personality || { type: 'passive', trait: 'avoids conflict', voteStyle: 'follows crowd' }
  let personalityStyle = ''
  if (p.type === 'paranoid') {
    personalityStyle = `You are jumpy and quick to accuse. Examples: "who called this? self report?", "saw [name] near [room] that's sketchy", "that timing is so sus"`
  } else if (p.type === 'analytical') {
    personalityStyle = `You reason from facts and locations. Examples: "body in ${bodyRoom}, who was near there?", "i saw [name] in [room] can anyone confirm?", "[name] has no alibi"`
  } else if (p.type === 'social') {
    personalityStyle = `You check in with others. Examples: "i vouch for [name]", "who are we voting?", "anyone see anything in ${bodyRoom}?", "skip?"`
  } else if (p.type === 'deceptive') {
    personalityStyle = `You sound calm and redirect suspicion. Examples: "was doing tasks the whole time", "saw [crewmate] heading towards [room]", "not me i was with [name]"`
  } else if (p.type === 'passive') {
    personalityStyle = `You say very little. Examples: "where?", "skip", "was doing tasks", "who found it?"`
  } else if (p.type === 'aggressive') {
    personalityStyle = `You accuse fast and push for votes. Examples: "[name] sus vote them", "why were you in ${bodyRoom}?", "[name] has been quiet this whole time"`
  }

  // ── Role instruction ──
  let roleInstruction = ''
  if (agent.role === 'impostor') {
    const beingAccused = context.aliveAgents
      .filter(a => a.name !== agent.name && (a.suspicions[agent.name] || 0) > 4).length >= 2
    if (beingAccused) {
      roleInstruction = `SECRET: You are the IMPOSTOR and people suspect you. Deny it — sound genuinely confused. Deflect by pointing at a crewmate based on what was said in chat.`
    } else {
      roleInstruction = `SECRET: You are the IMPOSTOR. Sound like an innocent crewmate. Subtly redirect suspicion onto one of the crewmates using facts from the chat or game.`
    }
  } else {
    const suspectHint = hasSuspicion
      ? `Based on what you witnessed, you lean towards suspecting ${topSuspect[0]}.`
      : `You have no strong read yet — ask about the body location or who was near ${bodyRoom}.`
    roleInstruction = `You are a crewmate. ${suspectHint} Only reference what is in YOUR WITNESSED EVENTS — do NOT invent rooms, names, or actions.`
  }

  // ── Anti-repetition: show last 2 chat lines as structures to avoid ──
  const lastTwo = transcript.slice(-2).map(t => `"${t.statement.replace(/\[SUSPECT:[^\]]*\]/gi,'').trim()}"`).join('\n')
  const avoidBlock = lastTwo ? `DO NOT copy or echo these sentence structures:\n${lastTwo}` : ''

  // ── Suspect tag: must match whoever the message is about ──
  const suspectHintForTag = hasSuspicion
    ? `If your message mentions or accuses someone, end with [SUSPECT: that-same-person short-reason]. The name in [SUSPECT:] MUST be the person your message is about. Never tag someone you didn't mention.`
    : `Only add [SUSPECT: NAME reason] if your message actually talks about that person being suspicious.`

  return `AMONG US — Emergency Meeting. ${bodyVictim} was found dead in ${bodyRoom}.
You are ${agent.name}. Players still alive: ${aliveNames}

YOUR WITNESSED EVENTS (base your reply on these ONLY — do not invent anything):
${memories}

WHAT OTHERS SAID SO FAR:
${priorChat}

${roleInstruction}

YOUR STYLE (${p.type}): ${personalityStyle}

RULES:
- Write ONE message, max 12 words, all lowercase.
- Be SPECIFIC — mention a name, room, or action from your events or the chat above.
- Do NOT use generic filler. Be direct, situational, and grounded in what you actually saw.
- Do NOT repeat the wording or structure of any prior message. Write a completely different kind of sentence.
- ${avoidBlock}
- Do NOT end with "...". Vary endings: ?, !, period, or nothing.
- Do NOT start with your own name.
- ${suspectHintForTag}

${agent.name}:`
}
window.buildAgentPrompt = buildAgentPrompt

// ============================================================
// DISCUSSION SYSTEM
// ============================================================
async function displayChatMessage(agentName, message, fullText) {
  const chatMessages = document.getElementById('chat-messages')
  if (!chatMessages) return
  
  let msgEl = chatMessages.querySelector(`[data-speaker="${agentName}"]`)
  if (!msgEl) {
    msgEl = document.createElement('div')
    msgEl.setAttribute('data-speaker', agentName)
    msgEl.className = 'chat-message'
    msgEl.style.cssText = `
      margin: 8px 0;
      padding: 8px 10px;
      background: rgba(171,71,188,0.1);
      border-left: 3px solid #ab47bc;
      border-radius: 4px;
      color: #fff;
      font-size: 12px;
      line-height: 1.4;
    `
    const speaker = document.createElement('span')
    speaker.className = 'speaker'
    speaker.style.cssText = 'color: #ab47bc; font-weight: bold; display: block; margin-bottom: 4px;'
    speaker.textContent = `${agentName}:`
    msgEl.appendChild(speaker)
    
    const text = document.createElement('span')
    text.className = 'message-text'
    msgEl.appendChild(text)
    
    chatMessages.appendChild(msgEl)
  }
  
  const textSpan = msgEl.querySelector('.message-text')
  if (textSpan) textSpan.textContent = message
  
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function processAgentResponse(agentName, responseText, agentObj) {
  const suspectPattern = /\[SUSPECT:\s*([A-Z]+)\s+(.+?)\]/gi
  const deltas = {}
  
  let match
  while ((match = suspectPattern.exec(responseText)) !== null) {
    const targetName = match[1].toUpperCase()
    const reason = match[2].trim()
    
    const targetAgent = WORLD.agents.find(a => a.name.toUpperCase() === targetName)
    if (targetAgent && targetAgent.name !== agentName) {
      let confidence = 2
      if (reason.toLowerCase().includes('saw') || reason.toLowerCase().includes('witnessed')) confidence = 3
      if (reason.toLowerCase().includes('very') || reason.toLowerCase().includes('definitely')) confidence = 3
      
      agentObj.raiseSuspicion(targetAgent.name, confidence)
      deltas[targetAgent.name] = confidence
      
      WORLD.logEvent('meeting', `${agentName} suspects ${targetAgent.name} (+${confidence} → ${(agentObj.suspicions[targetAgent.name] || 0).toFixed(1)})`)
    }
  }
  
  return deltas
}

async function runDiscussion() {
  const aliveAgents = WORLD.agents.filter(a => a.alive)
  
  for (let i = 0; i < aliveAgents.length; i++) {
    const agent = aliveAgents[i]
    const context = { aliveAgents, bodyFound: WORLD.bodyFound, tick: WORLD.gameTick }
    
    const typingIndicator = document.getElementById('typing-indicator')
    if (typingIndicator) {
      typingIndicator.style.display = 'block'
      typingIndicator.innerHTML = `<span style="color:#4a6a7a;font-size:10px;">${agent.name} is typing...</span>`
    }
    
    const prompt = buildAgentPrompt(agent, context, window.meetingTranscript || [])
    let fullResponse = ''
    
    await new Promise(resolve => {
      callLLMStream(prompt,
        (chunk, fullText) => {
          fullResponse = fullText
          const displayText = fullText.replace(/\[SUSPECT:[^\]]*\]/gi, '').trim()
          displayChatMessage(agent.name, displayText)
        },
        (finalText) => {
          if (finalText) {
            processAgentResponse(agent.name, finalText, agent)
          }
          
          const cleanStatement = (finalText || '').replace(/\[SUSPECT:[^\]]*\]/gi, '').trim()
          window.meetingTranscript.push({ name: agent.name, statement: cleanStatement })
          
          resolve()
        }
      )
    })
    
    if (typingIndicator) typingIndicator.style.display = 'none'
    
    await sleep(600)
  }
  
  WORLD.logEvent('meeting', 'Discussion complete — moving to vote')
}

// ============================================================
// startChatLog — closes chat window after all responses, then votes
// ============================================================
async function startChatLog() {
  const btn = document.getElementById('chat-log-btn')
  if (btn) {
    btn.disabled = true
    btn.style.opacity = '0.5'
    btn.style.cursor = 'not-allowed'
    btn.textContent = '[ DISCUSSION IN PROGRESS ]'
  }
  
  const stmtsEl = document.getElementById('meeting-statements')
  const chatWindow = document.getElementById('chat-window')
  if (stmtsEl) stmtsEl.style.display = 'none'
  if (chatWindow) chatWindow.style.display = 'block'
  
  const status = document.getElementById('chat-log-status')
  if (status) status.textContent = 'AGENTS DISCUSSING...'
  
  // Run discussion — one message per agent
  await runDiscussion()
  
  // ── FIX: close chat, show "VOTING..." then hand off ──────
  if (status) status.textContent = 'VOTING STARTING...'
  if (btn) btn.style.display = 'none'

  // Give the player a moment to read the last message
  await sleep(1500)

  // Hide chat window before voting UI takes over
  if (chatWindow) chatWindow.style.display = 'none'

  // Now proceed to voting — this resets/populates vote-tally
  await proceedToVoting()
}

window.startChatLog = startChatLog
window.runDiscussion = runDiscussion
window.processAgentResponse = processAgentResponse
window.displayChatMessage = displayChatMessage

// ============================================================
// VOTING
// ============================================================
function getAgentVote(agent, context) {
  const validAgents = context.aliveAgents.filter(a => a.name !== agent.name)
  if (validAgents.length === 0) return { vote: null, reason: 'nobody to vote' }
  if (agent.role === 'impostor') {
    const threat = validAgents.filter(a => a.role === 'crewmate')
      .sort((a, b) => (b.suspicions[agent.name]||0) - (a.suspicions[agent.name]||0))[0]
    const vote = threat || validAgents[0]
    return { vote: vote.name, reason: 'they seem most suspicious to me' }
  }
  const sorted = [...validAgents].sort((a,b) => (agent.suspicions[b.name]||0) - (agent.suspicions[a.name]||0))
  const top    = sorted[0]
  const score  = agent.suspicions[top.name] || 0
  return { vote: top.name, reason: score>5?'strong evidence':score>2?'suspicious behavior':'gut feeling' }
}
function runMeetingVotes(aliveAgents, context) {
  return aliveAgents.map(agent => ({ voter: agent.name, ...getAgentVote(agent, context) }))
}
window.getAgentVote    = getAgentVote
window.runMeetingVotes = runMeetingVotes

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ============================================================
// MEETING SYSTEM
// ============================================================
window.meetingInProgress = false

async function displayStatement(statement) {
  const container = document.getElementById('meeting-statements')
  if (!container) return
  const el = document.createElement('div')
  el.className = 'statement'
  el.innerHTML = `<span class="speaker">${statement.name}:</span> "${statement.statement}"`
  container.appendChild(el)
  container.scrollTop = container.scrollHeight
}

async function displayVoteTally(tally) {
  const voteTallyEl = document.getElementById('vote-tally')
  if (!voteTallyEl) return null

  // ── FIX: ensure tally is visible before populating ──────
  voteTallyEl.style.display = 'block'
  voteTallyEl.innerHTML = ''

  const maxVotes = Math.max(...Object.values(tally), 1)
  Object.entries(tally).forEach(([name, count]) => {
    const item = document.createElement('div')
    item.className = 'vote-item'
    item.innerHTML = `
      <div class="vote-name">${name}</div>
      <div class="vote-bar-container"><div class="vote-bar" style="width:${(count/maxVotes)*100}%"></div></div>
      <div class="vote-count">${count} vote${count!==1?'s':''}</div>`
    voteTallyEl.appendChild(item)
  })
  await sleep(2500)
  const sorted = Object.entries(tally).sort((a,b) => b[1]-a[1])
  const isTie  = sorted.length > 1 && sorted[0][1] === sorted[1][1]
  if (isTie || sorted.length === 0) {
    const el = document.createElement('div')
    el.className = 'vote-role-reveal'
    el.innerHTML = `<div class="role-reveal-title">NO EJECTION</div><div class="role-reveal-subtitle">Votes tied — nobody ejected</div>`
    voteTallyEl.appendChild(el)
    await sleep(2000)
    return null
  }
  const [topName] = sorted[0]
  const agent = WORLD.allAgents.find(a => a.name === topName)
  if (agent) {
    const el = document.createElement('div')
    el.className = 'vote-role-reveal'
    el.innerHTML = `
      <div class="role-reveal-title">EJECTED</div>
      <div class="role-reveal-name">${agent.name}</div>
      <div class="role-reveal-role ${agent.role}">${agent.role==='impostor'?'🔴 IMPOSTOR':'🟢 CREWMATE'}</div>
      <div class="role-reveal-subtitle">${agent.role==='impostor'?'The Impostor was ejected!':'An innocent Crewmate was ejected.'}</div>`
    voteTallyEl.appendChild(el)
    await sleep(2500)
  }
  return topName
}

function ejectAgent(agentName) {
  const agent = WORLD.agents.find(a => a.name === agentName)
  if (!agent) return
  const wasImpostor = agent.role === 'impostor'
  agent.alive = false
  const room = WORLD.getRoom(agent.currentRoom)
  if (room) room.agents.delete(agent.id)
  if (window.handleAgentDeath) window.handleAgentDeath(agent)
  const rc = document.getElementById('meeting-result')
  const ep = document.getElementById('ejected-player')
  const ev = document.getElementById('ejected-verdict')
  if (rc && ep && ev) {
    ep.textContent = `💀 ${agentName} was ejected.`
    ev.textContent = wasImpostor ? '✓ They WERE the impostor.' : '✗ They were NOT the impostor.'
    rc.className   = 'meeting-result ' + (wasImpostor ? 'ejected-impostor' : 'ejected-innocent')
    rc.style.display = 'block'
  }
  WORLD.logEvent('vote', `${agentName} ejected — ${wasImpostor?'WAS impostor ✓':'was NOT impostor ✗'}`)
  document.dispatchEvent(new CustomEvent('agentDied', { detail: { agent, killer: null, room: 'meeting' } }))
}

async function proceedToVoting() {
  try {
    const aliveAgents = WORLD.agents.filter(a => a.alive)
    const context = { aliveAgents, bodyFound: WORLD.bodyFound, tick: WORLD.gameTick }
    
    const overlay = document.getElementById('meeting-overlay')
    const tallyEl = document.getElementById('vote-tally')
    const resultEl = document.getElementById('meeting-result')
    const chatWindow = document.getElementById('chat-window')
    const status = document.getElementById('chat-log-status')
    
    // Clear and reset vote display
    if (tallyEl) { tallyEl.innerHTML = ''; tallyEl.style.display = 'block' }
    if (resultEl) resultEl.style.display = 'none'
    
    // Ensure chat is hidden, overlay is still showing
    if (chatWindow) chatWindow.style.display = 'none'
    if (status) status.textContent = ''
    if (overlay) overlay.style.display = 'flex'   // ── FIX: keep overlay visible for tally
    
    WORLD.setPhase('voting')
    await sleep(800)
    
    const votes = runMeetingVotes(aliveAgents, context)
    const tally = {}
    for (const v of votes) {
      if (v.vote) tally[v.vote] = (tally[v.vote] || 0) + 1
      WORLD.logEvent('vote', `${v.voter} → ${v.vote} (${v.reason})`)
    }
    
    const ejectedName = await displayVoteTally(tally)
    await sleep(3000)
    if (ejectedName) { ejectAgent(ejectedName); await sleep(4000) }

    const winner = WORLD.checkWinCondition()
    if (winner) {
      if (overlay) overlay.style.display = 'none'
      window.meetingInProgress = false
      if (window.endGame) endGame(winner)
      return
    }

    await sleep(2000)
    if (overlay) overlay.style.display = 'none'

    WORLD.pendingMeeting = false
    WORLD.bodyFound = null
    WORLD.lastKnownDeadCount = WORLD.agents.filter(a => !a.alive).length

    for (const room of Object.values(WORLD.rooms)) { room.hasBody = false; room.bodyOf = null }
    for (const id of Object.keys(window.bodyMarkers || {})) {
      if (window.scene) window.scene.remove(window.bodyMarkers[id])
    }
    window.bodyMarkers = {}
    WORLD.setPhase('roaming')

  } catch(err) {
    console.error('[VOTING] Error:', err)
    const overlay = document.getElementById('meeting-overlay')
    if (overlay) overlay.style.display = 'none'
    WORLD.pendingMeeting = false
    WORLD.bodyFound = null
    WORLD.lastKnownDeadCount = WORLD.agents.filter(a => !a.alive).length
    if (WORLD.phase !== 'gameover') WORLD.setPhase('roaming')
  } finally {
    window.meetingInProgress = false
  }
}

window.proceedToVoting = proceedToVoting

async function triggerMeeting() {
  // Reset meeting transcript
  window.meetingTranscript = []

  // Reset chat window completely
  const chatMessages = document.getElementById('chat-messages')
  if (chatMessages) chatMessages.innerHTML = ''

  const typingIndicator = document.getElementById('typing-indicator')
  if (typingIndicator) { 
    typingIndicator.style.display = 'none'
    typingIndicator.innerHTML = ''
  }

  // Re-enable and reset the chat log button
  const btn = document.getElementById('chat-log-btn')
  if (btn) {
    btn.disabled = false
    btn.style.opacity = '1'
    btn.style.cursor = 'pointer'
    btn.textContent = '[ CHAT LOG ]'
    btn.style.display = 'block'
  }

  const status = document.getElementById('chat-log-status')
  if (status) status.textContent = 'CLICK TO OPEN COMMUNICATION LINES'

  // Hide chat window until button clicked
  const chatWindow = document.getElementById('chat-window')
  if (chatWindow) chatWindow.style.display = 'none'

  // Clear vote tally and result from previous meeting
  const tallyEl = document.getElementById('vote-tally')
  if (tallyEl) tallyEl.innerHTML = ''

  const resultEl = document.getElementById('meeting-result')
  if (resultEl) resultEl.style.display = 'none'

  if (window.meetingInProgress) return
  if (WORLD.phase === 'gameover') return
  window.meetingInProgress = true
  WORLD.pendingMeeting = false
  WORLD.setPhase('meeting')
  try {
    const aliveAgents = WORLD.agents.filter(a => a.alive)
    const context     = { aliveAgents, bodyFound: WORLD.bodyFound, tick: WORLD.gameTick }
    const overlay     = document.getElementById('meeting-overlay')
    const reasonEl    = document.getElementById('meeting-reason')
    const stmtsEl     = document.getElementById('meeting-statements')
    if (stmtsEl) {
      stmtsEl.innerHTML = ''
      stmtsEl.style.display = 'block'
    }
    if (reasonEl) reasonEl.textContent = `Body found: ${WORLD.bodyFound || 'Unknown'}`
    if (overlay)  overlay.style.display = 'flex'

    // PHASE 1: Quick initial statements
    WORLD.setPhase('discussion')
    const statements = aliveAgents.map(agent => ({ name: agent.name, statement: getAgentStatement(agent, context) }))
    for (const s of statements) {
      await displayStatement(s)
      WORLD.logEvent('meeting', `${s.name}: "${s.statement.slice(0,50)}..."`)
      await sleep(500)
    }
    await sleep(1200)
    
    // PHASE 2: Wait for user to click CHAT LOG
    // startChatLog() handles discussion + voting chain
    
  } catch(err) {
    console.error('[MEETING] Error:', err)
    const overlay = document.getElementById('meeting-overlay')
    if (overlay) overlay.style.display = 'none'
    WORLD.pendingMeeting = false
    WORLD.bodyFound = null
    WORLD.lastKnownDeadCount = WORLD.agents.filter(a => !a.alive).length
    if (WORLD.phase !== 'gameover') WORLD.setPhase('roaming')
  }
}

window.triggerMeeting = triggerMeeting

// ============================================================
// AGENT ROSTER & PERSONALITIES
// ============================================================
const AGENT_ROSTER = [
  { name:'NOVA',  color:'#ef5350' },
  { name:'AXEL',  color:'#42a5f5' },
  { name:'ZIRA',  color:'#66bb6a' },
  { name:'KAGE',  color:'#ffca28' },
  { name:'PULSE', color:'#ab47bc' },
  { name:'VERA',  color:'#26c6da' },
]
const PERSONALITIES = {
  NOVA: { type:'paranoid',   trait:'suspects everyone',   voteStyle:'votes on gut feeling' },
  AXEL: { type:'analytical', trait:'needs evidence',      voteStyle:'only votes with proof' },
  ZIRA: { type:'social',     trait:'emotional reasoning', voteStyle:'votes with majority' },
  KAGE: { type:'deceptive',  trait:'calm, deflects',      voteStyle:'frames innocent agents' },
  PULSE:{ type:'passive',    trait:'avoids conflict',     voteStyle:'follows crowd' },
  VERA: { type:'aggressive', trait:'confrontational',     voteStyle:'campaigns loudly' },
}

// ============================================================
// TASK CLASS
// ============================================================
class Task {
  constructor(id, roomId, name, secondsToComplete) {
    this.id = id; this.roomId = roomId; this.name = name
    this.secondsToComplete = secondsToComplete
    this.secondsSpent = 0; this.completedBy = null; this.isComplete = false
  }
  workOn(agentId, seconds = 1) {
    if (this.isComplete) return false
    this.secondsSpent += seconds
    if (this.secondsSpent >= this.secondsToComplete) {
      this.isComplete = true; this.completedBy = agentId; return true
    }
    return false
  }
  getProgress() { return Math.min(this.secondsSpent / this.secondsToComplete, 1) }
}

// ============================================================
// AGENT STATE CLASS
// ============================================================
class AgentState {
  constructor(id, name, color, role, startRoomId) {
    this.id=id; this.name=name; this.color=color; this.role=role
    this.alive=true; this.currentRoom=startRoomId; this.previousRoom=null
    this.path=[]; this.currentTask=null; this.assignedTasks=[]; this.completedTasks=[]
    this.memory=[]; this.suspicions={}; this.deathTick=null
    this.killCooldown=0; this.isBusy=false; this.taskProgress=0; this.idleUntil=0
    this.personality=null; this.state='idle'; this.targetPosition=null
    this.isMoving=false; this.label=null; this.mesh=null; this.avgSuspicion=0
  }
  addMemory(obs) { this.memory.unshift(obs); if(this.memory.length>10) this.memory.pop() }
  raiseSuspicion(name, amount) { this.suspicions[name] = (this.suspicions[name]||0) + amount }
  getTopSuspect() { return Object.entries(this.suspicions).sort((a,b)=>b[1]-a[1])[0] || null }
  isImpostor() { return this.role === 'impostor' }
  canKill()    { return this.isImpostor() && this.alive && this.killCooldown <= 0 }
}

// ============================================================
// ROOM STATE CLASS
// ============================================================
class RoomState {
  constructor(id, name, connectedTo) {
    this.id=id; this.name=name; this.connectedTo=connectedTo
    this.agents=new Set(); this.tasks=[]; this.hasBody=false; this.bodyOf=null
  }
  addAgent(id)    { this.agents.add(id) }
  removeAgent(id) { this.agents.delete(id) }
  getAgents()     { return Array.from(this.agents) }
  hasAgent(id)    { return this.agents.has(id) }
}

// ============================================================
// WORLD STATE CLASS
// ============================================================
class WorldState {
  constructor() {
    this.rooms={}; this.agents=[]; this.allAgents=[]
    this.gameTick=0; this.phase='idle'; this.winner=null; this.events=[]
    this.pendingMeeting=false; this.bodyFound=null
    this.lastKnownDeadCount=0
    this.initializeWorld()
    this.setupEventListeners()
  }

  initializeWorld() {
    const conn = {
      cafeteria: ['reactor','security','admin'], reactor: ['cafeteria','medbay'],
      medbay: ['reactor','security'], security: ['cafeteria','medbay','electrical'],
      electrical: ['security','storage'], storage: ['electrical','admin'], admin: ['cafeteria','storage']
    }
    Object.keys(conn).forEach(id => {
      const name = id.charAt(0).toUpperCase()+id.slice(1)
      this.rooms[id] = new RoomState(id, name, conn[id])
    })
    this.initializeTasks()
    this.logEvent('system','World initialized')
  }

  spawnAgents() {
    this.agents=[]; this.allAgents=[]
    const impostorCount = window.GAME_CONFIG?.IMPOSTOR_COUNT ?? 1
    const tasksPerAgent = window.GAME_CONFIG?.TASKS_PER_AGENT ?? 5
    const indices = Array.from({length:AGENT_ROSTER.length},(_,i)=>i)
    const impostorIndices = []
    for(let i=0;i<impostorCount;i++) {
      const ri = Math.floor(Math.random()*indices.length)
      impostorIndices.push(indices.splice(ri,1)[0])
    }
    AGENT_ROSTER.forEach((data,index) => {
      const role  = impostorIndices.includes(index) ? 'impostor' : 'crewmate'
      const agent = new AgentState(index, data.name, data.color, role, 'cafeteria')
      agent.personality = PERSONALITIES[data.name]
      if(role==='crewmate') this.assignTasksToAgent(agent, tasksPerAgent)
      else { this.assignFakeTasksToAgent(agent, tasksPerAgent); agent.killCooldown=15 }
      this.agents.push(agent)
      this.rooms['cafeteria'].addAgent(agent.id)
      if(window.spawnAgentMesh) window.spawnAgentMesh(agent)
    })
    this.allAgents = [...this.agents]
    this.updateAgentPanel(); this.updateTaskHUD()
    this.logEvent('system',`Spawned ${this.agents.length} agents (${impostorCount} impostor)`)
  }

  assignTasksToAgent(agent, count) {
    const allTasks=[]; Object.values(this.rooms).forEach(r=>allTasks.push(...r.tasks))
    const available=allTasks.filter(t=>!t.isComplete); const assigned=[]
    for(let i=0;i<count&&available.length>0;i++) {
      const ri=Math.floor(Math.random()*available.length)
      assigned.push(available.splice(ri,1)[0])
    }
    agent.assignedTasks=assigned
  }

  assignFakeTasksToAgent(agent, count) {
    const names=['Fix Wiring','Start Reactor','Submit Scan','Check Cameras','Reset Breakers']
    const roomIds=Object.keys(this.rooms)
    agent.assignedTasks=[]
    for(let i=0;i<count;i++) {
      agent.assignedTasks.push({
        id:`fake_${agent.id}_${i}`, name:names[i%names.length],
        roomId:roomIds[Math.floor(Math.random()*roomIds.length)],
        isComplete:false, isFake:true, getProgress:()=>0, workOn:()=>false
      })
    }
  }

  findPath(fromId, toId) {
    if(fromId===toId) return [fromId]
    const visited=new Set([fromId]), queue=[{room:fromId,path:[fromId]}]
    while(queue.length>0) {
      const {room,path}=queue.shift()
      for(const next of (this.rooms[room]?.connectedTo||[])) {
        if(next===toId) return [...path,next]
        if(!visited.has(next)) { visited.add(next); queue.push({room:next,path:[...path,next]}) }
      }
    }
    return []
  }

  decideDestination(agent) {
    if(agent.role==='crewmate') {
      const next=agent.assignedTasks.find(t=>!t.isComplete&&t.roomId!==agent.currentRoom)
      if(next) return next.roomId
      const rooms=Object.keys(this.rooms).filter(r=>r!==agent.currentRoom)
      return rooms[Math.floor(Math.random()*rooms.length)]
    }
    if(agent.role==='impostor') {
      const target=Object.values(this.rooms)
        .filter(r=>r.id!==agent.currentRoom)
        .map(r=>({id:r.id,crew:r.getAgents().map(id=>this.agents.find(a=>a.id===id)).filter(a=>a&&a.alive&&a.role==='crewmate').length}))
        .sort((a,b)=>b.crew-a.crew)[0]
      return target?target.id:Object.keys(this.rooms).filter(r=>r!==agent.currentRoom)[0]
    }
    return 'cafeteria'
  }

  moveAgent(agent) {
    if(!agent.alive||agent.isBusy||this.gameTick<agent.idleUntil) return
    if(!agent.path||agent.path.length===0) {
      const dest=this.decideDestination(agent); if(!dest) return
      const path=this.findPath(agent.currentRoom,dest)
      if(!path||path.length<=1) return
      agent.path=path.slice(1)
    }
    if(agent.path.length===0) return
    const nextRoom=agent.path.shift()
    this.rooms[agent.currentRoom]?.agents.delete(agent.id)
    agent.previousRoom=agent.currentRoom; agent.currentRoom=nextRoom
    this.rooms[nextRoom]?.agents.add(agent.id)
    if(window.getRoomPosition) {
      const pos=window.getRoomPosition(nextRoom)
      if(pos&&window.THREE) {
        const ox=(Math.random()-0.5)*2, oz=(Math.random()-0.5)*2
        agent.targetPosition=new window.THREE.Vector3(pos.x+ox,0.8,pos.z+oz)
        agent.isMoving=true
      }
    }
    if(agent.path.length===0) agent.idleUntil=this.gameTick+Math.floor(Math.random()*3)+2
  }

  processTasks() {
    for(const agent of this.agents.filter(a=>a.alive)) {
      if(agent.isBusy&&agent.currentTask) {
        agent.taskProgress+=1
        if(window.updateAgentProgressBar) window.updateAgentProgressBar(agent.id,agent.currentTask.getProgress())
        const done=agent.currentTask.workOn(agent.id,1)
        if(done) {
          const taskName=agent.currentTask.name
          const roomName=this.getRoom(agent.currentRoom)?.name||agent.currentRoom
          agent.completedTasks.push(agent.currentTask)
          agent.assignedTasks=agent.assignedTasks.filter(t=>t.id!==agent.currentTask.id)
          agent.currentTask=null; agent.taskProgress=0; agent.isBusy=false; agent.state='idle'
          if(window.hideAgentProgressBar) window.hideAgentProgressBar(agent.id)
          this.logEvent('task',`${agent.name} completed ${taskName} in ${roomName}`)
          document.dispatchEvent(new CustomEvent('taskDone',{detail:{agent}}))
          this.updateTaskHUD()
        }
        continue
      }
      if(agent.isBusy) continue
      const myTask=agent.assignedTasks.find(t=>!t.isComplete&&!t.isFake&&t.roomId===agent.currentRoom)
      if(myTask) {
        agent.currentTask=myTask; agent.taskProgress=0; agent.isBusy=true; agent.state='working'
        if(window.showAgentProgressBar) window.showAgentProgressBar(agent.id)
        this.logEvent('task',`${agent.name} started ${myTask.name} in ${this.getRoom(agent.currentRoom)?.name}`)
      }
    }
  }

  processKills() {
    for(const imp of this.agents.filter(a=>a.role==='impostor'&&a.alive)) {
      if(imp.killCooldown>0) continue
      const targets=this.getAgentsInRoom(imp.currentRoom).filter(a=>a.role==='crewmate'&&a.alive)
      if(targets.length===0) continue
      const victim=targets[Math.floor(Math.random()*targets.length)]
      victim.alive=false; imp.killCooldown=45
      this.rooms[imp.currentRoom].hasBody=true
      this.rooms[imp.currentRoom].bodyOf=victim.name
      if(window.handleAgentDeath) window.handleAgentDeath(victim)
      this.logEvent('kill',`${imp.name} killed ${victim.name} in ${this.rooms[imp.currentRoom].name}`)
      if(!this.pendingMeeting&&this.phase==='roaming') {
        this.pendingMeeting=true; this.bodyFound=victim.name
      }
      this.getAgentsInRoom(imp.currentRoom)
        .filter(a=>a.alive&&a.id!==imp.id&&a.id!==victim.id)
        .forEach(w=>{
          w.addMemory({tick:this.gameTick,type:'witnessed_kill',subject:imp.name,detail:`SAW ${imp.name} kill ${victim.name}`})
          w.raiseSuspicion(imp.name,8)
        })
      for(const rId of this.getAdjacentRooms(imp.currentRoom)) {
        for(const a of this.getAgentsInRoom(rId)) {
          if(!a.alive) continue
          a.addMemory({tick:this.gameTick,type:'heard',detail:`heard something near ${this.rooms[imp.currentRoom].name}`})
          a.raiseSuspicion(imp.name,1.5)
        }
      }
      document.dispatchEvent(new CustomEvent('agentDied',{detail:{agent:victim,killer:imp,room:imp.currentRoom}}))
      return
    }
  }

  updateSuspicions() {
    for(const agent of this.agents.filter(a=>a.alive)) {
      for(const other of this.agents.filter(a=>a.alive&&a.id!==agent.id)) {
        if(agent.currentRoom===other.currentRoom) {
          const doingTask=other.currentTask&&other.currentTask.roomId===other.currentRoom
          agent.suspicions[other.name]=(agent.suspicions[other.name]||0)+(doingTask?0.05:0.15)
        }
        const roomAgents=this.getAgentsInRoom(agent.currentRoom)
        if(roomAgents.length===2&&roomAgents.some(a=>a.id===other.id))
          agent.suspicions[other.name]=(agent.suspicions[other.name]||0)+0.2
      }
      for(const name of Object.keys(agent.suspicions)) agent.suspicions[name]=Math.min(10,agent.suspicions[name])
    }
  }

  updatePerception() {
    for(const agent of this.agents.filter(a=>a.alive)) {
      const visibleRooms=[agent.currentRoom,...this.getAdjacentRooms(agent.currentRoom)]
      for(const roomId of visibleRooms) {
        for(const other of this.getAgentsInRoom(roomId)) {
          if(other.id===agent.id) continue
          if(roomId===agent.currentRoom)
            agent.addMemory({tick:this.gameTick,type:'saw',subject:other.name,detail:`saw ${other.name} in ${this.getRoom(roomId).name}`})
          if(other.currentTask&&other.currentTask.roomId===roomId)
            agent.suspicions[other.name]=Math.max(0,(agent.suspicions[other.name]||0)-0.3)
        }
        if(this.getRoom(roomId)?.hasBody)
          agent.addMemory({tick:this.gameTick,type:'body',detail:`found body of ${this.getRoom(roomId).bodyOf} in ${this.getRoom(roomId).name}`})
      }
    }
  }

  updateSuspicionVisuals() {
    for(const agent of this.agents.filter(a=>a.alive)) {
      const others=this.agents.filter(a=>a.alive&&a.id!==agent.id)
      const total=others.reduce((s,a)=>s+(a.suspicions[agent.name]||0),0)
      agent.avgSuspicion=others.length>0?total/others.length:0
      const mesh=window.agentMeshes?.[agent.id]
      if(mesh) {
        const glowRing=mesh.children.find(c=>c.userData?.isGlowRing)
        if(glowRing) {
          if(agent.avgSuspicion>5) { glowRing.material.color.setHex(0xff0000); glowRing.userData.pulseSpeed=0.006 }
          else { glowRing.material.color.set(agent.color); glowRing.userData.pulseSpeed=0.002 }
        }
      }
    }
  }

  async tick() {
    if(this.phase==='meeting'||this.phase==='voting'||this.phase==='discussion'||this.phase==='gameover') return
    if(window.meetingInProgress) return

    this.gameTick++
    this.agents.filter(a=>a.role==='impostor'&&a.alive).forEach(imp=>{ if(imp.killCooldown>0) imp.killCooldown-- })
    this.agents.filter(a=>a.alive).forEach(a=>this.moveAgent(a))
    this.processTasks()
    this.processKills()
    this.updatePerception()
    this.updateSuspicions()
    this.updateSuspicionVisuals()

    const currentDeadCount = this.agents.filter(a=>!a.alive).length
    if(currentDeadCount > this.lastKnownDeadCount && !window.meetingInProgress && this.phase === 'roaming') {
      if(!this.bodyFound) {
        const deadAgents = this.agents.filter(a => !a.alive)
        if(deadAgents.length > 0) {
          this.bodyFound = deadAgents[deadAgents.length - 1].name
        }
      }
      const winnerPre = this.checkWinCondition()
      if(winnerPre) { if(window.endGame) endGame(winnerPre); return }
      await triggerMeeting()
      const winnerPost = this.checkWinCondition()
      if(winnerPost) { if(window.endGame) endGame(winnerPost); return }
      return
    }

    const winner = this.checkWinCondition()
    if(winner) { if(window.endGame) endGame(winner); return }

    this.updateAgentPanel()
    this.updateTaskHUD()
  }

  initializeTasks() {
    Object.values(this.rooms).forEach(r=>{ r.tasks=[] })
    const taskDefs = {
      cafeteria:{name:'Fix Wiring',secs:5}, reactor:{name:'Start Reactor',secs:8},
      medbay:{name:'Submit Scan',secs:4}, security:{name:'Check Cameras',secs:4},
      electrical:{name:'Reset Breakers',secs:6}, storage:{name:'Fuel Engines',secs:5},
      admin:{name:'Swipe Card',secs:3}
    }
    const impostorCount=window.GAME_CONFIG?.IMPOSTOR_COUNT??1
    const tasksPerAgent=window.GAME_CONFIG?.TASKS_PER_AGENT??5
    const totalNeeded=(AGENT_ROSTER.length-impostorCount)*tasksPerAgent+10
    const roomIds=Object.keys(taskDefs); let taskId=0
    for(let i=0;i<totalNeeded;i++) {
      const roomId=roomIds[taskId%roomIds.length], def=taskDefs[roomId]
      this.rooms[roomId].tasks.push(new Task(taskId++,roomId,def.name,def.secs))
    }
  }

  getTotalTasks()    { let t=0; Object.values(this.rooms).forEach(r=>t+=r.tasks.length); return t }
  getCompletedTasks(){ let d=0; Object.values(this.rooms).forEach(r=>d+=r.tasks.filter(t=>t.isComplete).length); return d }

  checkWinCondition() {
    if(this.phase==='gameover') return this.winner
    const alive=this.agents.filter(a=>a.alive)
    const aliveImp=alive.filter(a=>a.isImpostor())
    const aliveCrew=alive.filter(a=>!a.isImpostor())
    const total=this.getTotalTasks(), done=this.getCompletedTasks()
    if(total>0&&done>=total) { this.winner='crewmates'; this.phase='gameover'; this.logEvent('victory','Crewmates win — all tasks done!'); return 'crewmates' }
    if(aliveImp.length===0)  { this.winner='crewmates'; this.phase='gameover'; this.logEvent('victory','Crewmates win — impostor eliminated!'); return 'crewmates' }
    if(aliveImp.length>=aliveCrew.length) { this.winner='impostors'; this.phase='gameover'; this.logEvent('victory','Impostors win!'); return 'impostors' }
    return null
  }

  setPhase(newPhase) {
    const old=this.phase; this.phase=newPhase; this.updatePhaseHUD(newPhase)
    document.dispatchEvent(new CustomEvent('phaseChange',{detail:{oldPhase:old,newPhase,tick:this.gameTick}}))
  }

  setupEventListeners() {
    document.addEventListener('agentDied',()=>{ this.updateAgentPanel(); this.updateSuspicionVisuals() })
    document.addEventListener('taskDone', ()=>{ this.updateTaskHUD() })
  }

  updatePhaseHUD(phase) {
    const el=document.getElementById('phase-display'); if(!el) return
    const labels={idle:'IDLE',roaming:'ROAMING',meeting:'MEETING',discussion:'DISCUSSION',voting:'VOTING',gameover:this.winner?`${this.winner.toUpperCase()} WIN`:'GAME OVER'}
    el.textContent=labels[phase]||phase.toUpperCase()
    el.className='phase-pill '+(phase==='meeting'||phase==='discussion'?'meeting':phase==='voting'?'voting':phase==='gameover'?'gameover':'roaming')
  }

  updateAgentPanel() {
    const panel=document.getElementById('agent-cards'); if(!panel) return
    panel.innerHTML=''
    const alive=this.agents.filter(a=>a.alive), dead=this.agents.filter(a=>!a.alive)
    for(const agent of [...alive,...dead]) {
      const card=document.createElement('div')
      card.className=`agent-card ${agent.alive?'':'dead'}`
      card.setAttribute('data-agent-id',agent.id)
      const showRole=!agent.alive||this.phase==='gameover'
      const roleLabel=showRole?agent.role.toUpperCase():'CREW'
      const roleClass=showRole&&agent.role==='impostor'?'impostor':'crewmate'
      const totalAssigned=agent.assignedTasks.length+agent.completedTasks.length
      const tasksDone=agent.completedTasks.length
      const taskPct=totalAssigned>0?(tasksDone/totalAssigned)*100:0
      const avgSusp=agent.avgSuspicion||0
      const suspColor=avgSusp>8?'#ef5350':avgSusp>5?'#ff9800':'#4caf50'
      card.innerHTML=`
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <span style="width:10px;height:10px;border-radius:50%;background:${agent.color};opacity:${agent.alive?1:0.4};display:inline-flex;align-items:center;justify-content:center;font-size:7px;color:#000;font-weight:bold;">${agent.alive?'':'✕'}</span>
          <span style="font-weight:bold;font-size:11px;color:${agent.alive?'#fff':'#555'};flex:1;">${agent.name}</span>
          <span style="padding:1px 5px;border-radius:3px;font-size:8px;font-weight:bold;background:${roleClass==='impostor'?'rgba(255,0,0,0.25)':'rgba(0,255,0,0.15)'};color:${roleClass==='impostor'?'#ff5252':'#69f0ae'};border:1px solid ${roleClass==='impostor'?'rgba(255,0,0,0.5)':'rgba(0,255,0,0.3)'};">${roleLabel}</span>
        </div>
        ${agent.alive?`
          <div style="margin-bottom:4px;">
            <div style="display:flex;justify-content:space-between;font-size:9px;color:#8ab4c4;margin-bottom:2px;"><span>TASKS</span><span>${tasksDone}/${totalAssigned}</span></div>
            <div style="height:4px;background:#1a2a3a;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${taskPct}%;background:#00e5ff;border-radius:2px;transition:width 0.5s;"></div></div>
          </div>
          <div style="margin-bottom:4px;">
            <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px;"><span style="color:#8ab4c4;">SUSP</span><span style="color:${suspColor};">${avgSusp.toFixed(1)}</span></div>
            <div style="height:6px;background:#1a2a3a;border-radius:3px;overflow:hidden;position:relative;">
              <div style="position:absolute;left:0;top:0;width:60%;height:100%;background:#4caf50;opacity:0.2;"></div>
              <div style="position:absolute;left:60%;top:0;width:20%;height:100%;background:#ff9800;opacity:0.2;"></div>
              <div style="position:absolute;left:80%;top:0;width:20%;height:100%;background:#f44336;opacity:0.2;"></div>
              ${avgSusp<=6?`<div style="position:absolute;left:0;top:0;width:${(avgSusp/10)*100}%;height:100%;background:#4caf50;transition:width 0.5s;"></div>`
              :avgSusp<=8?`<div style="position:absolute;left:0;top:0;width:60%;height:100%;background:#4caf50;"></div><div style="position:absolute;left:60%;top:0;width:${((avgSusp-6)/2)*20}%;height:100%;background:#ff9800;"></div>`
              :`<div style="position:absolute;left:0;top:0;width:60%;height:100%;background:#4caf50;"></div><div style="position:absolute;left:60%;top:0;width:20%;height:100%;background:#ff9800;"></div><div style="position:absolute;left:80%;top:0;width:${((avgSusp-8)/2)*20}%;height:100%;background:#f44336;"></div>`}
            </div>
          </div>
          ${agent.role==='impostor'?`
            <div style="margin-bottom:4px;">
              <div style="display:flex;justify-content:space-between;font-size:9px;margin-bottom:2px;"><span style="color:#8ab4c4;">KILL CD</span><span style="color:${agent.killCooldown>0?'#f44336':'#4caf50'};">${agent.killCooldown>0?agent.killCooldown+'s':'READY'}</span></div>
              <div style="height:4px;background:#1a2a3a;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${agent.killCooldown>0?((45-agent.killCooldown)/45)*100:100}%;background:${agent.killCooldown>0?'#f44336':'#4caf50'};transition:width 0.5s;"></div></div>
            </div>`:''}
          <div style="font-size:9px;color:#00e5ff;margin-top:2px;">📍 ${this.rooms[agent.currentRoom]?.name||'?'}</div>
        `:`<div style="font-size:9px;color:#444;margin-top:4px;">☠ eliminated — ${this.rooms[agent.currentRoom]?.name||'?'}${showRole&&agent.role==='impostor'?'<span style="color:#ef5350;"> — WAS IMPOSTOR</span>':''}</div>`}
      `
      panel.appendChild(card)
    }
  }

  updateTaskHUD() {
    const total=this.getTotalTasks(), done=this.getCompletedTasks()
    const taskEl=document.getElementById('task-counter')
    const aliveEl=document.getElementById('alive-counter')
    const roundEl=document.getElementById('round-counter')
    if(taskEl)  taskEl.textContent=`${done}/${total}`
    if(aliveEl) aliveEl.textContent=`${this.agents.filter(a=>a.alive).length}/${this.agents.length}`
    if(roundEl) roundEl.textContent=String(this.gameTick).padStart(2,'0')
  }

  advanceTick() {}
  getRoom(id)  { return this.rooms[id]||null }
  getAgentsInRoom(roomId) {
    const room=this.getRoom(roomId); if(!room) return []
    return room.getAgents().map(id=>this.agents.find(a=>a.id===id)).filter(a=>a&&a.alive)
  }
  getAdjacentRooms(roomId) { return this.getRoom(roomId)?.connectedTo||[] }

  logEvent(type,message) {
    this.events.push({tick:this.gameTick,type,message})
    if(this.events.length>500) this.events=this.events.slice(-300)
    this.addLog(message,type)
  }

  addLog(message,type='system') {
    const log=document.querySelector('#event-log-container')||document.querySelector('.event-log')
    if(!log) return
    const time=new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit'})
    const colorMap={kill:'#ff4444',meeting:'#cc88ff',vote:'#ffcc00',task:'#00cc66',system:'#2a4a5a',victory:'#ffcc00'}
    const item=document.createElement('div')
    item.className='event-item'
    item.innerHTML=`<span class="event-time">${time}</span><span style="color:${colorMap[type]||'#8ab4c4'}">${message}</span>`
    log.appendChild(item); log.scrollTop=log.scrollHeight
    while(log.children.length>80) log.removeChild(log.firstChild)
  }

  startMeeting(){} startVoting(){} resolveVoting(){} killAgent(){} reportBody(){} completeTask(){}
}

window.WORLD = new WorldState()
if(typeof module!=='undefined'&&module.exports) module.exports={WorldState,WORLD:window.WORLD}