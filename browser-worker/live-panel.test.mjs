import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { createLivePanel, jpegSize, validateLiveInput } from './live-panel.mjs'

const fakeJpeg=Buffer.from('ffd8ffc0001108006400c803011100021100031100','hex')
const tick=()=>new Promise(resolve=>setImmediate(resolve))

test('single frame in flight, rate limit, ack and stop are bounded',async()=>{
  let clock=0,done;const sent=[],calls=[]
  const panel=createLivePanel({now:()=>clock,call:async(method,params)=>{calls.push({method,params})},writeFrame:(frame,cb)=>{sent.push(frame);done=cb}})
  assert.deepEqual(jpegSize(fakeJpeg),{width:200,height:100})
  await panel.start({op:'live_start',maxWidth:200,maxHeight:100})
  const frame=id=>panel.frame({sessionId:id,data:fakeJpeg.toString('base64')})
  frame(1);await tick();clock=200;frame(2);await tick()
  assert.equal(sent.length,1,'slow output must not queue another frame')
  done();clock=201;frame(3);await tick();assert.equal(sent.length,2)
  done();clock=250;frame(4);await tick();assert.equal(sent.length,2,'rate limiter drops frame')
  assert.deepEqual(calls.filter(x=>x.method==='Page.screencastFrameAck').map(x=>x.params.sessionId),[1,2,3,4])
  await panel.stop({op:'live_stop'});clock=500;frame(5);await tick();assert.equal(sent.length,2)
  assert(calls.some(x=>x.method==='Page.stopScreencast'))
  assert.deepEqual(Object.keys(sent[0]).sort(),['data','event','height','seq','width'])
})

test('invalid frames are dropped and ack backlogs are bounded',async()=>{
  const calls=[],events=[];let failures=0
  const panel=createLivePanel({call:(method,params)=>{calls.push({method,params});return method==='Page.screencastFrameAck'?new Promise(()=>{}):Promise.resolve()},writeFrame:e=>events.push(e),onError:()=>failures++})
  await panel.start({op:'live_start'})
  panel.frame({sessionId:1,data:'not base64!'});panel.frame({sessionId:2,data:Buffer.alloc(1024*1024+1).toString('base64')})
  panel.frame({sessionId:3,data:Buffer.from('bad').toString('base64')});panel.frame({sessionId:4,data:fakeJpeg.toString('base64')});panel.frame({sessionId:5,data:fakeJpeg.toString('base64')})
  await tick();assert.equal(calls.filter(x=>x.method==='Page.screencastFrameAck').length,4)
  assert.equal(failures,1);assert.equal(events.length,1)
})

test('live input strictly validates fields, bounds and clamps coordinates',()=>{
  assert.deepEqual(validateLiveInput({op:'live_input',kind:'mouse',type:'mouseMoved',x:-4,y:900}).params,{type:'mouseMoved',x:0,y:799})
  assert.throws(()=>validateLiveInput({kind:'mouse',type:'mouseMoved',x:Infinity,y:1}))
  assert.throws(()=>validateLiveInput({kind:'mouse',type:'mousePressed',x:1,y:1}))
  assert.throws(()=>validateLiveInput({kind:'mouse',type:'mouseWheel',x:1,y:1,deltaX:0,deltaY:1201}))
  assert.throws(()=>validateLiveInput({kind:'mouse',type:'mouseMoved',x:1,y:1,extra:'x'}))
  assert.throws(()=>validateLiveInput({kind:'key',type:'keyDown',key:'A',windowsVirtualKeyCode:-1}))
  assert.throws(()=>validateLiveInput({kind:'key',type:'char',key:'A'}))
  assert.throws(()=>validateLiveInput({kind:'text',text:'x'.repeat(4097)}))
  assert.throws(()=>validateLiveInput({kind:'text',text:'x\0'}))
  assert.throws(()=>validateLiveInput({kind:'script',text:'alert(1)'}))
  assert.equal(validateLiveInput({kind:'text',text:'hello'}).method,'Input.insertText')
})

