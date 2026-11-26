import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { realpath, lstat, chmod } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { readLayout, homeScreen } from '../src/model.js'
import { regionMenu } from '../src/regions.js'

const safeText=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)
const allowedActions=new Set(['create','rect','note','remove','unref','open','refresh','dockSide','dockScreen','reorder','unpin','launch','quick','workspace','stop'])
const failure=reason=>({active:false,reason})
async function packaged(root,parts,kind){const base=await realpath(root),path=join(base,...parts),delta=relative(base,path);if(isAbsolute(delta)||delta.startsWith(`..${sep}`)||await realpath(path)!==path)throw Error('桌面组件路径无效');const info=await lstat(path);if(kind==='file'?!info.isFile():!info.isDirectory())throw Error('桌面组件类型无效');return path}
function nativeEnvironment(){const env={};for(const key of ['PATH','HOME','USER','LANG','LC_ALL','TMPDIR','TEMP','TMP','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','XDG_SESSION_TYPE','XDG_CURRENT_DESKTOP','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','SystemRoot','WINDIR','LOCALAPPDATA','USERPROFILE','ProgramFiles','ProgramFiles(x86)','SYSTEMDRIVE'])if(process.env[key])env[key]=process.env[key];return env}
function screensOf(raw){if(!Array.isArray(raw)||raw.length<1||raw.length>16)throw Error('不支持当前显示器拓扑');const screens=raw.map((screen,index)=>{if(!safeText(screen.id,180)||screen.id==='primary')throw Error('无法识别显示器');const insets={};for(const edge of ['left','right','top','bottom']){const value=screen.insets?.[edge]??0;if(!Number.isFinite(value)||value<0||value>4096)throw Error('无法确定显示器工作区');insets[edge]=value}return {id:screen.id,label:safeText(screen.label,140)?screen.label:`显示器 ${index+1}`,primary:screen.primary===true,insets}});if(new Set(screens.map(screen=>screen.id)).size!==screens.length)throw Error('无法区分同名显示器');if(screens.filter(screen=>screen.primary).length!==1)screens.forEach((screen,index)=>{screen.primary=index===0});return screens}
function listingOf(raw,layout){const result={};for(const block of layout.blocks.filter(item=>item.binding)){if(!Object.hasOwn(raw||{},block.id))continue;const listing=raw[block.id];if(!Array.isArray(listing.entries)||listing.entries.length>150)throw Error('文件夹列表无效');result[block.id]={entries:listing.entries.map(entry=>{if(!/^[a-f\d]{40}$/.test(entry.id)||!safeText(entry.name,255)||!['file','directory'].includes(entry.kind))throw Error('文件项无效');return {id:entry.id,name:entry.name,kind:entry.kind}}),truncated:listing.truncated===true,...(safeText(listing.error,200)?{error:listing.error}:{})}}return result}
export function createSession(context,host,emit,assertLive){
  let current=null,starting=false,generation=0
  const status=desk=>({active:true,session:desk.id,screens:desk.screens})
  function send(desk,op,fields={},screen=''){
    if(current!==desk||desk.retiring||!desk.child.stdin.writable)return
    const line=JSON.stringify({op,screen,...fields})+'\n';if(desk.child.stdin.writableLength>12*1024*1024){void end(desk,'桌面未响应，已恢复系统桌面');return}desk.child.stdin.write(line)
  }
  function display(desk,id){if(!desk.state||!desk.screens.some(screen=>screen.id===id))return;const blocks=desk.state.layout.blocks.filter(block=>homeScreen(block.screen,desk.screens)===id),listings={};for(const block of blocks)if(Object.hasOwn(desk.state.listings,block.id))listings[block.id]=desk.state.listings[block.id];send(desk,'render',{state:{layout:{...desk.state.layout,blocks},listings,screens:desk.screens,screen:id,running:true,regions:regionMenu,compact:desk.state.compact}},id)}
  function finish(desk,reason){if(desk.finished)return;desk.finished=true;clearTimeout(desk.startTimer);clearTimeout(desk.renderTimer);clearTimeout(desk.stopTimer);for(const pending of desk.requests.values())clearTimeout(pending.timer);desk.requests.clear();if(current===desk)current=null;desk.rejectStart(new Error(reason));emit('desktop.status',{active:false,session:desk.id,reason});desk.resolveExit();if(desk.child.pid&&desk.tracked)void host('process.untrack',{pid:desk.child.pid}).catch(()=>{});void host('activity.release',{token:desk.token}).catch(()=>{})}
  async function end(desk,reason='已恢复系统桌面'){
    if(!desk||desk.finished)return;if(!desk.retiring){desk.retiring=true;desk.reason=reason;desk.child.stdin.end();const soft=setTimeout(()=>desk.child.kill('SIGTERM'),220),hard=setTimeout(()=>desk.child.kill('SIGKILL'),1300);soft.unref();hard.unref();desk.exited.then(()=>{clearTimeout(soft);clearTimeout(hard)})}await desk.exited
  }
  function receive(desk,message){
    if(desk.retiring||current!==desk)return
    if(message.event==='error'){void end(desk,safeText(message.reason,260)?message.reason:'桌面层不可用，已恢复普通工作区');return}
    if(message.event==='attached'){
      desk.screens=screensOf(message.screens);if(!desk.attached){desk.attached=true;clearTimeout(desk.startTimer);desk.resolveStart(status(desk));desk.renderTimer=setTimeout(()=>{if(!desk.state)void end(desk,'工作区未连接，已恢复系统桌面')},10000)}else emit('desktop.status',status(desk));for(const screen of desk.screens)display(desk,screen.id);if(desk.wallpaper)send(desk,'wallpaper',{data:desk.wallpaper});return
    }
    if(message.event!=='action'||!desk.attached||!desk.screens.some(screen=>screen.id===message.screen)||!message.action||typeof message.action!=='object')return
    const action=message.action;if(action.action==='ready'){display(desk,message.screen);if(desk.wallpaper)send(desk,'wallpaper',{data:desk.wallpaper},message.screen);return}
    if(!desk.state||!allowedActions.has(action.action)||desk.stopTimer)return;if(action.action==='stop'){if(desk.requests.size)desk.stopTimer=setTimeout(()=>{void end(desk)},900);else void end(desk);return}
    if(desk.requests.size>=20){send(desk,'notice',{text:'操作较多，请稍候重试。'},message.screen);return}
    const request=randomUUID(),deadline=Date.now()+8000,timer=setTimeout(()=>{desk.requests.delete(request);send(desk,'notice',{text:'未收到工作区回应。请在 eNest 中打开自由桌面，或从桌面设置退出接管。'},message.screen)},8000);desk.requests.set(request,{timer,screen:message.screen});emit('desktop.action',{session:desk.id,screen:message.screen,request,deadline,action})
  }
  async function start(){
    assertLive();if(current?.attached&&!current.retiring)return status(current);if(starting||current)return failure('正在切换桌面，请稍候');starting=true;const attempt=++generation;let token,desk
    try{
      const platform=process.platform,target=`${platform}-${process.arch}`;if(!['darwin','win32','linux'].includes(platform))return failure('该平台仅支持普通工作区')
      if(platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return failure('没有可用的显示服务，保留普通工作区')
      let executable,assets;try{executable=await packaged(context.packagePath,['runtime','helpers',target,platform==='win32'?'desktop-host.exe':'desktop-host'],'file');assets=await packaged(context.packagePath,['assets','vendor','desk'],'dir');for(const name of ['native.html','native.js','surface.js','surface.css'])await packaged(assets,[name],'file')}catch{return failure(`当前安装包未包含可用的 ${target} 桌面组件；普通工作区仍可使用。`)}
      if(!await host('dialog.confirm',{title:'接管系统桌面',message:'在普通应用下方启用自由桌面？',detail:'不会替换系统外壳或修改系统壁纸。此次会话可在桌面设置、插件工作区或关闭插件时退出。'}))return failure('未启用接管，保留普通工作区')
      assertLive();if(attempt!==generation)return failure('接管已取消');if(platform!=='win32'){const info=await lstat(executable);if(!(info.mode&0o100))await chmod(executable,(info.mode&0o777)|0o100)}token=`free-desktop:${randomUUID()}`;await host('activity.acquire',{token,reason:'用户已启用的自由桌面'});assertLive();if(attempt!==generation)return failure('接管已取消')
      const child=spawn(executable,[assets],{stdio:['pipe','pipe','ignore'],windowsHide:true,shell:false,env:nativeEnvironment()});let resolveStart,rejectStart,resolveExit;const attached=new Promise((resolve,reject)=>{resolveStart=resolve;rejectStart=reject});void attached.catch(()=>{})
      desk={id:randomUUID(),child,token,screens:[],requests:new Map(),exited:new Promise(resolve=>{resolveExit=resolve}),resolveExit,resolveStart,rejectStart};current=desk;const owned=desk;let buffer=''
      child.once('error',()=>finish(owned,'原生桌面组件无法启动，保留普通工作区'));child.once('exit',()=>finish(owned,owned.reason||'原生桌面已退出，已恢复系统桌面'));child.stdin.on('error',()=>{void end(owned,'原生通道已断开，已恢复系统桌面')});child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(owned.retiring)return;buffer+=chunk;let newline;try{while((newline=buffer.indexOf('\n'))>=0){if(newline>24000)throw Error();const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line)receive(owned,JSON.parse(line))}if(buffer.length>24000)throw Error()}catch{void end(owned,'原生桌面返回了无效数据，已恢复系统桌面')}})
      desk.startTimer=setTimeout(()=>{void end(owned,'系统未确认可交互的桌面层，保留普通工作区')},12000)
      if(!child.pid)throw Error('无法创建原生桌面进程');await host('process.track',{pid:child.pid});desk.tracked=true;if(desk.finished)await host('process.untrack',{pid:child.pid}).catch(()=>{});assertLive();if(attempt!==generation||desk.retiring||desk.finished)throw Error('原生桌面已退出');send(desk,'init');return await attached
    }catch(error){if(desk)await end(desk,error.message);return failure(error.message||'当前环境不能接管桌面，保留普通工作区')}
    finally{if(token&&!desk)await host('activity.release',{token}).catch(()=>{});starting=false}
  }
  return {async run(method,args){if(method==='desktop.start')return start();if(!current||current.id!==args[0]||current.retiring){if(method==='desktop.stop')return false;throw Error('桌面会话已结束')}
    const desk=current;if(method==='desktop.stop'){++generation;await end(desk);return true}
    if(method==='desktop.render'){const layout=readLayout(args[1]?.layout);if(desk.state?.layout.revision>layout.revision)return false;desk.state={layout,listings:listingOf(args[1]?.listings,layout),compact:args[1]?.compact===true};clearTimeout(desk.renderTimer);for(const screen of desk.screens)display(desk,screen.id);return true}
    if(method==='desktop.wallpaper'){const data=args[1];if(data!==null&&(typeof data!=='string'||data.length>3*1024*1024||!/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(data)))throw Error('壁纸格式无效');desk.wallpaper=data;send(desk,'wallpaper',{data});return true}
    if(method==='desktop.reply'){const pending=desk.requests.get(args[1]);if(!pending)return false;clearTimeout(pending.timer);desk.requests.delete(args[1]);if(safeText(args[2],280))send(desk,'notice',{text:args[2]},pending.screen);if(desk.stopTimer&&!desk.requests.size)void end(desk);return true}throw Error('未知的桌面操作')},async close(){++generation;await end(current)}}
}
