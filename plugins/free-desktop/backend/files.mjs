import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { lstat, realpath, opendir, link, unlink, mkdtemp, rename, rmdir } from 'node:fs/promises'
import { basename, dirname, extname, join, isAbsolute } from 'node:path'
import { execFile } from 'node:child_process'

function reject(text){throw new Error(text)}
const stableKey=stat=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
const safeId=id=>typeof id==='string'&&/^[\w-]{1,120}$/.test(id)
const hostId=id=>typeof id==='string'&&id.length>0&&id.length<=512&&!id.includes('\0')
const safeName=name=>typeof name==='string'&&name.length>0&&name.length<=255&&!/[\u0000-\u001f\u007f]/.test(name)
const sensitiveBundle=name=>/\.(?:app|bundle|prefpane|plugin|workflow|scptd)$/i.test(name)
async function identify(path){
  if(!isAbsolute(path))reject('无效的文件授权');const canonical=await realpath(path), original=await lstat(path,{bigint:true}),stat=await lstat(canonical,{bigint:true});if(original.isSymbolicLink()||!(stat.isFile()||stat.isDirectory())||stat.ino===0n||stableKey(original)!==stableKey(stat)||!safeName(basename(canonical)))reject('只支持可识别的普通文件或目录，不跟随快捷方式')
  return {path:canonical,name:basename(canonical),kind:stat.isDirectory()?'directory':'file',identity:stableKey(stat)}
}
async function verify(ref){if(!ref)reject('授权已失效，请重新选择');const current=await identify(ref.path);if(current.path!==ref.path||ref.kind!==current.kind||ref.identity!==current.identity)reject('原文件已移动或被替换，请重新授权');return current}
async function retireMovedSource(source,destination,output,assertLive){
  const holding=await mkdtemp(join(dirname(source.path),'.enest-move-')), held=join(holding,'source')
  let occupied=false
  try{
    await verify(source);await verify(destination);assertLive()
    await rename(source.path,held);occupied=true
    const sourceNow=await lstat(held,{bigint:true}), linkNow=await lstat(output,{bigint:true})
    if(!sourceNow.isFile()||!linkNow.isFile()||stableKey(sourceNow)!==source.identity||stableKey(linkNow)!==source.identity)reject('文件在移动过程中发生变化，未删除被替换的文件')
    assertLive();await unlink(held);occupied=false
  }finally{
    if(occupied){try{await link(held,source.path);await unlink(held);occupied=false}catch{}}
    if(occupied)reject(`来源路径发生冲突，未删除文件。请从原目录内的「${basename(holding)}/source」恢复。`)
    await rmdir(holding)
  }
}
function keyFor(parent,child){return createHash('sha256').update(`${parent.id}\0${child.name}\0${child.identity}`).digest('hex').slice(0,40)}
const projection=entry=>({id:entry.id,name:entry.name,kind:entry.kind})
function launch(program,args){return new Promise((resolve,reject)=>{execFile(program,args,{timeout:8000,maxBuffer:32768,windowsHide:true},error=>error?reject(new Error('系统文件管理器未打开该项目')):resolve(true))})}
function open(entry){
  const readable=entry.kind==='file'&&/^\.(?:pdf|txt|png|jpe?g|webp|gif|mp3|mp4|wav|mov|webm|avif|heic)$/i.test(extname(entry.name)), directory=entry.kind==='directory'&&!sensitiveBundle(entry.name)
  if(process.platform==='darwin')return launch('/usr/bin/open',directory||readable?[entry.path]:['-R',entry.path]);if(process.platform==='win32')return launch(join(process.env.SystemRoot||'C:\\Windows','explorer.exe'),directory?[entry.path]:[`/select,${entry.path}`]);if(process.platform==='linux')return launch('/usr/bin/xdg-open',[readable||directory?entry.path:dirname(entry.path)]);reject('当前系统不支持打开文件')
}
export function createFiles(host,assertLive,emit){
  const storageKey='freeDesktop.bookmarks.v1', listings=new Map(), watchers=new Map();let refsPromise,serial=Promise.resolve(),sharded=false
  function stopWatch(id){const entry=watchers.get(id);if(!entry)return;clearTimeout(entry.timer);entry.watcher.close();watchers.delete(id)}
  function observe(ref){
    if(watchers.has(ref.id)||watchers.size>=48)return
    try{
      const entry={watcher:watch(ref.path,{persistent:false,recursive:false},()=>{clearTimeout(entry.timer);entry.timer=setTimeout(()=>emit('files.changed',{id:ref.id}),420)})}
      watchers.set(ref.id,entry);entry.watcher.once('error',()=>stopWatch(ref.id))
    }catch{}
  }
  const bucket=id=>createHash('sha256').update(id).digest('hex').slice(0,2)
  async function loadReferences(){
    const data=await host('storage.get',{key:storageKey});if(data==null)return new Map()
    if(data.version!==1)reject('文件授权记录版本不受支持，未覆盖原数据')
    let rows=data.refs
    if(data.format==='buckets'){
      if(!Array.isArray(data.buckets)||data.buckets.length>256||new Set(data.buckets).size!==data.buckets.length||!data.buckets.every(id=>/^[a-f\d]{2}$/.test(id)))reject('文件授权索引损坏，未覆盖原数据')
      rows=[]
      for(let index=0;index<data.buckets.length;index+=6){const batch=data.buckets.slice(index,index+6);const results=await Promise.all(batch.map(id=>host('storage.get',{key:`${storageKey}.${id}`})));for(const [position,entries] of results.entries()){if(!Array.isArray(entries)||entries.some(ref=>!ref||typeof ref.id!=='string'||bucket(ref.id)!==batch[position]))reject('文件授权分区缺失，未覆盖原数据');rows.push(...entries)}}
      sharded=true
    }
    if(!Array.isArray(rows)||rows.length>4800||rows.some(ref=>!ref||!safeId(ref.id)||typeof ref.path!=='string'||!isAbsolute(ref.path)||!safeName(ref.name)||!['directory','file'].includes(ref.kind)||typeof ref.identity!=='string'))reject('文件授权记录损坏，未覆盖原数据')
    return new Map(rows.map(ref=>[ref.id,ref]))
  }
  function references(){return refsPromise??=loadReferences()}
  async function writeReferences(old,next){
    const buckets=new Map(),changed=new Set()
    for(const [id,ref] of next){const shard=bucket(id);if(!buckets.has(shard))buckets.set(shard,[]);buckets.get(shard).push(ref);if(!sharded||!old.has(id))changed.add(shard)}
    for(const id of old.keys())if(!next.has(id))changed.add(bucket(id))
    for(const shard of changed){assertLive();await host('storage.set',{key:`${storageKey}.${shard}`,value:buckets.get(shard)||[]})}
    assertLive();await host('storage.set',{key:storageKey,value:{version:1,format:'buckets',buckets:[...buckets.keys()]}});sharded=true;refsPromise=Promise.resolve(next)
  }
  const transact=operation=>{const result=serial.then(operation);serial=result.catch(()=>{});return result}
  async function selected(id,access){if(!hostId(id))reject('无效的文件句柄');const path=await host('files.resolve',{handleId:id,access});assertLive();return identify(path)}
  async function list(id,subscribe){
    const parent=(await references()).get(id);await verify(parent);if(parent.kind!=='directory'||sensitiveBundle(parent.name))reject('请选择普通文件夹');const entries=[],children=new Map();let inspected=0,truncated=false
    for await(const entry of await opendir(parent.path)){assertLive();if(entries.length>=150||++inspected>450){truncated=true;break}if(entry.name.startsWith('.')||!safeName(entry.name)||entry.isSymbolicLink()||!(entry.isFile()||entry.isDirectory()))continue;try{const child=await identify(join(parent.path,entry.name));if(dirname(child.path)!==parent.path)continue;child.id=keyFor(parent,child);children.set(child.id,child);entries.push(projection(child))}catch{}}
    await verify(parent);assertLive();if(listings.size>=48&&!listings.has(id))listings.delete(listings.keys().next().value);listings.set(id,children);if(subscribe)observe(parent);entries.sort((first,second)=>Number(second.kind==='directory')-Number(first.kind==='directory')||first.name.localeCompare(second.name));return {entries,truncated}
  }
  async function run(method,args){
    if(method==='files.stopWatching'){for(const id of watchers.keys())stopWatch(id);return true}
    if(method==='files.remember')return transact(async()=>{
      const ids=args[0];if(!Array.isArray(ids)||ids.length<1||ids.length>100)reject('每次最多授权 100 项');const old=await references(),next=new Map(old),added=[]
      for(const id of ids){const picked=await selected(id,'read');let ref=Array.from(next.values()).find(entry=>entry.path===picked.path&&entry.identity===picked.identity);if(!ref){ref={...picked,id:randomUUID()};next.set(ref.id,ref)}added.push(projection(ref))}
      if(next.size>4800)reject('文件引用已达上限，请移除不需要的收纳区');await writeReferences(old,next);return added
    })
    if(method==='files.retain')return transact(async()=>{const ids=args[0];if(!Array.isArray(ids)||ids.length>4800||!ids.every(safeId))reject('文件引用无效');const keep=new Set(ids),old=await references(),next=new Map([...old].filter(([id])=>keep.has(id)));if(next.size!==old.size){await writeReferences(old,next);for(const id of listings.keys())if(!keep.has(id))listings.delete(id);for(const id of watchers.keys())if(!keep.has(id))stopWatch(id)}return true})
    if(!safeId(args[0]))reject('无效的文件引用')
    if(method==='files.list')return list(args[0],args[1]===true);const ref=(await references()).get(args[0]);await verify(ref);assertLive()
    if(method==='files.open')return open(ref)
    if(method==='files.openChild'){const child=listings.get(ref.id)?.get(args[1]);if(!child||dirname(child.path)!==ref.path)reject('请先刷新目录');await verify(child);assertLive();return open(child)}
    if(method==='files.move')return transact(async()=>{
      const source=await selected(args[1],'write'),destination=await selected(args[2],'write');if(source.kind!=='file'||destination.kind!=='directory'||destination.path!==ref.path||destination.identity!==ref.identity||sensitiveBundle(destination.name))reject('需要选择已绑定的目标文件夹和一个普通文件');if(dirname(source.path)===destination.path)reject('文件已在此目录中')
      if(!await host('dialog.confirm',{title:'移动真实文件',message:`将「${source.name}」移入「${destination.name}」？`,detail:'这会改变原文件的位置。同名文件不会被覆盖；不支持跨磁盘移动。'}))return false
      assertLive();await verify(source);await verify(destination);const output=join(destination.path,source.name);await link(source.path,output)
      const linked=await identify(output);if(linked.identity!==source.identity)reject('来源发生变化，保留文件以避免误删');await retireMovedSource(source,destination,output,assertLive);return true
    });reject('未知的文件操作')
  }
  const dispatch=async(method,args)=>{try{return await run(method,args)}catch(error){if(typeof error.code==='string')reject(({ENOENT:'文件已不存在或已移动',EACCES:'系统拒绝访问此文件',EPERM:'系统不允许此文件操作',EEXIST:'目标已有同名文件，未移动或覆盖',EXDEV:'不支持跨磁盘移动，原文件未改变'})[error.code]||'系统文件操作失败，请检查文件并重试');throw error}}
  dispatch.dispose=()=>{for(const id of watchers.keys())stopWatch(id);listings.clear()};return dispatch
}
