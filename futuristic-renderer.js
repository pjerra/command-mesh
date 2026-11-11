const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]))
const stations = ['you','model','memory','files','shell','web','browser','agents','skills','hooks']
const names = ['Operator','Model','Memory','Files','Terminal','Network','Browser','Agents','Skills','Hooks']
// One color per agent, used everywhere that agent shows up: cores, cards, routes, packets, ticker.
const PROVIDERS = ['claude','codex','omp']
const COLORS = { claude: '#ff9d6b', codex: '#a28aff', omp: '#53f4dd' }
const RED = '#ff728f', IDLE = '#506b85', OFF = '#2b3d4e'
// Labels that mean an agent finished a turn. They trigger the shockwave on that agent's core.
const TURN_END = / working$|answer ready|turn complete/i
const normalizeProvider = value => {
  const provider = String(value || '').toLowerCase()
  if (provider.includes('claude')) return 'claude'
  if (provider.includes('codex') || provider.includes('chatgpt')) return 'codex'
  if (provider.includes('omp')) return 'omp'
  return ''
}
const providerFor = entry => {
  const explicit = normalizeProvider(entry.provider)
  if (explicit) return explicit
  if (String(entry.id || '').startsWith('codex-') || /codex|chatgpt/i.test(String(entry.detail?.kind || ''))) return 'codex'
  if (String(entry.id || '').startsWith('omp-')) return 'omp'
  return 'claude'
}
const hexPath = (x, y, radius) => Array.from({ length: 6 }, (_, index) => {
  const angle = Math.PI / 3 * index - Math.PI / 2
  return `${index ? 'L' : 'M'}${(x + Math.cos(angle) * radius).toFixed(1)} ${(y + Math.sin(angle) * radius).toFixed(1)}`
}).join(' ') + 'Z'
const credits = value => {
  const n = Number(value) || 0
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)
}
// The SVG is rebuilt every frame, so one-shot effects use a negative delay equal to their age.
// The browser then resumes each animation exactly where the previous frame left it.
const since = ms => `animation-delay:${(-ms / 1000).toFixed(3)}s`

// present: the agent's process is running (or it was active in the last two minutes).
// offline: the extension's process check says it is not running. unknown: no recent check.
function presenceOf(board, provider, entries, now) {
  if (entries.some(e => providerFor(e) === provider && now - (e.endedAt || e.startedAt || 0) < 120000)) return 'present'
  const presence = board.presence
  if (!presence || now - Number(presence.at || 0) > 75000) return 'unknown'
  return presence[provider] ? 'present' : 'offline'
}

