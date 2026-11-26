import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const run=promisify(execFile), targets=['darwin-arm64','darwin-x64','linux-x64','linux-arm64','win32-x64']
const parts=target=>target==='win32-x64'?['desktop-host.exe','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WebView2-LICENSE.txt']:['desktop-host']
async function regular(path){try{return (await lstat(path)).isFile()&&await realpath(path)===resolve(path)}catch{return false}}
async function inspect(directory,target){
  for(const file of parts(target))if(!await regular(join(directory,file)))throw Error(`${target}: missing or unsafe desktop helper component ${file}`)
  const handle=await open(join(directory,parts(target)[0]),'r'),header=Buffer.alloc(64);try{await handle.read(header,0,header.length,0)}finally{await handle.close()}
  if(target.startsWith('darwin')&&(header.readUInt32LE(0)!==0xfeedfacf||header.readUInt32LE(4)!==(target.endsWith('arm64')?0x100000c:0x1000007)))throw Error(`${target}: incorrect Mach-O executable`)
  if(target.startsWith('linux')&&(header.readUInt32BE(0)!==0x7f454c46||header.readUInt16LE(18)!==(target.endsWith('arm64')?183:62)))throw Error(`${target}: incorrect ELF executable`)
  if(target.startsWith('win32')&&header.readUInt16LE(0)!==0x5a4d)throw Error(`${target}: incorrect PE executable`)
}
export async function afterBuild({source,directory,target,runtime}){
  const local=`${process.platform}-${process.arch}`,wanted=target==='universal'?targets:[target],cache=join(source,'helper-cache')
  if(wanted.includes(local)&&targets.includes(local)){
    const binary=join(cache,local,parts(local)[0]),platform=process.platform==='darwin'?'macos':process.platform==='win32'?'windows':'linux',native=join(source,'native',platform),code=process.platform==='darwin'?'main.m':process.platform==='win32'?'Desktop.cs':'main.c',script=process.platform==='win32'?'build.ps1':'build.sh'
    const built=(await stat(binary).catch(()=>null))?.mtimeMs||0
    if((!built||process.env.ENEST_REQUIRE_ALL_HELPERS!=='1')&&built<Math.max((await stat(join(native,code))).mtimeMs,(await stat(join(native,script))).mtimeMs)){
      try{await run(process.platform==='win32'?'powershell':'sh',process.platform==='win32'?['-NoProfile','-File',join(native,script)]:[join(native,script)],{cwd:source,timeout:90000})}
      catch(error){if(runtime||built)throw error;console.warn(`free-desktop: native build unavailable on ${local}; packaging the ordinary workspace only: ${error.message}`)}
    }
  }
  for(const item of wanted){const from=join(cache,item);if(!await regular(join(from,parts(item)[0])))continue;await inspect(from,item);const to=join(directory,'runtime','helpers',item);await mkdir(to,{recursive:true});for(const file of parts(item))await copyFile(join(from,file),join(to,file));if(!item.startsWith('win32'))await chmod(join(to,parts(item)[0]),0o755)}
}
export async function validateDistribution({directory,target,requireRuntime}){
  const local=`${process.platform}-${process.arch}`,wanted=target==='universal'?targets:[target],found=[]
  for(const item of wanted){const dir=join(directory,'runtime','helpers',item);if(!await lstat(dir).catch(()=>null))continue;await inspect(dir,item);found.push(item)}
  const required=process.env.ENEST_REQUIRE_ALL_HELPERS==='1'?(target==='universal'?wanted.filter(item=>item!=='linux-arm64'):wanted):requireRuntime?[target==='universal'?local:target]:[]
  for(const item of required)if(!found.includes(item))throw Error(`free-desktop: missing required helper for ${item}`)
}
