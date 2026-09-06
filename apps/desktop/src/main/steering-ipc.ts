import { ipcMain, nativeImage } from 'electron'
import { IPC } from '../shared/ipc'
import { success, failure } from '../shared/result'
import { redactLogText } from '../shared/redact-log'
import type { SteeringService } from './steering'
export function registerSteeringIpc(service:SteeringService):void {
  const handle=(channel:string,operation:(value:unknown)=>unknown)=>ipcMain.handle(channel,(_event,value:unknown)=>{
    try{return success(operation(value))}catch(error){return failure(redactLogText(error instanceof Error?error.message:'Steering operation failed.'))}
  })
  handle(IPC.steering.preview, value => {
    const image = nativeImage.createFromBuffer(service.preview(value))
    if (image.isEmpty()) throw new Error('This image could not be previewed.')
    return image.resize({ width: 256, height: 256 }).toDataURL()
  })
  handle(IPC.steering.history,value=>service.history(value))
  handle(IPC.steering.setModel,value=>service.setModel(value))
  handle(IPC.steering.send,value=>service.message(value))
  handle(IPC.steering.cancel,value=>service.cancel(value))
  handle(IPC.steering.withdraw,value=>service.withdraw(value))
}