function drawMap(board, now) {
  const entries = board.entries || []
  const active = entries.filter(e => e.status === 'run')
  const cyan = '#53f4dd', violet = '#a28aff'
  let body = `<style>@keyframes orbit{to{transform:rotate(360deg)}}@keyframes reactor{50%{opacity:.35}}@keyframes corePulse{50%{opacity:.35;transform:scale(1.12)}}@keyframes stream{to{stroke-dashoffset:-48}}@keyframes nodePulse{50%{opacity:.8}}.stream{animation:stream 1.2s linear infinite;animation-delay:-${(now%1200)/1000}s}.node-pulse{animation:nodePulse 2s ease-in-out infinite;animation-delay:-${(now%2000)/1000}s}.provider-pulse{transform-box:fill-box;transform-origin:center;animation:corePulse 1.8s ease-in-out infinite;animation-delay:-${(now%1800)/1000}s}.sweep{animation-duration:18s;animation-delay:-${(now%18000)/1000}s}.inner-orbit{animation-duration:9s;animation-delay:-${(now%9000)/1000}s}.orbit{transform-origin:450px 285px;animation:orbit 24s linear infinite;animation-delay:-${(now%24000)/1000}s}.counter{animation-direction:reverse;animation-duration:36s;animation-delay:-${(now%36000)/1000}s}.reactor{animation:reactor 2.4s ease-in-out infinite;animation-delay:-${(now%2400)/1000}s}`
    + `@keyframes breathe{0%,100%{opacity:.03}50%{opacity:.15}}.breathe{animation:breathe 4.8s ease-in-out infinite}`
    + `@keyframes shock{0%{transform:scale(.6);opacity:.95;stroke-width:3.5}100%{transform:scale(3.2);opacity:0;stroke-width:.3}}.shock{transform-box:fill-box;transform-origin:center;animation:shock 1.5s cubic-bezier(.15,.7,.3,1) both}`
    + `@keyframes flashOut{0%{opacity:.6}100%{opacity:0}}.flash{animation:flashOut 1.2s ease-out both}`
    + `@keyframes glitch{0%,100%{transform:translate(0,0)}12%{transform:translate(-3px,1px)}25%{transform:translate(3px,-1px)}37%{transform:translate(-2px,-1px)}50%{transform:translate(2px,1px)}62%{transform:translate(-1px,0)}75%{transform:translate(0,0)}}.glitch{animation:glitch .5s steps(2,end) 3 both}`
    + `@keyframes glitchFlash{0%,30%,60%{opacity:.45}15%,45%,75%{opacity:.04}100%{opacity:0}}.glitch-flash{animation:glitchFlash 1.5s linear both}`
    + `@keyframes floatUp{0%{transform:translateY(4px);opacity:0}15%{opacity:1}100%{transform:translateY(-26px);opacity:0}}.float-up{animation:floatUp 2.6s ease-out both}`
    + `@keyframes blink{50%{opacity:0}}.cursor{animation:blink 1s steps(1) infinite;animation-delay:-${(now%1000)/1000}s}`
    + `@media(prefers-reduced-motion:reduce){.orbit,.reactor,.stream,.node-pulse,.provider-pulse,.breathe,.glitch,.cursor{animation:none}.moving-packets,.sweep,.shock,.flash,.glitch-flash,.float-up{display:none}}</style>`
    + `<defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#162638" stroke-width=".5"/></pattern><radialGradient id="aura"><stop stop-color="#125252" stop-opacity=".48"/><stop offset="1" stop-color="#07101c" stop-opacity="0"/></radialGradient><filter id="glow"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="900" height="570" rx="16" fill="#080e19"/><rect width="900" height="570" fill="url(#grid)" opacity=".6"/><ellipse cx="450" cy="285" rx="260" ry="250" fill="url(#aura)"/><g font-family="Consolas,monospace"><text x="26" y="30" fill="#768ba4" font-size="10" letter-spacing="2">NEURAL TOPOLOGY / ${String(stations.length).padStart(2,'0')} NODES</text><text x="874" y="30" text-anchor="end" fill="${active.length ? COLORS[providerFor(active.at(-1))] : '#768ba4'}" font-size="10">${active.length ? active.length + ' ACTIVE' : 'STANDBY'}</text>`
  body += `<style>.station-card{cursor:pointer;outline:none}.station-card rect:first-of-type{transition:fill .18s,stroke .18s,filter .18s}.station-card:hover rect:first-of-type,.station-card:focus rect:first-of-type{fill:#12283a;stroke:#53f4dd;filter:url(#glow)}.station-card.selected rect:first-of-type{fill:#112e38;stroke:#53f4dd;stroke-width:2;filter:url(#glow)}</style>`
  for (const r of [90,111,166,218]) body += `<circle cx="450" cy="285" r="${r}" fill="none" stroke="${r===111?violet:'#244052'}" opacity="${r===111?'.6':'.5'}" stroke-dasharray="${r===111?'65 12 3 12':'2 7'}"/>`
  body += `<g class="orbit"><circle cx="450" cy="285" r="101" fill="none" stroke="${cyan}" stroke-width="2" stroke-dasharray="55 580"/><circle cx="450" cy="184" r="3" fill="${cyan}"/><circle cx="450" cy="386" r="2" fill="${cyan}"/></g><g class="orbit counter"><circle cx="450" cy="285" r="153" fill="none" stroke="${violet}" stroke-width="1.5" stroke-dasharray="80 220 15 646"/><circle cx="603" cy="285" r="3" fill="${violet}"/></g><circle class="reactor" cx="450" cy="285" r="83" fill="none" stroke="${cyan}" stroke-width="5" opacity=".15"/>`
  // Slow sensor sweep and a faster inner rotor add depth without moving the labels.
  body += `<g class="orbit sweep" opacity=".32"><path d="M450 285L450 72A213 213 0 0 1 551 97Z" fill="url(#aura)"/><path d="M450 285V72" stroke="${cyan}" opacity=".25"/><circle cx="450" cy="72" r="2" fill="${cyan}"/></g><g class="orbit inner-orbit"><circle cx="450" cy="285" r="87" fill="none" stroke="${violet}" stroke-width="3" stroke-dasharray="14 77" opacity=".6"/></g>`
  for(let tick=0;tick<60;tick++) {
    const angle=tick*Math.PI/30, major=tick%5===0, r=major?197:202
    body += `<line x1="${450+Math.sin(angle)*r}" y1="${285-Math.cos(angle)*r}" x2="${450+Math.sin(angle)*208}" y2="${285-Math.cos(angle)*208}" stroke="${major?violet:'#385467'}" stroke-width="${major?1.5:1}" opacity=".5"/>`
  }
  body += `<path d="M450 55V72M450 498V515M220 285H237M663 285H680" stroke="${cyan}" opacity=".7"/>`

  stations.forEach((station,i)=>{
    const left=i<5, row=i%5, x=left?24:684, y=66+row*94, edge=left?216:684, end=left?350:550
    const events=entries.filter(e=>e.station===station || station==='web'&&e.station==='network')
    const last=events.at(-1)
    const runningEvents=events.filter(e=>e.status==='run'), running=runningEvents.length>0
    const runProviders=[...new Set(runningEvents.map(providerFor))]
    const lastProvider=last ? providerFor(last) : ''
    const bad=last && ['err','block'].includes(last.status)
    // tone: whose color this station wears right now. color: tone, unless it errored or is idle.
    const tone=running ? COLORS[runProviders.at(-1)] : last ? COLORS[lastProvider] : IDLE
    const color=bad ? RED : running ? tone : IDLE
    const count=board.counts?.[station]??events.length
    const route=`M${edge} ${y+34}H${left?260:640}L${end} 285`
    body += `<path d="${route}" fill="none" stroke="${color}" stroke-width="${running?1.5:.7}" opacity="${running?.8:.3}"/>`
    const recentlyFinished = last?.endedAt && now-last.endedAt>=0 && now-last.endedAt<3000
    if(running || recentlyFinished) {
      const returning=!running
      // Several agents on one station: their packets take turns on the same route.
      const packetColors=running ? runProviders.map(p=>COLORS[p]) : [COLORS[lastProvider] || violet]
      body += `<path class="stream" d="${route}" fill="none" stroke="${packetColors[0]}" stroke-dasharray="3 21" stroke-width="2" opacity=".65" style="animation-direction:${returning?'reverse':'normal'}"/>`
      body += '<g class="moving-packets">'
      for(let packet=0;packet<3;packet++) {
        const phase=((now+i*190+packet*800)%2400)/1000, c=packetColors[packet % packetColors.length]
        const motion=`<animateMotion begin="-${phase}s" dur="2.4s" repeatCount="indefinite" keyPoints="${returning?'1;0':'0;1'}" keyTimes="0;1" calcMode="linear" path="${route}"/>`
        body += `<circle r="7" fill="${c}" opacity=".22" filter="url(#glow)">${motion}</circle><circle r="2.5" fill="${returning?c:'#eafffb'}">${motion}</circle>`
      }
      body += '</g>'
      body += `<rect class="node-pulse" x="${x-3}" y="${y-3}" width="198" height="76" rx="8" fill="none" stroke="${packetColors[0]}" opacity=".2"/>`
    }
    // A failed tool shakes its card and flashes it red for 1.5 s.
    const failAge=bad ? now-(last.endedAt||last.startedAt||0) : -1
    const glitching=failAge>=0 && failAge<1500
    // Pips: which agents have used this station (dim) and which are using it now (bright).
    let pips=''
    PROVIDERS.forEach((p,k)=>{
      const used=events.some(e=>providerFor(e)===p), on=runProviders.includes(p)
      pips += `<circle cx="${x+158+k*11}" cy="${y+49}" r="${on?3.3:2.4}" fill="${used?COLORS[p]:'#22364a'}" opacity="${used?(on?1:.5):1}"${on?' filter="url(#glow)"':''}/>${on?`<circle cx="${x+158+k*11}" cy="${y+49}" r="2.2" fill="${COLORS[p]}"/>`:''}`
    })
    const dot=bad ? RED : last ? COLORS[lastProvider] : IDLE
    body += `<g class="station-card" data-station="${station}" role="button" tabindex="0" aria-label="Filter events by ${names[i]}"><g${glitching?` class="glitch" style="${since(failAge)}"`:''}><rect x="${x}" y="${y}" width="192" height="70" rx="6" fill="#0d1826" stroke="${running?tone:bad&&glitching?RED:'#213349'}"/><path d="M${x} ${y+15}V${y+4}Q${x} ${y} ${x+4} ${y}H${x+20}" fill="none" stroke="${color}" stroke-width="2"/><text x="${x+14}" y="${y+23}" fill="#d4e6f5" font-size="12" letter-spacing="1">${names[i].toUpperCase()}</text><text x="${x+178}" y="${y+23}" fill="${running?tone:bad?RED:'#7d93ab'}" font-size="14" text-anchor="end">${String(count).padStart(2,'0')}</text><circle cx="${x+17}" cy="${y+49}" r="2.5" fill="${dot}"/><text x="${x+27}" y="${y+53}" fill="${running?'#cfe6f2':'#849ab2'}" font-size="10">${esc((last?.label || 'Awaiting signal').slice(0,20))}</text>${pips}${glitching?`<rect class="glitch-flash" x="${x}" y="${y}" width="192" height="70" rx="6" fill="${RED}" style="${since(failAge)}"/>`:''}<title>${esc(last?.label||names[i])}${last?' · '+lastProvider.toUpperCase():''}</title></g></g>`
  })

  const providers = [
    { id: 'claude', label: 'CLAUDE', x: 394, y: 238, color: COLORS.claude },
    { id: 'codex', label: 'CODEX', x: 506, y: 238, color: COLORS.codex },
    { id: 'omp', label: 'OMP', x: 450, y: 342, color: COLORS.omp },
  ]
  body += `<circle cx="450" cy="285" r="112" fill="#081522" stroke="#294256" stroke-width="1.5"/><circle cx="450" cy="285" r="106" fill="none" stroke="#183548" stroke-dasharray="2 8"/><path d="M394 238L506 238L450 342Z" fill="none" stroke="#29485c" stroke-width="1.2" stroke-dasharray="3 6"/><circle cx="450" cy="278" r="7" fill="#112d3b" stroke="#53f4dd" opacity=".8"/>`
  providers.forEach((provider, k) => {
    const { x, y, color } = provider
    const providerEntries = entries.filter(entry => providerFor(entry) === provider.id)
    const running = providerEntries.filter(entry => entry.status === 'run').length
    const last = providerEntries.at(-1)
    const recent = last?.endedAt && now - last.endedAt >= 0 && now - last.endedAt < 4000
    const lit = running > 0 || recent
    const offline = !lit && presenceOf(board, provider.id, entries, now) === 'offline'
    const model = offline ? 'OFFLINE' : board.models?.[provider.id] || 'MODEL PENDING'
    // Glow: pulses while working, breathes slowly while open but quiet, dark when the app is closed.
    const glowClass = running ? 'provider-pulse' : offline ? '' : 'breathe'
    const glowStyle = glowClass === 'breathe' ? ` style="animation-delay:-${(((now + k * 1600) % 4800) / 1000).toFixed(3)}s"` : ''
    body += `<g class="provider-core">`
    body += `<circle ${glowClass ? `class="${glowClass}"` : ''}${glowStyle} cx="${x}" cy="${y}" r="42" fill="${color}" opacity="${offline ? 0 : lit ? '.13' : '.035'}" filter="url(#glow)"/>`
    // Shockwave and flash when this agent finishes a turn.
    const turnEnd = [...providerEntries].reverse().find(e => e.endedAt && e.status !== 'run' && TURN_END.test(String(e.label || '')))
    const shockAge = turnEnd ? now - turnEnd.endedAt : -1
    if (shockAge >= 0 && shockAge < 1700) {
      body += `<circle class="flash" cx="${x}" cy="${y}" r="40" fill="${color}" filter="url(#glow)" style="${since(shockAge)}"/>`
      body += `<circle class="shock" cx="${x}" cy="${y}" r="34" fill="none" stroke="${color}" style="${since(shockAge)}"/>`
      body += `<circle class="shock" cx="${x}" cy="${y}" r="34" fill="none" stroke="#ffffff" opacity=".7" style="${since(shockAge - 180)}"/>`
    }
    if (offline) {
      body += `<path d="${hexPath(x, y, 34)}" fill="#0a131d" stroke="${OFF}" stroke-width="1.2" stroke-dasharray="4 4"/><path d="${hexPath(x, y, 23)}" fill="none" stroke="${OFF}" stroke-opacity=".8"/><text x="${x}" y="${y + 5}" text-anchor="middle" fill="#4b6075" font-size="13">--</text><circle cx="${x - 34}" cy="${y - 29}" r="3.5" fill="${OFF}"/><text x="${x}" y="${y + 48}" text-anchor="middle" fill="#55697d" font-size="11" letter-spacing="1.7">${provider.label}</text><rect x="${x - 50}" y="${y + 54}" width="100" height="17" rx="8.5" fill="#07111c" stroke="${OFF}"/><text x="${x}" y="${y + 65.5}" text-anchor="middle" fill="#5f7488" font-size="8.5" letter-spacing="2">OFFLINE</text>`
    } else {
      body += `<path d="${hexPath(x, y, 34)}" fill="#0b1a27" stroke="${lit ? color : '#385267'}" stroke-width="${lit ? 2.4 : 1.4}"/><path d="${hexPath(x, y, 23)}" fill="${color}" fill-opacity="${lit ? '.28' : '.09'}" stroke="${color}" stroke-opacity="${lit ? '.8' : '.25'}"/><text x="${x}" y="${y + 5}" text-anchor="middle" fill="${lit ? '#efffff' : '#7890a7'}" font-size="13">${String(providerEntries.length).padStart(2,'0')}</text><circle cx="${x - 34}" cy="${y - 29}" r="3.5" fill="${running ? color : '#3c566a'}"/><text x="${x}" y="${y + 48}" text-anchor="middle" fill="${lit ? color : '#9bb0c4'}" font-size="11" letter-spacing="1.7">${provider.label}</text><rect x="${x - 50}" y="${y + 54}" width="100" height="17" rx="8.5" fill="#07111c" stroke="${color}" stroke-opacity="${lit ? '.45' : '.18'}"/><text x="${x}" y="${y + 65.5}" text-anchor="middle" fill="#9bb0c4" font-size="8.5">${esc(String(model).slice(0, 22))}</text>`
    }
    const sessionCount = board.sessions?.[provider.id] || 0
    const ompUsage = provider.id === 'omp' ? board.usage?.omp : undefined
    if (!offline && sessionCount > 0) {
      const cost = ompUsage ? ' \u00b7 $' + Number(ompUsage.session || 0).toFixed(2) : ''
      body += `<rect x="${x - 96}" y="${y + 76}" width="192" height="11" rx="5.5" fill="#080e19" opacity=".9"/>`
      body += `<text x="${x}" y="${y + 84}" text-anchor="middle" fill="#7f93a8" font-size="8" letter-spacing="1">${sessionCount} SESSION${sessionCount === 1 ? '' : 'S'}${cost}</text>`
    }
    if (ompUsage && !offline) {
      const usageAge = now - (Number(ompUsage.lastAt) || 0)
      const fresh = usageAge >= 0 && usageAge < 2600
      if (fresh) body += `<text class="float-up" x="${x + 42}" y="${y + 12}" fill="${color}" font-size="12" font-weight="bold" style="${since(usageAge)}">+$${Number(ompUsage.last || 0).toFixed(3)}</text>`
    }
    body += `<title>${provider.label} · ${offline ? 'offline' : running ? running + ' active' : 'idle'} · ${esc(model)}</title></g>`
  })

  body += `<text x="450" y="444" fill="#5c7891" font-size="8" letter-spacing="3" text-anchor="middle">MULTI-AGENT BUS${active.length ? ` · ${active.length} ACTIVE CHANNEL${active.length === 1 ? '' : 'S'}` : ''}</text>`
  body += ticker(entries, active, now)
  body += `<text x="26" y="548" fill="#506b85" font-size="9" letter-spacing="2">COMMAND MESH / OPERATIONS GRID</text><text x="874" y="548" fill="#506b85" font-size="9" text-anchor="end">${entries.length} EVENTS IN BUFFER</text></g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 570" role="img" aria-label="Live agent activity topology">${body}</svg>`
}

