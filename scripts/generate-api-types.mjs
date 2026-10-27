#!/usr/bin/env node
/** Deterministic, portable SDK declarations. --check never writes generated files. */
import fs from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--host-root')
const host = resolve(flag >= 0 ? process.argv[flag + 1] : join(repository, '..'))
const check = process.argv.includes('--check')
let ts
try { ts = createRequire(join(repository,'package.json'))('typescript') }
catch { ts = createRequire(join(host,'package.json'))('typescript') }
const files = [join(host,'src/preload/pluginPreload.ts'), ...fs.readdirSync(join(host,'src/shared/types')).filter(x=>x.endsWith('.ts')).sort().map(x=>join(host,'src/shared/types',x))]
const declarations = new Map()
for(const file of files){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true)
 for(const node of source.statements) if(ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isEnumDeclaration(node)) if(!declarations.has(node.name.text)) declarations.set(node.name.text,{node,source})
}
const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed})
const queue=['EnestPluginApi','EnestHomeApi','EnestWorkspaceApi','EnestQuickApi','ThemeChromeApi','EnestSettingsApi','PluginBackgroundBridge','AuxiliaryPageApi','McpToolDeclaration','McpErrorCode'],seen=new Set(queue),blocks=[]
while(queue.length){
 const name=queue.shift();const entry=declarations.get(name)
 if(!entry)throw new Error(`Missing public API type ${name}`)
 let code=printer.printNode(ts.EmitHint.Unspecified,entry.node,entry.source)
 for(const candidate of declarations.keys())if(!seen.has(candidate)&&new RegExp(`\\b${candidate}\\b`).test(code)){seen.add(candidate);queue.push(candidate)}
 code=code.replace(/import\(["'][^"']+["']\)\./g,'')
 if(!/\bexport\s+(?:interface|type|enum)\b/.test(code))code=code.replace(/\b(interface|type|enum)\s/,'export $1 ')
 blocks.push(code.replace(/[\t ]+$/gm,''))
}
const text=`/** Generated from the eNest preload and shared API types. Do not edit. */\n${blocks.join('\n\n')}\n\ndeclare global { interface Window { enest: EnestPluginApi; /** @deprecated Use enest. */ zapi: EnestPluginApi; /** Dedicated workspace surfaces only. */ enestWorkspace?: EnestWorkspaceApi; /** Compatibility alias for enestWorkspace. */ enestHome?: EnestHomeApi; /** Isolated Quick theme pages only. */ enestQuick?: EnestQuickApi; /** Isolated theme chrome renderers only. */ enestChrome?: ThemeChromeApi; /** Isolated settings pages only. */ enestSettings?: EnestSettingsApi; /** Sandboxed background pages only. */ enestBackground?: PluginBackgroundBridge; /** Auxiliary pages only. */ enestAux?: AuxiliaryPageApi } }\nexport {}\n`
const doc=`# TypeScript 类型定义\n\n本页由插件仓库的 \`scripts/generate-api-types.mjs\` 从壳 preload 与共享类型生成。\n\n安装插件仓库的 \`@enest/plugin-sdk\`，在项目中加入 \`import type {} from '@enest/plugin-sdk'\` 即可获得 \`window.enest\` 类型。\n\n生成：\`npm run api:generate -- --host-root /path/to/eNest\`；只读校验：\`npm run api:check -- --host-root /path/to/eNest\`。\n\n类型不授予权限；系统能力仍由主进程验证 manifest、运行实例与用户授权。\n\n\`\`\`ts\n${text}\`\`\`\n`
let stale=false
for(const [file,content]of [[join(repository,'packages/plugin-sdk/index.d.ts'),text],[join(host,'docs/site/plugin/api-types.md'),doc],[join(repository,'docs/developer/api-types.md'),doc]]){
 if(check){if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==content){console.error(`Out of date: ${file}`);stale=true}}
 else{fs.mkdirSync(dirname(file),{recursive:true});fs.writeFileSync(file,content)}
}
const schemaPath=join(repository,'docs/plugin-manifest.schema.json')
const schema=JSON.parse(fs.readFileSync(schemaPath,'utf8'))
const permissionType=declarations.get('PluginPermission')?.node
const permissions=permissionType?.type?.types?.map(t=>t.literal?.text).filter(Boolean)
if(!permissions?.length)throw new Error('PluginPermission union is missing')
if(JSON.stringify([...schema.properties.permissions.items.enum].sort())!==JSON.stringify([...permissions].sort())){
 if(check){console.error('Plugin permission schema is out of date');stale=true}
 else{schema.properties.permissions.items.enum=permissions;fs.writeFileSync(schemaPath,JSON.stringify(schema,null,2)+'\n')}
}
const policySource=ts.createSourceFile('pluginPermissionPolicy.ts',fs.readFileSync(join(host,'src/shared/pluginPermissionPolicy.ts'),'utf8'),ts.ScriptTarget.Latest,true)
let builtinNode
for(const statement of policySource.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(declaration.name.getText(policySource)==='BUILTIN_PLUGIN_CAPABILITIES')builtinNode=declaration.initializer
while(builtinNode&&(ts.isAsExpression(builtinNode)||ts.isSatisfiesExpression(builtinNode)||ts.isParenthesizedExpression(builtinNode)))builtinNode=builtinNode.expression
if(!builtinNode||!ts.isArrayLiteralExpression(builtinNode))throw new Error('BUILTIN_PLUGIN_CAPABILITIES must be a literal array')
const builtin=builtinNode.elements.map(node=>{if(!ts.isStringLiteral(node))throw new Error('Invalid built-in capability');return node.text})
if(new Set(builtin).size!==builtin.length||builtin.some(name=>!permissions.includes(name)))throw new Error('Built-in policy does not match PluginPermission')
const policyText=JSON.stringify({builtin,consent:permissions.filter(name=>!builtin.includes(name))},null,2)+'\n'
const policyPath=join(repository,'docs/plugin-permission-policy.json')
if(check){if(!fs.existsSync(policyPath)||fs.readFileSync(policyPath,'utf8')!==policyText){console.error('Plugin permission policy snapshot is out of date');stale=true}}
else fs.writeFileSync(policyPath,policyText)
const sdkSchema=join(repository,'packages/plugin-sdk/src/manifest-schema.json')
const mcpValidatorSource=fs.readFileSync(join(host,'src/shared/mcpTools.ts'),'utf8')
const mcpValidatorText='/** Generated from the host shared MCP declaration validator. Do not edit. */\n'+ts.transpileModule(mcpValidatorSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const mcpValidatorPath=join(repository,'packages/plugin-sdk/src/mcp-tools.mjs')
if(check){if(!fs.existsSync(mcpValidatorPath)||fs.readFileSync(mcpValidatorPath,'utf8')!==mcpValidatorText){console.error(`Out of date: ${mcpValidatorPath}`);stale=true}}
else fs.writeFileSync(mcpValidatorPath,mcpValidatorText)
const schemaText=JSON.stringify(schema,null,2)+'\n'
for(const schemaCopy of [join(host,'src/shared/pluginManifest.schema.json'),sdkSchema]){
 if(check){if(!fs.existsSync(schemaCopy)||fs.readFileSync(schemaCopy,'utf8')!==schemaText){console.error(`Out of date: ${schemaCopy}`);stale=true}}
 else fs.writeFileSync(schemaCopy,schemaText)
}
if(stale)process.exitCode=1
else console.log(`${check?'Checked':'Generated'} ${seen.size} public types`)
