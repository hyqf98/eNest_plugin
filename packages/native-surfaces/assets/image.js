export async function surfaceImageUrl(data) {
  const source = String(data?.dataUrl || '')
  if (data) data.dataUrl = undefined
  if (source.length > 32 * 1024 * 1024 || !/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(source)) throw new Error('Invalid surface image')
  // Keep compressed Blob bytes rather than a second long base64 string in the image DOM.
  return URL.createObjectURL(await (await fetch(source)).blob())
}