// Terminal-style readout of the current operation. A running call types itself out once, with a
// blinking cursor; a call that just finished stays on screen for 4 s in a dimmer tone.
function ticker(entries, active, now) {
  const focus = active.at(-1) || [...entries].reverse().find(e => e.endedAt && now - e.endedAt >= 0 && now - e.endedAt < 4000)
  if (!focus) return `<text x="450" y="468" fill="#849ab2" font-size="10" letter-spacing="3" text-anchor="middle">AWAITING INPUT</text>`
  const provider = providerFor(focus), color = COLORS[provider]
  const station = focus.station === 'network' ? 'web' : String(focus.station || '')
  const text = `> ${provider.toUpperCase()} :: ${station.toUpperCase()} :: ${String(focus.label || '').replace(/\s+/g, ' ')}`.slice(0, 64)
  const charWidth = 6.05, width = text.length * charWidth, x0 = 450 - width / 2
  const running = focus.status === 'run'
  // Unique per render so two maps on one page never clip each other's ticker.
  const clipId = `ticker-clip-${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`
  let out = `<clipPath id="${clipId}"><rect x="${(x0 - 2).toFixed(1)}" y="455" height="18" width="${running ? 0 : (width + 4).toFixed(1)}">`
  let cursor = ''
  if (running) {
    const typed = Math.max(0, now - (focus.startedAt || now))
    const steps = Array.from({ length: text.length + 1 }, (_, k) => k * charWidth)
    const duration = (text.length * 0.028).toFixed(3), begin = `-${(typed / 1000).toFixed(3)}s`
    out += `<animate attributeName="width" values="${steps.map(v => (v + 2).toFixed(1)).join(';')};${(width + 4).toFixed(1)}" dur="${duration}s" begin="${begin}" fill="freeze" calcMode="discrete"/>`
    cursor = `<rect class="cursor" x="${x0.toFixed(1)}" y="459" width="6" height="11" fill="${color}" opacity=".85"><animate attributeName="x" values="${steps.map(v => (x0 + v + 1).toFixed(1)).join(';')}" dur="${duration}s" begin="${begin}" fill="freeze" calcMode="discrete"/></rect>`
  }
  out += `</rect></clipPath>`
  out += `<text x="${x0.toFixed(1)}" y="468" fill="${color}" opacity="${running ? 1 : .7}" font-size="11" textLength="${width.toFixed(1)}" lengthAdjust="spacing" clip-path="url(#${clipId})">${esc(text)}</text>${cursor}`
  return out
}

module.exports = drawMap
module.exports.providerFor = providerFor
module.exports.COLORS = COLORS