test('live flags fail closed when incomplete, unknown or duplicated',async()=>{
  for(const args of [['--experimental-live-panel'],['--experimental-private-http-fixture','--experimental-live-panel','--wrong'],['--experimental-private-http-fixture','--experimental-live-panel','--experimental-live-panel']]){
    const child=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname,...args],{stdio:['ignore','ignore','pipe']})
    let stderr='';child.stderr.on('data',x=>stderr+=x)
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    assert.equal(code,1);assert.match(stderr,/不支持的启动参数/)
  }
})

const enabled=process.env.DSH_FNOS_LIVE_PANEL_TEST==='1'
function deadline(p,ms=15000){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),ms)})]).finally(()=>clearTimeout(timer))}
function decodeJpeg(data){
  const child=spawn('/usr/bin/ffmpeg',['-v','error','-f','image2pipe','-vcodec','mjpeg','-i','pipe:0','-f','null','-'],{stdio:['pipe','ignore','pipe']})
  let stderr='';child.stderr.on('data',c=>stderr+=c);child.stdin.on('error',()=>{})
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(stderr||`ffmpeg exited ${code}`)))})
  child.stdin.end(Buffer.from(data,'base64'));return deadline(exited,5000)
}

test('real Chromium fixed fixture live frames and input', {skip:!enabled,timeout:40000},async()=>{
  const worker=new URL('./worker.mjs',import.meta.url)
  const child=spawn(process.execPath,[worker.pathname,'--experimental-private-http-fixture','--experimental-live-panel'],{stdio:['pipe','pipe','pipe']})
  let stderr='',id=0,frameCount=0;const frames=[],pending=new Map(),listeners=[]
  child.stderr.on('data',c=>stderr+=c);child.stdin.on('error',()=>{})
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{for(const p of pending.values())p.reject(Error(`worker exited ${code}/${signal}: ${stderr}`));pending.clear();resolve({code,signal})})})
  const output=readline.createInterface({input:child.stdout})
  output.on('line',line=>{
    const value=JSON.parse(line)
    if(value.event==='frame'){frameCount++;frames.push(value);for(const f of listeners.splice(0))f();return}
    if(value.event==='live_error'){for(const p of pending.values())p.reject(Error('live error'));pending.clear();return}
    const p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(Error(value.error)):p.resolve(value.result)}
  })
  const call=(op,extra={})=>deadline(new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,op,...extra})+'\n')}))
  const waitFrames=n=>deadline((async()=>{while(frames.length<n)await new Promise(resolve=>listeners.push(resolve))})())
  try{
    await assert.rejects(call('live_start'),/固定测试页/)
    await assert.rejects(call('open',{html:'user-provided'}),/不接受/)
    await call('open_test_site')
    const start=await call('live_start');assert.equal(start.viewportWidth,1280);assert.equal(start.viewportHeight,800)
    await waitFrames(1)
    await assert.rejects(call('live_input',{kind:'mouse',type:'mouseMoved',x:1,y:1,extra:true}),/未知字段/)
    await assert.rejects(call('live_input',{kind:'key',type:'keyDown',key:'A',modifiers:16}),/modifiers/)
    for(const type of ['mousePressed','mouseReleased'])await call('live_input',{kind:'mouse',type,x:20,y:15,button:'left',clickCount:1})
    await call('live_input',{kind:'text',text:'live-value'})
    assert.equal((await call('snapshot')).elements[0].text,'live-value')
    await waitFrames(2)
    for(const frame of frames.slice(0,2)){
      assert.deepEqual(Object.keys(frame).sort(),['data','event','height','seq','width'])
      const size=jpegSize(Buffer.from(frame.data,'base64'));assert.deepEqual(size,{width:frame.width,height:frame.height})
      assert(frame.width<=1280&&frame.height<=800);await decodeJpeg(frame.data)
    }
    await call('live_input',{kind:'key',type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35})
    await call('live_input',{kind:'key',type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35})
    assert.deepEqual(await call('live_stop'),{stopped:true})
    const atStop=frameCount;await new Promise(resolve=>setTimeout(resolve,400));assert.equal(frameCount,atStop)
    assert.deepEqual(await call('close'),{closed:true,groupConfirmedEmpty:true,temporaryDirectoryRetained:false})
    assert.equal((await deadline(exited)).code,0,stderr)
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')
    await deadline(exited,5000).catch(()=>{})
  }
})
