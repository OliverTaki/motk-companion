// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const state={projectId:'',token:'',timer:null};
const $=(selector)=>document.querySelector(selector);
const message=(selector,text,kind='')=>{const el=$(selector);el.textContent=text;el.className=`message ${kind}`.trim()};

async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{authorization:`Bearer ${state.token}`,'content-type':'application/json',...(options.headers||{})}});
  let body;try{body=await response.json()}catch{body={}};
  if(!response.ok||!body.ok)throw new Error(body.error||`Request failed (${response.status})`);
  return body;
}

function saveSession(){try{sessionStorage.setItem('motk.production.project',state.projectId);sessionStorage.setItem('motk.production.key',state.token)}catch{/* tab memory remains */}}
function clearSession(){try{sessionStorage.removeItem('motk.production.project');sessionStorage.removeItem('motk.production.key')}catch{/* no-op */}}
function setConnected(on){$('#workspace').classList.toggle('hidden',!on);const badge=$('#connectionBadge');badge.textContent=on?`Connected · ${state.projectId}`:'Not connected';badge.className=`badge ${on?'good':'neutral'}`;if(!on&&state.timer){clearInterval(state.timer);state.timer=null}}

function renderCommands(commands){
  const list=$('#commandList');list.replaceChildren();$('#emptyState').classList.toggle('hidden',commands.length>0);
  for(const command of commands){
    const item=document.createElement('li');item.className=`command ${command.status}`;
    const dot=document.createElement('span');dot.className='dot';dot.setAttribute('aria-hidden','true');
    const main=document.createElement('div');main.className='command-main';
    const title=document.createElement('div');title.className='command-title';title.textContent=command.payload?.recipe||command.action;
    const meta=document.createElement('div');meta.className='command-meta';const take=command.context?.take?` · Take ${command.context.take}`:'';meta.textContent=`${command.context?.shotId||'Project'}${take} · ${new Date(command.createdAt).toLocaleString()}`;
    if(command.error){const error=document.createElement('div');error.className='command-meta';error.textContent=command.error;main.append(title,meta,error)}else main.append(title,meta);
    const status=document.createElement('span');status.className='status';status.textContent=command.status.replace('_',' ');
    item.append(dot,main,status);list.append(item);
  }
}

async function refresh(){
  if(!state.projectId)return;
  try{const query=new URLSearchParams({projectId:state.projectId,limit:'30'});const body=await api(`/v1/commands?${query}`);renderCommands(body.commands||[]);message('#runMessage','')}
  catch(error){message('#runMessage',error.message,'error')}
}

async function connect(projectId,token){
  state.projectId=projectId.trim();state.token=token.trim();
  const body=await api(`/v1/projects/${encodeURIComponent(state.projectId)}`);
  if(body.project.projectId!==state.projectId)throw new Error('Project did not match');
  saveSession();setConnected(true);message('#connectMessage','Project connected. Your key will be forgotten when this tab closes.','success');
  await refresh();if(!state.timer)state.timer=setInterval(refresh,3000);
}

$('#connectForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;message('#connectMessage','Connecting…');try{await connect($('#projectId').value,$('#operatorToken').value)}catch(error){state.projectId='';state.token='';setConnected(false);message('#connectMessage',error.message==='unauthorized'?'The project ID or Production key was not accepted.':error.message,'error')}finally{button.disabled=false}});
$('#forgetButton').addEventListener('click',()=>{state.projectId='';state.token='';clearSession();$('#operatorToken').value='';setConnected(false);message('#connectMessage','Project key forgotten for this tab.','success')});
$('#refreshButton').addEventListener('click',refresh);
$('#runForm').addEventListener('submit',async(event)=>{
  event.preventDefault();const button=$('#runButton');button.disabled=true;message('#runMessage','Sending to Companion…');
  const context={projectId:state.projectId,shotId:$('#shotId').value.trim(),take:Number($('#take').value)};
  const payload={recipe:$('#recipe').value.trim(),dryRun:$('#dryRun').checked};
  try{const query=new URLSearchParams({projectId:state.projectId});await api(`/v1/commands?${query}`,{method:'POST',body:JSON.stringify({action:'runner.run',context,payload,idempotencyKey:`run:${crypto.randomUUID()}`})});message('#runMessage','Sent. Companion will pick it up automatically.','success');await refresh()}
  catch(error){message('#runMessage',error.message,'error')}finally{button.disabled=false}
});

try{const project=sessionStorage.getItem('motk.production.project')||'';const token=sessionStorage.getItem('motk.production.key')||'';if(project&&token){$('#projectId').value=project;$('#operatorToken').value=token;connect(project,token).catch(()=>{clearSession();setConnected(false)})}}catch{/* start disconnected */}
