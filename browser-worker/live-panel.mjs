// Fixed-fixture live panel only. No URL, HTML or script evaluation surface.
const VIEWPORT_WIDTH=1280, VIEWPORT_HEIGHT=800
const MAX_JPEG_BYTES=1024*1024, MIN_FRAME_INTERVAL=100
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k)
function keys(object,allowed){if(Object.keys(object).some(k=>!allowed.includes(k)))throw Error('live 请求包含未知字段')}
function integer(value,min,max,name){if(!Number.isInteger(value)||value<min||value>max)throw Error(`无效的 ${name}`);return value}
function finite(value,min,max,name){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(`无效的 ${name}`);return value}
function text(value,max,name,required=false){if(typeof value!=='string'||Buffer.byteLength(value)>max||value.includes('\0')||(required&&!value))throw Error(`无效的 ${name}`);return value}
function modifiers(value){return integer(value,0,15,'modifiers')}

// Parse dimensions instead of trusting CDP metadata, which describes viewport
// size and may differ when screencast maxWidth/maxHeight scales the JPEG.
export function jpegSize(data){
  if(!Buffer.isBuffer(data)||data.length<4||data[0]!==0xff||data[1]!==0xd8)return null
  let i=2
  while(i<data.length){
    if(data[i++]!==0xff)return null
    while(i<data.length&&data[i]===0xff)i++
    if(i>=data.length)return null
    const marker=data[i++]
    if(marker===0xd9||marker===0xda)return null
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue
    if(i+2>data.length)return null
    const len=data.readUInt16BE(i)
    if(len<2||i+len>data.length)return null
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(len<8)return null
      const height=data.readUInt16BE(i+3),width=data.readUInt16BE(i+5)
      return width&&height?{width,height}:null
    }
    i+=len
  }
  return null
}

export function validateLiveInput(request){
  if(!request||typeof request!=='object'||Array.isArray(request))throw Error('无效的 live 输入')
  const base=['id','op','kind']
  if(request.kind==='mouse'){
    keys(request,[...base,'type','x','y','button','clickCount','modifiers','deltaX','deltaY'])
    if(!['mouseMoved','mousePressed','mouseReleased','mouseWheel'].includes(request.type))throw Error('无效的鼠标事件')
    const x=finite(request.x,-100000,100000,'x'),y=finite(request.y,-100000,100000,'y')
    const p={type:request.type,x:Math.min(VIEWPORT_WIDTH-1,Math.max(0,x)),y:Math.min(VIEWPORT_HEIGHT-1,Math.max(0,y))}
    if(own(request,'button')){
      if(!['none','left','middle','right','back','forward'].includes(request.button))throw Error('无效的 button')
      p.button=request.button
    }
    if(['mousePressed','mouseReleased'].includes(request.type)&&(!p.button||p.button==='none'))throw Error('鼠标按键必须明确指定')
    if(own(request,'clickCount'))p.clickCount=integer(request.clickCount,0,3,'clickCount')
    if(own(request,'modifiers'))p.modifiers=modifiers(request.modifiers)
    if(request.type==='mouseWheel'){
      p.deltaX=finite(request.deltaX,-1200,1200,'deltaX');p.deltaY=finite(request.deltaY,-1200,1200,'deltaY')
    }else if(own(request,'deltaX')||own(request,'deltaY'))throw Error('非滚轮事件不支持 delta')
    return {method:'Input.dispatchMouseEvent',params:p}
  }
  if(request.kind==='key'){
    keys(request,[...base,'type','key','code','windowsVirtualKeyCode','nativeVirtualKeyCode','text','unmodifiedText','modifiers'])
    if(!['keyDown','keyUp'].includes(request.type))throw Error('无效的键盘事件')
    const p={type:request.type,key:text(request.key,64,'key',true)}
    if(own(request,'code'))p.code=text(request.code,64,'code')
    for(const k of ['windowsVirtualKeyCode','nativeVirtualKeyCode'])if(own(request,k))p[k]=integer(request[k],0,65535,k)
    for(const k of ['text','unmodifiedText'])if(own(request,k))p[k]=text(request[k],256,k)
    if(own(request,'modifiers'))p.modifiers=modifiers(request.modifiers)
    return {method:'Input.dispatchKeyEvent',params:p}
  }
  if(request.kind==='text'){
    keys(request,[...base,'text'])
    return {method:'Input.insertText',params:{text:text(request.text,4096,'text',true)}}
  }
  throw Error('无效的 live 输入类型')
}

