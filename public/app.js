import { providers, nextParticipant, canContinue, normalizeAgent } from '/engine.js';

const $ = id => document.getElementById(id);
const names = {demo:'Demo (no model)',ollama:'Ollama (local)', 'openai-compatible':'OpenAI-compatible / Hugging Face',claude:'Claude Code CLI',codex:'ChatGPT / Codex CLI'};
const defaults = { demo:'',ollama:'qwen3:8b','openai-compatible':'',claude:'',codex:'' };
let state = {agents:[],meetings:[]}, config = {}, current = null, running = null, revision = 0, recording = null;
let saveQueue = Promise.resolve();
function error(message='') { $('error').textContent=message; }
async function request(path, method='GET', data, signal) {
  const res=await fetch(path,{method,signal,...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});
  const json=await res.json();
  if(!res.ok) throw Object.assign(new Error(json.error??('HTTP '+res.status)),{status:res.status});
  return json;
}
function save() {
  const snapshot=JSON.parse(JSON.stringify(state));
  saveQueue=saveQueue.catch(()=>{}).then(()=>request('/api/state','PUT',snapshot)).catch(e=>error('Could not save: '+e.message));
  return saveQueue;
}
function node(tag,text,cls) { const el=document.createElement(tag); if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el; }
function button(text,fn) {const b=node('button',text,'secondary');b.type='button';b.addEventListener('click',fn);return b;}
function modelOptions(select, selected) {
  select.replaceChildren(...providers.map(p=>{const option=node('option',names[p]);option.value=p;option.disabled=!config.cli&&['claude','codex'].includes(p)&&p!==selected;return option;}));
  select.value=selected;
}
function renderAgents() {
  const list=$('agents'), invite=$('invite');
  const picked=new Set([...invite.querySelectorAll('input:checked')].map(x=>x.value));
  list.replaceChildren(); invite.replaceChildren();
  for (const a of state.agents) {
    const card=node('div',undefined,'agent');
    card.append(node('strong',a.name),node('div',names[a.provider]+(a.model?' · '+a.model:''),'muted small'),node('div',a.skills.map(s=>s.name).join(', ')||'No skills','small'));
    list.append(card);
    const label=node('label',undefined,'check'), input=node('input');
    input.type='checkbox';input.name='agent';input.value=a.id;input.checked=picked.has(a.id);label.append(input,node('span',a.name));invite.append(label);
  }
  if(!state.agents.length){list.append(node('p','Create your first agent.','muted'));invite.append(node('p','No agents available.','muted'));}
}
function renderHistory() {
  const list=$('history');list.replaceChildren();
  for(const m of [...state.meetings].reverse()){
    const item=node('div',undefined,'history-item');
    item.append(button(m.goal.slice(0,75)+' · '+m.status,()=>openMeeting(m)));
    list.append(item);
  }
}
function renderTeam(){
  $('team').replaceChildren();
  if(!current)return;
  for(const a of current.participants){
    const card=node('div',undefined,'participant');card.dataset.agent=a.id;
    card.append(node('span',a.name.slice(0,2).toUpperCase(),'avatar'),node('strong',a.name),node('small',a.skills.map(s=>s.name).join(' · ')||'No skills','muted'));
    const select=node('select'), model=node('input');
    modelOptions(select,a.provider);select.setAttribute('aria-label',a.name+' provider');model.value=a.model;model.placeholder='Model name';model.setAttribute('aria-label',a.name+' model');
    select.addEventListener('change',()=>{a.provider=select.value;a.model=defaults[a.provider];model.value=a.model;void save();});
    model.addEventListener('change',()=>{a.model=model.value.trim();void save();});
    card.append(select,model);$('team').append(card);
  }
}
function renderTranscript(){
  $('transcript').replaceChildren();
  if(!current)return;
  for(const m of current.transcript){
    const row=node('article',undefined,'message');
    row.append(node('span',m.speaker,'speaker'),node('span',m.model?' · '+m.model:'','muted small'),node('p',m.text));$('transcript').append(row);
  }
  $('transcript').scrollTop=$('transcript').scrollHeight;
}
function renderStatus(message=''){
  if(!current)return;
  $('status').textContent=current.status;
  $('progress').textContent=message;
  $('resume').disabled=Boolean(running)||Boolean(recording)||current.status==='accepted';
  $('pause').disabled=!running;
  $('accept').disabled=current.status==='accepted'||Boolean(recording);
  $('record').disabled=current.status==='accepted'||!config.whisper;
  $('message-form').querySelector('button[type=submit]').disabled=current.status==='accepted'||Boolean(recording);
}
function clearSpeaker(){for(const card of $('team').children)card.classList.remove('active');}
function pause(){
  revision++; if(running)running.abort(); running=null;
  if(window.speechSynthesis)window.speechSynthesis.cancel();
  if(current&&current.status==='running')current.status='paused';
  clearSpeaker();renderStatus();void save();
}
function openMeeting(m){
  if(recording){error('Finish recording first.');return;}
  pause();current=m;if(current.status==='running')current.status='paused';
  $('new-panel').hidden=true;$('meeting-panel').hidden=false;
  $('goal').textContent=m.goal;$('agenda').textContent=m.agenda||'No agenda specified';
  $('message-form').elements.message.value='';error();renderTeam();renderTranscript();renderStatus();renderHistory();
}
function newMeeting(){
  if(recording){error('Finish recording first.');return;}
  pause();current=null;$('new-panel').hidden=false;$('meeting-panel').hidden=true;renderHistory();error();
}
function addMessage(speaker,text,model){
  current.transcript.push({speaker,text,model,at:new Date().toISOString()});
  renderTranscript();void save();
}
function localSpeak(text, voice, signal){
  return new Promise((resolve,reject)=>{
    if(!window.speechSynthesis||signal.aborted){resolve();return;}
    const voices=window.speechSynthesis.getVoices().filter(v=>v.localService);
    if(!voices.length){reject(new Error('No local browser voices are available. Configure Kokoro or disable speech.'));return;}
    const utterance=new SpeechSynthesisUtterance(text);
    utterance.voice=voices.find(v=>v.name===voice)??voices[0];
    const finish=()=>{signal.removeEventListener('abort',stop);resolve();};
    const stop=()=>{window.speechSynthesis.cancel();finish();};
    utterance.onend=finish;utterance.onerror=e=>{signal.removeEventListener('abort',stop);if(signal.aborted)resolve();else reject(new Error('Speech playback: '+e.error));};
    signal.addEventListener('abort',stop,{once:true});window.speechSynthesis.speak(utterance);
  });
}
async function speak(text,voice,signal){
  if(!config.kokoro)return localSpeak(text,voice,signal);
  const res=await fetch('/api/speech',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice}),signal});
  if(!res.ok)throw new Error('Kokoro speech request failed');
  const url=URL.createObjectURL(await res.blob());
  const audio=new Audio(url);
  try{
    await new Promise((resolve,reject)=>{
      const cleanup=()=>signal.removeEventListener('abort',stop);
      const stop=()=>{audio.pause();cleanup();resolve();};
      if(signal.aborted){stop();return;}
      signal.addEventListener('abort',stop,{once:true});
      audio.onended=()=>{cleanup();resolve();};audio.onerror=()=>{cleanup();reject(new Error('Audio playback failed'));};
      audio.play().catch(e=>{cleanup();reject(e);});
    });
  }finally{URL.revokeObjectURL(url);}
}
async function run(){
  if(!current||running||recording||current.status==='accepted')return;
  const m=current, token=++revision, ctrl=new AbortController();running=ctrl;
  m.status='running';error();void save();renderHistory();
  const limit=Math.min(60,Math.max(1,Math.floor(Number($('limit').value)||12)));let turns=0;
  try{
    while(token===revision&&canContinue(m,turns,limit)){
      const agent=normalizeAgent(nextParticipant(m.participants,m.cursor??0));
      renderStatus(agent.name+' is thinking · '+(turns+1)+' / '+limit);
      clearSpeaker();[...$('team').children].find(el=>el.dataset.agent===agent.id)?.classList.add('active');
      const context={goal:m.goal,agenda:m.agenda,participants:m.participants.map(p=>({name:p.name})),transcript:m.transcript.slice(-30).map(x=>({speaker:x.speaker,text:x.text.slice(0,4000)}))};
      const result=await request('/api/turn','POST',{agent,meeting:context},ctrl.signal);
      if(token!==revision||ctrl.signal.aborted)break;
      addMessage(agent.name,result.text,names[agent.provider]+(agent.model?' / '+agent.model:''));
      m.cursor=(m.cursor??0)+1;turns++;void save();
      if($('voice-output').checked){
        renderStatus(agent.name+' is speaking');
        try{await speak(result.text,agent.voice,ctrl.signal);}catch(e){if(!ctrl.signal.aborted)$('audio-note').textContent=e.message;}
      }
      if(agent.provider==='demo')await new Promise(resolve=>setTimeout(resolve,600));
    }
  }catch(e){if(token===revision&&!ctrl.signal.aborted)error(e.message);}
  finally{if(token===revision){running=null;if(m.status==='running')m.status='paused';clearSpeaker();renderStatus(turns>=limit?'Turn budget reached. Accept the outcome or continue.':'Paused.');renderHistory();void save();}}
}
$('agent-form').addEventListener('submit',async e=>{
  e.preventDefault();error();const f=e.currentTarget, data=new FormData(f);
  try{
    const skills=[];for(const file of f.elements.skills.files){if(file.size>12000)throw new Error('Skill files must be under 12 KB for this version.');skills.push({name:file.name,text:await file.text()});}
    if(String(data.get('skillText')).trim())skills.push({name:'Custom skill',text:data.get('skillText')});
    const agent=normalizeAgent({id:crypto.randomUUID(),name:data.get('name'),provider:data.get('provider'),model:data.get('model'),voice:data.get('voice'),instructions:data.get('instructions'),skills});
    state.agents.push(agent);f.reset();modelOptions(f.elements.provider,'demo');renderAgents();await save();
  }catch(e){error(e.message);}
});
$('agent-form').elements.provider.addEventListener('change',e=>{$('agent-form').elements.model.value=defaults[e.target.value];});
$('meeting-form').addEventListener('submit',e=>{
  e.preventDefault();error();const f=e.currentTarget,d=new FormData(f), ids=d.getAll('agent');
  if(!ids.length){error('Choose at least one agent.');return;}
  const participants=state.agents.filter(a=>ids.includes(a.id)).map(a=>structuredClone(a));
  if(participants.length>12){error('Choose at most 12 participants.');return;}
  const m={id:crypto.randomUUID(),goal:String(d.get('goal')).trim(),agenda:String(d.get('agenda')).trim(),participants,transcript:[],cursor:0,status:'paused'};
  if(!m.goal){error('Enter a meeting goal.');return;}
  state.meetings.push(m);openMeeting(m);f.reset();void save();
});
$('message-form').addEventListener('submit',e=>{
  e.preventDefault();if(!current||recording||current.status==='accepted')return;
  const input=e.currentTarget.elements.message,text=input.value.trim();if(!text)return;
  pause();addMessage('Host',text);input.value='';renderStatus('Feedback added. Continue when ready.');
});
$('resume').addEventListener('click',()=>void run());$('pause').addEventListener('click',pause);
$('accept').addEventListener('click',()=>{if(!current||recording)return;pause();current.status='accepted';renderStatus('Outcome accepted by host.');renderHistory();void save();});
$('new').addEventListener('click',newMeeting);
$('record').addEventListener('click',async()=>{
  if(recording){if(recording.state==='recording')recording.stop();return;}
  if(!current||current.status==='accepted')return;
  pause();error();const m=current;let stream;
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    if(current!==m||m.status==='accepted'){stream.getTracks().forEach(t=>t.stop());return;}
    const rec=new MediaRecorder(stream);recording=rec;const chunks=[];
    rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    rec.onerror=()=>{stream.getTracks().forEach(t=>t.stop());recording=null;$('record').textContent='Record voice';renderStatus();error('Microphone recording failed.');};
    const timer=setTimeout(()=>{if(rec.state==='recording')rec.stop();},60000);
    rec.onstop=async()=>{
      clearTimeout(timer);stream.getTracks().forEach(t=>t.stop());$('record').textContent='Transcribing…';$('record').disabled=true;
      try{
        const blob=new Blob(chunks,{type:rec.mimeType||'audio/webm'});
        const res=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':blob.type},body:blob});
        const data=await res.json();if(!res.ok)throw new Error(data.error);
        if(current===m)$('message-form').elements.message.value=data.text;
      }catch(e){error(e.message);}
      finally{recording=null;$('record').textContent='Record voice';renderStatus('Review your transcription and send it.');}
    };
    rec.start();$('record').textContent='Stop recording';renderStatus('Recording…');
  }catch(e){stream?.getTracks().forEach(t=>t.stop());recording=null;renderStatus();error(e.message);}
});
async function init(){
  try{
    [state,config]=await Promise.all([request('/api/state'),request('/api/config')]);
    $('connection').textContent='Local · '+(config.whisper?'Whisper ready':'Whisper not configured');
    modelOptions($('agent-form').elements.provider,'demo');
    if(!state.agents.length){for(const [name,instructions] of [['Architect','Consider architecture and tradeoffs.'],['Critic','Challenge assumptions and identify risks.']])state.agents.push(normalizeAgent({id:crypto.randomUUID(),name,provider:'demo',instructions,skills:[]}));void save();}
    for(const m of state.meetings)if(m.status==='running')m.status='paused';
    renderAgents();renderHistory();
    $('audio-note').textContent=config.kokoro?'Kokoro configured.':'Speech uses available local browser voices unless Kokoro is configured.';
    if(window.speechSynthesis)window.speechSynthesis.getVoices();
  }catch(e){$('connection').textContent='Disconnected';error(e.message);}
}
void init();
