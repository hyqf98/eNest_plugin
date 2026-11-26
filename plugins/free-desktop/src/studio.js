import { initial, change, primaryScreen, homeScreen } from './model.js'
import { workspaceStore } from './persistence.js'
import { regionMenu } from './regions.js'

const api=window.enest, store=api&&workspaceStore(api.storage), icons=new Map(), localActions=new Set(['create','remove','rect','note','unref','dockSide','dockScreen','reorder','unpin']), helperActions=new Set([...localActions,'open','refresh','launch','quick','workspace','stop'])
let layout=initial(),screens=[primaryScreen],editScreen='primary',session=null,locked=true,queue=Promise.resolve(),wallpaper=null,backendUsed=false,visible=true
const listings=Object.create(null), refreshing=new Set()
const surface=window.FreeDesktopSurface(document.querySelector('#desk'),action=>{
  if(!locked&&api?.launcher){
    if(action.action==='start'&&!session)action.authorization=api.launcher.authorizeSession().catch(()=>false)
    if(action.action==='pickTarget')action.selection=api.launcher.pickTarget().then(value=>({value}),error=>({error}))
    if(action.action==='quick'||action.action==='launch'&&layout.dock.targets.some(entry=>entry.id===action.id)){
      const result=action.action==='quick'?api.launcher.showQuick():api.launcher.activateTarget(action.id);void result.then(ok=>{if(!ok)surface.notice('宿主未打开该项目')},error=>surface.notice(String(error.message||error)));return
    }
  }
  enqueue(action)
},false)
const renderedLayout=()=>({...layout,dock:{...layout.dock,targets:layout.dock.targets.map(target=>icons.has(target.id)?{...target,icon:icons.get(target.id)}:target)}})
const state=()=>({layout:renderedLayout(),screen:homeScreen(editScreen,screens),screens,running:!!session,listings,regions:regionMenu})
const draw=()=>surface.render(state())
const call=(method,args=[])=>{if(!api?.backend)throw Error('此操作需要在 eNest 里使用');backendUsed=true;return api.backend.call(method,args,{timeoutMs:120000})}
function nativeSnapshot(){
  const rendered=renderedLayout(),active=Object.fromEntries(rendered.blocks.filter(block=>block.binding&&listings[block.id]).map(block=>[block.id,listings[block.id]])),full={layout:rendered,listings:active}
  if(new Blob([JSON.stringify(full)]).size<=3*1024*1024)return full
  const limited={...rendered,dock:{...rendered.dock,targets:rendered.dock.targets.map(({icon,...target})=>target)},blocks:rendered.blocks.map(block=>block.kind==='collection'?{...block,refs:block.refs.slice(0,18)}:block)}
  for(const [id,listing] of Object.entries(active))active[id]={...listing,entries:listing.entries.slice(0,18),truncated:listing.truncated||listing.entries.length>18}
  return {layout:limited,listings:active,compact:true}
}
async function publish(){draw();if(session)await call('desktop.render',[session,nativeSnapshot()])}
async function persist(next){if(locked)throw Error('布局不可写，已有数据未改动');if(store)await store.commit(layout,next);layout=next;await publish()}
async function save(action,screen){await persist(change(layout,action,screen,screens))}
async function wall(data){wallpaper=data||null;surface.wallpaper(wallpaper);if(session)await call('desktop.wallpaper',[session,wallpaper])}
async function launcherIcon(raw){
  if(typeof raw!=='string'||raw.length>700000||!/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(raw))return undefined
  try{
    const image=new Image();image.src=raw;await image.decode()
    if(!image.naturalWidth||!image.naturalHeight)return undefined
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64
    const fit=64/Math.max(image.naturalWidth,image.naturalHeight),width=image.naturalWidth*fit,height=image.naturalHeight*fit
    canvas.getContext('2d').drawImage(image,(64-width)/2,(64-height)/2,width,height)
    return canvas.toDataURL('image/png')
  }catch{return undefined}
}
async function loadFolder(item){if(!item?.binding)return;try{listings[item.id]=await call('files.list',[item.binding.id,visible||!!session])}catch(error){listings[item.id]={entries:[],error:String(error.message||error).slice(0,200)}}}
function writableBlock(id,screen){const item=layout.blocks.find(entry=>entry.id===id);if(!item||homeScreen(item.screen,screens)!==screen)throw Error('区域不可用');return item}
async function perform(action,screen,fromHelper){
  if(locked)throw Error('布局未就绪或无法读取，未修改文件')
  if(fromHelper&&!helperActions.has(action.action))throw Error('请在插件工作区完成此操作')
  if(localActions.has(action.action)){
    const removed=action.action==='unpin'&&layout.dock.targets.find(entry=>entry.id===action.id)
    if(removed)await api?.launcher?.forgetTarget(action.id)
    await save(action,screen)
    if(removed){icons.delete(removed.id);if(removed.iconAsset)await api?.storage.assets.remove(removed.iconAsset)}
    if(backendUsed&&['remove','unref'].includes(action.action)){await call('files.retain',[layout.blocks.flatMap(block=>block.binding?[block.binding.id]:(block.refs||[]).map(ref=>ref.id))]);await api.storage.flush()}
    return
  }
  if(!api)throw Error('这是普通工作区预览；本机能力仅在 eNest 内可用。')
  if(action.action==='editScreen'){editScreen=action.value;draw();return}
  if(action.action==='workspace'){
    const opened=await api.launcher?.showWorkspace?.().catch(()=>false)
    if(!opened)throw Error('无法自动切换：请从系统 Dock / 任务栏打开 eNest，选择「自由桌面」标签或从插件库打开它。')
    editScreen=screen;draw();surface.focusRegion(action.id)
    const hints={pickFiles:'在收纳区点击「添加引用」选择文件。',bind:'在文件夹区域点击「选择目录」。',moveFile:'在文件夹区域点击「移入文件」并确认。',pickWallpaper:'打开「桌面设置 → 选择壁纸图片」。',pickTarget:'打开「桌面设置 → 添加程序 / 插件」。'}
    surface.notice(hints[action.hint]||'已打开自由桌面工作区。');return
  }
  if(action.action==='start'){
    if(session)return
    const authorized=await action.authorization||false
    let status;try{status=await call('desktop.start')}catch(error){if(authorized)await api.launcher.endSession();throw error}
    if(!status?.active){if(authorized)await api.launcher.endSession();surface.notice(status?.reason||'保留普通工作区');return}
    session=status.session;screens=status.screens;editScreen=homeScreen(editScreen,screens)
    try{await publish();if(wallpaper)await wall(wallpaper)}catch(error){const stale=session;session=null;await call('desktop.stop',[stale]).catch(()=>{});if(authorized)await api.launcher.endSession();draw();throw error}
    if(!authorized)surface.notice('桌面已启用，启动栏尚未获得本次会话授权。')
    for(const item of layout.blocks.filter(item=>item.kind==='folder'&&item.binding))await loadFolder(item);await publish();return
  }
  if(action.action==='stop'){const active=session;if(active){await call('desktop.stop',[active]);if(session===active){session=null;draw();await api.launcher?.endSession()}}return}
  if(action.action==='quick'||action.action==='launch'){
    if(action.action==='launch'&&!layout.dock.targets.some(target=>target.id===action.id))throw Error('此启动项不在程序栏')
    if(!api.launcher)throw Error('当前宿主不支持程序栏启动')
    const ok=action.action==='quick'?await api.launcher.showQuick():await api.launcher.activateTarget(action.id);if(!ok)throw Error('宿主未打开目标，可能已被移除或禁用');return
  }
  if(action.action==='pickTarget'){
    if(!action.selection)throw Error('当前宿主没有程序选择器');const {value,error}=await action.selection;if(error)throw error
    if(!value||layout.dock.targets.some(target=>target.id===value.id))return
    let asset
    try{
      const icon=await launcherIcon(value.icon)
      if(icon){asset=await api.storage.assets.put({name:'launcher.png',dataUrl:icon});icons.set(value.id,icon)}
      await save({action:'pin',target:{id:value.id,title:value.title,kind:value.kind,iconAsset:asset?.assetId}},screen)
    }catch(cause){if(!layout.dock.targets.some(target=>target.id===value.id)){icons.delete(value.id);if(asset)await api.storage.assets.remove(asset.assetId).catch(()=>{});await api.launcher.forgetTarget(value.id).catch(()=>{})}throw cause}return
  }
  if(action.action==='pickWallpaper'||action.action==='clearWallpaper'){
    const old=layout.wallpaper;let asset=null,data=null
    if(action.action==='pickWallpaper'){const [picked]=await api.localFiles.pick({kind:'file',access:'read'});if(!picked)return;if(picked.size>2*1024*1024)throw Error('请选择不超过 2 MiB 的 PNG、JPEG 或 WebP 壁纸');data=await api.localFiles.read({handleId:picked.id,encoding:'dataUrl',maxBytes:2*1024*1024});if(!/^data:image\/(?:png|jpeg|webp);base64,/.test(data))throw Error('仅支持 PNG、JPEG 或 WebP 图片');asset=await api.storage.assets.put({name:picked.name,dataUrl:data})}
    try{await save({action:'wallpaper',assetId:asset?.assetId||null},screen)}catch(error){if(asset&&layout.wallpaper!==asset.assetId)await api.storage.assets.remove(asset.assetId).catch(()=>{});throw error}await wall(data);if(old&&old!==asset?.assetId)await api.storage.assets.remove(old);return
  }
  if(action.action==='desktopFolder'){
    const [picked]=await api.localFiles.pick({kind:'directory',access:'read'});if(!picked)return
    const [ref]=await call('files.remember',[[picked.id]]);let next=change(layout,{action:'create',kind:'folder',rect:{x:.12,y:.26,w:.44,h:.49}},screen,screens);const item=next.blocks.at(-1);next=change(next,{action:'setBinding',id:item.id,ref},screen,screens);await persist(next);await loadFolder(layout.blocks.find(block=>block.id===item.id));await publish();return
  }
  const item=writableBlock(action.id,screen)
  if(action.action==='pickFiles'||action.action==='drop'){
    if(item.kind!=='collection')return;const handles=action.action==='drop'?await api.localFiles.fromDrop(action.files.slice(0,100)):await api.localFiles.pick({kind:'any',multiple:true,access:'read'});if(!handles.length)return
    if(handles.length+item.refs.length>100)throw Error('每个收纳区最多 100 项');const refs=await call('files.remember',[handles.map(handle=>handle.id)]);await save({action:'setRefs',id:item.id,refs},screen);return
  }
  if(action.action==='bind'){if(item.kind!=='folder')return;const [picked]=await api.localFiles.pick({kind:'directory',access:'read'});if(!picked)return;const [ref]=await call('files.remember',[[picked.id]]);await save({action:'setBinding',id:item.id,ref},screen);await loadFolder(layout.blocks.find(entry=>entry.id===item.id));await publish();return}
  if(action.action==='refresh'){await loadFolder(item);await publish();return}
  if(action.action==='open'){
    if(item.kind==='collection'&&item.refs.some(entry=>entry.id===action.ref))await call('files.open',[action.ref]);else if(item.kind==='folder'&&item.binding&&listings[item.id]?.entries.some(entry=>entry.id===action.ref))await call('files.openChild',[item.binding.id,action.ref]);else throw Error('文件引用失效，请刷新区域');return
  }
  if(action.action==='moveFile'){
    if(!item.binding)throw Error('请先绑定文件夹');surface.notice('请选择要移入的文件，然后再次选择绑定的文件夹以授予写入权限。');const [source]=await api.localFiles.pick({kind:'file',access:'write'});if(!source)return;const [destination]=await api.localFiles.pick({kind:'directory',access:'write'});if(!destination)return
    const moved=await call('files.move',[item.binding.id,source.id,destination.id]);if(moved){surface.notice('文件已移入绑定目录');await loadFolder(item);await publish()}return
  }
  throw Error('未知的桌面命令')
}
function enqueue(action,origin,request,deadline){
  const token=session,screen=origin||homeScreen(editScreen,screens)
  const task=queue.then(async()=>{if(origin&&(!token||token!==session||!screens.some(item=>item.id===origin)))return;if(origin&&Date.now()>deadline)throw Error('桌面操作已超时，请重新点击');await perform(action,screen,!!origin)})
  queue=task.then(async()=>{if(request&&token===session)await call('desktop.reply',[token,request,''])},async error=>{const text=String(error.message||error).slice(0,280);surface.notice(text);if(request&&token===session)await call('desktop.reply',[token,request,text])}).catch(error=>surface.notice(String(error.message||error)))
  return queue
}
api?.on('backend.event',({event,data})=>{
  if(event==='desktop.status'){if(data.active&&data.session!==session)return;if(!data.active&&data.session===session){session=null;void api.launcher?.endSession().catch(()=>{});if(!visible&&backendUsed)void call('files.stopWatching').catch(()=>{});draw();surface.notice(data.reason||'已恢复原系统桌面')}else if(data.active){screens=data.screens;void publish().catch(error=>surface.notice(error.message))}}
  if(event==='desktop.action'&&data.session===session)enqueue(data.action,data.screen,data.request,data.deadline)
  if(event==='files.changed')refreshBound(data.id)
})
function refreshBound(id){
  if((!visible&&!session)||!backendUsed||refreshing.has(id)||!layout.blocks.some(item=>item.binding?.id===id))return
  refreshing.add(id);queue=queue.then(async()=>{if(!visible&&!session)return;for(const item of layout.blocks.filter(item=>item.binding?.id===id))await loadFolder(item);await publish()}).catch(error=>surface.notice(error.message)).finally(()=>refreshing.delete(id))
}
api?.onEnter(()=>{visible=true;for(const item of layout.blocks)if(item.binding&&listings[item.id])refreshBound(item.binding.id)})
api?.onOut(()=>{visible=false;if(backendUsed&&!session)void call('files.stopWatching').catch(()=>{})})
function flushEditor(){const field=document.activeElement;if(field?.tagName==='TEXTAREA'&&field.dataset.dirty)field.dispatchEvent(new Event('change'));return queue}
api?.onBeforeSuspend(flushEditor);api?.onBeforeClose(async()=>{await flushEditor();if(session&&backendUsed)await call('desktop.stop',[session])})
async function init(){
  try {layout=store?await store.read():initial();locked=false;draw();if(layout.wallpaper){const image=await api.storage.assets.get(layout.wallpaper);if(image)await wall(image.dataUrl)}
    for(const target of layout.dock.targets.filter(item=>item.iconAsset)){const image=await api.storage.assets.get(target.iconAsset);if(image)icons.set(target.id,image.dataUrl)}draw()
  }catch(error){draw();surface.notice(String(error.message||error))}
}
void init()
