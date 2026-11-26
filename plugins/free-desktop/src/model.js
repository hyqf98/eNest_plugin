import { regionTypes } from './regions.js'
const sides = ['bottom','top','left','right']
export const primaryScreen = {id:'primary',label:'主显示器',primary:true}
const smallText = (value,max=180) => typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u001f]/.test(value)
const validId = value => smallText(value,192)
const makeId = () => crypto.randomUUID()
function rect(input){
  if(!input||!['x','y','w','h'].every(key=>Number.isFinite(input[key]))) throw Error('无效的区域位置')
  const w=Math.min(1,Math.max(.10,input.w)), h=Math.min(1,Math.max(.09,input.h))
  return {x:Math.max(0,Math.min(1-w,input.x)),y:Math.max(0,Math.min(1-h,input.y)),w,h}
}
function target(input){
  if(!input||!validId(input.id)||!smallText(input.title)||!['app','plugin'].includes(input.kind))throw Error('程序栏项目无效')
  return {id:input.id,title:input.title,kind:input.kind,...(validId(input.iconAsset)?{iconAsset:input.iconAsset}:{}),...(typeof input.icon==='string'&&input.icon.length<48000&&/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(input.icon)?{icon:input.icon}:{})}
}
function ref(input){if(!input||!validId(input.id)||!smallText(input.name,255)||!['file','directory'].includes(input.kind))throw Error('文件引用无效');return {id:input.id,name:input.name,kind:input.kind}}
function block(input){
  if(!input||!Object.hasOwn(regionTypes,input.kind)||typeof input.id!=='string'||!/^[-\w]{1,96}$/.test(input.id)||Object.hasOwn(Object.prototype,input.id)||!validId(input.screen)) throw Error('区域数据无效')
  const type=regionTypes[input.kind]
  return {id:input.id,kind:input.kind,screen:input.screen,title:smallText(input.title)?input.title:type.title,rect:rect(input.rect),...type.fields(input,ref)}
}
export function initial(){return {version:1,revision:0,dock:{side:'bottom',screen:'primary',targets:[]},wallpaper:null,blocks:[block({kind:'collection',id:'inbox',screen:'primary',rect:{x:.06,y:.22,w:.42,h:.49}}),block({kind:'clock',id:'time',screen:'primary',rect:{x:.55,y:.22,w:.30,h:.22}}),block({kind:'note',id:'memo',screen:'primary',rect:{x:.55,y:.49,w:.34,h:.28}})]}}
export function readLayout(raw){
  if(raw==null)return initial()
  if(raw.version!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.blocks)||raw.blocks.length>48||!sides.includes(raw.dock?.side)||!validId(raw.dock?.screen)||!Array.isArray(raw.dock.targets)||raw.dock.targets.length>48||raw.wallpaper!==null&&!validId(raw.wallpaper))throw Error('布局格式不受支持，未写入任何数据')
  const blocks=raw.blocks.map(block), targets=raw.dock.targets.map(target)
  if(new Set(blocks.map(item=>item.id)).size!==blocks.length||new Set(targets.map(item=>item.id)).size!==targets.length)throw Error('布局包含重复项目')
  return {version:1,revision:raw.revision,blocks,dock:{side:raw.dock.side,screen:raw.dock.screen,targets},wallpaper:raw.wallpaper}
}
export function homeScreen(id,screens){return screens.find(screen=>screen.id===id)?.id||screens.find(screen=>screen.primary)?.id||screens[0]?.id||'primary'}
export function change(previous,action,screen,screens){
  const layout=structuredClone(previous), item=layout.blocks.find(entry=>entry.id===action.id)
  if(['rect','note','remove','setRefs','unref','setBinding'].includes(action.action)&&(!item||homeScreen(item.screen,screens)!==screen))throw Error('区域不可用')
  switch(action.action){
    case 'create': {if(layout.blocks.length>=48)throw Error('最多可放置 48 个区域');layout.blocks.push(block({id:makeId(),kind:action.kind,screen,rect:action.rect}));break}
    case 'remove':layout.blocks=layout.blocks.filter(entry=>entry!==item);break
    case 'rect':item.rect=rect(action.rect);break
    case 'note':if(item.kind!=='note'||typeof action.text!=='string')throw Error('无效便签');item.text=action.text.slice(0,8192);break
    case 'setRefs':{if(item.kind!=='collection')throw Error('不是文件收纳区');const refs=new Map(item.refs.map(entry=>[entry.id,entry]));for(const entry of action.refs)refs.set(entry.id,ref(entry));if(refs.size>100)throw Error('每个收纳区最多 100 项');item.refs=[...refs.values()];break}
    case 'unref':if(item.kind!=='collection')throw Error('不是文件收纳区');item.refs=item.refs.filter(entry=>entry.id!==action.ref);break
    case 'setBinding':if(item.kind!=='folder')throw Error('不是文件夹区域');item.binding=ref(action.ref);item.title=action.ref.name;break
    case 'dockSide':if(!sides.includes(action.side))throw Error('无效边缘');layout.dock.side=action.side;break
    case 'dockScreen':if(action.value!=='primary'&&!screens.some(display=>display.id===action.value))throw Error('显示器不在线');layout.dock.screen=action.value;break
    case 'pin':{const entry=target(action.target);if(!layout.dock.targets.some(old=>old.id===entry.id))layout.dock.targets.push(entry);break}
    case 'unpin':layout.dock.targets=layout.dock.targets.filter(entry=>entry.id!==action.id);break
    case 'reorder':{const list=layout.dock.targets,moving=list.find(entry=>entry.id===action.id),before=list.find(entry=>entry.id===action.before);if(moving&&before&&moving!==before){list.splice(list.indexOf(moving),1);list.splice(list.indexOf(before),0,moving)}break}
    case 'wallpaper':layout.wallpaper=action.assetId;break
    default:throw Error('未知布局操作')
  }
  layout.revision++;return readLayout(layout)
}
