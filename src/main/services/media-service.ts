import { dialog } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { apiUrl, uploadMultipart } from '../infra/net/api'
import { endpoint } from '../infra/net/apiconfig'

export { clearImageCache } from '../infra/media/imgcache'

async function pickUpload(token: string): Promise<{ url: string } | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择要上传的图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
  })
  if (canceled || !filePaths[0]) return null
  const file = filePaths[0]
  const url = await uploadMultipart(apiUrl(endpoint('uploadFile').path), token, basename(file), readFileSync(file))
  return { url }
}

/** 弹系统文件框选择图片并上传荒启（编辑器插入媒体）；取消返回 null */
export function pickUploadImage(token: string): Promise<{ url: string } | null> {
  return pickUpload(token)
}

/** 弹系统文件框选择并上传用户头像；取消返回 null */
export function pickUploadUserImage(token: string): Promise<{ url: string } | null> {
  return pickUpload(token)
}
