import { createFiles } from './files.mjs'
import { createSession } from './session.mjs'

const port=process.parentPort,pending=new Map()
let sequence=0,owner,session,files,closing=false,closingTask
function assertLive(){if(!owner||closing)throw Error('插件运行实例已结束')}
function host(method,params){
  if(closing&&!['process.untrack','activity.release'].includes(method))return Promise.reject(Error('插件正在关闭'))
  if(pending.size>=40)return Promise.reject(Error('操作过于频繁'));const id=++sequence
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('宿主未回应请求'))},method==='dialog.confirm'?110000:9000);pending.set(id,{resolve,reject,timer});port.postMessage({type:'host.request',id,method,params})})
}
function emit(event,data){if(!closing)port.postMessage({event,data})}
function close(){if(closingTask)return closingTask;closing=true;closingTask=(async()=>{try{files?.dispose();await session?.close();port.postMessage({type:'shutdown.complete',ok:true})}finally{for(const call of pending.values()){clearTimeout(call.timer);call.reject(Error('实例已关闭'))}pending.clear();setTimeout(()=>process.exit(0),20).unref()}})();return closingTask}
port.on('message',({data})=>{
  if(!data||typeof data!=='object')return
  if(data.type==='host.response'){const waiter=pending.get(data.id);if(waiter){pending.delete(data.id);clearTimeout(waiter.timer);if(data.ok===true)waiter.resolve(data.data);else waiter.reject(new Error(String(data.error||'宿主拒绝请求').slice(0,512)))}return}
  if(data.type==='shutdown'){void close();return}
  if(data.type==='init'){if(owner||closing||!Number.isSafeInteger(data.wcId)||!Number.isSafeInteger(data.generation)||typeof data.pluginId!=='string'||data.context?.protocolVersion!==1||typeof data.context.packagePath!=='string')return;owner=data.pluginId;session=createSession(data.context,host,emit,assertLive);files=createFiles(host,assertLive,emit);return}
  if(!Number.isSafeInteger(data.id)||!owner||data.pluginId!==owner||!Array.isArray(data.args)||typeof data.method!=='string')return
  void Promise.resolve().then(()=>{assertLive();return data.method.startsWith('files.')?files(data.method,data.args):session.run(data.method,data.args)}).then(result=>{if(!closing)port.postMessage({id:data.id,ok:true,data:result})},error=>{if(!closing)port.postMessage({id:data.id,ok:false,error:String(error.message||error).slice(0,400)})})
})
process.once('SIGTERM',()=>{void close()});process.once('SIGINT',()=>{void close()})
