declare module 'jimp' {
  export interface JimpImage {
    resize(width: number, height: number): JimpImage
    quality(value: number): JimpImage
    getBufferAsync(mime: string): Promise<Buffer>
    bitmap: { width: number; height: number }
  }

  export interface JimpStatic {
    read(source: Buffer | string): Promise<JimpImage>
    MIME_JPEG: string
    MIME_PNG: string
    AUTO: number
  }

  const Jimp: JimpStatic
  export default Jimp
}