// writeFrame must write one complete JSON-line and invoke its callback when
// accepted by the Writable. Never queue more than one frame in user space.
export function createLivePanel({call,writeFrame,onError=()=>{},now=()=>performance.now()}){
  let active=false,busy=false,lastFrame=-Infinity,sequence=0,ackPending=0,limits,generation=0,stopping=Promise.resolve()
  function deactivate(){active=false;generation++}
  function fault(message){
    if(!active)return
    deactivate()
    stopping=Promise.resolve().then(()=>call('Page.stopScreencast',{})).catch(()=>{})
    onError(message)
  }
  async function start(request){
    keys(request,['id','op','quality','maxWidth','maxHeight'])
    if(active)throw Error('live 已启动')
    await stopping
    const quality=own(request,'quality')?integer(request.quality,1,80,'quality'):60
    const maxWidth=own(request,'maxWidth')?integer(request.maxWidth,64,1280,'maxWidth'):1280
    const maxHeight=own(request,'maxHeight')?integer(request.maxHeight,64,800,'maxHeight'):800
    await call('Emulation.setDeviceMetricsOverride',{width:VIEWPORT_WIDTH,height:VIEWPORT_HEIGHT,deviceScaleFactor:1,mobile:false})
    limits={maxWidth,maxHeight};active=true;generation++;lastFrame=-Infinity
    try{await call('Page.startScreencast',{format:'jpeg',quality,maxWidth,maxHeight,everyNthFrame:1})}
    catch(error){deactivate();throw error}
    return {started:true,viewportWidth:VIEWPORT_WIDTH,viewportHeight:VIEWPORT_HEIGHT,maxWidth,maxHeight,quality}
  }
  async function stop(request){
    keys(request,['id','op'])
    const wasActive=active;deactivate()
    if(wasActive)await call('Page.stopScreencast',{})
    return {stopped:true}
  }
  async function input(request){
    if(!active)throw Error('live 未启动')
    const {method,params}=validateLiveInput(request)
    await call(method,params)
    return {accepted:true}
  }
  function frame(params){
    if(!active)return
    if(!params||!Number.isSafeInteger(params.sessionId)||params.sessionId<0){fault('invalid screencast frame id');return}
    if(ackPending>=4){fault('screencast acknowledgement backlog');return}
    const frameGeneration=generation
    ackPending++
    Promise.resolve().then(()=>call('Page.screencastFrameAck',{sessionId:params.sessionId})).catch(()=>{if(active&&generation===frameGeneration)fault('screencast acknowledgement failed')}).finally(()=>{ackPending--})
    if(!active||busy||now()-lastFrame<MIN_FRAME_INTERVAL||typeof params.data!=='string'||params.data.length>Math.ceil(MAX_JPEG_BYTES/3)*4||params.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(params.data))return
    const bytes=Buffer.from(params.data,'base64')
    if(bytes.length>MAX_JPEG_BYTES)return
    const size=jpegSize(bytes)
    if(!size||size.width>limits.maxWidth||size.height>limits.maxHeight)return
    const event={event:'frame',seq:++sequence,data:params.data,width:size.width,height:size.height}
    busy=true;lastFrame=now()
    try{writeFrame(event,()=>{busy=false})}catch{busy=false;fault('screencast output failed')}
  }
  return Object.freeze({start,stop,input,frame,deactivate})
}
