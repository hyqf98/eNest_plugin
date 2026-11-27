async function configureCodec() {
  const [{ default: configure }, { default: types }, { default: resize }] = await Promise.all([
    import('@jimp/custom'), import('@jimp/types'), import('@jimp/plugin-resize'),
  ])
  return configure({ types: [types], plugins: [resize] })
}

let loading: ReturnType<typeof configureCodec> | undefined

export function loadImageCodec() {
  return loading ??= configureCodec().catch(error => { loading = undefined; throw error })
}
