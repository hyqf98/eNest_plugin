(() => {
  'use strict'
  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  function button(text, title, click) {
    const node = element('button', '', text)
    node.type = 'button'; node.title = title; node.setAttribute('aria-label', title); node.onclick = click
    return node
  }
  function select(options, current, change, label) {
    const node = element('select'); node.setAttribute('aria-label', label)
    for (const [value, text] of options) { const opt = element('option', '', text); opt.value = value; node.append(opt) }
    node.value = current; node.onchange = () => change(node.value)
    return node
  }
  function rectStyle(node, rect) {
    for (const [key, field] of [['left','x'], ['top','y'], ['width','w'], ['height','h']]) node.style[key] = `${rect[field] * 100}%`
  }
  window.FreeDesktopSurface = (root, send, native) => {
    root.className = `desk${native ? ' native' : ''}`
    const area = element('main', 'area'), tools = element('div','studio-tools'), dock = element('nav','dock'), empty = element('div','empty'), picker = element('div','picker'), toast = element('div','notice')
    area.setAttribute('aria-label','桌面收纳区域'); dock.setAttribute('aria-label','程序栏'); toast.setAttribute('role','status')
    picker.hidden = toast.hidden = true; root.append(area, empty, tools, dock, picker, toast)
    let state, drag, draggedApp, noticeTimer, menuOpened = false, labels={}
    const drafts=new Map()
    const dispatch = (action, fields = {}) => send({ action, ...fields })
    const scrollPositions = new Map()
    function notice(text) { clearTimeout(noticeTimer); toast.textContent = text; toast.hidden = !text; noticeTimer = setTimeout(() => { toast.hidden = true }, 6500) }
    toast.onclick = () => { toast.hidden = true }
    function closePicker() { picker.hidden = true; picker.replaceChildren() }
    function choose(clientX, clientY, options) {
      closePicker(); picker.hidden = false
      for (const [label, run] of options) picker.append(button(label, label, () => { closePicker(); run() }))
      picker.append(button('取消', '取消', closePicker)); const bounds = root.getBoundingClientRect()
      picker.style.left = `${Math.max(2, Math.min(clientX - bounds.left, bounds.width - picker.offsetWidth - 4))}px`
      picker.style.top = `${Math.max(2, Math.min(clientY - bounds.top, bounds.height - picker.offsetHeight - 4))}px`
      picker.querySelector('button')?.focus()
    }
    function origin(event) {
      const bounds = area.getBoundingClientRect()
      return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1,bounds.width))), y: Math.max(0, Math.min(1,(event.clientY - bounds.top) / Math.max(1,bounds.height))) }
    }
    function gesture(event, mode, block, target) {
      if (event.button !== 0 || !state || drag) return
      event.preventDefault(); closePicker(); const start = origin(event), frame = element('div','frame')
      area.append(frame); area.setPointerCapture(event.pointerId); area.classList.add('dragging')
      drag = {mode, block, target, frame, start, pointerId:event.pointerId, rect: block ? {...block.rect} : { ...start, w:0, h:0 } }; rectStyle(frame,drag.rect)
    }
    area.onpointerdown = event => { if (event.target === area) gesture(event, 'create') }
    area.onpointermove = event => {
      if (!drag || drag.pointerId !== event.pointerId) return
      const point = origin(event), {start,mode,block} = drag, from = block?.rect, clamp = (value,min,max) => Math.max(min,Math.min(max,value))
      if (mode === 'create') drag.rect = { x: Math.min(start.x,point.x), y: Math.min(start.y,point.y), w: Math.abs(start.x-point.x), h:Math.abs(start.y-point.y) }
      else if (mode === 'move') drag.rect = {...from,x:clamp(from.x+point.x-start.x,0,1-from.w), y:clamp(from.y+point.y-start.y,0,1-from.h)}
      else drag.rect = {...from,w:clamp(from.w+point.x-start.x,.10,1-from.x),h:clamp(from.h+point.y-start.y,.09,1-from.y)}
      rectStyle(drag.frame,drag.rect)
    }
    function end(event,cancel=false) {
      if (!drag || drag.pointerId !== event.pointerId) return
      const {mode,block,rect,frame} = drag; drag = null; frame.remove(); area.classList.remove('dragging'); if(area.hasPointerCapture(event.pointerId)) area.releasePointerCapture(event.pointerId)
      if (cancel) return
      if (mode !== 'create') { dispatch('rect',{id:block.id,rect}); return }
      if(rect.w * area.clientWidth < 25 || rect.h * area.clientHeight < 25) return
      choose(event.clientX,event.clientY,Object.entries(labels).map(([kind,label])=>[label,()=>dispatch('create',{kind,rect})]))
    }
    area.onpointerup = event => end(event); area.onpointercancel = event => end(event,true)
    document.addEventListener('keydown',event=>{ if(event.key==='Escape'){ closePicker(); if(drag) end({pointerId:drag.pointerId},true) } })
    function inStudio(action,fields={}) { if(native) dispatch('workspace',{hint:action,...fields}); else dispatch(action,fields) }
    function menu(node, options) { const bounds = node.getBoundingClientRect(); choose(bounds.left,bounds.bottom+3,options) }
    function card(block) {
      const node = element('section','card'), header = element('header'), body = element('div','contents'), footer = element('footer'), handle = element('div','handle')
      node.dataset.id = block.id; rectStyle(node, block.rect); header.append(element('span','',block.title || labels[block.kind])); header.onpointerdown = event => { if(!event.target.closest('button')) gesture(event,'move',block) }
      const more = button('•••', `${block.title} 操作`, () => menu(more, [['移除这个区域（保留文件）',()=>dispatch('remove',{id:block.id})]])); header.append(more)
      handle.onpointerdown = event => gesture(event,'resize',block)
      if (block.kind === 'clock') { body.append(element('time','clock'),element('small','date')) }
      else if (block.kind === 'note') {
        const field=element('textarea');field.placeholder='写下待办或灵感…';field.setAttribute('aria-label','便签内容');field.maxLength=8192
        field.value=drafts.get(block.id)?.text??block.text??''
        function flush(){const draft=drafts.get(block.id);if(!draft)return;clearTimeout(draft.timer);delete field.dataset.dirty;if(draft.sent===draft.text)return;draft.sent=draft.text;dispatch('note',{id:block.id,text:draft.text})}
        field.oninput=()=>{const old=drafts.get(block.id);if(old)clearTimeout(old.timer);field.dataset.dirty='1';const draft={text:field.value,sent:old?.sent,timer:setTimeout(flush,450)};drafts.set(block.id,draft)}
        field.onchange=flush;body.append(field)
      }
      else {
        const listing=state.listings?.[block.id], entries=block.kind==='collection' ? block.refs : (listing?.entries || [])
        if(!entries.length) body.append(element('small','',block.kind==='collection' ? '拖入或添加文件，仅保存引用' : (!block.binding?'尚未绑定目录':listing?.error || (listing?'此文件夹为空':'点击刷新载入文件夹'))))
        for(const entry of entries){ const row=element('div','file-row');row.append(button(`${entry.kind==='directory'?'▸':'·'} ${entry.name}`,`在系统中打开或显示 ${entry.name}`,()=>dispatch('open',{id:block.id,ref:entry.id}))); if(block.kind==='collection') row.append(button('×','移除引用',()=>dispatch('unref',{id:block.id,ref:entry.id})));body.append(row) }
        if(state.compact) body.append(element('small','','大型布局采用精简显示；打开工作区可查看全部。'))
        else if(listing?.truncated) body.append(element('small','','仅显示前 150 项'))
        if(block.kind==='collection'){footer.append(button('＋ 添加引用','选择文件或文件夹作为引用',()=>inStudio('pickFiles',{id:block.id}))); node.ondragover=event=>{if (!native&&event.dataTransfer.types.includes('Files')){event.preventDefault();node.classList.add('drop')}};node.ondragleave=()=>node.classList.remove('drop');node.ondrop=event=>{event.preventDefault();node.classList.remove('drop');if(!native&&event.dataTransfer.files.length) send({action:'drop',id:block.id,files:[...event.dataTransfer.files]})} }
        else {footer.append(button(block.binding?'重新绑定':'选择目录','绑定一个授权的目录',()=>inStudio('bind',{id:block.id})));if(block.binding) footer.append(button('刷新','刷新文件夹',()=>dispatch('refresh',{id:block.id})),button('移入文件','选择文件并确认移动',()=>inStudio('moveFile',{id:block.id}))) }
      }
      node.append(header,body,footer,handle); if(scrollPositions.has(block.id)) requestAnimationFrame(()=>{body.scrollTop=scrollPositions.get(block.id)||0}); return node
    }
    function clockTick(){const now=new Date();for(const clock of area.querySelectorAll('.clock')){clock.textContent=now.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});clock.nextSibling.textContent=now.toLocaleDateString(undefined,{month:'long',day:'numeric',weekday:'long'})}}
    setInterval(clockTick,30000)
    function render(next) {
      if(!next?.layout)return
      const active=document.activeElement, editing=area.contains(active)&&active.tagName==='TEXTAREA'?{id:active.closest('.card').dataset.id,text:active.value,start:active.selectionStart,end:active.selectionEnd,dirty:active.dataset.dirty}:null
      for(const old of area.querySelectorAll('.card')) scrollPositions.set(old.dataset.id,old.querySelector('.contents').scrollTop)
      state=next;labels=Object.fromEntries(next.regions.map(type=>[type.kind,type.title])); const {layout,screen,screens,running}=state, primary=screens.find(item=>item.primary)?.id || screens[0]?.id || 'primary'
      for(const [id,draft] of drafts){const block=layout.blocks.find(entry=>entry.id===id);if(!block||block.text===draft.text){clearTimeout(draft.timer);drafts.delete(id)}}
      const effective=id=>id==='primary'||!screens.some(item=>item.id===id)?primary:id
      const display=screens.find(item=>item.id===screen);for(const side of ['top','bottom','left','right']) root.style.setProperty(`--${side}`,`${native?Math.max(0,Number(display?.insets?.[side])||0):0}px`)
      const blocks=layout.blocks.filter(block=>effective(block.screen)===screen); for(const existing of area.querySelectorAll('.card')) existing.remove(); for(const block of blocks) area.append(card(block)); clockTick()
      if(editing){const field=Array.from(area.querySelectorAll('.card')).find(node=>node.dataset.id===editing.id)?.querySelector('textarea');if(field){if(editing.dirty){field.value=editing.text;field.dataset.dirty='1'}field.focus({preventScroll:true});field.setSelectionRange(editing.start,editing.end)}}
      empty.hidden=!!blocks.length;empty.replaceChildren(element('strong','','在空白处拖出一个区域'),element('small','','放置文件、文件夹、时钟或便签'))
      const opened=tools.querySelector('details')?.open;menuOpened=opened??menuOpened; tools.replaceChildren(element('strong','',native?'自由桌面':running?'自由桌面 · 接管中':'普通工作区'))
      const add=button('＋ 区域','选一种区域（也可在空白处拖动）',()=>menu(add,Object.entries(labels).map(([kind,label])=>[label,()=>dispatch('create',{kind,rect:{x:.16,y:.23,w:.34,h:.33}})])));tools.append(add)
      if(!native){ const take=button(running?'退出接管':'接管系统桌面',running?'恢复系统桌面':'选择并确认桌面托管',()=>dispatch(running?'stop':'start'));take.className='primary';tools.append(take) }
      const options=element('details'),summary=element('summary','','桌面设置'),list=element('div');options.open=menuOpened;options.ontoggle=()=>{menuOpened=options.open};options.append(summary,list);tools.append(options)
      list.append(element('strong','','程序栏位置'),select([['bottom','底部'],['top','顶部'],['left','左侧'],['right','右侧']],layout.dock.side,side=>dispatch('dockSide',{side}),'程序栏边缘'),select([['primary','随主屏'],...screens.filter(item=>item.id!=='primary').map(item=>[item.id,item.label]),...(!['primary',...screens.map(item=>item.id)].includes(layout.dock.screen)?[[layout.dock.screen,'原显示器（已断开）']]:[])],layout.dock.screen,value=>dispatch('dockScreen',{value}),'程序栏所在屏幕'))
      if(!native){list.append(button('添加程序 / 插件','从宿主目录选择程序',()=>dispatch('pickTarget')),button('选择壁纸图片','设置此工作区壁纸',()=>dispatch('pickWallpaper')),button('恢复默认壁纸','恢复插件默认背景',()=>dispatch('clearWallpaper')),button('原桌面文件区…','从系统选择框绑定原桌面目录',()=>dispatch('desktopFolder')));if(screens.length>1)list.append(element('small','','编辑显示器'),select(screens.map(item=>[item.id,item.label]),screen,value=>dispatch('editScreen',{value}),'工作区预览屏幕')) }
      else {tools.insertBefore(button('打开工作区','在 eNest 中打开本插件工作区',()=>inStudio('workspace')),options);list.append(button('选择壁纸…','在工作区选择壁纸',()=>inStudio('pickWallpaper')),button('添加程序 / 插件…','在工作区固定启动项',()=>inStudio('pickTarget')),button('退出接管','恢复系统桌面',()=>dispatch('stop')))}
      dock.hidden=effective(layout.dock.screen)!==screen;dock.dataset.side=layout.dock.side;dock.replaceChildren(button('⌕','打开 eNest 搜索',()=>dispatch('quick')),element('div','divider'))
      for(const entry of layout.dock.targets){const app=button('',entry.title,()=>dispatch('launch',{id:entry.id}));if(/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(entry.icon||'')){const image=element('img');image.src=entry.icon;image.alt='';app.append(image)}else app.append(element('span','letter',Array.from(entry.title)[0]||'·'));app.draggable=true;app.ondragstart=event=>{draggedApp=entry.id;event.dataTransfer.setData('text/plain','dock-item')};app.ondragover=event=>{if(draggedApp)event.preventDefault()};app.ondrop=event=>{event.preventDefault();if(draggedApp)dispatch('reorder',{id:draggedApp,before:entry.id});draggedApp=null};app.ondragend=()=>{draggedApp=null};app.oncontextmenu=event=>{event.preventDefault();choose(event.clientX,event.clientY,[['移至首位',()=>dispatch('reorder',{id:entry.id,before:layout.dock.targets[0].id})],['从程序栏移除',()=>dispatch('unpin',{id:entry.id})]])};dock.append(app)}
      if(!layout.dock.targets.length) dock.append(button('＋','添加系统应用或 eNest 插件',()=>inStudio('pickTarget')))
    }
    return {render,notice,focusRegion(id){const item=Array.from(area.querySelectorAll('.card')).find(node=>node.dataset.id===id);item?.querySelector('footer button,textarea,header button')?.focus({preventScroll:true})},wallpaper(data){if(typeof data==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(data))root.style.setProperty('--wallpaper',`url("${data}")`);else root.style.removeProperty('--wallpaper')}}
  }
})()
